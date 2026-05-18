"""FastAPI router for ``/investments/accounts``."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query

from app import db
from app.deps import get_current_user
from app.models.investments import (
    InvestmentAccountCreate,
    InvestmentAccountRead,
    InvestmentAccountUpdate,
)

router = APIRouter(tags=["investments"], dependencies=[Depends(get_current_user)])


@router.get("/", response_model=list[InvestmentAccountRead])
def list_accounts(active: bool | None = Query(default=None)) -> list[dict[str, Any]]:
    if active is True:
        return db.fetch_all(
            "SELECT * FROM investment_accounts WHERE is_active = TRUE ORDER BY name"
        )
    if active is False:
        return db.fetch_all(
            "SELECT * FROM investment_accounts WHERE is_active = FALSE ORDER BY name"
        )
    return db.fetch_all("SELECT * FROM investment_accounts ORDER BY name")


@router.post(
    "/",
    response_model=InvestmentAccountRead,
    status_code=201,
)
def create_account(payload: InvestmentAccountCreate) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    new_id = uuid4()
    row = db.fetch_one(
        """
        INSERT INTO investment_accounts (
            id, name, kind, currency, owner_label, contribution_limit,
            notes, is_active, created_at, updated_at
        )
        VALUES (
            :id, :name, :kind, :currency, :owner_label, :contribution_limit,
            :notes, :is_active, :now, :now
        )
        RETURNING *
        """,
        {
            "id": new_id,
            "name": payload.name,
            "kind": payload.kind,
            "currency": payload.currency.upper(),
            "owner_label": payload.owner_label,
            "contribution_limit": payload.contribution_limit,
            "notes": payload.notes,
            "is_active": payload.is_active,
            "now": now,
        },
    )
    if row is None:
        raise HTTPException(status_code=500, detail="Insert returned no row")
    return row


@router.patch("/{account_id}", response_model=InvestmentAccountRead)
def update_account(
    account_id: UUID, payload: InvestmentAccountUpdate
) -> dict[str, Any]:
    existing = db.fetch_one(
        "SELECT id FROM investment_accounts WHERE id = :id", {"id": account_id}
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
    params: dict[str, Any] = {**fields, "now": datetime.now(timezone.utc), "id": account_id}
    row = db.fetch_one(
        f"UPDATE investment_accounts SET {', '.join(set_clauses)} "
        f"WHERE id = :id RETURNING *",
        params,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Account not found")
    return row


@router.delete("/{account_id}", status_code=204)
def delete_account(account_id: UUID) -> None:
    holding_count = db.fetch_one(
        "SELECT COUNT(*) AS n FROM investment_holdings WHERE account_id = :id",
        {"id": account_id},
    )
    if holding_count and int(holding_count.get("n") or 0) > 0:
        raise HTTPException(
            status_code=409,
            detail=(
                "Account has holdings — archive it (set is_active=false) "
                "instead, or delete the holdings first."
            ),
        )
    db.execute(
        "DELETE FROM investment_accounts WHERE id = :id", {"id": account_id}
    )


def _read_one(account_id: UUID) -> dict[str, Any]:
    row = db.fetch_one(
        "SELECT * FROM investment_accounts WHERE id = :id", {"id": account_id}
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Account not found")
    return row
