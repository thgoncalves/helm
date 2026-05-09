"""Pydantic models for the ``tax_ledger`` table.

Mirrors the Drizzle schema in ``db/schema/tax-ledger.ts``.
"""

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class TaxLedgerBase(BaseModel):
    """Shared data fields for a tax ledger entry (no id or timestamps).

    Attributes:
        tax_type: Type of tax (e.g. ``"GST"``). Max 20 chars.
        tax_period: Human-readable period label (e.g. ``"2024-Q1"``).
        period_start: Start date of the tax period.
        period_end: End date of the tax period.
        tax_rate: Rate as a decimal (e.g. ``0.0500`` for 5%). Precision 6,4.
        taxable_amount: Total taxable revenue for the period.
        tax_amount: Total tax owed for the period.
        paid_status: Payment status (e.g. ``"unpaid"``, ``"paid"``).
            Defaults to ``"unpaid"``.
        paid_date: Date the tax was remitted. Optional.
        paid_amount: Amount actually paid. Optional, defaults to ``Decimal("0")``.
        payment_method: How the tax was paid. Optional.
        payment_reference: Reference number for the payment. Optional.
        notes: Free-form notes. Optional.
    """

    tax_type: str
    tax_period: str
    period_start: date
    period_end: date
    tax_rate: Decimal
    taxable_amount: Decimal
    tax_amount: Decimal
    paid_status: str = "unpaid"
    paid_date: date | None = None
    paid_amount: Decimal | None = Decimal("0")
    payment_method: str | None = None
    payment_reference: str | None = None
    notes: str | None = None


class TaxLedgerCreate(TaxLedgerBase):
    """Request body for creating a new tax ledger entry.

    Inherits all fields from :class:`TaxLedgerBase`.
    """


class TaxLedgerRead(TaxLedgerBase):
    """Response model for reading a tax ledger entry.

    Extends :class:`TaxLedgerBase` with server-generated fields.

    Attributes:
        id: Primary key UUID.
        created_at: Timestamp when the record was created (UTC).
        updated_at: Timestamp when the record was last updated (UTC).
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime
    updated_at: datetime


class TaxLedgerUpdate(BaseModel):
    """Request body for partially updating a tax ledger entry (PATCH).

    All fields are optional so the caller only sends what changed.
    """

    tax_type: str | None = None
    tax_period: str | None = None
    period_start: date | None = None
    period_end: date | None = None
    tax_rate: Decimal | None = None
    taxable_amount: Decimal | None = None
    tax_amount: Decimal | None = None
    paid_status: str | None = None
    paid_date: date | None = None
    paid_amount: Decimal | None = None
    payment_method: str | None = None
    payment_reference: str | None = None
    notes: str | None = None
