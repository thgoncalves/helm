"""Tests for ``POST /investments/stocks/refresh-prices`` (bulk quote refresh).

The endpoint force-refreshes the cached quote for every held ticker and
returns a summary. Partial failures (a ticker that's rate-limited or not
found) must NOT fail the whole request — they're tallied into
``failed`` / ``errors``.

Follows the monkeypatch-on-top-of-autouse pattern used by the Research
and Accounts router tests: we patch ``app.db.fetch_all`` for the
held-tickers query and the router's ``get_quote`` symbol.
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import db as db_module
from app.investments.stocks_quotes import Quote, TickerNotFound
from app.routers import investments_stocks as stocks_router_module


def _quote(ticker: str, when: datetime) -> Quote:
    return Quote(
        ticker=ticker,
        name=f"{ticker} Inc.",
        exchange="NASDAQ",
        currency="USD",
        last_price=Decimal("100.00"),
        previous_close=Decimal("99.00"),
        fetched_at=when,
    )


class TestRefreshPrices:
    def test_refreshes_all_held_tickers_and_reports_partial_failure(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            db_module,
            "fetch_all",
            lambda sql, params=None: [
                {"ticker": "AAPL"},
                {"ticker": "NVDA"},
                {"ticker": "BADX"},
            ],
        )

        newest = datetime(2026, 5, 28, 18, 0, tzinfo=timezone.utc)
        older = datetime(2026, 5, 28, 17, 0, tzinfo=timezone.utc)

        def fake_get_quote(ticker: str, *, force_refresh: bool = False) -> Quote:
            assert force_refresh is True
            if ticker == "BADX":
                raise TickerNotFound(ticker)
            return _quote(ticker, newest if ticker == "AAPL" else older)

        monkeypatch.setattr(stocks_router_module, "get_quote", fake_get_quote)

        resp = client.post("/investments/stocks/refresh-prices")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["refreshed"] == 2
        assert data["failed"] == 1
        # max_fetched_at is the newest successful fetch.
        assert data["max_fetched_at"].startswith("2026-05-28T18:00")
        assert len(data["errors"]) == 1
        assert "BADX" in data["errors"][0]

    def test_no_holdings_returns_zeroes(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(db_module, "fetch_all", lambda sql, params=None: [])

        def boom(*args: Any, **kwargs: Any) -> Quote:  # pragma: no cover
            raise AssertionError("get_quote should not be called with no holdings")

        monkeypatch.setattr(stocks_router_module, "get_quote", boom)

        resp = client.post("/investments/stocks/refresh-prices")
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data == {
            "refreshed": 0,
            "failed": 0,
            "max_fetched_at": None,
            "errors": [],
        }
