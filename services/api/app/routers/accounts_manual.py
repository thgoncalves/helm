"""FastAPI router for ``/accounts/manual`` — non-YNAB cash accounts.

CRUD over the ``manual_accounts`` table. The unified Accounts page reads
these via the aggregator at ``/accounts``; this router handles writes.

``balance_as_of`` is server-managed: any PATCH that includes a balance
value bumps the timestamp to ``CURRENT_DATE`` so the UI can show
"updated N days ago" without trusting the client.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query

from app import db
from app.deps import get_current_user
from app.models.manual_accounts import (
    ManualAccountCreate,
    ManualAccountRead,
    ManualAccountUpdate,
)
from app.money.snapshots import record_snapshot

router = APIRouter(
    prefix="/accounts/manual",
    tags=["accounts"],
    dependencies=[Depends(get_current_user)],
)


@router.get("", response_model=list[ManualAccountRead])
def list_manual_accounts(
    active: bool | None = Query(default=None),
) -> list[dict[str, Any]]:
    if active is True:
        return db.fetch_all(
            "SELECT * FROM manual_accounts WHERE is_active = TRUE ORDER BY name"
        )
    if active is False:
        return db.fetch_all(
            "SELECT * FROM manual_accounts WHERE is_active = FALSE ORDER BY name"
        )
    return db.fetch_all("SELECT * FROM manual_accounts ORDER BY name")


@router.post("", response_model=ManualAccountRead, status_code=201)
def create_manual_account(payload: ManualAccountCreate) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    today = date.today()
    new_id = uuid4()
    row = db.fetch_one(
        """
        INSERT INTO manual_accounts (
            id, name, bank, currency, balance, balance_as_of,
            kind, owner, notes, is_active,
            created_at, updated_at
        )
        VALUES (
            :id, :name, :bank, :currency, :balance, :today,
            :kind, :owner, :notes, :is_active,
            :now, :now
        )
        RETURNING *
        """,
        {
            "id": new_id,
            "name": payload.name,
            "bank": payload.bank,
            "currency": payload.currency.upper(),
            "balance": payload.balance,
            "today": today,
            "kind": payload.kind,
            "owner": payload.owner,
            "notes": payload.notes,
            "is_active": payload.is_active,
            "now": now,
        },
    )
    if row is None:
        raise HTTPException(status_code=500, detail="Insert returned no row")
    record_snapshot()
    return row


@router.patch("/{account_id}", response_model=ManualAccountRead)
def update_manual_account(
    account_id: UUID, payload: ManualAccountUpdate
) -> dict[str, Any]:
    existing = db.fetch_one(
        "SELECT id FROM manual_accounts WHERE id = :id", {"id": account_id}
    )
    if existing is None:
        raise HTTPException(status_code=404, detail="Account not found")

    fields = payload.model_dump(exclude_unset=True)
    if not fields:
        return _read_one(account_id)

    if "currency" in fields and fields["currency"]:
        fields["currency"] = fields["currency"].upper()

    set_clauses = [f"{k} = :{k}" for k in fields]
    set_clauses.append("updated_at = :now")
    # Bump balance_as_of when the user updates the balance.
    if "balance" in fields:
        set_clauses.append("balance_as_of = :today")

    params: dict[str, Any] = {
        **fields,
        "now": datetime.now(timezone.utc),
        "today": date.today(),
        "id": account_id,
    }
    row = db.fetch_one(
        f"UPDATE manual_accounts SET {', '.join(set_clauses)} "
        f"WHERE id = :id RETURNING *",
        params,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Account not found")
    record_snapshot()
    return row


@router.delete("/{account_id}", status_code=204)
def delete_manual_account(account_id: UUID) -> None:
    # Hard delete — manual accounts have no FK dependents and the user
    # expects "delete" to actually remove the row, not archive it.
    db.execute(
        "DELETE FROM manual_accounts WHERE id = :id",
        {"id": account_id},
    )
    record_snapshot()


def _read_one(account_id: UUID) -> dict[str, Any]:
    row = db.fetch_one(
        "SELECT * FROM manual_accounts WHERE id = :id", {"id": account_id}
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Account not found")
    return row
