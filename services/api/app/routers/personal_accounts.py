"""FastAPI router for the ``/personal/accounts`` endpoints.

CRUD plus archive (``is_active``) toggle. Hard delete is allowed only
when no transactions reference the account — otherwise the user must
archive instead. The frontend nudges them toward archive in either
case.
"""

from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query

from app import db
from app.deps import get_current_user
from app.models.personal_accounts import (
    PersonalAccountCreate,
    PersonalAccountRead,
)

router = APIRouter(
    tags=["personal-accounts"], dependencies=[Depends(get_current_user)]
)


def _fetch_or_404(account_id: UUID) -> dict:
    row = db.fetch_one(
        "SELECT * FROM personal_accounts WHERE id = :id",
        {"id": account_id},
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Account not found")
    return row


@router.get(
    "/",
    response_model=list[PersonalAccountRead],
    summary="List personal accounts",
)
async def list_accounts(
    include_archived: bool = Query(default=False),
) -> list[PersonalAccountRead]:
    if include_archived:
        rows = db.fetch_all(
            "SELECT * FROM personal_accounts ORDER BY is_active DESC, name ASC"
        )
    else:
        rows = db.fetch_all(
            "SELECT * FROM personal_accounts WHERE is_active = TRUE ORDER BY name ASC"
        )
    return [PersonalAccountRead(**r) for r in rows]


@router.get(
    "/{account_id}",
    response_model=PersonalAccountRead,
    summary="Get a single personal account",
)
async def get_account(account_id: UUID) -> PersonalAccountRead:
    return PersonalAccountRead(**_fetch_or_404(account_id))


@router.post(
    "/",
    response_model=PersonalAccountRead,
    status_code=201,
    summary="Create a personal account",
)
async def create_account(body: PersonalAccountCreate) -> PersonalAccountRead:
    now = datetime.now(timezone.utc)
    row = db.fetch_one(
        """
        INSERT INTO personal_accounts (
            id, name, institution, account_type, currency,
            opening_balance, is_active, notes,
            created_at, updated_at
        ) VALUES (
            :id, :name, :institution, :account_type, :currency,
            :opening_balance, :is_active, :notes,
            :now, :now
        )
        RETURNING *
        """,
        {
            "id": uuid4(),
            "name": body.name,
            "institution": body.institution,
            "account_type": body.account_type,
            "currency": body.currency or "CAD",
            "opening_balance": body.opening_balance or 0,
            "is_active": body.is_active,
            "notes": body.notes,
            "now": now,
        },
    )
    assert row is not None
    return PersonalAccountRead(**row)


@router.put(
    "/{account_id}",
    response_model=PersonalAccountRead,
    summary="Replace a personal account (full update)",
)
async def update_account(
    account_id: UUID, body: PersonalAccountCreate
) -> PersonalAccountRead:
    _fetch_or_404(account_id)
    now = datetime.now(timezone.utc)
    row = db.fetch_one(
        """
        UPDATE personal_accounts SET
            name = :name,
            institution = :institution,
            account_type = :account_type,
            currency = :currency,
            opening_balance = :opening_balance,
            is_active = :is_active,
            notes = :notes,
            updated_at = :now
        WHERE id = :id
        RETURNING *
        """,
        {
            "id": account_id,
            "name": body.name,
            "institution": body.institution,
            "account_type": body.account_type,
            "currency": body.currency or "CAD",
            "opening_balance": body.opening_balance or 0,
            "is_active": body.is_active,
            "notes": body.notes,
            "now": now,
        },
    )
    assert row is not None
    return PersonalAccountRead(**row)


@router.delete(
    "/{account_id}",
    status_code=204,
    summary="Delete a personal account (only if no transactions exist)",
)
async def delete_account(account_id: UUID) -> None:
    _fetch_or_404(account_id)
    txn_count = db.fetch_one(
        """
        SELECT COUNT(*) AS n FROM personal_transactions
        WHERE account_id = :id
        """,
        {"id": account_id},
    )
    if txn_count and txn_count.get("n", 0) > 0:
        raise HTTPException(
            status_code=409,
            detail=(
                "Account has transactions — archive it (set is_active=false) "
                "instead of deleting."
            ),
        )
    db.execute(
        "DELETE FROM personal_accounts WHERE id = :id",
        {"id": account_id},
    )
