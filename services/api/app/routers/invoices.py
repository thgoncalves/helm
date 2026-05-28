"""FastAPI router for the ``/business/invoices`` endpoints.

V1 invoice flow:

* Invoices are created from the Timesheets page via the
  ``POST /business/timesheets/submit`` endpoint (see
  :mod:`app.routers.timesheets`) — this router covers the manual CRUD,
  filtered listing, status flip, and PDF export.
* Filtering: optional ``from`` / ``to`` (issue_date), ``status``, and
  ``client_id``. The list response includes ``totals_by_status`` so the
  landing page can render the Draft/Sent/Overdue/Paid cards.
* "Overdue" is computed at read time: status == ``"sent"`` AND
  ``due_date < today``. We don't persist an ``overdue`` status — flipping
  to "paid" simply removes it from the overdue bucket.
"""

from datetime import date, datetime, timezone
from decimal import Decimal
from io import BytesIO
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app import db
from app.deps import get_current_user
from app.models.invoice_line_items import (
    InvoiceLineItemCreate,
    InvoiceLineItemRead,
)
from app.models.invoices import InvoiceRead
from app.routers._invoice_pdf import render_invoice_pdf

router = APIRouter(tags=["invoices"], dependencies=[Depends(get_current_user)])


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------


class InvoiceLineItemInput(BaseModel):
    """Line item as accepted from the create/update body.

    The server recomputes ``line_subtotal``, ``line_tax``, ``line_total``
    from ``quantity``, ``unit_price``, ``is_taxable`` and ``tax_rate`` so the
    UI can't disagree with the DB on totals.
    """

    line_order: int
    description: str
    quantity: Decimal
    unit_price: Decimal
    is_taxable: bool = True
    tax_rate: Decimal | None = None
    tax_category: str | None = None


class InvoiceCreateBody(BaseModel):
    invoice_number: str
    client_id: UUID
    issue_date: date
    due_date: date | None = None
    status: str = "draft"
    currency: str = "CAD"
    notes: str | None = None
    payment_terms: str | None = None
    line_items: list[InvoiceLineItemInput]


class InvoiceUpdateBody(BaseModel):
    invoice_number: str
    client_id: UUID
    issue_date: date
    due_date: date | None = None
    status: str | None = None
    currency: str = "CAD"
    notes: str | None = None
    payment_terms: str | None = None
    line_items: list[InvoiceLineItemInput]


class InvoiceWithLines(BaseModel):
    """Single invoice plus its line items (used by GET /{id})."""

    invoice: InvoiceRead
    line_items: list[InvoiceLineItemRead]


class StatusTotals(BaseModel):
    """Money totals grouped by status for the landing-page cards.

    ``overdue`` is a derived bucket — invoices with status ``"sent"`` whose
    ``due_date`` is before today. ``total`` is the grand total across all
    rows in the listing (after filters).
    """

    draft: Decimal
    sent: Decimal
    overdue: Decimal
    paid: Decimal
    total: Decimal


class InvoiceListResponse(BaseModel):
    invoices: list[InvoiceRead]
    totals_by_status: StatusTotals


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _compute_line_totals(item: InvoiceLineItemInput) -> tuple[Decimal, Decimal, Decimal]:
    """Return (subtotal, tax, total) for one line item.

    Subtotal is quantity * unit_price. Tax is subtotal * tax_rate if the
    line is taxable and ``tax_rate`` is present; zero otherwise. All
    values are quantised to 2 decimal places to match Postgres
    ``numeric(15,2)``.
    """
    subtotal = (item.quantity * item.unit_price).quantize(Decimal("0.01"))
    if item.is_taxable and item.tax_rate is not None:
        tax = (subtotal * item.tax_rate).quantize(Decimal("0.01"))
    else:
        tax = Decimal("0.00")
    return subtotal, tax, (subtotal + tax).quantize(Decimal("0.01"))


def _sum_lines(lines: list[InvoiceLineItemInput]) -> tuple[Decimal, Decimal, Decimal]:
    """Sum subtotal/tax/total across all lines."""
    subtotal = Decimal("0.00")
    tax = Decimal("0.00")
    for item in lines:
        s, t, _ = _compute_line_totals(item)
        subtotal += s
        tax += t
    return subtotal, tax, (subtotal + tax).quantize(Decimal("0.01"))


def _next_invoice_number(year: int) -> str:
    """Return the next available ``INV-{year}-{NNNN}`` for the given year."""
    row = db.fetch_one(
        """
        SELECT invoice_number FROM invoices
        WHERE invoice_number LIKE :prefix
        ORDER BY invoice_number DESC
        LIMIT 1
        """,
        {"prefix": f"INV-{year}-%"},
    )
    if row is None:
        return f"INV-{year}-0001"
    last = row["invoice_number"]
    try:
        seq = int(last.rsplit("-", 1)[-1])
    except ValueError:
        seq = 0
    return f"INV-{year}-{seq + 1:04d}"


def _fetch_invoice_or_404(invoice_id: UUID) -> dict:
    row = db.fetch_one(
        "SELECT * FROM invoices WHERE id = :id",
        {"id": invoice_id},
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return row


def _fetch_line_items(invoice_id: UUID) -> list[dict]:
    return db.fetch_all(
        """
        SELECT * FROM invoice_line_items
        WHERE invoice_id = :invoice_id
        ORDER BY line_order ASC
        """,
        {"invoice_id": invoice_id},
    )


def _insert_line_items(
    invoice_id: UUID, lines: list[InvoiceLineItemInput]
) -> None:
    """Insert all line items for ``invoice_id`` (caller pre-deletes existing)."""
    for item in lines:
        subtotal, tax, total = _compute_line_totals(item)
        db.execute(
            """
            INSERT INTO invoice_line_items (
                id, invoice_id, line_order, description,
                quantity, unit_price, tax_category,
                is_taxable, tax_rate,
                line_subtotal, line_tax, line_total
            ) VALUES (
                :id, :invoice_id, :line_order, :description,
                :quantity, :unit_price, :tax_category,
                :is_taxable, :tax_rate,
                :line_subtotal, :line_tax, :line_total
            )
            """,
            {
                "id": uuid4(),
                "invoice_id": invoice_id,
                "line_order": item.line_order,
                "description": item.description,
                "quantity": item.quantity,
                "unit_price": item.unit_price,
                "tax_category": item.tax_category,
                "is_taxable": item.is_taxable,
                "tax_rate": item.tax_rate,
                "line_subtotal": subtotal,
                "line_tax": tax,
                "line_total": total,
            },
        )


# ---------------------------------------------------------------------------
# GET /business/invoices/  — list with filters + status totals
# ---------------------------------------------------------------------------


@router.get(
    "/",
    response_model=InvoiceListResponse,
    summary="List invoices with optional filters and status totals",
)
async def list_invoices(
    from_date: date | None = Query(
        None, alias="from", description="Inclusive issue_date lower bound."
    ),
    to_date: date | None = Query(
        None, alias="to", description="Inclusive issue_date upper bound."
    ),
    status: str | None = Query(None, description="Filter by exact status."),
    client_id: UUID | None = Query(None, description="Filter by client."),
) -> InvoiceListResponse:
    where: list[str] = []
    params: dict = {}
    if from_date is not None:
        where.append("issue_date >= :from_date")
        params["from_date"] = from_date
    if to_date is not None:
        where.append("issue_date <= :to_date")
        params["to_date"] = to_date
    if status is not None:
        where.append("status = :status")
        params["status"] = status
    if client_id is not None:
        where.append("client_id = :client_id")
        params["client_id"] = client_id
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    rows = db.fetch_all(
        f"SELECT * FROM invoices {where_sql} ORDER BY issue_date DESC, invoice_number DESC",
        params,
    )

    today = date.today()
    totals = StatusTotals(
        draft=Decimal("0.00"),
        sent=Decimal("0.00"),
        overdue=Decimal("0.00"),
        paid=Decimal("0.00"),
        total=Decimal("0.00"),
    )
    invoices: list[InvoiceRead] = []
    for row in rows:
        total_value = row["total"] if isinstance(row["total"], Decimal) else Decimal(0)
        totals.total += total_value
        s = row["status"]
        if s == "draft":
            totals.draft += total_value
        elif s == "paid":
            totals.paid += total_value
        elif s == "sent":
            due = row["due_date"]
            if isinstance(due, date) and due < today:
                totals.overdue += total_value
            else:
                totals.sent += total_value
        invoices.append(InvoiceRead(**row))

    return InvoiceListResponse(invoices=invoices, totals_by_status=totals)


# ---------------------------------------------------------------------------
# GET /business/invoices/{id}
# ---------------------------------------------------------------------------


@router.get(
    "/{invoice_id}",
    response_model=InvoiceWithLines,
    summary="Get a single invoice with its line items",
)
async def get_invoice(invoice_id: UUID) -> InvoiceWithLines:
    row = _fetch_invoice_or_404(invoice_id)
    lines = _fetch_line_items(invoice_id)
    return InvoiceWithLines(
        invoice=InvoiceRead(**row),
        line_items=[InvoiceLineItemRead(**ln) for ln in lines],
    )


# ---------------------------------------------------------------------------
# POST /business/invoices/  — create
# ---------------------------------------------------------------------------


@router.post(
    "/",
    response_model=InvoiceWithLines,
    status_code=201,
    summary="Create a new invoice with line items",
)
async def create_invoice(body: InvoiceCreateBody) -> InvoiceWithLines:
    if not body.line_items:
        raise HTTPException(
            status_code=400, detail="At least one line item is required."
        )

    subtotal, tax, total = _sum_lines(body.line_items)
    now = datetime.now(timezone.utc)
    new_id = uuid4()
    row = db.fetch_one(
        """
        INSERT INTO invoices (
            id, invoice_number, issue_date, due_date, client_id,
            status, currency, subtotal, tax_amount, total,
            notes, payment_terms, attachments_path,
            created_at, updated_at
        ) VALUES (
            :id, :invoice_number, :issue_date, :due_date, :client_id,
            :status, :currency, :subtotal, :tax_amount, :total,
            :notes, :payment_terms, NULL,
            :created_at, :updated_at
        )
        RETURNING *
        """,
        {
            "id": new_id,
            "invoice_number": body.invoice_number,
            "issue_date": body.issue_date,
            "due_date": body.due_date,
            "client_id": body.client_id,
            "status": body.status,
            "currency": body.currency,
            "subtotal": subtotal,
            "tax_amount": tax,
            "total": total,
            "notes": body.notes,
            "payment_terms": body.payment_terms,
            "created_at": now,
            "updated_at": now,
        },
    )
    assert row is not None

    _insert_line_items(new_id, body.line_items)
    lines = _fetch_line_items(new_id)
    return InvoiceWithLines(
        invoice=InvoiceRead(**row),
        line_items=[InvoiceLineItemRead(**ln) for ln in lines],
    )


# ---------------------------------------------------------------------------
# PUT /business/invoices/{id}  — update header + replace lines
# ---------------------------------------------------------------------------


@router.put(
    "/{invoice_id}",
    response_model=InvoiceWithLines,
    summary="Replace an invoice's header fields and line items",
)
async def update_invoice(
    invoice_id: UUID, body: InvoiceUpdateBody
) -> InvoiceWithLines:
    if not body.line_items:
        raise HTTPException(
            status_code=400, detail="At least one line item is required."
        )
    _fetch_invoice_or_404(invoice_id)

    subtotal, tax, total = _sum_lines(body.line_items)
    now = datetime.now(timezone.utc)

    row = db.fetch_one(
        """
        UPDATE invoices SET
            invoice_number = :invoice_number,
            issue_date = :issue_date,
            due_date = :due_date,
            client_id = :client_id,
            status = COALESCE(:status, status),
            currency = :currency,
            subtotal = :subtotal,
            tax_amount = :tax_amount,
            total = :total,
            notes = :notes,
            payment_terms = :payment_terms,
            updated_at = :updated_at
        WHERE id = :id
        RETURNING *
        """,
        {
            "id": invoice_id,
            "invoice_number": body.invoice_number,
            "issue_date": body.issue_date,
            "due_date": body.due_date,
            "client_id": body.client_id,
            "status": body.status,
            "currency": body.currency,
            "subtotal": subtotal,
            "tax_amount": tax,
            "total": total,
            "notes": body.notes,
            "payment_terms": body.payment_terms,
            "updated_at": now,
        },
    )
    assert row is not None

    # Replace lines wholesale — much simpler than diffing.
    db.execute(
        "DELETE FROM invoice_line_items WHERE invoice_id = :invoice_id",
        {"invoice_id": invoice_id},
    )
    _insert_line_items(invoice_id, body.line_items)
    lines = _fetch_line_items(invoice_id)
    return InvoiceWithLines(
        invoice=InvoiceRead(**row),
        line_items=[InvoiceLineItemRead(**ln) for ln in lines],
    )


# ---------------------------------------------------------------------------
# POST /business/invoices/{id}/mark-sent
# ---------------------------------------------------------------------------


@router.post(
    "/{invoice_id}/mark-sent",
    response_model=InvoiceRead,
    summary="Flip an invoice's status to 'sent'",
)
async def mark_sent(invoice_id: UUID) -> InvoiceRead:
    now = datetime.now(timezone.utc)
    row = db.fetch_one(
        """
        UPDATE invoices SET status = 'sent', updated_at = :updated_at
        WHERE id = :id
        RETURNING *
        """,
        {"id": invoice_id, "updated_at": now},
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return InvoiceRead(**row)


# ---------------------------------------------------------------------------
# GET /business/invoices/{id}/pdf
# ---------------------------------------------------------------------------


def _get_setting(key: str, default: str = "") -> str:
    row = db.fetch_one(
        "SELECT value FROM settings WHERE key = :key",
        {"key": key},
    )
    return row["value"] if row else default


@router.get(
    "/{invoice_id}/pdf",
    summary="Render the invoice as a PDF",
)
async def export_pdf(invoice_id: UUID) -> StreamingResponse:
    invoice = _fetch_invoice_or_404(invoice_id)
    lines = _fetch_line_items(invoice_id)
    client = db.fetch_one(
        "SELECT * FROM clients WHERE id = :id",
        {"id": invoice["client_id"]},
    )
    if client is None:
        raise HTTPException(status_code=404, detail="Client not found")

    pdf_bytes = render_invoice_pdf(
        invoice=invoice,
        line_items=lines,
        client_name=client["name"],
        user_name=_get_setting("user_full_name", ""),
        user_address=_get_setting("user_address", ""),
        user_postal_code=_get_setting("user_postal_code", ""),
        user_phone=_get_setting("user_phone", ""),
        user_email=_get_setting("user_email", ""),
        etransfer_email=_get_setting("etransfer_email", _get_setting("user_email", "")),
        company_name=_get_setting("company_name", ""),
    )

    filename = f"{invoice['invoice_number']} Invoice.pdf"
    return StreamingResponse(
        BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


# ---------------------------------------------------------------------------
# Exposed for the timesheets router (Submit Timesheet endpoint)
# ---------------------------------------------------------------------------


def next_invoice_number_for_year(year: int) -> str:
    """Public helper so the timesheets router can mint a number for a new
    invoice that comes from a submitted timesheet."""
    return _next_invoice_number(year)
