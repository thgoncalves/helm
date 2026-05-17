"""Pydantic models for the ``expenses`` table.

Mirrors the Drizzle schema in ``db/schema/expenses.ts``.
"""

from datetime import date, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class ExpenseBase(BaseModel):
    """Shared editable fields for an expense.

    Status / s3_key are intentionally NOT in here — they're owned by the
    backend (status flows through pending → processing → ready) and the
    user never edits them directly.
    """

    expense_date: date | None = None
    supplier: str | None = None
    category: str | None = None
    subtotal: Decimal | None = None
    tax_amount: Decimal | None = None
    total: Decimal | None = None
    currency: str | None = "CAD"
    notes: str | None = None


class ExpenseUpdate(ExpenseBase):
    """Request body for ``PUT /business/expenses/{id}``."""


class ExpenseRead(ExpenseBase):
    """Response shape for an expense row.

    Attributes:
        id: Primary key UUID.
        status: ``pending`` / ``processing`` / ``ready`` / ``failed``.
        s3_key: Bucket-relative key for the uploaded image.
        content_type: MIME type the client uploaded (e.g. ``image/jpeg``).
        size_bytes: File size as reported on upload. Optional.
        ocr_error: Human-readable error string when ``status='failed'``.
        created_at: Timestamp when the row was created (UTC).
        updated_at: Timestamp when the row was last updated (UTC).
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    status: str
    s3_key: str
    content_type: str | None = None
    size_bytes: int | None = None
    ocr_error: str | None = None
    created_at: datetime
    updated_at: datetime


class ExpenseCreateRequest(BaseModel):
    """Body for ``POST /business/expenses/``.

    The client tells us the file's MIME type + extension up front so we
    can choose a deterministic S3 key and the right presigned URL
    content-type binding.
    """

    file_extension: str = "jpg"
    content_type: str = "image/jpeg"
    size_bytes: int | None = None


class ExpenseCreateResponse(BaseModel):
    """Response for ``POST /business/expenses/``.

    The client uses ``upload_url`` to PUT the file directly to S3 — it's
    a presigned URL valid for ~5 minutes. The row's ``status`` is
    ``pending`` until the S3 event triggers the processor Lambda.
    """

    expense: ExpenseRead
    upload_url: str


class ExpenseImageUrlResponse(BaseModel):
    """Response for ``GET /business/expenses/{id}/image-url``."""

    url: str


# Internal helper type used by the processor handler — not exposed via
# the HTTP API but lives here so the schema stays in one place.


class TextractSummary(BaseModel):
    """Parsed Textract ``AnalyzeExpense`` summary fields.

    Empty/None when Textract didn't find a confident value for that
    field. Confidence scores are intentionally dropped here — they were
    useful at parse time but storing them adds noise.
    """

    supplier: str | None = None
    expense_date: date | None = None
    subtotal: Decimal | None = None
    tax_amount: Decimal | None = None
    total: Decimal | None = None
    raw: dict[str, Any] | None = None
