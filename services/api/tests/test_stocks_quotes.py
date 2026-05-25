"""Unit tests for the Yahoo Finance price client.

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
    """Force a fresh httpx client per test."""
    monkeypatch.setattr(stocks_quotes, "_HTTPX_CLIENT", None)
    yield


def _stub_response(status: int, json_body: dict, text: str = "") -> httpx.Response:
    return httpx.Response(
        status_code=status,
        json=json_body,
        request=httpx.Request("GET", "https://query1.finance.yahoo.com/"),
    )


def _mock_client_returning(response: httpx.Response):
    client = MagicMock()
    client.get = MagicMock(return_value=response)
    return client


def _mock_client_responses(responses: list[httpx.Response]):
    client = MagicMock()
    client.get = MagicMock(side_effect=responses)
    return client


def _quote_payload(
    *,
    price: float | str | None = "310.06",
    previous: float | str | None = "304.99",
    currency: str | None = "USD",
    exchange: str | None = "NMS",
    long_name: str | None = "Apple Inc.",
    short_name: str | None = None,
) -> dict:
    meta: dict = {}
    if price is not None:
        meta["regularMarketPrice"] = price
    if previous is not None:
        meta["chartPreviousClose"] = previous
    if currency is not None:
        meta["currency"] = currency
    if exchange is not None:
        meta["exchangeName"] = exchange
    if long_name is not None:
        meta["longName"] = long_name
    if short_name is not None:
        meta["shortName"] = short_name
    return {"chart": {"result": [{"meta": meta}], "error": None}}


def _not_found_payload() -> dict:
    return {
        "chart": {
            "result": None,
            "error": {
                "code": "Not Found",
                "description": "No data found, symbol may be delisted",
            },
        }
    }


class TestSymbolTranslation:
    def test_bare_symbol_passthrough(self):
        original, candidates = stocks_quotes._to_yahoo_symbols("AAPL")
        assert original == "AAPL"
        assert candidates == ["AAPL"]

    def test_us_code_strips_to_bare(self):
        _, candidates = stocks_quotes._to_yahoo_symbols("AAPL:NASDAQ")
        assert candidates == ["AAPL"]

    def test_ca_yields_ne_then_to_fallback(self):
        _, candidates = stocks_quotes._to_yahoo_symbols("PFE:CA")
        assert candidates == ["PFE.NE", "PFE.TO"]

    def test_brazil_maps_to_sa(self):
        _, candidates = stocks_quotes._to_yahoo_symbols("PETR4:BR")
        assert candidates == ["PETR4.SA"]

    def test_yahoo_form_passes_through(self):
        original, candidates = stocks_quotes._to_yahoo_symbols("RY.TO")
        assert original == "RY.TO"
        assert candidates == ["RY.TO"]

    def test_unknown_code_falls_back_to_bare(self):
        _, candidates = stocks_quotes._to_yahoo_symbols("AAPL:XX")
        assert candidates == ["AAPL"]


class TestRangePicker:
    @pytest.mark.parametrize(
        "days,expected",
        [
            (1, "1d"),
            (5, "5d"),
            (30, "1mo"),
            (90, "3mo"),
            (180, "6mo"),
            (365, "1y"),
            (700, "2y"),
            (1800, "5y"),
            (5000, "max"),
        ],
    )
    def test_smallest_range_covering_days(self, days, expected):
        assert stocks_quotes._yahoo_range(days) == expected


class TestQuoteParser:
    def test_parses_chart_meta(self, monkeypatch):
        client = _mock_client_returning(_stub_response(200, _quote_payload()))
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)

        q = stocks_quotes._fetch_quote_upstream("AAPL")
        assert q.ticker == "AAPL"
        assert q.name == "Apple Inc."
        assert q.exchange == "NMS"
        assert q.currency == "USD"
        assert q.last_price == Decimal("310.06")
        assert q.previous_close == Decimal("304.99")

    def test_falls_back_to_shortname_when_longname_missing(self, monkeypatch):
        client = _mock_client_returning(
            _stub_response(
                200, _quote_payload(long_name=None, short_name="Apple")
            )
        )
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)
        q = stocks_quotes._fetch_quote_upstream("AAPL")
        assert q.name == "Apple"

    def test_unknown_symbol_raises_ticker_not_found(self, monkeypatch):
        """Yahoo returns 404 + envelope with chart.error for unknowns."""
        client = _mock_client_returning(
            _stub_response(404, _not_found_payload())
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
                request=httpx.Request(
                    "GET", "https://query1.finance.yahoo.com/"
                ),
            )
        )
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)

        with pytest.raises(stocks_quotes.QuoteRateLimited):
            stocks_quotes._fetch_quote_upstream("AAPL")

    def test_missing_currency_defaults_to_usd(self, monkeypatch):
        client = _mock_client_returning(
            _stub_response(
                200,
                _quote_payload(currency=None, previous=None, long_name=None),
            )
        )
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)
        q = stocks_quotes._fetch_quote_upstream("TST")
        assert q.currency == "USD"
        assert q.previous_close is None

    def test_ca_ticker_uses_ne_when_available(self, monkeypatch):
        """The .NE candidate hits first; .TO should not be called."""
        client = _mock_client_returning(_stub_response(200, _quote_payload()))
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)

        q = stocks_quotes._fetch_quote_upstream("PFE:CA")
        assert q.ticker == "PFE:CA"
        assert client.get.call_count == 1
        assert "/v8/finance/chart/PFE.NE" in client.get.call_args.args[0]

    def test_ca_ticker_falls_back_to_to_on_404(self, monkeypatch):
        """First call (.NE) 404s, second call (.TO) wins."""
        client = _mock_client_responses(
            [
                _stub_response(404, _not_found_payload()),
                _stub_response(200, _quote_payload(exchange="TOR")),
            ]
        )
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)

        q = stocks_quotes._fetch_quote_upstream("RY:CA")
        assert q.ticker == "RY:CA"
        assert q.exchange == "TOR"
        assert client.get.call_count == 2
        assert "PFE" not in client.get.call_args_list[0].args[0]
        assert "/v8/finance/chart/RY.NE" in client.get.call_args_list[0].args[0]
        assert "/v8/finance/chart/RY.TO" in client.get.call_args_list[1].args[0]

    def test_ca_ticker_all_candidates_404_raises_not_found(self, monkeypatch):
        client = _mock_client_responses(
            [
                _stub_response(404, _not_found_payload()),
                _stub_response(404, _not_found_payload()),
            ]
        )
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)

        with pytest.raises(stocks_quotes.TickerNotFound) as exc:
            stocks_quotes._fetch_quote_upstream("ZZZZ:CA")
        assert exc.value.ticker == "ZZZZ:CA"


class TestHistoryParser:
    def test_parses_chart_timeseries(self, monkeypatch):
        # 2026-05-20, 2026-05-21, 2026-05-22 (UTC noon-ish epochs).
        timestamps = [1779667200, 1779753600, 1779840000]
        client = _mock_client_returning(
            _stub_response(
                200,
                {
                    "chart": {
                        "result": [
                            {
                                "meta": {"currency": "USD"},
                                "timestamp": timestamps,
                                "indicators": {
                                    "quote": [
                                        {
                                            "close": [
                                                "180.50",
                                                "182.25",
                                                "184.10",
                                            ]
                                        }
                                    ]
                                },
                            }
                        ],
                        "error": None,
                    }
                },
            )
        )
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)

        points = stocks_quotes._fetch_history_upstream("AAPL")
        assert len(points) == 3
        assert points[0].close == Decimal("180.50")
        assert points[2].close == Decimal("184.10")
        assert points[0].currency == "USD"

    def test_skips_missing_close(self, monkeypatch):
        timestamps = [1779667200, 1779753600, 1779840000]
        client = _mock_client_returning(
            _stub_response(
                200,
                {
                    "chart": {
                        "result": [
                            {
                                "meta": {"currency": "USD"},
                                "timestamp": timestamps,
                                "indicators": {
                                    "quote": [
                                        {
                                            "close": [
                                                "180.50",
                                                None,
                                                "184.10",
                                            ]
                                        }
                                    ]
                                },
                            }
                        ],
                        "error": None,
                    }
                },
            )
        )
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)

        points = stocks_quotes._fetch_history_upstream("AAPL")
        assert [p.close for p in points] == [Decimal("180.50"), Decimal("184.10")]

    def test_empty_history_returns_empty_list(self, monkeypatch):
        client = _mock_client_returning(
            _stub_response(
                200,
                {
                    "chart": {
                        "result": [
                            {
                                "meta": {"currency": "USD"},
                                "timestamp": [],
                                "indicators": {"quote": [{"close": []}]},
                            }
                        ],
                        "error": None,
                    }
                },
            )
        )
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)

        assert stocks_quotes._fetch_history_upstream("AAPL") == []

    def test_history_falls_back_for_ca_symbol(self, monkeypatch):
        timestamps = [1779667200]
        client = _mock_client_responses(
            [
                _stub_response(404, _not_found_payload()),
                _stub_response(
                    200,
                    {
                        "chart": {
                            "result": [
                                {
                                    "meta": {"currency": "CAD"},
                                    "timestamp": timestamps,
                                    "indicators": {
                                        "quote": [{"close": ["263.72"]}]
                                    },
                                }
                            ],
                            "error": None,
                        }
                    },
                ),
            ]
        )
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)

        points = stocks_quotes._fetch_history_upstream("RY:CA")
        assert [p.close for p in points] == [Decimal("263.72")]
        assert points[0].currency == "CAD"
        assert client.get.call_count == 2


class TestSearchParser:
    def test_returns_typed_hits(self, monkeypatch):
        client = _mock_client_returning(
            _stub_response(
                200,
                {
                    "quotes": [
                        {
                            "symbol": "AAPL",
                            "longname": "Apple Inc.",
                            "exchDisp": "NASDAQ",
                            "exchange": "NMS",
                            "quoteType": "EQUITY",
                            "typeDisp": "Equity",
                        },
                        {
                            "symbol": "AAPL.NE",
                            "shortname": "CDR APPLE INC",
                            "exchange": "NEO",
                            "exchDisp": "Cboe CA",
                            "quoteType": "EQUITY",
                        },
                    ]
                },
            )
        )
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)

        hits = stocks_quotes.search_symbols("apple")
        assert len(hits) == 2
        assert hits[0].ticker == "AAPL"
        assert hits[0].name == "Apple Inc."
        assert hits[0].exchange == "NASDAQ"
        assert hits[0].type == "Equity"
        assert hits[1].ticker == "AAPL.NE"
        assert hits[1].name == "CDR APPLE INC"
        assert hits[1].exchange == "Cboe CA"

    def test_empty_query_short_circuits(self, monkeypatch):
        client = MagicMock()
        client.get = MagicMock()
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)
        assert stocks_quotes.search_symbols("   ") == []
        client.get.assert_not_called()

    def test_search_handles_missing_quotes_field(self, monkeypatch):
        client = _mock_client_returning(_stub_response(200, {}))
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)
        assert stocks_quotes.search_symbols("anything") == []

    def test_search_swallows_upstream_errors(self, monkeypatch):
        client = _mock_client_returning(
            httpx.Response(
                500,
                text="boom",
                request=httpx.Request(
                    "GET", "https://query1.finance.yahoo.com/"
                ),
            )
        )
        monkeypatch.setattr(stocks_quotes, "_http", lambda: client)
        # Search is best-effort; an upstream blip yields an empty list.
        assert stocks_quotes.search_symbols("apple") == []
