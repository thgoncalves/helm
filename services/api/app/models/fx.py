"""Pydantic models for FX rate surfaces."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel


class FxQuote(BaseModel):
    """A currency-pair rate with its short-term direction.

    ``rate`` is units of the second currency per 1 of the first
    (``"CAD/BRL"`` → BRL per 1 CAD). ``direction`` compares ``rate`` to
    the previous available rate: ``"up"`` means the first currency
    strengthened. ``prev_rate``/``change``/``direction`` are ``None``
    until at least two dated rates are cached.
    """

    pair: str
    rate: Decimal
    prev_rate: Decimal | None = None
    change: Decimal | None = None
    change_pct: Decimal | None = None
    direction: Literal["up", "down", "flat"] | None = None
    as_of: date
