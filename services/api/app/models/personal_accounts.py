"""Pydantic models for the ``personal_accounts`` table.

Mirrors the Drizzle schema in ``db/schema/accounts.ts``.
"""

from datetime import datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


# Locked V1 vocabularies. Frontend dropdowns mirror these; adding a new
# institution means writing a parser at the same time, so this list is
# intentionally small.
Institution = Literal["RBC", "TD", "Scotia", "Other"]
AccountType = Literal["checking", "savings", "credit_card", "cash"]


class PersonalAccountBase(BaseModel):
    name: str
    institution: Institution = "Other"
    account_type: AccountType = "checking"
    currency: str = "CAD"
    opening_balance: Decimal | None = Decimal("0")
    is_active: bool = True
    notes: str | None = None


class PersonalAccountCreate(PersonalAccountBase):
    pass


class PersonalAccountRead(PersonalAccountBase):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime
    updated_at: datetime


class PersonalAccountUpdate(BaseModel):
    name: str | None = None
    institution: Institution | None = None
    account_type: AccountType | None = None
    currency: str | None = None
    opening_balance: Decimal | None = None
    is_active: bool | None = None
    notes: str | None = None
