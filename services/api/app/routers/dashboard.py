"""FastAPI router for the ``/business/dashboard`` endpoint.

V1 dashboard returns every section the landing page needs in a single
response so the frontend renders without staggered loading states.

The charts are *cash-basis*: money is recognised on the date it was
actually received (``payments_received.payment_date``), not the date the
invoice was issued. The KPI cards still carry an invoice-basis "FY
Invoiced"/"Invoices" figure, and aging is still measured from the issue
date — both are about billing, not cash in.

Sections:

* ``kpis``                 — FY invoiced/received/outstanding/count + GST
                             collected/owed + transfers FY + tax exposure.
                             Each KPI carries a *same-point-last-FY*
                             comparison (NOT a full-FY-vs-full-FY one)
                             because the current FY isn't over.
* ``monthly_revenue``      — 12 points (Apr→Mar) of cash received, with a
                             per-client breakdown for the stacked bar chart.
* ``top_clients``          — top 5 clients in the current FY by cash received.
* ``cash_flow``            — 12 points (Apr→Mar) of cash received per month.
* ``quarterly``            — 4 points (Q1→Q4) of cash received this FY.
* ``by_fiscal_year``       — all-time cash received, grouped by FY label.
* ``aging``                — outstanding invoices bucketed 0-30 / 31-60
                             / 61-90 / 90+ days since issue.

Implementation note: aggregation is done in Python from a small number
of raw SELECTs. The dataset is tiny (a few hundred rows max even at
V1's largest), so this trades raw speed for testability — the fake DB
in tests doesn't have to emulate GROUP BY across half a dozen joins.
"""

import asyncio
from calendar import monthrange
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app import db
from app.deps import get_current_user

router = APIRouter(tags=["dashboard"], dependencies=[Depends(get_current_user)])


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------


class KPI(BaseModel):
    """A single dashboard KPI.

    ``prev_value`` is the same metric measured at the equivalent point in
    the previous fiscal year (today - 1 year, then clipped to that FY's
    bounds) so the comparison stays apples-to-apples when the current
    FY isn't over.

    ``delta_pct`` is ``100 * (value - prev_value) / prev_value``,
    rounded to one decimal place. ``None`` when prev_value is zero or
    null (avoids div-by-zero and meaningless ∞% deltas).
    """

    value: Decimal
    prev_value: Decimal | None = None
    delta_pct: Decimal | None = None
    detail: str | None = None


class DashboardKPIs(BaseModel):
    fy_invoiced: KPI
    fy_received: KPI
    outstanding: KPI
    invoice_count: KPI
    gst_collected: KPI
    gst_owed: KPI
    transfers_fy: KPI
    tax_exposure: KPI


class ClientSliceAmount(BaseModel):
    """One client's slice of a single month's revenue."""

    client_id: UUID
    client_name: str
    amount: Decimal


class MonthlyRevenuePoint(BaseModel):
    month: str  # "Apr", "May", ...
    total: Decimal
    by_client: list[ClientSliceAmount]


class TopClient(BaseModel):
    client_id: UUID
    client_name: str
    total: Decimal


class CashFlowPoint(BaseModel):
    month: str
    received: Decimal


class QuarterlyPoint(BaseModel):
    quarter: str
    received: Decimal


class FYIncomePoint(BaseModel):
    fy_label: str  # "2024/25"
    received: Decimal


class AgingBucket(BaseModel):
    label: str
    count: int
    amount: Decimal


class DashboardResponse(BaseModel):
    fy_start: date
    fy_end: date
    today: date
    kpis: DashboardKPIs
    monthly_revenue: list[MonthlyRevenuePoint]
    top_clients: list[TopClient]
    cash_flow: list[CashFlowPoint]
    quarterly: list[QuarterlyPoint]
    by_fiscal_year: list[FYIncomePoint]
    aging: list[AgingBucket]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


_MONTHS = (
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
    "Jan",
    "Feb",
    "Mar",
)
_QUARTERS = ("Q1", "Q2", "Q3", "Q4")


def _fiscal_year_for(d: date) -> int:
    """Year in which the fiscal year containing ``d`` begins (April-start)."""
    return d.year - 1 if d.month < 4 else d.year


def _fy_bounds(fy_start_year: int) -> tuple[date, date]:
    return date(fy_start_year, 4, 1), date(fy_start_year + 1, 3, 31)


def _fy_label(fy_start_year: int) -> str:
    """Render a fiscal year as ``2024/25``."""
    end_short = str(fy_start_year + 1)[-2:]
    return f"{fy_start_year}/{end_short}"


def _fy_month_index(d: date) -> int:
    """Returns 0..11 for Apr..Mar within a fiscal year."""
    return (d.month - 4) % 12


def _fy_quarter_index(d: date) -> int:
    """Returns 0..3 for Q1..Q4 within a fiscal year."""
    return _fy_month_index(d) // 3


def _quantize(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.01"))


def _delta_pct(value: Decimal, prev: Decimal | None) -> Decimal | None:
    """Percent change, one decimal place. ``None`` if prev is zero/null."""
    if prev is None or prev == 0:
        return None
    return ((value - prev) / prev * Decimal(100)).quantize(Decimal("0.1"))


def _kpi(
    value: Decimal,
    *,
    prev: Decimal | None = None,
    detail: str | None = None,
) -> KPI:
    return KPI(
        value=_quantize(value),
        prev_value=_quantize(prev) if prev is not None else None,
        delta_pct=_delta_pct(value, prev),
        detail=detail,
    )


def _shift_one_year(d: date) -> date:
    """Same-day-of-year a year earlier. Handles Feb 29 → Feb 28."""
    try:
        return d.replace(year=d.year - 1)
    except ValueError:
        return d.replace(year=d.year - 1, day=28)


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@router.get(
    "/",
    response_model=DashboardResponse,
    summary="Aggregated dashboard payload — KPIs, charts, aging",
)
async def get_dashboard() -> DashboardResponse:
    today = date.today()
    fy_start_year = _fiscal_year_for(today)
    fy_start, fy_end = _fy_bounds(fy_start_year)
    prev_fy_start, prev_fy_end = _fy_bounds(fy_start_year - 1)
    prev_fy_today = _shift_one_year(today)

    # ---- Pull raw data (in parallel) -------------------------------------
    # All of this is small (V1 = ~100 invoices, ~100 payments, ~10
    # transfers). The bottleneck is round-trip latency to the RDS Data
    # API — ~100-200ms per call on a warm Lambda, and Aurora can be
    # auto-paused on the first request after idle, adding 10-20s of
    # resume latency to whichever query goes first.
    #
    # ``db.fetch_all`` is a blocking boto3 call, so ``asyncio.to_thread``
    # runs each on the default thread pool and ``gather`` lets them
    # overlap. On a warm Aurora this drops the dashboard wall time from
    # ~5×roundtrip to ~1×roundtrip.
    (
        invoices,
        payments,
        transfers,
        clients,
        tax_links,
    ) = await asyncio.gather(
        asyncio.to_thread(db.fetch_all, "SELECT * FROM invoices"),
        asyncio.to_thread(db.fetch_all, "SELECT * FROM payments_received"),
        asyncio.to_thread(db.fetch_all, "SELECT * FROM transfers"),
        asyncio.to_thread(db.fetch_all, "SELECT id, name FROM clients"),
        asyncio.to_thread(
            db.fetch_all, "SELECT invoice_id FROM invoice_tax_links"
        ),
    )

    client_name_by_id: dict[UUID, str] = {c["id"]: c["name"] for c in clients}
    linked_invoice_ids: set[UUID] = {l["invoice_id"] for l in tax_links}
    # Cash-basis charts attribute a payment to the client of the invoice it
    # pays, so we need invoice_id → client_id alongside the name lookup.
    client_id_by_invoice: dict[UUID, UUID] = {
        inv["id"]: inv["client_id"] for inv in invoices
    }

    # ---- KPIs -------------------------------------------------------------
    def sum_invoices_in(start: date, end: date) -> Decimal:
        return sum(
            (
                inv["total"]
                for inv in invoices
                if isinstance(inv["total"], Decimal)
                and start <= inv["issue_date"] <= end
            ),
            Decimal(0),
        )

    def sum_invoice_tax_in(start: date, end: date) -> Decimal:
        return sum(
            (
                inv["tax_amount"]
                for inv in invoices
                if isinstance(inv["tax_amount"], Decimal)
                and start <= inv["issue_date"] <= end
            ),
            Decimal(0),
        )

    def count_invoices_in(start: date, end: date) -> int:
        return sum(
            1 for inv in invoices if start <= inv["issue_date"] <= end
        )

    def sum_payments_in(start: date, end: date) -> Decimal:
        return sum(
            (
                p["amount"]
                for p in payments
                if isinstance(p["amount"], Decimal)
                and start <= p["payment_date"] <= end
            ),
            Decimal(0),
        )

    def sum_transfers_in(start: date, end: date) -> Decimal:
        return sum(
            (
                t["amount"]
                for t in transfers
                if isinstance(t["amount"], Decimal)
                and start <= t["transfer_date"] <= end
            ),
            Decimal(0),
        )

    def sum_tax_exposure_in(start: date, end: date) -> Decimal:
        total = Decimal(0)
        for t in transfers:
            if not (start <= t["transfer_date"] <= end):
                continue
            for key in ("estimated_tax_company", "estimated_tax_personal"):
                v = t.get(key)
                if isinstance(v, Decimal):
                    total += v
        return total

    fy_invoiced = sum_invoices_in(fy_start, fy_end)
    fy_received = sum_payments_in(fy_start, fy_end)
    fy_invoice_count = count_invoices_in(fy_start, fy_end)
    fy_gst_collected = sum_invoice_tax_in(fy_start, fy_end)
    fy_transfers = sum_transfers_in(fy_start, fy_end)
    fy_tax_exposure = sum_tax_exposure_in(fy_start, fy_end)

    # Same-point-last-FY: clip "today shifted back a year" to the prev FY
    # bounds (handles the FY boundary edge case in March).
    prev_clip = max(prev_fy_start, min(prev_fy_today, prev_fy_end))
    prev_fy_invoiced = sum_invoices_in(prev_fy_start, prev_clip)
    prev_fy_received = sum_payments_in(prev_fy_start, prev_clip)
    prev_fy_invoice_count = Decimal(count_invoices_in(prev_fy_start, prev_clip))
    prev_fy_transfers = sum_transfers_in(prev_fy_start, prev_clip)

    # Outstanding = invoices that have been sent or drafted but not paid,
    # at any point in time (not FY-bounded). Same definition the Invoices
    # page uses in its "Sent" + "Overdue" cards.
    outstanding_amount = Decimal(0)
    outstanding_count = 0
    for inv in invoices:
        if inv["status"] == "paid":
            continue
        if inv["status"] not in ("sent", "draft"):
            continue
        if isinstance(inv["total"], Decimal):
            outstanding_amount += inv["total"]
            outstanding_count += 1

    # GST Owed = invoice.tax_amount for invoices NOT yet linked to a
    # tax payment. Matches the Taxes landing page KPI.
    gst_owed = Decimal(0)
    for inv in invoices:
        if not isinstance(inv["tax_amount"], Decimal):
            continue
        if inv["tax_amount"] <= 0:
            continue
        if inv["id"] in linked_invoice_ids:
            continue
        gst_owed += inv["tax_amount"]

    kpis = DashboardKPIs(
        fy_invoiced=_kpi(fy_invoiced, prev=prev_fy_invoiced),
        fy_received=_kpi(fy_received, prev=prev_fy_received),
        outstanding=_kpi(
            outstanding_amount,
            detail=(
                f"{outstanding_count} invoice"
                f"{'' if outstanding_count == 1 else 's'}"
            ),
        ),
        invoice_count=_kpi(
            Decimal(fy_invoice_count),
            prev=prev_fy_invoice_count,
            detail="this FY",
        ),
        gst_collected=_kpi(fy_gst_collected, detail="this FY"),
        gst_owed=_kpi(gst_owed),
        transfers_fy=_kpi(fy_transfers, prev=prev_fy_transfers),
        tax_exposure=_kpi(fy_tax_exposure, detail="this FY"),
    )

    # ---- Monthly revenue (cash received, stacked by client) ---------------
    # Build a (month_idx, client_id) → amount accumulator for the current FY,
    # keyed off when each payment landed and the client of the invoice it pays.
    monthly_by_client: dict[tuple[int, UUID], Decimal] = {}
    monthly_totals: list[Decimal] = [Decimal(0)] * 12
    for p in payments:
        if not (fy_start <= p["payment_date"] <= fy_end):
            continue
        if not isinstance(p["amount"], Decimal):
            continue
        cid = client_id_by_invoice.get(p["invoice_id"])
        if cid is None:
            continue
        m_idx = _fy_month_index(p["payment_date"])
        key = (m_idx, cid)
        monthly_by_client[key] = (
            monthly_by_client.get(key, Decimal(0)) + p["amount"]
        )
        monthly_totals[m_idx] += p["amount"]

    monthly_revenue: list[MonthlyRevenuePoint] = []
    for m_idx, month_label in enumerate(_MONTHS):
        slices = [
            ClientSliceAmount(
                client_id=cid,
                client_name=client_name_by_id.get(cid, "Unknown"),
                amount=_quantize(amount),
            )
            for (m, cid), amount in monthly_by_client.items()
            if m == m_idx
        ]
        slices.sort(key=lambda s: s.amount, reverse=True)
        monthly_revenue.append(
            MonthlyRevenuePoint(
                month=month_label,
                total=_quantize(monthly_totals[m_idx]),
                by_client=slices,
            )
        )

    # ---- Top clients (FY, by cash received) ------------------------------
    client_totals: dict[UUID, Decimal] = {}
    for p in payments:
        if not (fy_start <= p["payment_date"] <= fy_end):
            continue
        if not isinstance(p["amount"], Decimal):
            continue
        cid = client_id_by_invoice.get(p["invoice_id"])
        if cid is None:
            continue
        client_totals[cid] = client_totals.get(cid, Decimal(0)) + p["amount"]
    top_clients = [
        TopClient(
            client_id=cid,
            client_name=client_name_by_id.get(cid, "Unknown"),
            total=_quantize(total),
        )
        for cid, total in sorted(
            client_totals.items(), key=lambda kv: kv[1], reverse=True
        )[:5]
    ]

    # ---- Cash flow (cash received per month, FY) -------------------------
    received_per_month = [Decimal(0)] * 12
    for p in payments:
        if fy_start <= p["payment_date"] <= fy_end and isinstance(
            p["amount"], Decimal
        ):
            received_per_month[_fy_month_index(p["payment_date"])] += p["amount"]
    cash_flow = [
        CashFlowPoint(
            month=_MONTHS[i],
            received=_quantize(received_per_month[i]),
        )
        for i in range(12)
    ]

    # ---- Quarterly (FY, cash received) -----------------------------------
    q_received = [Decimal(0)] * 4
    for p in payments:
        if fy_start <= p["payment_date"] <= fy_end and isinstance(
            p["amount"], Decimal
        ):
            q_received[_fy_quarter_index(p["payment_date"])] += p["amount"]
    quarterly = [
        QuarterlyPoint(
            quarter=_QUARTERS[i],
            received=_quantize(q_received[i]),
        )
        for i in range(4)
    ]

    # ---- By fiscal year (all-time cash received) -------------------------
    fy_received_map: dict[int, Decimal] = {}
    for p in payments:
        if not isinstance(p["amount"], Decimal):
            continue
        y = _fiscal_year_for(p["payment_date"])
        fy_received_map[y] = fy_received_map.get(y, Decimal(0)) + p["amount"]
    by_fiscal_year = [
        FYIncomePoint(
            fy_label=_fy_label(y),
            received=_quantize(fy_received_map[y]),
        )
        for y in sorted(fy_received_map)
    ]

    # ---- Aging buckets ---------------------------------------------------
    buckets = [
        ("0-30", 0, 30),
        ("31-60", 31, 60),
        ("61-90", 61, 90),
        ("90+", 91, 10_000),
    ]
    aging_counts = {label: 0 for label, _, _ in buckets}
    aging_amounts = {label: Decimal(0) for label, _, _ in buckets}
    for inv in invoices:
        if inv["status"] not in ("sent", "draft"):
            continue
        if not isinstance(inv["total"], Decimal):
            continue
        days = (today - inv["issue_date"]).days
        for label, lo, hi in buckets:
            if lo <= days <= hi:
                aging_counts[label] += 1
                aging_amounts[label] += inv["total"]
                break

    aging = [
        AgingBucket(
            label=label,
            count=aging_counts[label],
            amount=_quantize(aging_amounts[label]),
        )
        for label, _, _ in buckets
    ]

    return DashboardResponse(
        fy_start=fy_start,
        fy_end=fy_end,
        today=today,
        kpis=kpis,
        monthly_revenue=monthly_revenue,
        top_clients=top_clients,
        cash_flow=cash_flow,
        quarterly=quarterly,
        by_fiscal_year=by_fiscal_year,
        aging=aging,
    )
