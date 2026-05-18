"""FastAPI router for ``/investments/holdings``."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query

from app import db
from app.deps import get_current_user
from app.models.investments import (
    InvestmentHoldingCreate,
    InvestmentHoldingRead,
    InvestmentHoldingUpdate,
)

router = APIRouter(tags=["investments"], dependencies=[Depends(get_current_user)])


@router.get("/", response_model=list[InvestmentHoldingRead])
def list_holdings(
    account_id: UUID | None = Query(default=None),
) -> list[dict[str, Any]]:
    if account_id is not None:
        return db.fetch_all(
            """
            SELECT * FROM investment_holdings
            WHERE account_id = :account_id
            ORDER BY ticker
            """,
            {"account_id": account_id},
        )
    return db.fetch_all(
        """
        SELECT * FROM investment_holdings
        ORDER BY account_id, ticker
        """
    )


@router.post(
    "/",
    response_model=InvestmentHoldingRead,
    status_code=201,
)
def create_holding(payload: InvestmentHoldingCreate) -> dict[str, Any]:
    account = db.fetch_one(
        "SELECT id, currency FROM investment_accounts WHERE id = :id",
        {"id": payload.account_id},
    )
    if account is None:
        raise HTTPException(status_code=400, detail="Unknown account_id")

    # Enforce unique (account_id, ticker) friendly-side. The DB unique
    # index also enforces — this gives a nicer error than a 500.
    dup = db.fetch_one(
        """
        SELECT id FROM investment_holdings
        WHERE account_id = :account_id AND ticker = :ticker
        """,
        {"account_id": payload.account_id, "ticker": payload.ticker.upper()},
    )
    if dup is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Holding for {payload.ticker.upper()} already exists in "
                "this account. Edit the existing row to update shares."
            ),
        )

    now = datetime.now(timezone.utc)
    new_id = uuid4()
    row = db.fetch_one(
        """
        INSERT INTO investment_holdings (
            id, account_id, ticker, asset_class, shares, avg_cost,
            current_price, currency, as_of, notes, created_at, updated_at
        )
        VALUES (
            :id, :account_id, :ticker, :asset_class, :shares, :avg_cost,
            :current_price, :currency, :as_of, :notes, :now, :now
        )
        RETURNING *
        """,
        {
            "id": new_id,
            "account_id": payload.account_id,
            "ticker": payload.ticker.upper(),
            "asset_class": payload.asset_class,
            "shares": payload.shares,
            "avg_cost": payload.avg_cost,
            "current_price": payload.current_price,
            "currency": payload.currency.upper(),
            "as_of": payload.as_of,
            "notes": payload.notes,
            "now": now,
        },
    )
    if row is None:
        raise HTTPException(status_code=500, detail="Insert returned no row")
    return row


@router.patch("/{holding_id}", response_model=InvestmentHoldingRead)
def update_holding(
    holding_id: UUID, payload: InvestmentHoldingUpdate
) -> dict[str, Any]:
    existing = db.fetch_one(
        "SELECT id FROM investment_holdings WHERE id = :id", {"id": holding_id}
    )
    if existing is None:
        raise HTTPException(status_code=404, detail="Holding not found")

    fields = payload.model_dump(exclude_unset=True)
    if not fields:
        row = db.fetch_one(
            "SELECT * FROM investment_holdings WHERE id = :id",
            {"id": holding_id},
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Holding not found")
        return row

    if "ticker" in fields and fields["ticker"]:
        fields["ticker"] = fields["ticker"].upper()
    if "currency" in fields and fields["currency"]:
        fields["currency"] = fields["currency"].upper()

    # If `current_price` is being touched but `as_of` isn't, bump as_of
    # to today. The user's "I updated my prices today" intent is implied.
    if "current_price" in fields and "as_of" not in fields:
        fields["as_of"] = date.today()

    set_clauses = [f"{k} = :{k}" for k in fields]
    set_clauses.append("updated_at = :now")
    params: dict[str, Any] = {
        **fields,
        "now": datetime.now(timezone.utc),
        "id": holding_id,
    }
    row = db.fetch_one(
        f"UPDATE investment_holdings SET {', '.join(set_clauses)} "
        f"WHERE id = :id RETURNING *",
        params,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Holding not found")
    return row


@router.delete("/{holding_id}", status_code=204)
def delete_holding(holding_id: UUID) -> None:
    db.execute(
        "DELETE FROM investment_holdings WHERE id = :id", {"id": holding_id}
    )
