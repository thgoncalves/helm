"""Pydantic models for the Money module / YNAB integration.

These shapes are the contract between the FastAPI layer and the
frontend's ``apps/web/src/types/api.ts``. Keep both in sync.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field


class YnabTokenPut(BaseModel):
    """Request body for ``PUT /money/integrations/ynab/token``."""

    token: str = Field(min_length=1)


class YnabStatusResponse(BaseModel):
    """Response for ``GET /money/integrations/ynab/status``.

    Drives the Settings → YNAB section ("Connected"/"Not connected") and
    the Money dashboard's empty state.
    """

    token_configured: bool
    last_synced_at: datetime | None = None
    active_budget_name: str | None = None
    active_budget_id: str | None = None


class YnabRefreshResponse(BaseModel):
    """Response for ``POST /money/ynab/refresh``."""

    budget_id: str
    budget_name: str
    categories_upserted: int
    month_rows_upserted: int
    transactions_upserted: int
    updated_at: datetime


# ---------------------------------------------------------------------------
# Money dashboard payload
# ---------------------------------------------------------------------------


class MoneyCategoryOverage(BaseModel):
    """One row in the bill-over-budget widget."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    category_id: str
    category_name: str
    group_name: str
    assigned: Decimal
    activity: Decimal
    overage: Decimal
    percent_over: Decimal | None = None


class MoneyCategoryGroupSpend(BaseModel):
    """One bar in the top-categories chart."""

    group_name: str
    amount: Decimal


class MoneyT3MGroupRow(BaseModel):
    """One row of the trailing-3-month grouped-bar chart."""

    group_name: str
    m_minus_2: Decimal
    m_minus_1: Decimal
    m_minus_0: Decimal


class MoneyPacingPoint(BaseModel):
    """One day on the pacing chart."""

    day: int
    cumulative: Decimal
    expected: Decimal


class MoneyDashboardResponse(BaseModel):
    """Single-shot dashboard payload."""

    month: date
    currency: str
    last_synced_at: datetime | None = None
    spent: Decimal
    income: Decimal
    net: Decimal
    categories_over_budget_count: int
    overages: list[MoneyCategoryOverage]
    top_groups: list[MoneyCategoryGroupSpend]
    pacing: list[MoneyPacingPoint]
    trailing_3m: list[MoneyT3MGroupRow]
