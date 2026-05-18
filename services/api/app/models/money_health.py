"""Pydantic models for ``GET /money/health``.

The Money dashboard's new shape is a stock + ratio view: net worth at
the top, four health KPIs below (savings ratio, debt-to-income,
liquidity in months, plus net worth as the anchor). Each ratio metric
carries its computed value, its target, and a status pip so the UI can
render score-card-style indicators with consistent colour.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel

HealthStatus = Literal["above", "at", "below", "unavailable"]


class KindAllocation(BaseModel):
    """One slice of the asset-allocation donut.

    ``kind`` matches the Helm account taxonomy: ``checking``,
    ``savings``, ``investing`` (funds + stocks rolled together for the
    chart's purpose — the per-account view in /accounts keeps them
    distinct).
    """

    kind: str
    label: str
    cad_amount: Decimal
    share_pct: Decimal


class MonthlyFlow(BaseModel):
    """One bar in the monthly inflow/outflow chart."""

    month: date  # first of month
    income_cad: Decimal
    expenses_cad: Decimal
    net_cad: Decimal


class NetWorthSnapshot(BaseModel):
    """One point on the 12-month net-worth trend line.

    Pulled from the ``net_worth_snapshots`` table; the writer fills it
    after every balance-changing operation (YNAB refresh, manual /
    investment account edits, tag PATCHes).
    """

    month: date
    net_worth_cad: Decimal
    personal_cad: Decimal
    business_cad: Decimal


AttentionSeverity = Literal["info", "warning"]


class AttentionItem(BaseModel):
    """A single row in the dashboard's "Needs attention" panel.

    Each item points the user at something actionable — a KPI below
    target, a stale manual balance, etc. ``severity`` drives the icon /
    accent colour on the dashboard.
    """

    severity: AttentionSeverity
    title: str
    detail: str
    # When the item came from a specific KPI, the ID lets the frontend
    # scroll-into-view the matching card. ``None`` for non-KPI items.
    kpi_id: str | None = None


class HealthMetric(BaseModel):
    """One health KPI: value vs target with a derived status.

    ``value`` is ``None`` when the metric can't be computed (e.g. no
    YNAB income data yet). The router supplies a one-line ``reason``
    so the UI can render an empty-state hint without the frontend
    having to know which inputs feed which KPI.
    """

    value: Decimal | None
    target: Decimal
    status: HealthStatus
    reason: str | None = None


class MoneyHealthResponse(BaseModel):
    """Payload for ``GET /money/health``."""

    # Anchor numbers — always populated, even when income data is missing.
    net_worth_cad: Decimal
    assets_cad: Decimal
    liabilities_cad: Decimal
    personal_net_worth_cad: Decimal
    business_net_worth_cad: Decimal

    # Trailing-12-month flows (CAD). ``None`` when YNAB isn't connected
    # or has no transactions yet.
    income_monthly_cad: Decimal | None
    expenses_monthly_cad: Decimal | None

    # The four ratio KPIs the dashboard renders. Net worth itself is
    # the anchor; the other three are below-target signals. Growth is
    # ``unavailable`` until there's a ~3-month-old snapshot to compare
    # against.
    savings_ratio: HealthMetric
    debt_to_income: HealthMetric
    liquidity_months: HealthMetric
    net_worth_growth: HealthMetric

    # Freshness — surfaces "Last YNAB sync …" on the dashboard.
    last_ynab_sync_at: datetime | None
    computed_at: datetime

    # Chart data — derived from the same inputs as the KPIs above so the
    # frontend can render visuals without a second round-trip.
    allocation: list[KindAllocation] = []
    monthly_flows: list[MonthlyFlow] = []
    net_worth_trend: list[NetWorthSnapshot] = []

    # Actionable items the dashboard surfaces in a "Needs attention"
    # panel — below-target KPIs, stale manual balances, etc.
    attention: list[AttentionItem] = []

    # Soft warnings the UI shows as banner / footnote. Stale FX, very
    # old manual balances, etc.
    warnings: list[str] = []
