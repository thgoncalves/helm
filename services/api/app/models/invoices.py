"""Pydantic models for the ``invoices`` table.

Mirrors the Drizzle schema in ``db/schema/invoices.ts``.
"""

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class InvoiceBase(BaseModel):
    """Shared data fields for an invoice (no id or timestamps).

    Attributes:
        invoice_number: Human-readable invoice identifier (e.g. ``202203-001``).
            Must be unique across all invoices.
        issue_date: Date the invoice was issued.
        due_date: Payment due date. Optional.
        client_id: UUID of the associated client.
        status: Invoice workflow status (e.g. ``"draft"``, ``"sent"``,
            ``"paid"``). Defaults to ``"draft"``.
        currency: ISO 4217 currency code (e.g. ``"CAD"``). Defaults to
            ``"CAD"``.
        subtotal: Invoice subtotal before tax.
        tax_amount: Total tax on the invoice. Defaults to ``Decimal("0")``.
        total: Invoice total including tax.
        notes: Free-form notes. Optional.
        payment_terms: Payment terms text (e.g. ``"Net 30"``). Optional.
        attachments_path: S3 path to any attachments. Optional.
    """

    invoice_number: str
    issue_date: date
    due_date: date | None = None
    client_id: UUID
    status: str = "draft"
    currency: str = "CAD"
    subtotal: Decimal
    tax_amount: Decimal = Decimal("0")
    total: Decimal
    notes: str | None = None
    payment_terms: str | None = None
    attachments_path: str | None = None


class InvoiceCreate(InvoiceBase):
    """Request body for creating a new invoice.

    Inherits all fields from :class:`InvoiceBase`.
    """


class InvoiceRead(InvoiceBase):
    """Response model for reading an invoice.

    Extends :class:`InvoiceBase` with server-generated fields.

    Attributes:
        id: Primary key UUID.
        created_at: Timestamp when the record was created (UTC).
        updated_at: Timestamp when the record was last updated (UTC).
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime
    updated_at: datetime


class InvoiceUpdate(BaseModel):
    """Request body for partially updating an invoice (PATCH).

    All fields are optional so the caller only sends what changed.
    """

    invoice_number: str | None = None
    issue_date: date | None = None
    due_date: date | None = None
    client_id: UUID | None = None
    status: str | None = None
    currency: str | None = None
    subtotal: Decimal | None = None
    tax_amount: Decimal | None = None
    total: Decimal | None = None
    notes: str | None = None
    payment_terms: str | None = None
    attachments_path: str | None = None
