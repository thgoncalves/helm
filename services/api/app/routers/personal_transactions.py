"""FastAPI router for the ``/personal/transactions`` endpoints.

Read-mostly. Transactions are created by the CSV processor handler, not
by users (V1). The PATCH endpoint exists so the user can re-categorise
rows after the fact.
"""

from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from app import db
from app.deps import get_current_user
from app.models.personal_transactions import (
    PersonalTransactionRead,
    PersonalTransactionUpdate,
)

router = APIRouter(
    tags=["personal-transactions"],
    dependencies=[Depends(get_current_user)],
)


@router.get(
    "/",
    response_model=list[PersonalTransactionRead],
    summary="List transactions, optionally filtered by account / date",
)
async def list_transactions(
    account_id: UUID | None = Query(None),
    from_date: date | None = Query(None, alias="from"),
    to_date: date | None = Query(None, alias="to"),
    category: str | None = Query(None),
) -> list[PersonalTransactionRead]:
    where: list[str] = []
    params: dict = {}
    if account_id is not None:
        where.append("account_id = :account_id")
        params["account_id"] = account_id
    if from_date is not None:
        where.append("posted_date >= :from_date")
        params["from_date"] = from_date
    if to_date is not None:
        where.append("posted_date <= :to_date")
        params["to_date"] = to_date
    if category is not None:
        where.append("category = :category")
        params["category"] = category
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    rows = db.fetch_all(
        f"""
        SELECT * FROM personal_transactions
        {where_sql}
        ORDER BY posted_date DESC, created_at DESC
        """,
        params,
    )
    return [PersonalTransactionRead(**r) for r in rows]


@router.patch(
    "/{transaction_id}",
    response_model=PersonalTransactionRead,
    summary="Update user-editable fields (category)",
)
async def update_transaction(
    transaction_id: UUID, body: PersonalTransactionUpdate
) -> PersonalTransactionRead:
    row = db.fetch_one(
        "SELECT * FROM personal_transactions WHERE id = :id",
        {"id": transaction_id},
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Transaction not found")

    if body.category is None:
        return PersonalTransactionRead(**row)

    updated = db.fetch_one(
        """
        UPDATE personal_transactions
        SET category = :category
        WHERE id = :id
        RETURNING *
        """,
        {"id": transaction_id, "category": body.category},
    )
    assert updated is not None
    return PersonalTransactionRead(**updated)
