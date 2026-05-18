"""FastAPI router for ``/investments/targets``.

Targets are a small set (≤ 9 rows — one per AssetClass enum value) so
the API surface is just GET (list) + PUT (atomic replace). Asset classes
omitted from the PUT body are deleted.
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.deps import get_current_user
from app.models.investments import (
    TargetAllocationRow,
    TargetAllocationsPut,
)

router = APIRouter(tags=["investments"], dependencies=[Depends(get_current_user)])

_SUM_TOLERANCE = Decimal("0.01")


@router.get("/", response_model=list[TargetAllocationRow])
def list_targets() -> list[dict[str, Any]]:
    return db.fetch_all(
        "SELECT asset_class, target_pct FROM target_allocations ORDER BY asset_class"
    )


@router.put("/", response_model=list[TargetAllocationRow])
def replace_targets(payload: TargetAllocationsPut) -> list[dict[str, Any]]:
    if not payload.targets:
        # Empty payload deletes all targets. That's a valid state — user
        # is removing their target allocation entirely.
        db.execute("DELETE FROM target_allocations")
        return []

    # Reject duplicates: each asset_class can appear at most once.
    seen: set[str] = set()
    for t in payload.targets:
        key = str(t.asset_class)
        if key in seen:
            raise HTTPException(
                status_code=400,
                detail=f"Duplicate asset_class in payload: {key}",
            )
        seen.add(key)

    total = sum((t.target_pct for t in payload.targets), Decimal("0"))
    if abs(total - Decimal("100")) > _SUM_TOLERANCE:
        raise HTTPException(
            status_code=400,
            detail=(
                f"target_pct rows must sum to 100; got {total}. "
                "Adjust the percentages and resubmit."
            ),
        )

    now = datetime.now(timezone.utc)
    db.execute("DELETE FROM target_allocations")
    for row in payload.targets:
        db.execute(
            """
            INSERT INTO target_allocations (asset_class, target_pct, updated_at)
            VALUES (:asset_class, :target_pct, :now)
            """,
            {
                "asset_class": row.asset_class,
                "target_pct": row.target_pct,
                "now": now,
            },
        )

    return db.fetch_all(
        "SELECT asset_class, target_pct FROM target_allocations ORDER BY asset_class"
    )
