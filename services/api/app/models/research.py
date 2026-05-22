"""Pydantic models for the Research surface.

One row per ticker in the curated universe, joined with the latest
cached quote and the user's aggregated position. See
``docs/specs/investments-research-v1.md``.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel


Country = Literal["US", "CA"]


class ResearchRow(BaseModel):
    ticker: str
    name: str
    sector: str
    industry: str | None = None
    country: Country

    # Quote-side fields — null when no quote has been cached yet.
    last_price: Decimal | None = None
    currency: str | None = None
    previous_close: Decimal | None = None
    fetched_at: datetime | None = None
    day_change_pct: Decimal | None = None

    # Position-side fields. ``position_shares`` is "0" when the user
    # holds nothing in this ticker; the ``*_value_*`` fields stay None
    # when there's no position OR no quote to value it with.
    position_shares: Decimal = Decimal(0)
    position_currency: str | None = None
    position_value_native: Decimal | None = None
    position_value_cad: Decimal | None = None
