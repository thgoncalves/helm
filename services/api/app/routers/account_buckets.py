"""User-defined account categories — internally "buckets".

Mounts at ``/accounts/buckets``. The Accounts page uses these to group
its rows; deleting a bucket leaves its accounts in place with
``bucket_id = NULL`` thanks to the FK's ``ON DELETE SET NULL``.

The name "bucket" (vs. the user-facing "category") is intentional —
YNAB already owns the word "category" in this codebase as a budget
concept.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.deps import get_current_user
from app.models.account_buckets import (
    AccountBucketCreate,
    AccountBucketRead,
    AccountBucketUpdate,
)

router = APIRouter(
    prefix="/accounts/buckets",
    tags=["accounts"],
    dependencies=[Depends(get_current_user)],
)


# ---------------------------------------------------------------------------
# GET / — list
# ---------------------------------------------------------------------------


@router.get("", response_model=list[AccountBucketRead])
def list_buckets() -> list[AccountBucketRead]:
    rows = db.fetch_all(
        """
        SELECT id, name, color, sort_order, created_at, updated_at
        FROM account_buckets
        ORDER BY sort_order ASC, name ASC
        """
    )
    return [AccountBucketRead(**r) for r in rows]


# ---------------------------------------------------------------------------
# POST / — create
# ---------------------------------------------------------------------------


@router.post("", response_model=AccountBucketRead, status_code=201)
def create_bucket(payload: AccountBucketCreate) -> AccountBucketRead:
    """Create a category. New categories sort to the end by default."""
    existing = db.fetch_one(
        "SELECT id FROM account_buckets WHERE name = :name",
        {"name": payload.name},
    )
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "BUCKET_NAME_EXISTS",
                "name": payload.name,
            },
        )
    # Sort new categories last; the user can reorder later.
    next_order_row = db.fetch_one(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM account_buckets"
    )
    next_order = int(next_order_row["next"]) if next_order_row else 0
    row = db.fetch_one(
        """
        INSERT INTO account_buckets (name, color, sort_order)
        VALUES (:name, :color, :sort_order)
        RETURNING id, name, color, sort_order, created_at, updated_at
        """,
        {
            "name": payload.name,
            "color": payload.color,
            "sort_order": next_order,
        },
    )
    assert row is not None
    return AccountBucketRead(**row)


# ---------------------------------------------------------------------------
# PATCH /{id} — rename / recolor / reorder
# ---------------------------------------------------------------------------


@router.patch("/{bucket_id}", response_model=AccountBucketRead)
def update_bucket(
    bucket_id: UUID, payload: AccountBucketUpdate
) -> AccountBucketRead:
    fields = payload.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="No fields supplied.")

    # Reject rename collisions explicitly so the UI can surface a useful
    # message instead of a 500 from the unique constraint.
    if "name" in fields:
        existing = db.fetch_one(
            "SELECT id FROM account_buckets WHERE name = :name AND id <> :id",
            {"name": fields["name"], "id": bucket_id},
        )
        if existing is not None:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "BUCKET_NAME_EXISTS",
                    "name": fields["name"],
                },
            )

    set_clauses = [f"{k} = :{k}" for k in fields]
    set_clauses.append("updated_at = :now")
    params: dict[str, Any] = {"id": bucket_id, "now": datetime.now(timezone.utc)}
    params.update(fields)
    row = db.fetch_one(
        f"UPDATE account_buckets SET {', '.join(set_clauses)} "
        f"WHERE id = :id "
        f"RETURNING id, name, color, sort_order, created_at, updated_at",
        params,
    )
    if row is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "BUCKET_NOT_FOUND", "id": str(bucket_id)},
        )
    return AccountBucketRead(**row)


# ---------------------------------------------------------------------------
# DELETE /{id} — drop; accounts cascade to bucket_id = NULL
# ---------------------------------------------------------------------------


@router.delete("/{bucket_id}", status_code=204)
def delete_bucket(bucket_id: UUID) -> None:
    existing = db.fetch_one(
        "SELECT id FROM account_buckets WHERE id = :id",
        {"id": bucket_id},
    )
    if existing is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "BUCKET_NOT_FOUND", "id": str(bucket_id)},
        )
    # ON DELETE SET NULL on the FK takes care of orphaned bucket_id
    # references on manual_accounts / ynab_accounts.
    db.execute("DELETE FROM account_buckets WHERE id = :id", {"id": bucket_id})
