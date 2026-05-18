"""FastAPI router for ``/investments/accounts/{account_id}/contributions``.

Track money in / out of investment accounts. For Brazilian (BRL)
accounts each row stores the BRL→CAD rate on the contribution date so
the CAD cost basis is locked in at the time of the deposit — today's
rate doesn't retroactively rewrite history.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.deps import get_current_user
from app.investments.fx import (
    FxRateUnavailable,
    get_rate,
)
from app.models.investments import (
    ContributionRoom,
    InvestmentContributionCreate,
    InvestmentContributionRead,
    InvestmentContributionUpdate,
)

router = APIRouter(tags=["investments"], dependencies=[Depends(get_current_user)])

_BASE_CURRENCY = "CAD"


def _account_or_404(account_id: UUID) -> dict[str, Any]:
    row = db.fetch_one(
        "SELECT id, currency FROM investment_accounts WHERE id = :id",
        {"id": account_id},
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Account not found")
    return row


def _resolve_fx_to_cad(currency: str, on: date) -> Decimal:
    """Return the FX rate from `currency` to CAD on `on`.

    CAD → CAD is exactly 1. Any other currency hits the BoC cache; if
    the BoC fetch fails and there's nothing within the stale window, a
    typed 503 is surfaced so the user can retry later instead of
    silently writing a bad cost basis.
    """
    upper = currency.upper()
    if upper == _BASE_CURRENCY:
        return Decimal("1")
    try:
        rate = get_rate(upper, _BASE_CURRENCY, on=on)
    except FxRateUnavailable as e:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "FX_UNAVAILABLE",
                "message": str(e),
                "currency": upper,
                "on": on.isoformat(),
            },
        ) from e
    return rate.rate


def _signed_amount_cad(
    kind: str, amount: Decimal, fx_rate_cad: Decimal
) -> Decimal:
    """Apply the kind's sign to the CAD amount.

    Deposits are positive (money in). Withdrawals are negative (money
    out). Reports SUM(amount_cad) to get net contributions without
    branching on kind.
    """
    magnitude = (amount * fx_rate_cad).quantize(Decimal("0.01"))
    return -magnitude if kind == "withdrawal" else magnitude


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@router.get(
    "/accounts/{account_id}/contributions",
    response_model=list[InvestmentContributionRead],
)
def list_contributions(account_id: UUID) -> list[dict[str, Any]]:
    _account_or_404(account_id)
    return db.fetch_all(
        """
        SELECT * FROM investment_contributions
        WHERE account_id = :account_id
        ORDER BY contributed_on DESC, created_at DESC
        """,
        {"account_id": account_id},
    )


@router.post(
    "/accounts/{account_id}/contributions",
    response_model=InvestmentContributionRead,
    status_code=201,
)
def create_contribution(
    account_id: UUID, payload: InvestmentContributionCreate
) -> dict[str, Any]:
    _account_or_404(account_id)

    fx_rate = _resolve_fx_to_cad(payload.currency, payload.contributed_on)
    amount_cad = _signed_amount_cad(payload.kind, payload.amount, fx_rate)

    now = datetime.now(timezone.utc)
    new_id = uuid4()
    row = db.fetch_one(
        """
        INSERT INTO investment_contributions (
            id, account_id, contributed_on, kind, amount, currency,
            fx_rate_cad, amount_cad, notes, created_at, updated_at
        )
        VALUES (
            :id, :account_id, :contributed_on, :kind, :amount, :currency,
            :fx_rate_cad, :amount_cad, :notes, :now, :now
        )
        RETURNING *
        """,
        {
            "id": new_id,
            "account_id": account_id,
            "contributed_on": payload.contributed_on,
            "kind": payload.kind,
            "amount": payload.amount,
            "currency": payload.currency.upper(),
            "fx_rate_cad": fx_rate,
            "amount_cad": amount_cad,
            "notes": payload.notes,
            "now": now,
        },
    )
    if row is None:
        raise HTTPException(status_code=500, detail="Insert returned no row")
    return row


@router.patch(
    "/accounts/{account_id}/contributions/{contribution_id}",
    response_model=InvestmentContributionRead,
)
def update_contribution(
    account_id: UUID,
    contribution_id: UUID,
    payload: InvestmentContributionUpdate,
) -> dict[str, Any]:
    existing = db.fetch_one(
        """
        SELECT * FROM investment_contributions
        WHERE id = :id AND account_id = :account_id
        """,
        {"id": contribution_id, "account_id": account_id},
    )
    if existing is None:
        raise HTTPException(status_code=404, detail="Contribution not found")

    patch = payload.model_dump(exclude_unset=True)
    merged = {**existing, **patch}
    if "currency" in patch and patch["currency"]:
        merged["currency"] = patch["currency"].upper()

    # Recompute fx_rate_cad + amount_cad whenever currency, date, kind
    # or amount change. Cheaper to always recompute than to enumerate
    # every conditional.
    fx_rate = _resolve_fx_to_cad(
        str(merged["currency"]), merged["contributed_on"]
    )
    amount_cad = _signed_amount_cad(
        str(merged["kind"]),
        Decimal(str(merged["amount"])),
        fx_rate,
    )

    now = datetime.now(timezone.utc)
    row = db.fetch_one(
        """
        UPDATE investment_contributions
        SET contributed_on = :contributed_on,
            kind = :kind,
            amount = :amount,
            currency = :currency,
            fx_rate_cad = :fx_rate_cad,
            amount_cad = :amount_cad,
            notes = :notes,
            updated_at = :now
        WHERE id = :id AND account_id = :account_id
        RETURNING *
        """,
        {
            "contributed_on": merged["contributed_on"],
            "kind": merged["kind"],
            "amount": merged["amount"],
            "currency": merged["currency"],
            "fx_rate_cad": fx_rate,
            "amount_cad": amount_cad,
            "notes": merged.get("notes"),
            "now": now,
            "id": contribution_id,
            "account_id": account_id,
        },
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Contribution not found")
    return row


@router.delete(
    "/accounts/{account_id}/contributions/{contribution_id}",
    status_code=204,
)
def delete_contribution(account_id: UUID, contribution_id: UUID) -> None:
    db.execute(
        """
        DELETE FROM investment_contributions
        WHERE id = :id AND account_id = :account_id
        """,
        {"id": contribution_id, "account_id": account_id},
    )


# ---------------------------------------------------------------------------
# Registered-room widget (separate endpoint so the Overview can render
# without pulling every contribution row).
# ---------------------------------------------------------------------------


@router.get("/contributions/room", response_model=list[ContributionRoom])
def get_room() -> list[ContributionRoom]:
    """Per-account remaining room for the current calendar year.

    Only includes accounts with a contribution_limit set — typically
    RRSP and TFSA. Limit is treated as a yearly cap; we sum contributions
    where ``contributed_on`` is in the current calendar year, then
    subtract from the limit. (RRSP's deduction-limit semantics are
    different from TFSA's hard cap; we're using calendar-year semantics
    as a first approximation. If you need RRSP's first-60-days rule, we
    can split the math later.)
    """
    rows: list[dict[str, Any]] = db.fetch_all(
        """
        SELECT
            a.id AS account_id,
            a.name AS account_name,
            a.kind AS account_kind,
            a.currency AS currency,
            a.contribution_limit AS contribution_limit,
            COALESCE((
                SELECT SUM(c.amount_cad)
                FROM investment_contributions c
                WHERE c.account_id = a.id
                  AND c.contributed_on >= :year_start
                  AND c.contributed_on <= :year_end
            ), 0) AS contributed_ytd
        FROM investment_accounts a
        WHERE a.contribution_limit IS NOT NULL
          AND a.is_active = TRUE
        ORDER BY a.kind, a.name
        """,
        {
            "year_start": date(date.today().year, 1, 1),
            "year_end": date(date.today().year, 12, 31),
        },
    )

    out: list[ContributionRoom] = []
    for r in rows:
        limit = Decimal(str(r["contribution_limit"] or 0))
        ytd = Decimal(str(r["contributed_ytd"] or 0))
        out.append(
            ContributionRoom(
                account_id=r["account_id"],
                account_name=str(r["account_name"]),
                account_kind=str(r["account_kind"]),  # type: ignore[arg-type]
                currency=str(r["currency"]),
                contribution_limit=limit,
                contributed_ytd=ytd,
                remaining=(limit - ytd).quantize(Decimal("0.01")),
            )
        )
    return out
