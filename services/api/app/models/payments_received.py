"""Pydantic models for the ``payments_received`` table.

Mirrors the Drizzle schema in ``db/schema/payments-received.ts``.
"""

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class PaymentReceivedBase(BaseModel):
    """Shared data fields for a received payment (no id or timestamps).

    Attributes:
        invoice_id: UUID of the invoice this payment is for.
        payment_date: Date the payment was received.
        amount: Amount received.
        payment_method: How the payment was made (e.g. ``"EFT"``). Optional.
        reference: External reference number (e.g. bank transaction ID).
            Optional.
        notes: Free-form notes. Optional.
        deduction_amount: Any amount deducted (e.g. bank fees).
            Defaults to ``Decimal("0")``.
        deduction_description: Description of the deduction. Optional.
    """

    invoice_id: UUID
    payment_date: date
    amount: Decimal
    payment_method: str | None = None
    reference: str | None = None
    notes: str | None = None
    deduction_amount: Decimal = Decimal("0")
    deduction_description: str | None = None


class PaymentReceivedCreate(PaymentReceivedBase):
    """Request body for recording a new received payment.

    Inherits all fields from :class:`PaymentReceivedBase`.
    """


class PaymentReceivedRead(PaymentReceivedBase):
    """Response model for reading a received payment.

    Extends :class:`PaymentReceivedBase` with server-generated fields.

    Attributes:
        id: Primary key UUID.
        created_at: Timestamp when the record was created (UTC).
        updated_at: Timestamp when the record was last updated (UTC).
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime
    updated_at: datetime


class PaymentReceivedUpdate(BaseModel):
    """Request body for partially updating a received payment (PATCH).

    All fields are optional so the caller only sends what changed.
    """

    invoice_id: UUID | None = None
    payment_date: date | None = None
    amount: Decimal | None = None
    payment_method: str | None = None
    reference: str | None = None
    notes: str | None = None
    deduction_amount: Decimal | None = None
    deduction_description: str | None = None
