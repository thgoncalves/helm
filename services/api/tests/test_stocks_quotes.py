"""Unit tests for the Twelve Data price client.

Router-level integration tests would need fake-DB rules for
investment_accounts, investment_holdings, stock_transactions,
stock_quotes, and stock_price_history. Out of scope for the V1
pytest pass — deferred until we have a need.
"""

from __future__ import annotations

from decimal import Decimal
from unittest.mock import MagicMock

import httpx
import pytest

from app.investments import stocks_quotes


@pytest.fixture(autouse=True)
def _reset_client(monkeypatch):
    """Force a fresh httpx client + key cache per test."""
    monkeypatch.setattr(stocks_quotes, "_HTTPX_CLIENT", None)
    monkeypatch.setattr(stocks_quotes, "_CACHED_KEY", "test-key")
    yield


def _stub_response(status: int, json_body: dict, text: str = "") -> httpx.Response:
    return httpx.Response(
        status_code=status,
        json=json_body,
        request=httpx.Request("GET", "https://api.twelvedata.com/"),
    )


def _mock_client_returning(response: httpx.Response):
    client = MagicMock()
    client.get = MagicMock(return_value=response)
    return client


class TestQuoteParser:
    def test_parses_quote_payload(self, monkeypatch):
        client = _mock_client_returning(
            _stub_response(
                200,
                {
                    "symbol": "AAPL",
                    "name": "Apple Inc",
                    "exchange": "NASDAQ",
                    "currency": "USD",
                    "close": "310.06",
                    "previous_close": "304.99",
                },
            )
        )
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)

        q = stocks_quotes._fetch_quote_upstream("AAPL")
        assert q.ticker == "AAPL"
        assert q.name == "Apple Inc"
        assert q.exchange == "NASDAQ"
        assert q.currency == "USD"
        assert q.last_price == Decimal("310.06")
        assert q.previous_close == Decimal("304.99")

    def test_error_status_raises_ticker_not_found(self, monkeypatch):
        """Twelve Data returns 200 + ``status: error`` for unknown symbols."""
        client = _mock_client_returning(
            _stub_response(
                200,
                {
                    "code": 404,
                    "status": "error",
                    "message": "Symbol not found.",
                },
            )
        )
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)

        with pytest.raises(stocks_quotes.TickerNotFound) as exc:
            stocks_quotes._fetch_quote_upstream("NOPE")
        assert exc.value.ticker == "NOPE"

    def test_rate_limited_maps_to_quote_rate_limited(self, monkeypatch):
        client = _mock_client_returning(
            httpx.Response(
                429,
                text="Too Many Requests",
                request=httpx.Request("GET", "https://api.twelvedata.com/"),
            )
        )
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)

        with pytest.raises(stocks_quotes.QuoteRateLimited):
            stocks_quotes._fetch_quote_upstream("AAPL")

    def test_credit_limit_message_maps_to_rate_limited(self, monkeypatch):
        """Twelve Data signals daily-credit overrun via the 200 ``error`` shape."""
        client = _mock_client_returning(
            _stub_response(
                200,
                {
                    "code": 429,
                    "status": "error",
                    "message": "You have reached your daily API credit limit.",
                },
            )
        )
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)

        with pytest.raises(stocks_quotes.QuoteRateLimited):
            stocks_quotes._fetch_quote_upstream("AAPL")

    def test_missing_currency_defaults_to_usd(self, monkeypatch):
        client = _mock_client_returning(
            _stub_response(
                200,
                {
                    "symbol": "TST",
                    "close": "1.23",
                },
            )
        )
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)
        q = stocks_quotes._fetch_quote_upstream("TST")
        assert q.currency == "USD"
        assert q.previous_close is None


class TestHistoryParser:
    def test_parses_time_series(self, monkeypatch):
        client = _mock_client_returning(
            _stub_response(
                200,
                {
                    "meta": {"currency": "USD"},
                    "values": [
                        {"datetime": "2026-05-20", "close": "180.50"},
                        {"datetime": "2026-05-21", "close": "182.25"},
                    ],
                },
            )
        )
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)

        points = stocks_quotes._fetch_history_upstream("AAPL")
        assert len(points) == 2
        assert points[0].close == Decimal("180.50")
        assert points[1].close == Decimal("182.25")
        assert points[0].currency == "USD"

    def test_skips_missing_close(self, monkeypatch):
        client = _mock_client_returning(
            _stub_response(
                200,
                {
                    "meta": {"currency": "USD"},
                    "values": [
                        {"datetime": "2026-05-20", "close": "180.50"},
                        {"datetime": "2026-05-21", "close": None},
                        {"datetime": "2026-05-22", "close": "184.10"},
                    ],
                },
            )
        )
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)

        points = stocks_quotes._fetch_history_upstream("AAPL")
        assert [p.close for p in points] == [Decimal("180.50"), Decimal("184.10")]


class TestSearchParser:
    def test_returns_typed_hits(self, monkeypatch):
        client = _mock_client_returning(
            _stub_response(
                200,
                {
                    "data": [
                        {
                            "symbol": "AAPL",
                            "instrument_name": "Apple Inc",
                            "exchange": "NASDAQ",
                            "instrument_type": "Common Stock",
                        },
                        {
                            "symbol": "AAPL.MX",
                            "instrument_name": "Apple Inc",
                            "exchange": "BMV",
                            "instrument_type": "Common Stock",
                        },
                    ]
                },
            )
        )
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)

        hits = stocks_quotes.search_symbols("apple")
        assert len(hits) == 2
        assert hits[0].ticker == "AAPL"
        assert hits[0].name == "Apple Inc"
        assert hits[0].exchange == "NASDAQ"

    def test_empty_query_short_circuits(self, monkeypatch):
        client = MagicMock()
        client.get = MagicMock()
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)
        assert stocks_quotes.search_symbols("   ") == []
        client.get.assert_not_called()


class TestApiKeyMissing:
    def test_missing_key_raises_specific_error(self, monkeypatch):
        monkeypatch.setattr(stocks_quotes, "_CACHED_KEY", None)
        monkeypatch.setattr(
            stocks_quotes.settings, "twelvedata_api_key", None
        )
        monkeypatch.setattr(
            stocks_quotes.settings, "twelvedata_secret_arn", None
        )

        with pytest.raises(stocks_quotes.QuoteApiKeyMissing):
            stocks_quotes._load_api_key()
