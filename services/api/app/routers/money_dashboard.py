"""FastAPI router for ``GET /money/dashboard``.

Reads the local YNAB cache (filled by ``POST /money/ynab/refresh``)
and aggregates into the single payload the Money page renders. Never
talks to YNAB directly — that's :mod:`app.routers.money_ynab`'s job.

Numbers come from YNAB in signed milliunits (CAD 12.34 = 12340; outflows
are negative). The dashboard returns dollars (rounded to cents) and
inverts outflow sign so "spent this month" reads as a positive amount in
the UI.
"""

from __future__ import annotations

from calendar import monthrange
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.config import settings
from app.deps import get_current_user
from app.models.ynab import (
    MoneyCategoryGroupSpend,
    MoneyCategoryOverage,
    MoneyDashboardResponse,
    MoneyPacingPoint,
    MoneyT3MGroupRow,
)

router = APIRouter(tags=["money"], dependencies=[Depends(get_current_user)])

_MILLI = Decimal(1000)
_TWO_DP = Decimal("0.01")

# YNAB auto-creates these category groups for budget plumbing — they're
# not real spending categories and would inflate every total. Names are
# stable across YNAB API versions; if a user has a budget in a non-
# English locale we'd want to revisit (YNAB itself is English-only as
# of writing).
_SYSTEM_GROUP_NAMES: frozenset[str] = frozenset(
    {
        "Credit Card Payments",
        "Internal Master Category",
        "Hidden Categories",
    }
)


def _is_system_group(group_name: str | None) -> bool:
    return (group_name or "") in _SYSTEM_GROUP_NAMES


def _dollars(milli: int | Decimal | None) -> Decimal:
    if milli is None:
        return Decimal("0.00")
    return (Decimal(int(milli)) / _MILLI).quantize(_TWO_DP)


def _first_day(d: date) -> date:
    return d.replace(day=1)


def _months_back(d: date, n: int) -> date:
    """Return the first day of the month n months before ``d``."""
    year = d.year
    month = d.month - n
    while month <= 0:
        month += 12
        year -= 1
    return date(year, month, 1)


@router.get("/", response_model=MoneyDashboardResponse)
def get_dashboard() -> MoneyDashboardResponse:
    """Aggregate the cache into a single dashboard payload."""

    if not (settings.database_resource_arn and settings.database_secret_arn):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "DB_NOT_CONFIGURED",
                "message": (
                    "Aurora is not configured for this environment. "
                    "Money dashboard requires the cache DB."
                ),
            },
        )

    budget = db.fetch_one(
        """
        SELECT id, currency_code, last_synced_at
        FROM ynab_budgets
        WHERE is_active = TRUE
        LIMIT 1
        """
    )
    if not budget:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "YNAB_NO_BUDGET",
                "message": (
                    "No active YNAB budget. Connect YNAB in Settings → "
                    "YNAB to populate the dashboard."
                ),
            },
        )

    budget_id = str(budget["id"])
    currency = str(budget.get("currency_code") or "CAD")
    last_synced_at = budget.get("last_synced_at")

    today = date.today()
    month_start = _first_day(today)

    # ---------------------------------------------------------------------
    # Current-month category amounts (assigned / activity) joined to names.
    # ---------------------------------------------------------------------
    mcats: list[dict[str, Any]] = db.fetch_all(
        """
        SELECT
            c.category_id AS category_id,
            c.name AS category_name,
            c.group_name AS group_name,
            c.hidden AS hidden,
            mc.assigned AS assigned,
            mc.activity AS activity,
            mc.balance AS balance
        FROM ynab_month_categories mc
        JOIN ynab_categories c ON c.category_id = mc.category_id
        WHERE mc.budget_id = :budget_id AND mc.month = :month
        """,
        {"budget_id": budget_id, "month": month_start},
    )
    visible = [
        r
        for r in mcats
        if not r.get("hidden") and not _is_system_group(r.get("group_name"))
    ]

    # Outflow magnitudes per category (positive dollars for display).
    # YNAB activity is negative for spending; flip the sign.
    spent_total = Decimal("0.00")
    overages: list[MoneyCategoryOverage] = []
    group_spend: dict[str, Decimal] = {}
    for r in visible:
        assigned = _dollars(r.get("assigned"))
        activity_signed = _dollars(r.get("activity"))
        spent = -activity_signed if activity_signed < 0 else Decimal("0.00")
        spent_total += spent
        group_spend[str(r["group_name"])] = (
            group_spend.get(str(r["group_name"]), Decimal("0.00")) + spent
        )

        if spent > assigned and assigned > 0:
            overage = (spent - assigned).quantize(_TWO_DP)
            pct = (overage / assigned * Decimal(100)).quantize(Decimal("0.1"))
            overages.append(
                MoneyCategoryOverage(
                    category_id=str(r["category_id"]),
                    category_name=str(r["category_name"]),
                    group_name=str(r["group_name"]),
                    assigned=assigned,
                    activity=spent,
                    overage=overage,
                    percent_over=pct,
                )
            )

    overages.sort(key=lambda o: o.overage, reverse=True)

    # ---------------------------------------------------------------------
    # Income from current month's transactions (positive amounts).
    # Use transactions table so we capture inflows that don't sit on a
    # tracked category (YNAB's "Inflow: Ready to Assign").
    # ---------------------------------------------------------------------
    # ``transfer_account_id IS NULL`` excludes cross-account transfers
    # (moving money between your own accounts shows up as both a positive
    # and a negative transaction; counting the positive side as income
    # inflates the total). Real inflows from external payers don't have
    # a transfer_account_id.
    income_row = db.fetch_one(
        """
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM ynab_transactions
        WHERE budget_id = :budget_id
          AND posted_date >= :start
          AND posted_date <= :end
          AND amount > 0
          AND transfer_account_id IS NULL
        """,
        {
            "budget_id": budget_id,
            "start": month_start,
            "end": today,
        },
    )
    income_milli = int(income_row["total"]) if income_row else 0
    income_total = _dollars(income_milli)
    net = (income_total - spent_total).quantize(_TWO_DP)

    # ---------------------------------------------------------------------
    # Top groups (sorted DESC; cap at 8 so the bar chart stays legible).
    # ---------------------------------------------------------------------
    top_groups = sorted(
        (
            MoneyCategoryGroupSpend(group_name=g, amount=v)
            for g, v in group_spend.items()
            if v > 0
        ),
        key=lambda g: g.amount,
        reverse=True,
    )[:8]

    # ---------------------------------------------------------------------
    # Daily pacing: cumulative outflow vs linear-budget expected spend.
    # ---------------------------------------------------------------------
    # Same transfer filter as above — transferring from chequing to a
    # credit card surfaces as a negative outflow on chequing, which
    # would inflate the pacing chart's cumulative spend even though
    # nothing actually left the user's pocket.
    pacing_rows: list[dict[str, Any]] = db.fetch_all(
        """
        SELECT posted_date AS d, COALESCE(SUM(-amount), 0) AS spent_milli
        FROM ynab_transactions
        WHERE budget_id = :budget_id
          AND posted_date >= :start
          AND posted_date <= :end
          AND amount < 0
          AND transfer_account_id IS NULL
        GROUP BY posted_date
        ORDER BY posted_date
        """,
        {
            "budget_id": budget_id,
            "start": month_start,
            "end": today,
        },
    )
    days_in_month = monthrange(today.year, today.month)[1]
    daily_budget = (
        spent_total + sum(  # noqa: RUF005 — explicit Decimal sum
            (Decimal("0.00") for _ in range(0)), Decimal("0.00")
        )
    )
    # Expected pacing line uses TOTAL assigned for the month (so the line
    # represents "budget spent if I paced linearly across the month")
    # rather than current actual.
    total_assigned = sum(
        (_dollars(r.get("assigned")) for r in visible),
        Decimal("0.00"),
    )
    per_day_expected = (
        (total_assigned / Decimal(days_in_month)).quantize(_TWO_DP)
        if days_in_month > 0
        else Decimal("0.00")
    )

    by_day: dict[int, Decimal] = {}
    for row in pacing_rows:
        d_val = row["d"]
        if isinstance(d_val, date):
            by_day[d_val.day] = _dollars(int(row["spent_milli"]))
    pacing: list[MoneyPacingPoint] = []
    running = Decimal("0.00")
    for day in range(1, today.day + 1):
        running = (running + by_day.get(day, Decimal("0.00"))).quantize(
            _TWO_DP
        )
        pacing.append(
            MoneyPacingPoint(
                day=day,
                cumulative=running,
                expected=(per_day_expected * Decimal(day)).quantize(_TWO_DP),
            )
        )
    # Mirror the daily_budget unused-name flake; keep symbol around to satisfy
    # readers expecting it but don't double-count it in totals.
    _ = daily_budget

    # ---------------------------------------------------------------------
    # Trailing-3-month spend per group.
    # ---------------------------------------------------------------------
    m0 = month_start
    m1 = _months_back(month_start, 1)
    m2 = _months_back(month_start, 2)
    t3m_rows: list[dict[str, Any]] = db.fetch_all(
        """
        SELECT
            c.group_name AS group_name,
            mc.month AS month,
            SUM(GREATEST(-mc.activity, 0)) AS spent_milli
        FROM ynab_month_categories mc
        JOIN ynab_categories c ON c.category_id = mc.category_id
        WHERE mc.budget_id = :budget_id
          AND mc.month IN (:m2, :m1, :m0)
          AND COALESCE(c.hidden, FALSE) = FALSE
          AND c.group_name NOT IN (
              'Credit Card Payments',
              'Internal Master Category',
              'Hidden Categories'
          )
        GROUP BY c.group_name, mc.month
        """,
        {
            "budget_id": budget_id,
            "m0": m0,
            "m1": m1,
            "m2": m2,
        },
    )
    per_group: dict[str, dict[date, Decimal]] = {}
    for row in t3m_rows:
        g = str(row["group_name"])
        m = row["month"]
        per_group.setdefault(g, {})[m] = _dollars(int(row["spent_milli"]))
    trailing_3m: list[MoneyT3MGroupRow] = []
    # Include any group that shows up in any of the 3 months; sort by
    # this-month spend DESC so the chart reads top-down.
    for g in sorted(
        per_group,
        key=lambda g: per_group[g].get(m0, Decimal("0.00")),
        reverse=True,
    ):
        trailing_3m.append(
            MoneyT3MGroupRow(
                group_name=g,
                m_minus_2=per_group[g].get(m2, Decimal("0.00")),
                m_minus_1=per_group[g].get(m1, Decimal("0.00")),
                m_minus_0=per_group[g].get(m0, Decimal("0.00")),
            )
        )

    # ---------------------------------------------------------------------
    # Compose
    # ---------------------------------------------------------------------
    if last_synced_at is not None and isinstance(last_synced_at, datetime):
        if last_synced_at.tzinfo is None:
            last_synced_at = last_synced_at.replace(tzinfo=timezone.utc)
    elif last_synced_at is None:
        last_synced_at = None
    else:
        # Defensive — coerce stray ISO-string returns.
        last_synced_at = None

    return MoneyDashboardResponse(
        month=month_start,
        currency=currency,
        last_synced_at=last_synced_at,
        spent=spent_total.quantize(_TWO_DP),
        income=income_total.quantize(_TWO_DP),
        net=net,
        categories_over_budget_count=len(overages),
        overages=overages,
        top_groups=top_groups,
        pacing=pacing,
        trailing_3m=trailing_3m,
    )


# Suppress unused-import warning for timedelta — kept available since
# follow-up endpoints (e.g., week-over-week deltas) will want it.
_ = timedelta
