"""Pydantic models for the ``invoice_line_items`` table.

Mirrors the Drizzle schema in ``db/schema/invoice-line-items.ts``. Line
items have no ``created_at`` / ``updated_at`` columns — their lifecycle is
cascade-managed via the parent invoice — so ``InvoiceLineItemRead`` only
adds ``id`` to the base, no timestamps.
"""

from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class InvoiceLineItemBase(BaseModel):
    """Shared data fields for an invoice line item (no id).

    Attributes:
        invoice_id: UUID of the parent invoice.
        line_order: Display order of this line on the invoice.
        description: Description of the work or product billed.
        quantity: Number of units billed.
        unit_price: Price per unit.
        tax_category: Tax category code (e.g. ``"GST"``). Optional.
        is_taxable: Whether this line is subject to tax. Defaults to ``True``.
        tax_rate: Tax rate as a decimal (e.g. ``0.0500`` for 5% GST). Optional.
        line_subtotal: Pre-tax total for this line (``quantity * unit_price``).
        line_tax: Tax amount for this line. Defaults to ``Decimal("0")``.
        line_total: Total for this line including tax.
    """

    invoice_id: UUID
    line_order: int
    description: str
    quantity: Decimal
    unit_price: Decimal
    tax_category: str | None = None
    is_taxable: bool = True
    tax_rate: Decimal | None = None
    line_subtotal: Decimal
    line_tax: Decimal = Decimal("0")
    line_total: Decimal


class InvoiceLineItemCreate(InvoiceLineItemBase):
    """Request body for creating a new invoice line item.

    Inherits all fields from :class:`InvoiceLineItemBase`.
    """


class InvoiceLineItemRead(InvoiceLineItemBase):
    """Response model for reading an invoice line item.

    Extends :class:`InvoiceLineItemBase` with the server-generated primary key.

    Attributes:
        id: Primary key UUID.
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID


class InvoiceLineItemUpdate(BaseModel):
    """Request body for partially updating an invoice line item (PATCH).

    All fields are optional so the caller only sends what changed.
    """

    invoice_id: UUID | None = None
    line_order: int | None = None
    description: str | None = None
    quantity: Decimal | None = None
    unit_price: Decimal | None = None
    tax_category: str | None = None
    is_taxable: bool | None = None
    tax_rate: Decimal | None = None
    line_subtotal: Decimal | None = None
    line_tax: Decimal | None = None
    line_total: Decimal | None = None
