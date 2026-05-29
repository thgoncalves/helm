"""FastAPI router for the ``/business/payments`` endpoints.

V1 flow:

* List, create, update, delete payments tied to invoices.
* The list response is enriched with ``invoice_number`` and ``client_name``
  so the landing page can render without N+1 round-trips.
* ``GET /business/payments/invoice-options`` powers the "Invoice" dropdown
  on the create/edit form. It returns each invoice with its current
  ``balance_due`` (``invoice.total`` minus the sum of all existing payment
  ``amount`` values).
* On every payment mutation the invoice's status is recomputed: if the
  cumulative paid (``sum(amount)``) is greater than or equal to
  ``invoice.total``, the invoice is marked ``paid``; otherwise if it was
  previously ``paid`` it drops back to ``sent`` so the listing stays
  consistent.

Deductions:
* ``amount`` is the GROSS amount the client paid (matches what the
  invoice was billed for). ``deduction_amount`` is anything subtracted
  before it hits the user's account — e.g. bank fees or processing fees.
* "Net" = ``amount - deduction_amount`` and is what the user actually
  received. Tracked separately so the Tax module can later reconcile
  bank deposits.
"""

from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app import db
from app.deps import get_current_user
from app.models.payments_received import (
    PaymentReceivedCreate,
    PaymentReceivedRead,
    PaymentReceivedUpdate,
)

router = APIRouter(tags=["payments"], dependencies=[Depends(get_current_user)])


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------


class PaymentListRow(BaseModel):
    """One row in the payments landing-page table.

    ``net`` is computed (``amount - deduction_amount``) so the frontend
    doesn't have to.
    """

    id: UUID
    payment_date: date
    invoice_id: UUID
    invoice_number: str
    client_id: UUID
    client_name: str
    amount: Decimal
    deduction_amount: Decimal
    net: Decimal
    payment_method: str | None
    reference: str | None
    notes: str | None
    created_at: datetime
    updated_at: datetime


class InvoiceOption(BaseModel):
    """One option in the invoice dropdown of the payment form.

    ``balance_due`` is the invoice total minus the sum of already-recorded
    payments (excluding this payment if we're editing).
    """

    invoice_id: UUID
    invoice_number: str
    client_id: UUID
    client_name: str
    total: Decimal
    balance_due: Decimal
    status: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fetch_payment_or_404(payment_id: UUID) -> dict:
    row = db.fetch_one(
        "SELECT * FROM payments_received WHERE id = :id",
        {"id": payment_id},
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Payment not found")
    return row


def _recompute_invoice_status(invoice_id: UUID) -> None:
    """Set the invoice's status to 'paid' iff total paid >= invoice.total.

    Leaves status alone otherwise — a 'draft' invoice with a partial
    payment stays 'draft' (the user hasn't sent it yet). If the invoice
    was previously 'paid' but a payment was removed or reduced and now
    total paid < invoice.total, downgrade it to 'sent'.
    """
    row = db.fetch_one(
        """
        SELECT i.total AS total, i.status AS status,
               COALESCE(SUM(p.amount), 0) AS paid
        FROM invoices i
        LEFT JOIN payments_received p ON p.invoice_id = i.id
        WHERE i.id = :invoice_id
        GROUP BY i.total, i.status
        """,
        {"invoice_id": invoice_id},
    )
    if row is None:
        return
    total = row["total"] if isinstance(row["total"], Decimal) else Decimal(0)
    paid = row["paid"] if isinstance(row["paid"], Decimal) else Decimal(0)
    current_status = row["status"]
    now = datetime.now(timezone.utc)
    if paid >= total and total > 0:
        if current_status != "paid":
            db.execute(
                """
                UPDATE invoices SET status = 'paid', updated_at = :now
                WHERE id = :id
                """,
                {"id": invoice_id, "now": now},
            )
    else:
        # Drop back to 'sent' only if we'd been marking it 'paid' previously.
        if current_status == "paid":
            db.execute(
                """
                UPDATE invoices SET status = 'sent', updated_at = :now
                WHERE id = :id
                """,
                {"id": invoice_id, "now": now},
            )


# ---------------------------------------------------------------------------
# GET /business/payments/  — list with filters
# ---------------------------------------------------------------------------


@router.get(
    "/",
    response_model=list[PaymentListRow],
    summary="List payments with optional filters",
)
async def list_payments(
    from_date: date | None = Query(None, alias="from"),
    to_date: date | None = Query(None, alias="to"),
    client_id: UUID | None = Query(None),
    invoice_id: UUID | None = Query(None),
) -> list[PaymentListRow]:
    where: list[str] = []
    params: dict = {}
    if from_date is not None:
        where.append("p.payment_date >= :from_date")
        params["from_date"] = from_date
    if to_date is not None:
        where.append("p.payment_date <= :to_date")
        params["to_date"] = to_date
    if client_id is not None:
        where.append("i.client_id = :client_id")
        params["client_id"] = client_id
    if invoice_id is not None:
        where.append("p.invoice_id = :invoice_id")
        params["invoice_id"] = invoice_id
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    rows = db.fetch_all(
        f"""
        SELECT p.id, p.payment_date, p.invoice_id, p.amount,
               p.deduction_amount, p.payment_method, p.reference,
               p.notes, p.created_at, p.updated_at,
               i.invoice_number, i.client_id,
               c.name AS client_name
        FROM payments_received p
        JOIN invoices i ON p.invoice_id = i.id
        JOIN clients c ON i.client_id = c.id
        {where_sql}
        ORDER BY p.payment_date DESC, p.created_at DESC
        """,
        params,
    )
    result: list[PaymentListRow] = []
    for row in rows:
        amount = row["amount"] if isinstance(row["amount"], Decimal) else Decimal(0)
        deduction = (
            row["deduction_amount"]
            if isinstance(row["deduction_amount"], Decimal)
            else Decimal(0)
        )
        result.append(
            PaymentListRow(
                id=row["id"],
                payment_date=row["payment_date"],
                invoice_id=row["invoice_id"],
                invoice_number=row["invoice_number"],
                client_id=row["client_id"],
                client_name=row["client_name"],
                amount=amount,
                deduction_amount=deduction,
                net=(amount - deduction).quantize(Decimal("0.01")),
                payment_method=row["payment_method"],
                reference=row["reference"],
                notes=row["notes"],
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            )
        )
    return result


# ---------------------------------------------------------------------------
# GET /business/payments/invoice-options
# ---------------------------------------------------------------------------


@router.get(
    "/invoice-options",
    response_model=list[InvoiceOption],
    summary="List invoices with current balance_due for the payment form dropdown",
)
async def invoice_options(
    open_only: bool = Query(
        default=False,
        description=(
            "If True, exclude any invoice with balance_due <= 0 (fully "
            "settled — nothing left to pay). The edit form keeps them "
            "visible (open_only=False) so the user can adjust historical "
            "payments."
        ),
    ),
) -> list[InvoiceOption]:
    rows = db.fetch_all(
        """
        SELECT i.id AS invoice_id, i.invoice_number, i.client_id,
               i.total, i.status,
               c.name AS client_name,
               COALESCE(SUM(p.amount), 0) AS paid
        FROM invoices i
        JOIN clients c ON i.client_id = c.id
        LEFT JOIN payments_received p ON p.invoice_id = i.id
        GROUP BY i.id, i.invoice_number, i.client_id, i.total, i.status,
                 c.name
        ORDER BY i.issue_date ASC, i.invoice_number ASC
        """,
    )
    out: list[InvoiceOption] = []
    for row in rows:
        total = row["total"] if isinstance(row["total"], Decimal) else Decimal(0)
        paid = row["paid"] if isinstance(row["paid"], Decimal) else Decimal(0)
        balance = (total - paid).quantize(Decimal("0.01"))
        # When recording a new payment, drop fully-settled invoices —
        # there's nothing left to pay on them. (The edit form passes
        # open_only=False so a historical payment on a now-paid invoice
        # stays selectable.)
        if open_only and balance <= 0:
            continue
        out.append(
            InvoiceOption(
                invoice_id=row["invoice_id"],
                invoice_number=row["invoice_number"],
                client_id=row["client_id"],
                client_name=row["client_name"],
                total=total,
                balance_due=balance,
                status=row["status"],
            )
        )
    return out


# ---------------------------------------------------------------------------
# GET /business/payments/{id}
# ---------------------------------------------------------------------------


@router.get(
    "/{payment_id}",
    response_model=PaymentReceivedRead,
    summary="Get a single payment",
)
async def get_payment(payment_id: UUID) -> PaymentReceivedRead:
    row = _fetch_payment_or_404(payment_id)
    return PaymentReceivedRead(**row)


# ---------------------------------------------------------------------------
# POST /business/payments/
# ---------------------------------------------------------------------------


@router.post(
    "/",
    response_model=PaymentReceivedRead,
    status_code=201,
    summary="Record a new payment",
)
async def create_payment(body: PaymentReceivedCreate) -> PaymentReceivedRead:
    # Confirm invoice exists.
    invoice = db.fetch_one(
        "SELECT id FROM invoices WHERE id = :id",
        {"id": body.invoice_id},
    )
    if invoice is None:
        raise HTTPException(status_code=404, detail="Invoice not found")

    now = datetime.now(timezone.utc)
    payment_id = uuid4()
    row = db.fetch_one(
        """
        INSERT INTO payments_received (
            id, invoice_id, payment_date, amount, payment_method, reference,
            notes, deduction_amount, deduction_description,
            created_at, updated_at
        ) VALUES (
            :id, :invoice_id, :payment_date, :amount, :payment_method,
            :reference, :notes, :deduction_amount, :deduction_description,
            :created_at, :updated_at
        )
        RETURNING *
        """,
        {
            "id": payment_id,
            "invoice_id": body.invoice_id,
            "payment_date": body.payment_date,
            "amount": body.amount,
            "payment_method": body.payment_method,
            "reference": body.reference,
            "notes": body.notes,
            "deduction_amount": body.deduction_amount,
            "deduction_description": body.deduction_description,
            "created_at": now,
            "updated_at": now,
        },
    )
    assert row is not None

    _recompute_invoice_status(body.invoice_id)
    return PaymentReceivedRead(**row)


# ---------------------------------------------------------------------------
# PUT /business/payments/{id}
# ---------------------------------------------------------------------------


@router.put(
    "/{payment_id}",
    response_model=PaymentReceivedRead,
    summary="Replace a payment (full update)",
)
async def update_payment(
    payment_id: UUID, body: PaymentReceivedCreate
) -> PaymentReceivedRead:
    existing = _fetch_payment_or_404(payment_id)
    now = datetime.now(timezone.utc)
    row = db.fetch_one(
        """
        UPDATE payments_received SET
            invoice_id = :invoice_id,
            payment_date = :payment_date,
            amount = :amount,
            payment_method = :payment_method,
            reference = :reference,
            notes = :notes,
            deduction_amount = :deduction_amount,
            deduction_description = :deduction_description,
            updated_at = :updated_at
        WHERE id = :id
        RETURNING *
        """,
        {
            "id": payment_id,
            "invoice_id": body.invoice_id,
            "payment_date": body.payment_date,
            "amount": body.amount,
            "payment_method": body.payment_method,
            "reference": body.reference,
            "notes": body.notes,
            "deduction_amount": body.deduction_amount,
            "deduction_description": body.deduction_description,
            "updated_at": now,
        },
    )
    assert row is not None

    # Recompute status on both the old and new invoice in case the payment
    # was moved between invoices.
    if existing["invoice_id"] != body.invoice_id:
        _recompute_invoice_status(existing["invoice_id"])
    _recompute_invoice_status(body.invoice_id)
    return PaymentReceivedRead(**row)


# ---------------------------------------------------------------------------
# DELETE /business/payments/{id}
# ---------------------------------------------------------------------------


@router.delete(
    "/{payment_id}",
    status_code=204,
    summary="Delete a payment",
)
async def delete_payment(payment_id: UUID) -> None:
    existing = _fetch_payment_or_404(payment_id)
    db.execute(
        "DELETE FROM payments_received WHERE id = :id",
        {"id": payment_id},
    )
    _recompute_invoice_status(existing["invoice_id"])
