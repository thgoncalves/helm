"""Pydantic models for the Money module / YNAB integration.

These shapes are the contract between the FastAPI layer and the
frontend's ``apps/web/src/types/api.ts``. Keep both in sync.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


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
    accounts_upserted: int = 0
    categories_upserted: int
    month_rows_upserted: int
    transactions_upserted: int
    updated_at: datetime


