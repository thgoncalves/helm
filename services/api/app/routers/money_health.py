"""FastAPI router for ``GET /money/health``.

Health-first dashboard payload. Reads:

* the unified accounts surface (``ynab_accounts`` + ``manual_accounts``
  + ``investment_accounts``) for current balances by kind/owner, and
* the cached YNAB transactions for trailing-12-month income/expenses.

CAD is the common base — YNAB amounts come from the local cache in
milliunits, non-CAD account balances are FX-converted via the
``fx_rates`` cache.

The four KPIs the dashboard renders:

* ``savings_ratio``   = (income − expenses) / income, trailing 12 mo
* ``debt_to_income``  = total lending / (income × 12)
* ``liquidity_months``= (checking + savings cash) / monthly expenses
* anchor: ``net_worth_cad`` (assets − liabilities)

Targets are the recommended defaults from
``docs/specs/money-dashboard-health-v1.md``. Phase 3 will make these
user-editable via Settings.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends

from app import db
from app.config import settings
from app.deps import get_current_user
from app.money.balances import (
    ASSET_KINDS,
    LIABILITY_KINDS,
    Balances,
    compute_balances,
)
from app.money.snapshots import fetch_trend
from app.models.money_health import (
    HealthMetric,
    HealthStatus,
    KindAllocation,
    MonthlyFlow,
    MoneyHealthResponse,
    NetWorthSnapshot,
)

router = APIRouter(tags=["money"], dependencies=[Depends(get_current_user)])

_MILLI = Decimal(1000)
_TWO_DP = Decimal("0.01")
_INCOME_WINDOW_DAYS = 365

# Default targets — Phase 3 will override these from Settings.
_TARGET_SAVINGS_PCT = Decimal("20")
_TARGET_DEBT_TO_INCOME_PCT = Decimal("30")
_TARGET_LIQUIDITY_MONTHS = Decimal("3")


def _db_configured() -> bool:
    return bool(
        settings.database_resource_arn and settings.database_secret_arn
    )


@router.get("/health", response_model=MoneyHealthResponse)
def get_health() -> MoneyHealthResponse:
    """Aggregate accounts + YNAB transactions into the health payload."""
    now = datetime.now(timezone.utc)
    warnings: list[str] = []

    if not _db_configured():
        # Local dev without Aurora wired — return all-zero / unavailable
        # so the frontend still renders the page instead of erroring.
        return _empty_response(
            now,
            ["Database not configured; numbers unavailable."],
        )

    # ---- Balances ---------------------------------------------------------
    balances = compute_balances()
    warnings.extend(balances.warnings)
    assets_cad = balances.assets_cad
    liabilities_cad = balances.liabilities_cad
    cash_cad = balances.cash_cad
    net_worth_cad = (assets_cad - liabilities_cad).quantize(_TWO_DP)
    personal_nw = (
        balances.personal_assets - balances.personal_liabilities
    ).quantize(_TWO_DP)
    business_nw = (
        balances.business_assets - balances.business_liabilities
    ).quantize(_TWO_DP)

    # ---- Flows (trailing 12 months) --------------------------------------
    flows = _ynab_flows(_INCOME_WINDOW_DAYS)
    income_monthly = flows["income_monthly_cad"]
    expenses_monthly = flows["expenses_monthly_cad"]
    last_sync = flows["last_synced_at"]

    if income_monthly is None:
        warnings.append(
            "No YNAB income data in the last 12 months; "
            "savings ratio and debt-to-income unavailable."
        )

    # ---- KPI assembly -----------------------------------------------------
    savings_ratio = _savings_ratio_metric(income_monthly, expenses_monthly)
    debt_to_income = _debt_to_income_metric(liabilities_cad, income_monthly)
    liquidity = _liquidity_metric(cash_cad, expenses_monthly)

    # ---- Chart data -------------------------------------------------------
    allocation = _allocation_slices(balances.by_kind, assets_cad)
    monthly_flows = _monthly_flows(12)
    trend = _net_worth_trend(12)
    growth = _net_worth_growth_metric(net_worth_cad, trend)

    return MoneyHealthResponse(
        net_worth_cad=net_worth_cad,
        assets_cad=assets_cad.quantize(_TWO_DP),
        liabilities_cad=liabilities_cad.quantize(_TWO_DP),
        personal_net_worth_cad=personal_nw,
        business_net_worth_cad=business_nw,
        income_monthly_cad=(
            income_monthly.quantize(_TWO_DP) if income_monthly else None
        ),
        expenses_monthly_cad=(
            expenses_monthly.quantize(_TWO_DP) if expenses_monthly else None
        ),
        savings_ratio=savings_ratio,
        debt_to_income=debt_to_income,
        liquidity_months=liquidity,
        net_worth_growth=growth,
        last_ynab_sync_at=last_sync,
        computed_at=now,
        allocation=allocation,
        monthly_flows=monthly_flows,
        net_worth_trend=trend,
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# YNAB flow aggregation
# ---------------------------------------------------------------------------


def _ynab_flows(window_days: int) -> dict[str, Any]:
    """Aggregate trailing-window income + expenses from the YNAB cache.

    Returns a dict with monthly income/expenses (CAD, Decimal) or
    ``None`` when the cache is empty. Transfers (rows with a non-null
    ``transfer_account_id``) are excluded so moving cash between
    accounts doesn't double-count as income + expense.
    """
    today = datetime.now(timezone.utc).date()
    since = today - timedelta(days=window_days)

    last_sync_row = db.fetch_one(
        "SELECT last_synced_at FROM ynab_budgets "
        "WHERE is_active = TRUE LIMIT 1"
    )
    last_sync = last_sync_row.get("last_synced_at") if last_sync_row else None

    totals = db.fetch_one(
        """
        SELECT
          COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS inflow,
          COALESCE(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0) AS outflow,
          COUNT(*) AS n
        FROM ynab_transactions
        WHERE transfer_account_id IS NULL
          AND posted_date >= :since
        """,
        {"since": since},
    )
    n = int((totals or {}).get("n") or 0)
    if n == 0:
        return {
            "income_monthly_cad": None,
            "expenses_monthly_cad": None,
            "last_synced_at": last_sync,
        }

    # Spec is "trailing 12 months" — treat the window as 12 months even
    # though the day-count comes in slightly over (365 / 30 ≠ 12). Keeps
    # ratios honest with how a user reads "monthly income."
    months = Decimal(12)
    inflow_dollars = (
        Decimal(int((totals or {}).get("inflow") or 0)) / _MILLI / months
    )
    # outflow is negative milliunits; flip to positive dollar burn rate.
    outflow_dollars = (
        -Decimal(int((totals or {}).get("outflow") or 0)) / _MILLI / months
    )
    return {
        "income_monthly_cad": inflow_dollars,
        "expenses_monthly_cad": outflow_dollars,
        "last_synced_at": last_sync,
    }


# ---------------------------------------------------------------------------
# KPI metric assembly
# ---------------------------------------------------------------------------


def _savings_ratio_metric(
    income: Decimal | None, expenses: Decimal | None
) -> HealthMetric:
    if not income or income == 0:
        return HealthMetric(
            value=None,
            target=_TARGET_SAVINGS_PCT,
            status="unavailable",
            reason="No YNAB income recorded in the last 12 months.",
        )
    saved = income - (expenses or Decimal("0"))
    pct = (saved / income * Decimal(100)).quantize(_TWO_DP)
    return HealthMetric(
        value=pct,
        target=_TARGET_SAVINGS_PCT,
        status=_status_higher_better(pct, _TARGET_SAVINGS_PCT),
    )


def _debt_to_income_metric(
    debt: Decimal, income_monthly: Decimal | None
) -> HealthMetric:
    if not income_monthly or income_monthly == 0:
        return HealthMetric(
            value=None,
            target=_TARGET_DEBT_TO_INCOME_PCT,
            status="unavailable",
            reason="Connect YNAB to compute annualised income.",
        )
    annual = income_monthly * Decimal(12)
    pct = (debt / annual * Decimal(100)).quantize(_TWO_DP)
    return HealthMetric(
        value=pct,
        target=_TARGET_DEBT_TO_INCOME_PCT,
        # Lower is better for debt-to-income.
        status=_status_lower_better(pct, _TARGET_DEBT_TO_INCOME_PCT),
    )


def _liquidity_metric(
    cash: Decimal, expenses_monthly: Decimal | None
) -> HealthMetric:
    if not expenses_monthly or expenses_monthly == 0:
        return HealthMetric(
            value=None,
            target=_TARGET_LIQUIDITY_MONTHS,
            status="unavailable",
            reason="Connect YNAB to estimate monthly expenses.",
        )
    months = (cash / expenses_monthly).quantize(_TWO_DP)
    return HealthMetric(
        value=months,
        target=_TARGET_LIQUIDITY_MONTHS,
        status=_status_higher_better(months, _TARGET_LIQUIDITY_MONTHS),
    )


def _allocation_slices(
    by_kind: dict[str, Decimal], total_assets: Decimal
) -> list[KindAllocation]:
    """Build asset-allocation slices for the donut chart.

    Funds + stocks collapse into one ``investing`` slice to keep the
    chart legible — the per-account drilldown on /accounts preserves
    the split. Liabilities are excluded (they live in the debts panel,
    not the assets donut).
    """
    investing_total = (
        by_kind.get("investing_fund", Decimal("0"))
        + by_kind.get("investing_stock", Decimal("0"))
    )
    raw: list[tuple[str, str, Decimal]] = [
        ("checking", "Checking", by_kind.get("checking", Decimal("0"))),
        ("savings", "Savings", by_kind.get("savings", Decimal("0"))),
        ("investing", "Investing", investing_total),
    ]
    out: list[KindAllocation] = []
    for kind, label, amount in raw:
        if amount <= 0:
            continue
        share = (
            (amount / total_assets * Decimal(100)).quantize(_TWO_DP)
            if total_assets > 0
            else Decimal("0.00")
        )
        out.append(
            KindAllocation(
                kind=kind,
                label=label,
                cad_amount=amount.quantize(_TWO_DP),
                share_pct=share,
            )
        )
    return out


def _monthly_flows(months: int) -> list[MonthlyFlow]:
    """Return per-month inflow/outflow/net for the trailing N months.

    Months that have zero rows in ``ynab_transactions`` still appear in
    the output as a (0, 0, 0) row so the chart doesn't get gappy.
    Transfers are excluded — same rule as the 12-month aggregate.
    """
    today = datetime.now(timezone.utc).date()
    # First of the month that's ``months − 1`` ago.
    start_year = today.year
    start_month = today.month - (months - 1)
    while start_month <= 0:
        start_month += 12
        start_year -= 1
    start = date(start_year, start_month, 1)

    rows = db.fetch_all(
        """
        SELECT
          date_trunc('month', posted_date)::date AS month,
          COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS inflow,
          COALESCE(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0) AS outflow
        FROM ynab_transactions
        WHERE transfer_account_id IS NULL
          AND posted_date >= :since
        GROUP BY 1
        ORDER BY 1
        """,
        {"since": start},
    )
    by_month: dict[date, dict[str, int]] = {}
    for r in rows:
        m = r["month"]
        if isinstance(m, datetime):
            m = m.date()
        by_month[m] = {
            "inflow": int(r.get("inflow") or 0),
            "outflow": int(r.get("outflow") or 0),
        }

    out: list[MonthlyFlow] = []
    year, month = start.year, start.month
    for _ in range(months):
        month_first = date(year, month, 1)
        agg = by_month.get(month_first, {"inflow": 0, "outflow": 0})
        income = (Decimal(agg["inflow"]) / _MILLI).quantize(_TWO_DP)
        # outflow comes back negative; flip to positive expense magnitude.
        expenses = (-Decimal(agg["outflow"]) / _MILLI).quantize(_TWO_DP)
        out.append(
            MonthlyFlow(
                month=month_first,
                income_cad=income,
                expenses_cad=expenses,
                net_cad=(income - expenses).quantize(_TWO_DP),
            )
        )
        month += 1
        if month > 12:
            month = 1
            year += 1
    return out


def _net_worth_trend(months: int) -> list[NetWorthSnapshot]:
    """Pull the most recent ``months`` snapshots from the table."""
    rows = fetch_trend(months)
    out: list[NetWorthSnapshot] = []
    for r in rows:
        assets = Decimal(r.get("assets_cad") or 0)
        liab = Decimal(r.get("liabilities_cad") or 0)
        out.append(
            NetWorthSnapshot(
                month=r["snapshot_month"],
                net_worth_cad=(assets - liab).quantize(_TWO_DP),
                personal_cad=Decimal(
                    r.get("personal_cad") or 0
                ).quantize(_TWO_DP),
                business_cad=Decimal(
                    r.get("business_cad") or 0
                ).quantize(_TWO_DP),
            )
        )
    return out


# Net-worth-growth KPI default target: 5% growth quarter-over-quarter.
# The spec doesn't lock a target — picking a mild positive default so
# the dashboard has something to colour against.
_TARGET_NET_WORTH_GROWTH_PCT = Decimal("5")


def _net_worth_growth_metric(
    current_net_worth: Decimal,
    trend: list[NetWorthSnapshot],
) -> HealthMetric:
    """3-month change in net worth, expressed as a percentage.

    Hidden (``unavailable``) when there aren't at least two snapshots
    in the trend window — we need history to know what changed.
    """
    if len(trend) < 2:
        return HealthMetric(
            value=None,
            target=_TARGET_NET_WORTH_GROWTH_PCT,
            status="unavailable",
            reason=(
                "Net worth growth needs at least one prior monthly "
                "snapshot. Come back next month."
            ),
        )

    # Aim for the snapshot ~3 months back; fall back to the oldest in
    # the window if there's less than three months of history.
    target_idx = max(0, len(trend) - 4)
    baseline = trend[target_idx].net_worth_cad
    if baseline == 0:
        return HealthMetric(
            value=None,
            target=_TARGET_NET_WORTH_GROWTH_PCT,
            status="unavailable",
            reason=(
                "Baseline net worth is zero; growth math is undefined."
            ),
        )
    pct = (
        (current_net_worth - baseline) / baseline * Decimal(100)
    ).quantize(_TWO_DP)
    return HealthMetric(
        value=pct,
        target=_TARGET_NET_WORTH_GROWTH_PCT,
        status=_status_higher_better(pct, _TARGET_NET_WORTH_GROWTH_PCT),
    )


def _status_higher_better(value: Decimal, target: Decimal) -> HealthStatus:
    if value >= target:
        return "above"
    if value >= target * Decimal("0.8"):
        return "at"
    return "below"


def _status_lower_better(value: Decimal, target: Decimal) -> HealthStatus:
    # For debt-to-income, "at" target is fine, below target is great.
    if value <= target:
        return "above"  # i.e. healthy
    if value <= target * Decimal("1.2"):
        return "at"
    return "below"


def _empty_response(
    now: datetime, warnings: list[str]
) -> MoneyHealthResponse:
    zero = Decimal("0.00")
    return MoneyHealthResponse(
        net_worth_cad=zero,
        assets_cad=zero,
        liabilities_cad=zero,
        personal_net_worth_cad=zero,
        business_net_worth_cad=zero,
        income_monthly_cad=None,
        expenses_monthly_cad=None,
        savings_ratio=HealthMetric(
            value=None,
            target=_TARGET_SAVINGS_PCT,
            status="unavailable",
            reason="Database unavailable.",
        ),
        debt_to_income=HealthMetric(
            value=None,
            target=_TARGET_DEBT_TO_INCOME_PCT,
            status="unavailable",
            reason="Database unavailable.",
        ),
        liquidity_months=HealthMetric(
            value=None,
            target=_TARGET_LIQUIDITY_MONTHS,
            status="unavailable",
            reason="Database unavailable.",
        ),
        net_worth_growth=HealthMetric(
            value=None,
            target=_TARGET_NET_WORTH_GROWTH_PCT,
            status="unavailable",
            reason="Database unavailable.",
        ),
        last_ynab_sync_at=None,
        computed_at=now,
        warnings=warnings,
    )
