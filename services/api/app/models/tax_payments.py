"""Pydantic models for the ``tax_payments`` table.

Mirrors the Drizzle schema in ``db/schema/tax-payments.ts``.
"""

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class TaxPaymentBase(BaseModel):
    """Shared data fields for a tax payment (no id or timestamps).

    Attributes:
        tax_id: UUID of the associated tax ledger entry. Optional (soft link).
        payment_date: Date the payment was made.
        amount: Amount paid.
        payment_method: How the payment was made. Optional.
        payment_reference: External reference for the payment. Optional.
        fiscal_year: Fiscal year this payment belongs to (e.g. ``"2024"``).
            Optional.
        notes: Free-form notes. Optional.
    """

    tax_id: UUID | None = None
    payment_date: date
    amount: Decimal
    payment_method: str | None = None
    payment_reference: str | None = None
    fiscal_year: str | None = None
    notes: str | None = None


class TaxPaymentCreate(TaxPaymentBase):
    """Request body for creating a new tax payment.

    Inherits all fields from :class:`TaxPaymentBase`.
    """


class TaxPaymentRead(TaxPaymentBase):
    """Response model for reading a tax payment.

    Extends :class:`TaxPaymentBase` with server-generated fields.

    Attributes:
        id: Primary key UUID.
        created_at: Timestamp when the record was created (UTC).
        updated_at: Timestamp when the record was last updated (UTC).
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime
    updated_at: datetime


class TaxPaymentUpdate(BaseModel):
    """Request body for partially updating a tax payment (PATCH).

    All fields are optional so the caller only sends what changed.
    """

    tax_id: UUID | None = None
    payment_date: date | None = None
    amount: Decimal | None = None
    payment_method: str | None = None
    payment_reference: str | None = None
    fiscal_year: str | None = None
    notes: str | None = None
