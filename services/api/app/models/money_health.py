"""Pydantic models for ``GET /money/health``.

The Money dashboard's new shape is a stock + ratio view: net worth at
the top, four health KPIs below (savings ratio, debt-to-income,
liquidity in months, plus net worth as the anchor). Each ratio metric
carries its computed value, its target, and a status pip so the UI can
render score-card-style indicators with consistent colour.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel

HealthStatus = Literal["above", "at", "below", "unavailable"]


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
    # the anchor; the other three are below-target signals.
    savings_ratio: HealthMetric
    debt_to_income: HealthMetric
    liquidity_months: HealthMetric

    # Freshness — surfaces "Last YNAB sync …" on the dashboard.
    last_ynab_sync_at: datetime | None
    computed_at: datetime

    # Soft warnings the UI shows as banner / footnote. Stale FX, very
    # old manual balances, etc.
    warnings: list[str] = []
