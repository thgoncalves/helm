"""Pydantic models for the ``transfers`` table.

Mirrors the Drizzle schema in ``db/schema/transfers.ts``.

Transfers represent business-to-personal owner draws. They optionally link
to tax ledger entries for both the company-side and personal-side tax impact.
"""

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class TransferBase(BaseModel):
    """Shared data fields for a transfer (no id or timestamps).

    Attributes:
        transfer_date: Date the transfer was made.
        amount: Transfer amount.
        method: Payment method (e.g. ``"EFT"``). Max 50 chars. Optional.
        purpose: Description of the transfer's purpose. Optional.
        category: Classification category. Max 50 chars. Optional.
        estimated_tax_company: Estimated company-side tax impact. Optional.
        estimated_tax_personal: Estimated personal-side tax impact. Optional.
        actual_tax_paid_company: Actual company-side tax paid. Optional.
        actual_tax_paid_personal: Actual personal-side tax paid. Optional.
        tax_ledger_link_company: UUID of the company tax ledger entry.
            Soft link. Optional.
        tax_ledger_link_personal: UUID of the personal tax ledger entry.
            Soft link. Optional.
        notes: Free-form notes. Optional.
    """

    transfer_date: date
    amount: Decimal
    method: str | None = None
    purpose: str | None = None
    category: str | None = None
    estimated_tax_company: Decimal | None = None
    estimated_tax_personal: Decimal | None = None
    actual_tax_paid_company: Decimal | None = None
    actual_tax_paid_personal: Decimal | None = None
    tax_ledger_link_company: UUID | None = None
    tax_ledger_link_personal: UUID | None = None
    notes: str | None = None


class TransferCreate(TransferBase):
    """Request body for creating a new transfer.

    Inherits all fields from :class:`TransferBase`.
    """


class TransferRead(TransferBase):
    """Response model for reading a transfer.

    Extends :class:`TransferBase` with server-generated fields.

    Attributes:
        id: Primary key UUID.
        created_at: Timestamp when the record was created (UTC).
        updated_at: Timestamp when the record was last updated (UTC).
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime
    updated_at: datetime


class TransferUpdate(BaseModel):
    """Request body for partially updating a transfer (PATCH).

    All fields are optional so the caller only sends what changed.
    """

    transfer_date: date | None = None
    amount: Decimal | None = None
    method: str | None = None
    purpose: str | None = None
    category: str | None = None
    estimated_tax_company: Decimal | None = None
    estimated_tax_personal: Decimal | None = None
    actual_tax_paid_company: Decimal | None = None
    actual_tax_paid_personal: Decimal | None = None
    tax_ledger_link_company: UUID | None = None
    tax_ledger_link_personal: UUID | None = None
    notes: str | None = None
