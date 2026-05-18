"""FastAPI router for ``/accounts`` — the unified Accounts page.

Reads from three sources and unions them into a common shape:

* ``ynab_accounts``        — read-only, synced from YNAB.
* ``manual_accounts``      — fully editable cash accounts.
* ``investment_accounts``  — editable brokerage rows with optional cash + holdings.

Writes on this router are limited to the Helm-side taxonomy
(``kind`` + ``owner``); the source-specific CRUD (manual create/update,
investment account fields) lives on its own router so this aggregator
stays read-mostly.

The Sync action on the page hits :func:`sync_ynab_accounts`, which is a
thin alias over ``POST /money/ynab/refresh`` so the URL matches what the
user sees ("Sync accounts" instead of "Refresh YNAB").
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.deps import get_current_user
from app.investments.fx import FxRateUnavailable, get_rate
from app.models.accounts import (
    AccountListResponse,
    AccountRow,
    AccountTagsUpdate,
)
from app.models.ynab import YnabRefreshResponse
from app.ynab import token as ynab_token
from app.ynab.client import (
    YnabApiError,
    YnabAuthError,
    YnabClient,
    YnabRateLimit,
)
from app.ynab.sync import refresh as run_refresh

router = APIRouter(
    prefix="/accounts",
    tags=["accounts"],
    dependencies=[Depends(get_current_user)],
)

# Maps the YNAB account-type strings we expect onto Helm's kind
# taxonomy. Anything not in this table starts life as "unassigned" —
# the user assigns it on the Accounts page. We don't auto-classify
# beyond the obvious cases because YNAB's "otherAsset" / "otherLiability"
# buckets can be anything.
_YNAB_TYPE_TO_KIND: dict[str, str] = {
    "checking": "checking",
    "savings": "savings",
    "lineOfCredit": "line_of_credit",
    "creditCard": "line_of_credit",
}


# ---------------------------------------------------------------------------
# GET / — unified list
# ---------------------------------------------------------------------------


@router.get("", response_model=AccountListResponse)
def list_accounts() -> AccountListResponse:
    """Union of all three account sources, normalised for the page."""
    rows: list[AccountRow] = []
    rows.extend(_load_ynab_rows())
    rows.extend(_load_manual_rows())
    rows.extend(_load_investment_rows())
    return AccountListResponse(accounts=rows)


# ---------------------------------------------------------------------------
# PATCH /{source}/{id}/tags — assign kind / owner
# ---------------------------------------------------------------------------


@router.patch("/{source}/{account_id}/tags", response_model=AccountRow)
def update_tags(
    source: str,
    account_id: str,
    payload: AccountTagsUpdate,
) -> AccountRow:
    """Update the Helm-side taxonomy on any source's account row.

    For YNAB rows this writes ``helm_kind`` / ``helm_owner`` (the only
    Helm-mutable columns on a synced row). For manual + investment rows
    it writes the equivalent native columns.
    """
    fields = payload.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(
            status_code=400, detail="No tag fields supplied."
        )

    # The wire taxonomy uses "unassigned" as the sentinel for "no value".
    # Translate that to NULL at the DB layer so the column type stays
    # nullable + nice to query.
    def _denull(v: Any) -> Any:
        return None if v == "unassigned" else v

    now = datetime.now(timezone.utc)

    if source == "ynab":
        col_map = {"kind": "helm_kind", "owner": "helm_owner"}
        set_clauses = [
            f"{col_map[k]} = :{col_map[k]}" for k in fields
        ]
        set_clauses.append("last_synced_at = :now")
        params: dict[str, Any] = {"id": account_id, "now": now}
        for k, v in fields.items():
            params[col_map[k]] = _denull(v)
        row = db.fetch_one(
            f"UPDATE ynab_accounts SET {', '.join(set_clauses)} "
            f"WHERE id = :id RETURNING *",
            params,
        )
        if row is None:
            raise HTTPException(
                status_code=404, detail="YNAB account not cached."
            )
        return _ynab_row_to_account(row)

    if source == "manual":
        col_map = {"kind": "kind", "owner": "owner"}
        set_clauses = [
            f"{col_map[k]} = :{col_map[k]}" for k in fields
        ]
        set_clauses.append("updated_at = :now")
        params = {"id": _parse_uuid(account_id), "now": now}
        for k, v in fields.items():
            # Manual accounts disallow NULL on these columns — they're
            # required at create time. Reject the unassigned sentinel.
            if v == "unassigned":
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Manual accounts can't be untagged; pick a "
                        "specific kind/owner."
                    ),
                )
            params[col_map[k]] = v
        row = db.fetch_one(
            f"UPDATE manual_accounts SET {', '.join(set_clauses)} "
            f"WHERE id = :id RETURNING *",
            params,
        )
        if row is None:
            raise HTTPException(
                status_code=404, detail="Manual account not found."
            )
        return _manual_row_to_account(row)

    if source == "investment":
        col_map = {"kind": "helm_kind", "owner": "owner"}
        set_clauses = [
            f"{col_map[k]} = :{col_map[k]}" for k in fields
        ]
        set_clauses.append("updated_at = :now")
        params = {"id": _parse_uuid(account_id), "now": now}
        for k, v in fields.items():
            params[col_map[k]] = _denull(v)
        row = db.fetch_one(
            f"UPDATE investment_accounts SET {', '.join(set_clauses)} "
            f"WHERE id = :id RETURNING *",
            params,
        )
        if row is None:
            raise HTTPException(
                status_code=404, detail="Investment account not found."
            )
        return _investment_row_to_account(row)

    raise HTTPException(
        status_code=404, detail=f"Unknown account source: {source!r}"
    )


# ---------------------------------------------------------------------------
# POST /ynab/sync — alias for /money/ynab/refresh
# ---------------------------------------------------------------------------


@router.post("/ynab/sync", response_model=YnabRefreshResponse)
def sync_ynab_accounts() -> YnabRefreshResponse:
    """Pull a fresh YNAB snapshot. Bound to the Accounts page Sync button.

    Same handler as :func:`app.routers.money_ynab.refresh`; lives here
    too so the page's URL matches its mental model.
    """
    client = YnabClient()
    try:
        result = run_refresh(client=client)
    except ynab_token.YnabTokenNotConfigured as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except YnabAuthError as e:
        raise HTTPException(
            status_code=502,
            detail={"code": "YNAB_AUTH", "message": str(e)},
        ) from e
    except YnabRateLimit as e:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "YNAB_RATE_LIMIT",
                "retry_after": e.retry_after,
            },
        ) from e
    except YnabApiError as e:
        raise HTTPException(
            status_code=502,
            detail={"code": "YNAB_UPSTREAM", "message": str(e)},
        ) from e

    return YnabRefreshResponse(
        budget_id=result.budget_id,
        budget_name=result.budget_name,
        accounts_upserted=result.accounts_upserted,
        categories_upserted=result.categories_upserted,
        month_rows_upserted=result.month_rows_upserted,
        transactions_upserted=result.transactions_upserted,
        updated_at=result.synced_at or datetime.now(timezone.utc),
    )


# ---------------------------------------------------------------------------
# Loaders — one per source
# ---------------------------------------------------------------------------


def _load_ynab_rows() -> list[AccountRow]:
    """Read ``ynab_accounts``, dropping closed/deleted rows.

    Budget currency is fetched once from ``ynab_budgets`` and shared by
    all rows in the budget — YNAB enforces single-currency budgets, so
    this saves a JOIN per row.
    """
    budgets = db.fetch_all(
        "SELECT id, currency_code FROM ynab_budgets WHERE is_active = TRUE"
    )
    ccy_by_budget: dict[str, str] = {
        b["id"]: (b.get("currency_code") or "CAD") for b in budgets
    }
    rows = db.fetch_all(
        """
        SELECT *
        FROM ynab_accounts
        WHERE closed = FALSE AND deleted = FALSE
        ORDER BY name
        """
    )
    return [_ynab_row_to_account(r, ccy_by_budget) for r in rows]


def _load_manual_rows() -> list[AccountRow]:
    rows = db.fetch_all(
        "SELECT * FROM manual_accounts WHERE is_active = TRUE ORDER BY name"
    )
    return [_manual_row_to_account(r) for r in rows]


def _load_investment_rows() -> list[AccountRow]:
    rows = db.fetch_all(
        "SELECT * FROM investment_accounts WHERE is_active = TRUE ORDER BY name"
    )
    return [_investment_row_to_account(r) for r in rows]


# ---------------------------------------------------------------------------
# Row → AccountRow shape conversion
# ---------------------------------------------------------------------------


def _ynab_row_to_account(
    row: dict[str, Any],
    ccy_by_budget: dict[str, str] | None = None,
) -> AccountRow:
    budget_id = row.get("budget_id") or ""
    currency = (
        (ccy_by_budget or {}).get(budget_id)
        or _budget_currency(budget_id)
        or "CAD"
    )
    balance = _milliunits_to_decimal(row.get("balance") or 0)
    helm_kind = row.get("helm_kind") or _YNAB_TYPE_TO_KIND.get(
        row.get("type") or "", "unassigned"
    )
    return AccountRow(
        source="ynab",
        id=f"ynab:{row['id']}",
        name=row.get("name") or "",
        bank=None,
        currency=currency,
        balance=balance,
        balance_cad=_to_cad(balance, currency),
        balance_as_of=None,
        last_synced_at=row.get("last_synced_at"),
        kind=helm_kind,
        owner=row.get("helm_owner") or "unassigned",
        is_editable=False,
        is_active=True,
        extra={
            "ynab_type": row.get("type"),
            "on_budget": bool(row.get("on_budget")),
            "budget_id": budget_id,
        },
    )


def _manual_row_to_account(row: dict[str, Any]) -> AccountRow:
    currency = row.get("currency") or "BRL"
    balance = Decimal(row.get("balance") or 0)
    return AccountRow(
        source="manual",
        id=f"manual:{row['id']}",
        name=row.get("name") or "",
        bank=row.get("bank"),
        currency=currency,
        balance=balance,
        balance_cad=_to_cad(balance, currency),
        balance_as_of=row.get("balance_as_of"),
        last_synced_at=None,
        kind=row.get("kind") or "unassigned",
        owner=row.get("owner") or "unassigned",
        is_editable=True,
        is_active=bool(row.get("is_active", True)),
        extra={},
    )


def _investment_row_to_account(row: dict[str, Any]) -> AccountRow:
    currency = row.get("currency") or "CAD"
    cash_balance = Decimal(row.get("cash_balance") or 0)
    holdings_value, holdings_count = _holdings_summary(row["id"], currency)
    total = cash_balance + holdings_value
    return AccountRow(
        source="investment",
        id=f"investment:{row['id']}",
        name=row.get("name") or "",
        bank=row.get("bank"),
        currency=currency,
        balance=total,
        balance_cad=_to_cad(total, currency),
        balance_as_of=row.get("balance_as_of"),
        last_synced_at=None,
        kind=row.get("helm_kind") or "unassigned",
        owner=row.get("owner") or "unassigned",
        is_editable=True,
        is_active=bool(row.get("is_active", True)),
        extra={
            "regulatory_kind": row.get("kind"),
            "cash_balance": float(cash_balance),
            "cash_currency": row.get("cash_currency") or currency,
            "holdings_count": holdings_count,
            "holdings_value": float(holdings_value),
            "contribution_limit": (
                float(row["contribution_limit"])
                if row.get("contribution_limit") is not None
                else None
            ),
        },
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _milliunits_to_decimal(amount: int | float) -> Decimal:
    """Convert YNAB's milliunits (CAD 12.34 → 12340) to Decimal dollars."""
    return (Decimal(int(amount)) / Decimal(1000)).quantize(Decimal("0.01"))


def _to_cad(amount: Decimal, currency: str) -> Decimal | None:
    """Convert ``amount`` to CAD via the FX cache. Returns ``None`` on miss."""
    if (currency or "").upper() == "CAD":
        return amount
    try:
        rate = get_rate(currency, "CAD")
    except FxRateUnavailable:
        return None
    return (amount * rate.rate).quantize(Decimal("0.01"))


def _budget_currency(budget_id: str) -> str | None:
    if not budget_id:
        return None
    row = db.fetch_one(
        "SELECT currency_code FROM ynab_budgets WHERE id = :id",
        {"id": budget_id},
    )
    return row.get("currency_code") if row else None


def _holdings_summary(
    account_id: Any, account_currency: str
) -> tuple[Decimal, int]:
    """Sum ``shares * current_price`` for the account; return (total, count).

    Returns ``(0, 0)`` if no holdings — keeps the aggregator simple for
    cash-only / fund-style accounts.
    """
    row = db.fetch_one(
        """
        SELECT
          COALESCE(SUM(shares * current_price), 0) AS total,
          COUNT(*) AS n
        FROM investment_holdings
        WHERE account_id = :id
        """,
        {"id": account_id},
    )
    if row is None:
        return Decimal("0"), 0
    total = Decimal(row.get("total") or 0)
    count = int(row.get("n") or 0)
    return total, count


def _parse_uuid(s: str) -> UUID:
    try:
        return UUID(s)
    except (ValueError, TypeError) as e:
        raise HTTPException(
            status_code=400, detail=f"Invalid id: {s!r}"
        ) from e
