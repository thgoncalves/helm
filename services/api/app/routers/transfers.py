"""FastAPI router for the ``/business/transfers`` endpoints.

Models the Company → Personal owner-draw workflow. Each transfer carries
two estimated-tax columns because the user pays tax on both ends: the
company side (income tax on the draw out of the business) and the
personal side (income tax on the draw into personal). The Taxes module
will later reconcile these against actual ATO payments.

Endpoints:

* ``GET    /business/transfers/`` — list with optional ``from`` / ``to``
  date filters. The landing page uses fiscal-year boundaries
  (Apr 1 → Mar 31) but the endpoint just takes raw dates.
* ``GET    /business/transfers/summary`` — KPIs for the cards. Same
  ``from`` / ``to`` window.
* ``GET    /business/transfers/tax-rates`` — read the default
  ``transfer_tax_rate_company`` and ``transfer_tax_rate_personal`` from
  the settings table; the form uses these for the auto-estimate.
* ``GET    /business/transfers/{id}`` — single transfer.
* ``POST   /business/transfers/`` — create.
* ``PUT    /business/transfers/{id}`` — update.
* ``DELETE /business/transfers/{id}`` — delete.
"""

from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app import db
from app.deps import get_current_user
from app.models.transfers import TransferCreate, TransferRead

router = APIRouter(tags=["transfers"], dependencies=[Depends(get_current_user)])


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------


class TransferSummary(BaseModel):
    """KPI cards for the Transfers landing page.

    ``tax_exposure`` is the sum of company + personal estimates — the
    "still owed to the tax authorities" total the user owes if they
    don't reduce the bill some other way.
    """

    total_transferred: Decimal
    transaction_count: int
    est_company_tax: Decimal
    est_personal_tax: Decimal
    tax_exposure: Decimal


class TransferTaxRates(BaseModel):
    """Default per-side tax rates read from the settings table."""

    company_rate: Decimal
    personal_rate: Decimal


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fetch_or_404(transfer_id: UUID) -> dict:
    row = db.fetch_one(
        "SELECT * FROM transfers WHERE id = :id",
        {"id": transfer_id},
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Transfer not found")
    return row


def _get_setting(key: str) -> str | None:
    row = db.fetch_one(
        "SELECT value FROM settings WHERE key = :key",
        {"key": key},
    )
    return row["value"] if row else None


def _build_where(
    from_date: date | None, to_date: date | None
) -> tuple[str, dict]:
    where: list[str] = []
    params: dict = {}
    if from_date is not None:
        where.append("transfer_date >= :from_date")
        params["from_date"] = from_date
    if to_date is not None:
        where.append("transfer_date <= :to_date")
        params["to_date"] = to_date
    return (("WHERE " + " AND ".join(where)) if where else "", params)


# ---------------------------------------------------------------------------
# GET /  — list
# ---------------------------------------------------------------------------


@router.get(
    "/",
    response_model=list[TransferRead],
    summary="List transfers with optional date-range filters",
)
async def list_transfers(
    from_date: date | None = Query(None, alias="from"),
    to_date: date | None = Query(None, alias="to"),
) -> list[TransferRead]:
    where_sql, params = _build_where(from_date, to_date)
    rows = db.fetch_all(
        f"""
        SELECT * FROM transfers
        {where_sql}
        ORDER BY transfer_date DESC, created_at DESC
        """,
        params,
    )
    return [TransferRead(**r) for r in rows]


# ---------------------------------------------------------------------------
# GET /summary
# ---------------------------------------------------------------------------


@router.get(
    "/summary",
    response_model=TransferSummary,
    summary="KPI summary for the Transfers landing page",
)
async def get_summary(
    from_date: date | None = Query(None, alias="from"),
    to_date: date | None = Query(None, alias="to"),
) -> TransferSummary:
    where_sql, params = _build_where(from_date, to_date)
    row = db.fetch_one(
        f"""
        SELECT
            COALESCE(SUM(amount), 0) AS total_transferred,
            COUNT(*) AS transaction_count,
            COALESCE(SUM(estimated_tax_company), 0) AS est_company_tax,
            COALESCE(SUM(estimated_tax_personal), 0) AS est_personal_tax
        FROM transfers
        {where_sql}
        """,
        params,
    )
    total = row["total_transferred"] if isinstance(row["total_transferred"], Decimal) else Decimal(0)
    company = row["est_company_tax"] if isinstance(row["est_company_tax"], Decimal) else Decimal(0)
    personal = row["est_personal_tax"] if isinstance(row["est_personal_tax"], Decimal) else Decimal(0)
    return TransferSummary(
        total_transferred=total,
        transaction_count=int(row["transaction_count"] or 0),
        est_company_tax=company,
        est_personal_tax=personal,
        tax_exposure=(company + personal).quantize(Decimal("0.01")),
    )


# ---------------------------------------------------------------------------
# GET /tax-rates
# ---------------------------------------------------------------------------


@router.get(
    "/tax-rates",
    response_model=TransferTaxRates,
    summary="Default transfer tax rates from settings",
)
async def get_tax_rates() -> TransferTaxRates:
    """Read ``transfer_tax_rate_company`` and ``transfer_tax_rate_personal``
    from the ``settings`` table. Falls back to 0.30 / 0.325 (the legacy
    defaults) when missing so the auto-estimate still works on a fresh
    install."""
    company_raw = _get_setting("transfer_tax_rate_company") or "0.30"
    personal_raw = _get_setting("transfer_tax_rate_personal") or "0.325"
    return TransferTaxRates(
        company_rate=Decimal(company_raw),
        personal_rate=Decimal(personal_raw),
    )


# ---------------------------------------------------------------------------
# GET /{id}
# ---------------------------------------------------------------------------


@router.get(
    "/{transfer_id}",
    response_model=TransferRead,
    summary="Get a single transfer",
)
async def get_transfer(transfer_id: UUID) -> TransferRead:
    return TransferRead(**_fetch_or_404(transfer_id))


# ---------------------------------------------------------------------------
# POST /
# ---------------------------------------------------------------------------


@router.post(
    "/",
    response_model=TransferRead,
    status_code=201,
    summary="Record a new transfer",
)
async def create_transfer(body: TransferCreate) -> TransferRead:
    now = datetime.now(timezone.utc)
    new_id = uuid4()
    row = db.fetch_one(
        """
        INSERT INTO transfers (
            id, transfer_date, amount, method, purpose, category,
            estimated_tax_company, estimated_tax_personal,
            actual_tax_paid_company, actual_tax_paid_personal,
            tax_ledger_link_company, tax_ledger_link_personal,
            notes, created_at, updated_at
        ) VALUES (
            :id, :transfer_date, :amount, :method, :purpose, :category,
            :estimated_tax_company, :estimated_tax_personal,
            :actual_tax_paid_company, :actual_tax_paid_personal,
            :tax_ledger_link_company, :tax_ledger_link_personal,
            :notes, :created_at, :updated_at
        )
        RETURNING *
        """,
        {
            "id": new_id,
            "transfer_date": body.transfer_date,
            "amount": body.amount,
            "method": body.method,
            "purpose": body.purpose,
            "category": body.category,
            "estimated_tax_company": body.estimated_tax_company,
            "estimated_tax_personal": body.estimated_tax_personal,
            "actual_tax_paid_company": body.actual_tax_paid_company,
            "actual_tax_paid_personal": body.actual_tax_paid_personal,
            "tax_ledger_link_company": body.tax_ledger_link_company,
            "tax_ledger_link_personal": body.tax_ledger_link_personal,
            "notes": body.notes,
            "created_at": now,
            "updated_at": now,
        },
    )
    assert row is not None
    return TransferRead(**row)


# ---------------------------------------------------------------------------
# PUT /{id}
# ---------------------------------------------------------------------------


@router.put(
    "/{transfer_id}",
    response_model=TransferRead,
    summary="Replace a transfer (full update)",
)
async def update_transfer(
    transfer_id: UUID, body: TransferCreate
) -> TransferRead:
    _fetch_or_404(transfer_id)
    now = datetime.now(timezone.utc)
    row = db.fetch_one(
        """
        UPDATE transfers SET
            transfer_date = :transfer_date,
            amount = :amount,
            method = :method,
            purpose = :purpose,
            category = :category,
            estimated_tax_company = :estimated_tax_company,
            estimated_tax_personal = :estimated_tax_personal,
            actual_tax_paid_company = :actual_tax_paid_company,
            actual_tax_paid_personal = :actual_tax_paid_personal,
            tax_ledger_link_company = :tax_ledger_link_company,
            tax_ledger_link_personal = :tax_ledger_link_personal,
            notes = :notes,
            updated_at = :updated_at
        WHERE id = :id
        RETURNING *
        """,
        {
            "id": transfer_id,
            "transfer_date": body.transfer_date,
            "amount": body.amount,
            "method": body.method,
            "purpose": body.purpose,
            "category": body.category,
            "estimated_tax_company": body.estimated_tax_company,
            "estimated_tax_personal": body.estimated_tax_personal,
            "actual_tax_paid_company": body.actual_tax_paid_company,
            "actual_tax_paid_personal": body.actual_tax_paid_personal,
            "tax_ledger_link_company": body.tax_ledger_link_company,
            "tax_ledger_link_personal": body.tax_ledger_link_personal,
            "notes": body.notes,
            "updated_at": now,
        },
    )
    assert row is not None
    return TransferRead(**row)


# ---------------------------------------------------------------------------
# DELETE /{id}
# ---------------------------------------------------------------------------


@router.delete(
    "/{transfer_id}",
    status_code=204,
    summary="Delete a transfer",
)
async def delete_transfer(transfer_id: UUID) -> None:
    _fetch_or_404(transfer_id)
    db.execute(
        "DELETE FROM transfers WHERE id = :id",
        {"id": transfer_id},
    )
