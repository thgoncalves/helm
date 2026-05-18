"""FastAPI router for ``/money/integrations/ynab/*`` + ``/money/ynab/*``.

Owns the lifecycle of the YNAB Personal Access Token (store + status +
test connection) and the refresh-on-demand endpoint that pulls fresh
YNAB data into the local Postgres cache.

Errors from YNAB are mapped to typed HTTP statuses the frontend can
surface as banners:

* ``YnabAuthError``   → 502 ``{"code": "YNAB_AUTH",       …}``
* ``YnabRateLimit``   → 503 ``{"code": "YNAB_RATE_LIMIT", "retry_after": …}``
* anything else       → 502 ``{"code": "YNAB_UPSTREAM",   …}``
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.config import settings
from app.deps import get_current_user
from app.models.ynab import (
    YnabRefreshResponse,
    YnabStatusResponse,
    YnabTokenPut,
)
from app.ynab import token as ynab_token
from app.ynab.client import (
    YnabApiError,
    YnabAuthError,
    YnabClient,
    YnabRateLimit,
)
from app.ynab.sync import refresh as run_refresh

router = APIRouter(tags=["money"], dependencies=[Depends(get_current_user)])


def _db_configured() -> bool:
    """Both Aurora ARNs must be set for db.execute to work."""
    return bool(
        settings.database_resource_arn and settings.database_secret_arn
    )


@router.get("/integrations/ynab/status", response_model=YnabStatusResponse)
def get_status() -> YnabStatusResponse:
    """Report whether the user has connected YNAB yet.

    Returns ``token_configured=False`` when the secret has never been
    populated, so the frontend can render the "Connect YNAB" empty state
    without trying to fetch dashboard data.
    """
    try:
        token = ynab_token.load_token()
    except ynab_token.YnabTokenNotConfigured:
        return YnabStatusResponse(token_configured=False)

    # Budget metadata lives in the cache DB. Surface a "connected but
    # never synced" state when the DB is unconfigured or unreachable —
    # the Settings page still wants to render "Connected" even if Helm
    # can't yet confirm which budget is active.
    row: dict[str, Any] | None = None
    if _db_configured():
        try:
            row = db.fetch_one(
                """
                SELECT id, name, last_synced_at
                FROM ynab_budgets
                WHERE is_active = TRUE
                LIMIT 1
                """
            )
        except Exception:
            row = None

    return YnabStatusResponse(
        token_configured=bool(token),
        last_synced_at=row["last_synced_at"] if row else None,
        active_budget_name=row["name"] if row else None,
        active_budget_id=row["id"] if row else None,
    )


@router.put("/integrations/ynab/token", response_model=YnabStatusResponse)
def put_token(payload: YnabTokenPut) -> YnabStatusResponse:
    """Store (or rotate) the YNAB Personal Access Token.

    The supplied token is sanity-checked with a ``GET /user`` probe
    before persisting; an obviously bad token doesn't pollute Secrets
    Manager. If the probe passes, an initial refresh runs so the
    dashboard has data immediately.
    """
    try:
        ynab_token.put_token(payload.token)
    except ynab_token.YnabTokenNotConfigured as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

    client = YnabClient()
    try:
        client.test_connection()
        # Only run the initial refresh when the DB is wired up — local
        # dev (HELM_STAGE=local with no Aurora) still wants to accept the
        # token so the rest of the UI can render; the user can hit
        # "Refresh now" once a real DB is available.
        if _db_configured():
            run_refresh(client=client)
    except YnabAuthError as e:
        ynab_token.delete_token()
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

    return get_status()


@router.delete("/integrations/ynab/token", response_model=YnabStatusResponse)
def delete_token() -> YnabStatusResponse:
    """Remove the stored token. Used by the Settings "Disconnect" action."""
    ynab_token.delete_token()
    return YnabStatusResponse(token_configured=False)


@router.post("/ynab/refresh", response_model=YnabRefreshResponse)
def refresh() -> YnabRefreshResponse:
    """Pull fresh YNAB data into the cache. Bound to the Refresh button."""
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
        categories_upserted=result.categories_upserted,
        month_rows_upserted=result.month_rows_upserted,
        transactions_upserted=result.transactions_upserted,
        updated_at=result.synced_at or datetime.now(timezone.utc),
    )
