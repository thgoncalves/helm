"""FastAPI router for the ``/business/tax-payments`` endpoints.

Models the GST-to-ATO payment workflow:

* An invoice that carries GST (``invoices.tax_amount > 0``) becomes
  remittable only once the client has fully paid the invoice
  (``invoices.status = 'paid'``). Until then the GST hasn't actually
  been collected, so we don't owe it to the CRA yet. Once paid, the
  invoice is "unpaid GST" from a tax-remittance point of view until
  it is linked to a ``tax_payments`` row via ``invoice_tax_links``.
  Pre-existing links are preserved regardless of paid status.
* A single ``tax_payments`` row typically covers several invoices'
  worth of GST (the user pays the ATO in chunks).
* V1 invariant — enforced by ``UNIQUE (invoice_id)`` on
  ``invoice_tax_links`` — an invoice is paid in full as part of
  **exactly one** tax_payment. The Link/Unlink dialog only ever shows
  invoices that aren't already linked elsewhere.

Endpoints:

* ``GET    /business/tax-payments/summary`` — KPI cards
* ``GET    /business/tax-payments/`` — list of GST payments, enriched
  with the number of linked invoices and their total income.
* ``GET    /business/tax-payments/unpaid-invoices`` — bottom-table feed
  for the landing page.
* ``GET    /business/tax-payments/{id}`` — payment + its linked invoices
  (for the Edit dialog).
* ``GET    /business/tax-payments/{id}/linkable-invoices`` — feed for
  the Link/Unlink dialog: all currently-linked invoices plus every
  GST-bearing invoice that hasn't been linked anywhere yet.
* ``POST   /business/tax-payments/`` — record a new payment with the
  initial set of linked invoices.
* ``PUT    /business/tax-payments/{id}`` — update header fields.
* ``PUT    /business/tax-payments/{id}/links`` — bulk replace the set of
  linked invoices.
* ``DELETE /business/tax-payments/{id}`` — drops the payment; the FK
  cascades to ``invoice_tax_links`` (delete the links first, then the
  payment) so the unlinked invoices reappear on the "unpaid" list.
"""

from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import db
from app.deps import get_current_user
from app.models.tax_payments import TaxPaymentRead

router = APIRouter(tags=["tax-payments"], dependencies=[Depends(get_current_user)])


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------


class TaxSummary(BaseModel):
    """KPI cards for the Taxes landing page."""

    gst_unpaid: Decimal
    unpaid_income: Decimal
    total_gst_paid: Decimal


class TaxPaymentListRow(BaseModel):
    """One row in the GST Payments table.

    ``invoice_count`` and ``income`` are aggregated from the
    ``invoice_tax_links`` + ``invoices`` join.
    """

    id: UUID
    payment_date: date
    amount: Decimal
    payment_method: str | None
    payment_reference: str | None
    notes: str | None
    invoice_count: int
    income: Decimal


class LinkableInvoice(BaseModel):
    """One option in the Link/Unlink Invoices dialog or the Edit dialog's
    linked-invoices table."""

    invoice_id: UUID
    invoice_number: str
    client_id: UUID
    client_name: str
    issue_date: date
    total: Decimal
    tax_amount: Decimal
    is_linked: bool


class UnpaidInvoice(BaseModel):
    """Bottom-table row on the Taxes landing page."""

    invoice_id: UUID
    invoice_number: str
    client_id: UUID
    client_name: str
    issue_date: date
    total: Decimal
    tax_amount: Decimal


class TaxPaymentWithLinks(BaseModel):
    """Payment + the list of currently-linked invoices (for Edit dialog)."""

    payment: TaxPaymentRead
    linked_invoices: list[LinkableInvoice]


class TaxPaymentCreateBody(BaseModel):
    payment_date: date
    amount: Decimal
    payment_method: str | None = "ATO"
    payment_reference: str | None = None
    notes: str | None = None
    # Initial set of invoices to link. May be empty.
    invoice_ids: list[UUID] = []


class TaxPaymentUpdateBody(BaseModel):
    payment_date: date
    amount: Decimal
    payment_method: str | None = "ATO"
    payment_reference: str | None = None
    notes: str | None = None


class TaxPaymentLinksBody(BaseModel):
    """Bulk-replace request body for /links — fully replaces the link set."""

    invoice_ids: list[UUID]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fetch_payment_or_404(payment_id: UUID) -> dict:
    row = db.fetch_one(
        "SELECT * FROM tax_payments WHERE id = :id",
        {"id": payment_id},
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Tax payment not found")
    return row


def _fetch_linked_invoices(payment_id: UUID) -> list[dict]:
    return db.fetch_all(
        """
        SELECT i.id AS invoice_id, i.invoice_number, i.client_id,
               i.issue_date, i.total, i.tax_amount,
               c.name AS client_name
        FROM invoice_tax_links l
        JOIN invoices i ON l.invoice_id = i.id
        JOIN clients c ON i.client_id = c.id
        WHERE l.tax_payment_id = :payment_id
        ORDER BY i.issue_date ASC, i.invoice_number ASC
        """,
        {"payment_id": payment_id},
    )


def _replace_links(payment_id: UUID, invoice_ids: list[UUID]) -> None:
    """Drop existing links for this payment, then re-create from ``invoice_ids``.

    Each link's ``gst_amount`` is set to the invoice's ``tax_amount`` (the
    V1 "pay GST in full" rule). The unique index on ``invoice_id`` means
    an INSERT for an invoice already linked to a different payment will
    fail with a 23505 — we surface that as a 409.
    """
    db.execute(
        "DELETE FROM invoice_tax_links WHERE tax_payment_id = :payment_id",
        {"payment_id": payment_id},
    )
    if not invoice_ids:
        return
    now = datetime.now(timezone.utc)
    for invoice_id in invoice_ids:
        inv = db.fetch_one(
            "SELECT tax_amount FROM invoices WHERE id = :id",
            {"id": invoice_id},
        )
        if inv is None:
            raise HTTPException(
                status_code=400,
                detail=f"Invoice {invoice_id} not found",
            )
        gst = inv["tax_amount"] if isinstance(inv["tax_amount"], Decimal) else Decimal(0)
        db.execute(
            """
            INSERT INTO invoice_tax_links (
                id, invoice_id, tax_payment_id, tax_id, gst_amount, created_at
            ) VALUES (
                :id, :invoice_id, :payment_id, NULL, :gst_amount, :now
            )
            """,
            {
                "id": uuid4(),
                "invoice_id": invoice_id,
                "payment_id": payment_id,
                "gst_amount": gst,
                "now": now,
            },
        )


# ---------------------------------------------------------------------------
# GET /summary
# ---------------------------------------------------------------------------


@router.get(
    "/summary",
    response_model=TaxSummary,
    summary="KPI cards: GST Unpaid, Unpaid Income, Total GST Paid",
)
async def get_summary() -> TaxSummary:
    # GST is only remittable once the client has actually paid the
    # invoice — until then, the cash hasn't landed. Invoices already
    # linked to a tax_payment stay linked regardless of paid status.
    unpaid = db.fetch_one(
        """
        SELECT COALESCE(SUM(i.tax_amount), 0) AS gst_unpaid,
               COALESCE(SUM(i.total), 0) AS unpaid_income
        FROM invoices i
        WHERE i.tax_amount > 0
          AND i.status = 'paid'
          AND NOT EXISTS (
              SELECT 1 FROM invoice_tax_links l
              WHERE l.invoice_id = i.id
          )
        """
    )
    total = db.fetch_one(
        "SELECT COALESCE(SUM(amount), 0) AS total_gst_paid FROM tax_payments"
    )
    return TaxSummary(
        gst_unpaid=(unpaid or {}).get("gst_unpaid") or Decimal(0),
        unpaid_income=(unpaid or {}).get("unpaid_income") or Decimal(0),
        total_gst_paid=(total or {}).get("total_gst_paid") or Decimal(0),
    )


# ---------------------------------------------------------------------------
# GET /  — list payments enriched with counts/income
# ---------------------------------------------------------------------------


@router.get(
    "/",
    response_model=list[TaxPaymentListRow],
    summary="List GST payments with linked-invoice counts and income totals",
)
async def list_payments() -> list[TaxPaymentListRow]:
    rows = db.fetch_all(
        """
        SELECT p.id, p.payment_date, p.amount, p.payment_method,
               p.payment_reference, p.notes,
               COALESCE(COUNT(l.id), 0) AS invoice_count,
               COALESCE(SUM(i.total), 0) AS income
        FROM tax_payments p
        LEFT JOIN invoice_tax_links l ON l.tax_payment_id = p.id
        LEFT JOIN invoices i ON l.invoice_id = i.id
        GROUP BY p.id, p.payment_date, p.amount, p.payment_method,
                 p.payment_reference, p.notes
        ORDER BY p.payment_date DESC, p.created_at DESC
        """,
    )
    out: list[TaxPaymentListRow] = []
    for r in rows:
        out.append(
            TaxPaymentListRow(
                id=r["id"],
                payment_date=r["payment_date"],
                amount=r["amount"]
                if isinstance(r["amount"], Decimal)
                else Decimal(0),
                payment_method=r["payment_method"],
                payment_reference=r["payment_reference"],
                notes=r["notes"],
                invoice_count=int(r["invoice_count"] or 0),
                income=r["income"]
                if isinstance(r["income"], Decimal)
                else Decimal(0),
            )
        )
    return out


# ---------------------------------------------------------------------------
# GET /unpaid-invoices
# ---------------------------------------------------------------------------


@router.get(
    "/unpaid-invoices",
    response_model=list[UnpaidInvoice],
    summary="Invoices with GST > 0 that have no tax-payment link",
)
async def unpaid_invoices() -> list[UnpaidInvoice]:
    # Same predicate as the summary query: GST is unpaid (remitted)
    # only once the client has fully paid the invoice and it isn't
    # already linked to a tax_payment.
    rows = db.fetch_all(
        """
        SELECT i.id AS invoice_id, i.invoice_number, i.client_id,
               i.issue_date, i.total, i.tax_amount,
               c.name AS client_name
        FROM invoices i
        JOIN clients c ON i.client_id = c.id
        WHERE i.tax_amount > 0
          AND i.status = 'paid'
          AND NOT EXISTS (
              SELECT 1 FROM invoice_tax_links l
              WHERE l.invoice_id = i.id
          )
        ORDER BY i.issue_date DESC, i.invoice_number DESC
        """,
    )
    return [UnpaidInvoice(**r) for r in rows]


# ---------------------------------------------------------------------------
# GET /{id}
# ---------------------------------------------------------------------------


@router.get(
    "/{payment_id}",
    response_model=TaxPaymentWithLinks,
    summary="Get a single GST payment with the invoices linked to it",
)
async def get_payment(payment_id: UUID) -> TaxPaymentWithLinks:
    payment = _fetch_payment_or_404(payment_id)
    linked = _fetch_linked_invoices(payment_id)
    return TaxPaymentWithLinks(
        payment=TaxPaymentRead(**payment),
        linked_invoices=[LinkableInvoice(**r, is_linked=True) for r in linked],
    )


# ---------------------------------------------------------------------------
# GET /{id}/linkable-invoices
# ---------------------------------------------------------------------------


@router.get(
    "/{payment_id}/linkable-invoices",
    response_model=list[LinkableInvoice],
    summary="Invoices a user can attach to this payment",
)
async def linkable_invoices(payment_id: UUID) -> list[LinkableInvoice]:
    """All GST-bearing invoices that are either:
    * currently linked to ``payment_id`` (shown checked, regardless of
      paid status — pre-existing links are preserved), or
    * not linked to any payment yet AND fully paid by the client
      (shown unchecked, available to attach).
    """
    _fetch_payment_or_404(payment_id)
    rows = db.fetch_all(
        """
        SELECT i.id AS invoice_id, i.invoice_number, i.client_id,
               i.issue_date, i.total, i.tax_amount,
               c.name AS client_name,
               l.tax_payment_id AS linked_payment_id
        FROM invoices i
        JOIN clients c ON i.client_id = c.id
        LEFT JOIN invoice_tax_links l ON l.invoice_id = i.id
        WHERE i.tax_amount > 0
          AND (
            l.tax_payment_id = :payment_id
            OR (l.tax_payment_id IS NULL AND i.status = 'paid')
          )
        ORDER BY i.issue_date ASC, i.invoice_number ASC
        """,
        {"payment_id": payment_id},
    )
    return [
        LinkableInvoice(
            invoice_id=r["invoice_id"],
            invoice_number=r["invoice_number"],
            client_id=r["client_id"],
            client_name=r["client_name"],
            issue_date=r["issue_date"],
            total=r["total"],
            tax_amount=r["tax_amount"],
            is_linked=r["linked_payment_id"] == payment_id,
        )
        for r in rows
    ]


# ---------------------------------------------------------------------------
# POST /
# ---------------------------------------------------------------------------


@router.post(
    "/",
    response_model=TaxPaymentWithLinks,
    status_code=201,
    summary="Record a new GST payment with its initial linked invoices",
)
async def create_payment(body: TaxPaymentCreateBody) -> TaxPaymentWithLinks:
    now = datetime.now(timezone.utc)
    payment_id = uuid4()
    row = db.fetch_one(
        """
        INSERT INTO tax_payments (
            id, tax_id, payment_date, amount, payment_method,
            payment_reference, fiscal_year, notes,
            created_at, updated_at
        ) VALUES (
            :id, NULL, :payment_date, :amount, :payment_method,
            :payment_reference, NULL, :notes,
            :created_at, :updated_at
        )
        RETURNING *
        """,
        {
            "id": payment_id,
            "payment_date": body.payment_date,
            "amount": body.amount,
            "payment_method": body.payment_method,
            "payment_reference": body.payment_reference,
            "notes": body.notes,
            "created_at": now,
            "updated_at": now,
        },
    )
    assert row is not None

    _replace_links(payment_id, body.invoice_ids)
    linked = _fetch_linked_invoices(payment_id)
    return TaxPaymentWithLinks(
        payment=TaxPaymentRead(**row),
        linked_invoices=[LinkableInvoice(**r, is_linked=True) for r in linked],
    )


# ---------------------------------------------------------------------------
# PUT /{id}  — header fields only (links via /links)
# ---------------------------------------------------------------------------


@router.put(
    "/{payment_id}",
    response_model=TaxPaymentRead,
    summary="Update the header fields of a GST payment",
)
async def update_payment(
    payment_id: UUID, body: TaxPaymentUpdateBody
) -> TaxPaymentRead:
    _fetch_payment_or_404(payment_id)
    now = datetime.now(timezone.utc)
    row = db.fetch_one(
        """
        UPDATE tax_payments SET
            payment_date = :payment_date,
            amount = :amount,
            payment_method = :payment_method,
            payment_reference = :payment_reference,
            notes = :notes,
            updated_at = :updated_at
        WHERE id = :id
        RETURNING *
        """,
        {
            "id": payment_id,
            "payment_date": body.payment_date,
            "amount": body.amount,
            "payment_method": body.payment_method,
            "payment_reference": body.payment_reference,
            "notes": body.notes,
            "updated_at": now,
        },
    )
    assert row is not None
    return TaxPaymentRead(**row)


# ---------------------------------------------------------------------------
# PUT /{id}/links  — bulk replace the linked invoice set
# ---------------------------------------------------------------------------


@router.put(
    "/{payment_id}/links",
    response_model=list[LinkableInvoice],
    summary="Replace the set of invoices linked to this payment",
)
async def replace_links(
    payment_id: UUID, body: TaxPaymentLinksBody
) -> list[LinkableInvoice]:
    _fetch_payment_or_404(payment_id)
    _replace_links(payment_id, body.invoice_ids)
    linked = _fetch_linked_invoices(payment_id)
    return [LinkableInvoice(**r, is_linked=True) for r in linked]


# ---------------------------------------------------------------------------
# DELETE /{id}
# ---------------------------------------------------------------------------


@router.delete(
    "/{payment_id}",
    status_code=204,
    summary="Delete a GST payment and unlink all its invoices",
)
async def delete_payment(payment_id: UUID) -> None:
    _fetch_payment_or_404(payment_id)
    # Links go away first, then the payment. invoice_tax_links has
    # ON DELETE CASCADE for tax_payment_id, but doing it explicitly keeps
    # the test fakes simple.
    db.execute(
        "DELETE FROM invoice_tax_links WHERE tax_payment_id = :payment_id",
        {"payment_id": payment_id},
    )
    db.execute(
        "DELETE FROM tax_payments WHERE id = :id",
        {"id": payment_id},
    )
