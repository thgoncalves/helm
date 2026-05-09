"""Pydantic models for the ``invoice_tax_links`` junction table.

Mirrors the Drizzle schema in ``db/schema/invoice-tax-links.ts``.

This is a many-to-many join table between ``invoices`` and ``tax_payments``.
It has a ``created_at`` timestamp but no ``updated_at`` (junction rows are
not updated in place; they are deleted and re-created).
"""

from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class InvoiceTaxLinkBase(BaseModel):
    """Shared data fields for an invoice-tax-payment link (no id or created_at).

    Attributes:
        invoice_id: UUID of the linked invoice.
        tax_payment_id: UUID of the linked tax payment.
        tax_id: UUID of the associated tax ledger entry. Optional (soft link).
        gst_amount: GST amount attributed to this invoice for this tax payment.
    """

    invoice_id: UUID
    tax_payment_id: UUID
    tax_id: UUID | None = None
    gst_amount: Decimal


class InvoiceTaxLinkCreate(InvoiceTaxLinkBase):
    """Request body for creating a new invoice-tax-payment link.

    Inherits all fields from :class:`InvoiceTaxLinkBase`.
    """


class InvoiceTaxLinkRead(InvoiceTaxLinkBase):
    """Response model for reading an invoice-tax-payment link.

    Extends :class:`InvoiceTaxLinkBase` with server-generated fields.

    Note: this table has ``created_at`` but no ``updated_at``.

    Attributes:
        id: Primary key UUID.
        created_at: Timestamp when the link was created (UTC).
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime


class InvoiceTaxLinkUpdate(BaseModel):
    """Request body for partially updating an invoice-tax-payment link (PATCH).

    All fields are optional so the caller only sends what changed.
    """

    invoice_id: UUID | None = None
    tax_payment_id: UUID | None = None
    tax_id: UUID | None = None
    gst_amount: Decimal | None = None
