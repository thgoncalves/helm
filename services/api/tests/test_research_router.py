"""Tests for the Stocks Research router (``/investments/research``).

Covers the V1 contract in ``docs/specs/investments-research-v1.md``:

* ``GET /investments/research`` returns every seeded ticker, joins the
  cached quote when present, and ``null``-fills price fields when not.
* Day-change-pct is computed from previous_close.
* Positions are aggregated across stock_transactions and FX-converted
  to CAD when the quote currency differs from CAD.
* ``POST /refresh/{ticker}`` rejects tickers that aren't in the
  research universe (so a typo can't generate gratuitous traffic to
  Yahoo).

Follows the same monkeypatch-on-top-of-autouse pattern as the Accounts
tests: the conftest fake covers Business surfaces; we layer Research-
specific stores here so the giant conftest doesn't sprout one-off
patterns for every new module.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app import db as db_module
from app.investments import fx as fx_module
from app.investments import stocks_quotes as quotes_module
from app.routers import investments_research as research_router_module

# ---------------------------------------------------------------------------
# Fixture
# ---------------------------------------------------------------------------


@pytest.fixture
def research_db(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Replace ``app.db`` with in-memory stores for the Research router."""
    universe: dict[str, dict[str, Any]] = {}
    quotes: dict[str, dict[str, Any]] = {}
    transactions: list[dict[str, Any]] = []

    stores: dict[str, Any] = {
        "research_tickers": universe,
        "stock_quotes": quotes,
        "stock_transactions": transactions,
    }

    def fetch_all(
        sql: str, params: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        sql = " ".join(sql.split())  # collapse whitespace
        params = params or {}
        if "FROM research_tickers r LEFT JOIN stock_quotes q" in sql:
            out: list[dict[str, Any]] = []
            for r in sorted(
                universe.values(), key=lambda x: (x["sort_order"], x["ticker"])
            ):
                q = quotes.get(r["ticker"], {})
                out.append(
                    {
                        **r,
                        "last_price": q.get("last_price"),
                        "quote_currency": q.get("currency"),
                        "previous_close": q.get("previous_close"),
                        "fetched_at": q.get("fetched_at"),
                    }
                )
            return out
        if (
            "FROM stock_transactions" in sql
            and "GROUP BY ticker" in sql
        ):
            agg: dict[str, dict[str, Any]] = {}
            for t in transactions:
                if t["ticker"] not in universe:
                    continue
                row = agg.setdefault(
                    t["ticker"],
                    {"ticker": t["ticker"], "shares": Decimal(0), "currency": None},
                )
                if t["transaction_type"] == "buy":
                    row["shares"] += Decimal(t["quantity"])
                row["currency"] = row["currency"] or t.get("currency")
            return [r for r in agg.values() if r["shares"] > 0]
        raise NotImplementedError(f"research_db.fetch_all: {sql[:120]}")

    def fetch_one(
        sql: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any] | None:
        sql = " ".join(sql.split())
        params = params or {}
        if "FROM research_tickers WHERE ticker = :ticker" in sql:
            return universe.get(params["ticker"])
        raise NotImplementedError(f"research_db.fetch_one: {sql[:120]}")

    def execute(
        sql: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return {}

    monkeypatch.setattr(db_module, "fetch_all", fetch_all)
    monkeypatch.setattr(db_module, "fetch_one", fetch_one)
    monkeypatch.setattr(db_module, "execute", execute)

    # FX: USD→CAD = 1.40 (deterministic).
    def fake_rate(f: str, t: str, on: date | None = None) -> fx_module.FxRate:
        rates = {("USD", "CAD"): Decimal("1.40"), ("CAD", "USD"): Decimal("0.7143")}
        return fx_module.FxRate(f, t, on or date.today(), rates.get((f, t), Decimal(1)))

    monkeypatch.setattr(fx_module, "get_rate", fake_rate)
    monkeypatch.setattr(research_router_module, "fx_rate", fake_rate)

    return stores


def _seed_universe(stores: dict[str, Any]) -> None:
    """Populate research_tickers with a small predictable slice."""
    stores["research_tickers"].update(
        {
            "AAPL": {
                "ticker": "AAPL",
                "name": "Apple Inc.",
                "sector": "Technology",
                "industry": "Consumer Electronics",
                "country": "US",
                "sort_order": 100,
            },
            "RY.TO": {
                "ticker": "RY.TO",
                "name": "Royal Bank of Canada",
                "sector": "Financials",
                "industry": "Banks",
                "country": "CA",
                "sort_order": 208,
            },
            "MSFT": {
                "ticker": "MSFT",
                "name": "Microsoft Corporation",
                "sector": "Technology",
                "industry": "Software",
                "country": "US",
                "sort_order": 107,
            },
        }
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestListResearch:
    def test_returns_universe_in_sort_order(
        self, client: TestClient, research_db: dict[str, Any]
    ) -> None:
        """sort_order wins; rows without a cached quote come back with nulls."""
        _seed_universe(research_db)

        resp = client.get("/investments/research")
        assert resp.status_code == 200, resp.text
        rows = resp.json()
        tickers = [r["ticker"] for r in rows]
        assert tickers == ["AAPL", "MSFT", "RY.TO"]
        for r in rows:
            # No quotes seeded yet — every price field is null.
            assert r["last_price"] is None
            assert r["currency"] is None
            assert r["day_change_pct"] is None
            # No positions yet either.
            assert Decimal(r["position_shares"]) == Decimal(0)
            assert r["position_value_native"] is None
            assert r["position_value_cad"] is None

    def test_day_change_pct_is_computed(
        self, client: TestClient, research_db: dict[str, Any]
    ) -> None:
        """(last - prev) / prev * 100, quantized to 2dp."""
        _seed_universe(research_db)
        research_db["stock_quotes"]["AAPL"] = {
            "ticker": "AAPL",
            "last_price": Decimal("150.00"),
            "previous_close": Decimal("148.00"),
            "currency": "USD",
            "fetched_at": datetime(2026, 5, 22, tzinfo=timezone.utc),
        }

        rows = client.get("/investments/research").json()
        aapl = next(r for r in rows if r["ticker"] == "AAPL")
        # (150 - 148) / 148 * 100 = 1.3513…
        assert Decimal(aapl["day_change_pct"]) == Decimal("1.35")
        assert Decimal(aapl["last_price"]) == Decimal("150.00")
        assert aapl["currency"] == "USD"

    def test_position_aggregates_across_sources_and_converts_to_cad(
        self, client: TestClient, research_db: dict[str, Any]
    ) -> None:
        """Positions sum across (source, account) and FX-convert to CAD."""
        _seed_universe(research_db)
        research_db["stock_quotes"]["AAPL"] = {
            "ticker": "AAPL",
            "last_price": Decimal("200.00"),
            "previous_close": Decimal("198.00"),
            "currency": "USD",
            "fetched_at": datetime(2026, 5, 22, tzinfo=timezone.utc),
        }
        # 5 shares in a YNAB account + 3 shares in a manual account.
        research_db["stock_transactions"].extend(
            [
                {
                    "ticker": "AAPL",
                    "account_source": "ynab",
                    "account_id": "ynab-acct-1",
                    "transaction_type": "buy",
                    "quantity": Decimal("5"),
                    "unit_price": Decimal("180"),
                    "fees": Decimal("0"),
                    "currency": "USD",
                },
                {
                    "ticker": "AAPL",
                    "account_source": "manual",
                    "account_id": uuid4(),
                    "transaction_type": "buy",
                    "quantity": Decimal("3"),
                    "unit_price": Decimal("190"),
                    "fees": Decimal("0"),
                    "currency": "USD",
                },
            ]
        )

        rows = client.get("/investments/research").json()
        aapl = next(r for r in rows if r["ticker"] == "AAPL")
        # 5 + 3 = 8 shares.
        assert Decimal(aapl["position_shares"]) == Decimal("8")
        # 8 × $200 = $1,600 USD.
        assert Decimal(aapl["position_value_native"]) == Decimal("1600.00")
        # $1,600 × 1.40 = $2,240 CAD.
        assert Decimal(aapl["position_value_cad"]) == Decimal("2240.00")

    def test_position_value_cad_short_circuits_for_cad_tickers(
        self, client: TestClient, research_db: dict[str, Any]
    ) -> None:
        """Native value == CAD value when the quote is already in CAD."""
        _seed_universe(research_db)
        research_db["stock_quotes"]["RY.TO"] = {
            "ticker": "RY.TO",
            "last_price": Decimal("130.00"),
            "previous_close": Decimal("129.00"),
            "currency": "CAD",
            "fetched_at": datetime(2026, 5, 22, tzinfo=timezone.utc),
        }
        research_db["stock_transactions"].append(
            {
                "ticker": "RY.TO",
                "account_source": "ynab",
                "account_id": "ynab-acct-2",
                "transaction_type": "buy",
                "quantity": Decimal("10"),
                "unit_price": Decimal("120"),
                "fees": Decimal("0"),
                "currency": "CAD",
            }
        )

        rows = client.get("/investments/research").json()
        ry = next(r for r in rows if r["ticker"] == "RY.TO")
        assert Decimal(ry["position_shares"]) == Decimal("10")
        assert Decimal(ry["position_value_native"]) == Decimal("1300.00")
        assert Decimal(ry["position_value_cad"]) == Decimal("1300.00")


class TestRefreshOne:
    def test_rejects_ticker_outside_universe(
        self,
        client: TestClient,
        research_db: dict[str, Any],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A typo'd ticker 404s before we ever call Yahoo."""
        _seed_universe(research_db)
        called = {"n": 0}

        def fake_get_quote(*args: Any, **kwargs: Any) -> Any:
            called["n"] += 1
            raise AssertionError("Yahoo must not be called")

        monkeypatch.setattr(quotes_module, "get_quote", fake_get_quote)
        monkeypatch.setattr(research_router_module, "get_quote", fake_get_quote)

        resp = client.post("/investments/research/refresh/NOPE")
        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "NOT_IN_RESEARCH"
        assert called["n"] == 0

    def test_refresh_returns_updated_row(
        self,
        client: TestClient,
        research_db: dict[str, Any],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The refresh handler calls get_quote, then re-reads the row."""
        _seed_universe(research_db)
        called = {"ticker": None}

        def fake_get_quote(ticker: str, *, force_refresh: bool = False) -> Any:
            called["ticker"] = ticker
            assert force_refresh is True
            # Simulate the side effect: cache the quote so the
            # subsequent list_research call picks it up.
            research_db["stock_quotes"]["AAPL"] = {
                "ticker": "AAPL",
                "last_price": Decimal("210.00"),
                "previous_close": Decimal("205.00"),
                "currency": "USD",
                "fetched_at": datetime(2026, 5, 22, tzinfo=timezone.utc),
            }
            return None

        monkeypatch.setattr(research_router_module, "get_quote", fake_get_quote)

        resp = client.post("/investments/research/refresh/aapl")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ticker"] == "AAPL"
        assert Decimal(body["last_price"]) == Decimal("210.00")
        assert called["ticker"] == "AAPL"
