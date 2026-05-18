"""Thin httpx wrapper around the YNAB v1 API.

Only covers the read-only endpoints Helm needs:

* ``GET  /budgets``                          — pick the budget to track.
* ``GET  /budgets/{id}/categories``          — group + category catalogue.
* ``GET  /budgets/{id}/months/{month}``      — assigned / activity / balance.
* ``GET  /budgets/{id}/transactions``        — recent transactions.
* ``GET  /user``                             — used as the "test connection"
                                               probe; cheapest authenticated
                                               endpoint YNAB exposes.

Error translation: 401 → :class:`YnabAuthError`, 429 → :class:`YnabRateLimit`,
everything else → :class:`YnabApiError` with the upstream status code so
the router layer can map to typed FastAPI errors.

Tests substitute the module-level ``_HTTPX_CLIENT`` reference or the
client's ``_request`` method via ``monkeypatch.setattr``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from app.ynab.token import YnabTokenNotConfigured, load_token

_BASE_URL = "https://api.ynab.com/v1"
_DEFAULT_TIMEOUT = httpx.Timeout(15.0, read=15.0, connect=5.0)


class YnabApiError(RuntimeError):
    """Generic YNAB upstream failure."""

    def __init__(self, status: int, detail: str = "") -> None:
        super().__init__(detail or f"YNAB API error {status}")
        self.status = status
        self.detail = detail


class YnabAuthError(YnabApiError):
    """YNAB rejected the PAT (401). Surfaced to the user as 'reconnect'."""

    def __init__(self, detail: str = "") -> None:
        super().__init__(401, detail or "YNAB token rejected.")


class YnabRateLimit(YnabApiError):
    """Hit YNAB's 200 req/hr limit."""

    def __init__(self, retry_after: int | None = None) -> None:
        super().__init__(
            429,
            "YNAB rate limit hit. Retry after the window resets.",
        )
        self.retry_after = retry_after


# ---------------------------------------------------------------------------
# Cached httpx client
# ---------------------------------------------------------------------------

_HTTPX_CLIENT: httpx.Client | None = None


def _http() -> httpx.Client:
    """Return the process-cached httpx client.

    Lambda warm containers keep this alive, so YNAB's TCP connection can
    be re-used across invocations of the same Lambda instance.
    """
    global _HTTPX_CLIENT
    if _HTTPX_CLIENT is None:
        _HTTPX_CLIENT = httpx.Client(
            base_url=_BASE_URL,
            timeout=_DEFAULT_TIMEOUT,
            # ``http2=False`` — httpx requires the ``h2`` package for HTTP/2,
            # which we don't ship. YNAB serves HTTP/1.1 fine.
            http2=False,
        )
    return _HTTPX_CLIENT


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


@dataclass
class YnabClient:
    """Stateless wrapper. The PAT is read from Secrets Manager per request
    via :func:`app.ynab.token.load_token` (which caches in-process).
    """

    def test_connection(self) -> dict[str, Any]:
        """Hit ``GET /user`` to verify the PAT works. Returns the user payload."""
        return self._request("GET", "/user")

    def list_budgets(self) -> list[dict[str, Any]]:
        """``GET /budgets`` → list of budget summaries."""
        data = self._request("GET", "/budgets")
        return data.get("budgets", [])

    def get_categories(self, budget_id: str) -> list[dict[str, Any]]:
        """``GET /budgets/{id}/categories`` → list of category groups."""
        data = self._request("GET", f"/budgets/{budget_id}/categories")
        return data.get("category_groups", [])

    def get_month(self, budget_id: str, month: str) -> dict[str, Any]:
        """``GET /budgets/{id}/months/{month}`` → month detail with categories.

        ``month`` is ``YYYY-MM-01`` or the literal ``"current"``.
        """
        data = self._request("GET", f"/budgets/{budget_id}/months/{month}")
        return data.get("month", {})

    def get_transactions(
        self,
        budget_id: str,
        *,
        since_date: str | None = None,
    ) -> list[dict[str, Any]]:
        """``GET /budgets/{id}/transactions`` with optional ``since_date``."""
        params: dict[str, str] = {}
        if since_date:
            params["since_date"] = since_date
        data = self._request(
            "GET",
            f"/budgets/{budget_id}/transactions",
            params=params or None,
        )
        return data.get("transactions", [])

    # -------------------------------------------------------------------------
    # Inner: request + error translation
    # -------------------------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        params: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        token = load_token()
        if not token:
            raise YnabTokenNotConfigured(
                "No YNAB Personal Access Token has been stored. Visit "
                "Settings → YNAB to connect."
            )

        headers = {"Authorization": f"Bearer {token}"}
        try:
            response = _http().request(
                method,
                path,
                params=params,
                headers=headers,
            )
        except httpx.HTTPError as e:
            raise YnabApiError(0, f"YNAB unreachable: {e}") from e

        if response.status_code == 401:
            raise YnabAuthError(_extract_error_detail(response))
        if response.status_code == 429:
            retry = response.headers.get("X-Rate-Limit")
            retry_after: int | None = None
            try:
                if retry:
                    retry_after = int(retry)
            except ValueError:
                retry_after = None
            raise YnabRateLimit(retry_after=retry_after)
        if response.status_code >= 400:
            raise YnabApiError(
                response.status_code, _extract_error_detail(response)
            )

        payload = response.json()
        # YNAB wraps everything in {"data": {...}}.
        return payload.get("data", payload)


def _extract_error_detail(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text[:200]
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, dict) and isinstance(err.get("detail"), str):
        return err["detail"]
    return str(body)[:200]
