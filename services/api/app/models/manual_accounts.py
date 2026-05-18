"""Pydantic models for manual cash accounts.

Manual accounts are the third source feeding the unified Accounts page —
non-YNAB, non-investment cash positions (Brazilian checking, anything
else the user wants to track without wiring into YNAB).

Balances are stored at native precision (numeric(15, 2)). Currency is
ISO 4217. ``balance_as_of`` is bumped automatically by the router when
the balance changes; the API doesn't accept it directly.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

ManualAccountKind = Literal[
    "checking", "savings", "credit_card", "line_of_credit"
]
ManualAccountOwner = Literal["personal", "business"]


class ManualAccountCreate(BaseModel):
    """Body for ``POST /accounts/manual``."""

    name: str = Field(min_length=1)
    bank: str | None = None
    currency: str = Field(default="BRL", min_length=3, max_length=3)
    balance: Decimal = Decimal("0")
    kind: ManualAccountKind
    owner: ManualAccountOwner
    notes: str | None = None
    is_active: bool = True


class ManualAccountUpdate(BaseModel):
    """Body for ``PATCH /accounts/manual/{id}``. All fields optional."""

    name: str | None = Field(default=None, min_length=1)
    bank: str | None = None
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    balance: Decimal | None = None
    kind: ManualAccountKind | None = None
    owner: ManualAccountOwner | None = None
    notes: str | None = None
    is_active: bool | None = None


class ManualAccountRead(BaseModel):
    """Response shape for manual account rows."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    id: UUID
    name: str
    bank: str | None = None
    currency: str
    balance: Decimal
    balance_as_of: date
    kind: str
    owner: str
    notes: str | None = None
    is_active: bool
    created_at: datetime
    updated_at: datetime
