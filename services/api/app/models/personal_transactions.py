"""Pydantic models for the ``personal_transactions`` table."""

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class PersonalTransactionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    account_id: UUID
    import_id: UUID | None = None
    posted_date: date
    description: str
    amount: Decimal
    balance: Decimal | None = None
    category: str | None = None
    external_id: str | None = None
    created_at: datetime


class PersonalTransactionUpdate(BaseModel):
    """User edits — for now only ``category``. Description/amount are
    treated as authoritative-from-source; rewriting them would defeat
    the dedup invariant."""

    category: str | None = None
