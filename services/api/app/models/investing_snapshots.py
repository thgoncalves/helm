"""Pydantic models for Investing Dashboard position snapshots.

A snapshot is the per-source position state on a specific date —
manual investing funds (XP, Santander, …) and one aggregate row for
all stock holdings. See ``docs/specs/investing-dashboard-snapshots-v1.md``
for the data flow.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict


SourceKind = Literal["manual_fund", "ynab_fund", "stocks"]


class SnapshotRow(BaseModel):
    """One row of a snapshot — one source on one date."""

    model_config = ConfigDict(from_attributes=True)

    snapshot_date: date
    source_kind: SourceKind
    # Text so it can hold either a manual-account UUID or a YNAB string
    # id; NULL for the stocks aggregate.
    source_id: str | None
    label: str
    native_currency: str
    native_amount: Decimal
    cad_amount: Decimal
    fx_rate: Decimal
    created_at: datetime | None = None


class SnapshotDay(BaseModel):
    """All sources captured on a single date."""

    snapshot_date: date
    rows: list[SnapshotRow]
    total_cad: Decimal


class SnapshotHistoryItem(BaseModel):
    """One point on the dashboard chart.

    ``by_source`` is keyed by label so the chart can stack-by-source
    without a second round-trip.
    """

    snapshot_date: date
    total_cad: Decimal
    by_source: dict[str, Decimal]
