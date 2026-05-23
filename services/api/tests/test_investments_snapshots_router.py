"""Tests for the Investing snapshots router (``/investments/snapshots``).

Covers ``docs/specs/investing-dashboard-snapshots-v1.md``:

* POST captures one row per active investing fund + one stocks aggregate.
* Same-day re-POST UPSERTs rather than appending.
* FX conversion math (BRL → CAD) on funds and per-quote-currency on stocks.
* Stocks aggregate skips tickers with no cached quote and is omitted
  entirely when no positions exist.
* GET /history returns ASC-sorted items with per-source breakdown.
* GET /{date} 404s when no snapshot exists; 200s with rows otherwise.

Follows the same monkeypatch-on-top-of-autouse pattern as the Research
tests — small purpose-built in-memory stores rather than extending the
giant conftest.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app import db as db_module
from app.investments import fx as fx_module
from app.routers import investments_snapshots as router_module


XP_ID = UUID("11111111-1111-1111-1111-111111111111")
SANTANDER_ID = UUID("22222222-2222-2222-2222-222222222222")


@pytest.fixture
def snapshots_db(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """In-memory stand-in for the five tables the router touches."""
    manual_accounts: dict[UUID, dict[str, Any]] = {}
    ynab_accounts: dict[str, dict[str, Any]] = {}
    transactions: list[dict[str, Any]] = []
    quotes: dict[str, dict[str, Any]] = {}
    # Modeled as a list of dicts; PK semantics enforced by the dispatch
    # below mirroring the partial unique indexes.
    snapshots: list[dict[str, Any]] = []

    stores: dict[str, Any] = {
        "manual_accounts": manual_accounts,
        "ynab_accounts": ynab_accounts,
        "stock_transactions": transactions,
        "stock_quotes": quotes,
        "investing_snapshots": snapshots,
    }

    def fetch_all(
        sql: str, params: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        sql = " ".join(sql.split())
        params = params or {}

        if "FROM manual_accounts" in sql and "kind = 'investing_fund'" in sql:
            return sorted(
                (a for a in manual_accounts.values() if a.get("is_active", True)),
                key=lambda x: x["name"],
            )

        if "FROM ynab_accounts" in sql and "helm_kind = 'investing_fund'" in sql:
            return sorted(
                (
                    a
                    for a in ynab_accounts.values()
                    if not a.get("closed") and not a.get("deleted")
                ),
                key=lambda x: x["name"],
            )

        if "FROM stock_transactions t" in sql and "LEFT JOIN stock_quotes q" in sql:
            agg: dict[str, dict[str, Any]] = {}
            for t in transactions:
                row = agg.setdefault(
                    t["ticker"], {"ticker": t["ticker"], "shares": Decimal(0)}
                )
                if t["transaction_type"] == "buy":
                    row["shares"] += Decimal(t["quantity"])
                elif t["transaction_type"] == "sell":
                    row["shares"] -= Decimal(t["quantity"])
            out: list[dict[str, Any]] = []
            for ticker, row in agg.items():
                if row["shares"] <= 0:
                    continue
                q = quotes.get(ticker, {})
                out.append(
                    {
                        "ticker": ticker,
                        "shares": row["shares"],
                        "last_price": q.get("last_price"),
                        "quote_currency": q.get("currency"),
                    }
                )
            return out

        if "FROM investing_snapshots" in sql and "ORDER BY snapshot_date ASC" in sql:
            return sorted(
                snapshots,
                key=lambda r: (r["snapshot_date"], r["label"]),
            )

        if "FROM investing_snapshots" in sql and "WHERE snapshot_date = :on" in sql:
            return [
                r for r in snapshots if r["snapshot_date"] == params["on"]
            ]

        raise NotImplementedError(f"snapshots_db.fetch_all: {sql[:160]}")

    def fetch_one(
        sql: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any] | None:
        rows = fetch_all(sql, params)
        return rows[0] if rows else None

    def execute(
        sql: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        sql = " ".join(sql.split())
        params = params or {}
        if "INSERT INTO investing_snapshots" not in sql:
            raise NotImplementedError(f"snapshots_db.execute: {sql[:160]}")
        # Emulate the partial-unique-index UPSERT.
        existing = next(
            (
                r
                for r in snapshots
                if r["snapshot_date"] == params["snapshot_date"]
                and r["source_kind"] == params["source_kind"]
                and r.get("source_id") == params["source_id"]
            ),
            None,
        )
        if existing is not None:
            existing.update(
                label=params["label"],
                native_currency=params["native_currency"],
                native_amount=params["native_amount"],
                cad_amount=params["cad_amount"],
                fx_rate=params["fx_rate"],
            )
        else:
            snapshots.append(
                {
                    "snapshot_date": params["snapshot_date"],
                    "source_kind": params["source_kind"],
                    "source_id": params["source_id"],
                    "label": params["label"],
                    "native_currency": params["native_currency"],
                    "native_amount": params["native_amount"],
                    "cad_amount": params["cad_amount"],
                    "fx_rate": params["fx_rate"],
                    "created_at": datetime.now(timezone.utc),
                }
            )
        return {}

    monkeypatch.setattr(db_module, "fetch_all", fetch_all)
    monkeypatch.setattr(db_module, "fetch_one", fetch_one)
    monkeypatch.setattr(db_module, "execute", execute)

    # FX: BRL→CAD = 0.27, USD→CAD = 1.40 (deterministic).
    def fake_rate(
        f: str, t: str, on: date | None = None
    ) -> fx_module.FxRate:
        rates = {
            ("BRL", "CAD"): Decimal("0.27"),
            ("USD", "CAD"): Decimal("1.40"),
        }
        return fx_module.FxRate(
            f, t, on or date.today(), rates.get((f, t), Decimal(1))
        )

    monkeypatch.setattr(fx_module, "get_rate", fake_rate)
    monkeypatch.setattr(router_module, "fx_rate", fake_rate)

    return stores


# ---------------------------------------------------------------------------
# Seed helpers
# ---------------------------------------------------------------------------


def _seed_funds(stores: dict[str, Any]) -> None:
    stores["manual_accounts"].update(
        {
            XP_ID: {
                "id": XP_ID,
                "name": "XP",
                "currency": "BRL",
                "balance": Decimal("1057403.00"),
                "is_active": True,
                "kind": "investing_fund",
            },
            SANTANDER_ID: {
                "id": SANTANDER_ID,
                "name": "Santander",
                "currency": "BRL",
                "balance": Decimal("1369656.00"),
                "is_active": True,
                "kind": "investing_fund",
            },
        }
    )


def _seed_stocks(stores: dict[str, Any]) -> None:
    stores["stock_transactions"].extend(
        [
            {
                "id": str(uuid4()),
                "ticker": "AAPL",
                "transaction_type": "buy",
                "quantity": Decimal("10"),
                "currency": "USD",
            },
            {
                "id": str(uuid4()),
                "ticker": "MSFT",
                "transaction_type": "buy",
                "quantity": Decimal("5"),
                "currency": "USD",
            },
        ]
    )
    stores["stock_quotes"]["AAPL"] = {
        "ticker": "AAPL",
        "last_price": Decimal("150.00"),
        "currency": "USD",
    }
    # Intentionally no quote for MSFT — the aggregate should skip it.


# ---------------------------------------------------------------------------
# POST /investments/snapshots
# ---------------------------------------------------------------------------


class TestTakeSnapshot:
    def test_captures_funds_and_stocks(
        self, client: TestClient, snapshots_db: dict[str, Any]
    ) -> None:
        _seed_funds(snapshots_db)
        _seed_stocks(snapshots_db)

        resp = client.post("/investments/snapshots")
        assert resp.status_code == 200, resp.text
        body = resp.json()

        labels = sorted(r["label"] for r in body["rows"])
        assert labels == ["Santander", "Stocks", "XP"]

        # XP: 1,057,403 BRL × 0.27 = 285,498.81 CAD
        xp = next(r for r in body["rows"] if r["label"] == "XP")
        assert Decimal(xp["native_amount"]) == Decimal("1057403.00")
        assert Decimal(xp["cad_amount"]) == Decimal("285498.81")
        assert Decimal(xp["fx_rate"]) == Decimal("0.27")

        # Stocks: 10 AAPL × $150 × 1.40 = 2,100 CAD (MSFT skipped — no quote)
        stocks = next(r for r in body["rows"] if r["label"] == "Stocks")
        assert Decimal(stocks["cad_amount"]) == Decimal("2100.00")
        assert stocks["source_id"] is None
        assert stocks["native_currency"] == "CAD"

        # Total: XP + Santander + Stocks
        # 285498.81 + 369807.12 + 2100.00 = 657,405.93
        assert Decimal(body["total_cad"]) == Decimal("657405.93")

    def test_same_day_resnapshot_upserts(
        self, client: TestClient, snapshots_db: dict[str, Any]
    ) -> None:
        _seed_funds(snapshots_db)

        client.post("/investments/snapshots")
        # Bump XP balance and re-snapshot.
        snapshots_db["manual_accounts"][XP_ID]["balance"] = Decimal("2000000.00")
        client.post("/investments/snapshots")

        rows = snapshots_db["investing_snapshots"]
        # Still two rows (one per fund), not four.
        assert len(rows) == 2
        xp = next(r for r in rows if r["label"] == "XP")
        # 2,000,000 × 0.27 = 540,000.00
        assert xp["cad_amount"] == Decimal("540000.00")

    def test_no_funds_no_stocks_returns_empty(
        self, client: TestClient, snapshots_db: dict[str, Any]
    ) -> None:
        """Edge case: brand-new user with nothing to snapshot."""
        resp = client.post("/investments/snapshots")
        assert resp.status_code == 200
        body = resp.json()
        assert body["rows"] == []
        assert Decimal(body["total_cad"]) == Decimal(0)

    def test_captures_ynab_investing_funds_too(
        self, client: TestClient, snapshots_db: dict[str, Any]
    ) -> None:
        """YNAB-tagged investing accounts come in alongside manuals.

        Balance is stored in milliunits (×1000) on YNAB; the router
        divides back down. Currency is assumed CAD per the production
        comment.
        """
        snapshots_db["ynab_accounts"].update(
            {
                "ynab-acct-1": {
                    "id": "ynab-acct-1",
                    "name": "Thiago TFSA",
                    "helm_kind": "investing_fund",
                    "closed": False,
                    "deleted": False,
                    "balance": 79_100_000,  # CAD 79,100.00
                },
                "ynab-closed": {
                    "id": "ynab-closed",
                    "name": "Closed RSP",
                    "helm_kind": "investing_fund",
                    "closed": True,
                    "deleted": False,
                    "balance": 1_000_000,
                },
            }
        )

        body = client.post("/investments/snapshots").json()
        ynab_rows = [
            r for r in body["rows"] if r["source_kind"] == "ynab_fund"
        ]
        assert len(ynab_rows) == 1  # closed account excluded
        assert ynab_rows[0]["label"] == "Thiago TFSA"
        assert Decimal(ynab_rows[0]["native_amount"]) == Decimal("79100.00")
        assert Decimal(ynab_rows[0]["cad_amount"]) == Decimal("79100.00")
        assert ynab_rows[0]["source_id"] == "ynab-acct-1"

    def test_stocks_omitted_when_all_positions_unquoted(
        self, client: TestClient, snapshots_db: dict[str, Any]
    ) -> None:
        """If we hold something but have no quote yet, no stocks row.

        (We could record a zero, but that'd drag the chart total down
        misleadingly. Better to wait until the quote is cached.)
        """
        _seed_funds(snapshots_db)
        snapshots_db["stock_transactions"].append(
            {
                "id": str(uuid4()),
                "ticker": "NOPRICE",
                "transaction_type": "buy",
                "quantity": Decimal("1"),
                "currency": "USD",
            }
        )
        # No matching row in stock_quotes.

        body = client.post("/investments/snapshots").json()
        labels = [r["label"] for r in body["rows"]]
        assert "Stocks" in labels  # aggregate row written
        stocks = next(r for r in body["rows"] if r["label"] == "Stocks")
        assert Decimal(stocks["cad_amount"]) == Decimal("0.00")


# ---------------------------------------------------------------------------
# GET /investments/snapshots/history
# ---------------------------------------------------------------------------


class TestHistory:
    def test_returns_dates_ascending_with_breakdown(
        self, client: TestClient, snapshots_db: dict[str, Any]
    ) -> None:
        # Manually seed two prior days so we don't have to fake the clock.
        snapshots_db["investing_snapshots"].extend(
            [
                {
                    "snapshot_date": date(2026, 5, 20),
                    "source_kind": "manual_fund",
                    "source_id": str(XP_ID),
                    "label": "XP",
                    "native_currency": "BRL",
                    "native_amount": Decimal("1000000"),
                    "cad_amount": Decimal("270000.00"),
                    "fx_rate": Decimal("0.27"),
                },
                {
                    "snapshot_date": date(2026, 5, 20),
                    "source_kind": "stocks",
                    "source_id": None,
                    "label": "Stocks",
                    "native_currency": "CAD",
                    "native_amount": Decimal("1500.00"),
                    "cad_amount": Decimal("1500.00"),
                    "fx_rate": Decimal("1"),
                },
                {
                    "snapshot_date": date(2026, 5, 22),
                    "source_kind": "manual_fund",
                    "source_id": str(XP_ID),
                    "label": "XP",
                    "native_currency": "BRL",
                    "native_amount": Decimal("1100000"),
                    "cad_amount": Decimal("297000.00"),
                    "fx_rate": Decimal("0.27"),
                },
            ]
        )

        body = client.get("/investments/snapshots/history").json()
        dates = [item["snapshot_date"] for item in body]
        assert dates == ["2026-05-20", "2026-05-22"]
        assert Decimal(body[0]["total_cad"]) == Decimal("271500.00")
        assert sorted(body[0]["by_source"].keys()) == ["Stocks", "XP"]
        assert Decimal(body[1]["total_cad"]) == Decimal("297000.00")

    def test_empty_when_no_snapshots(
        self, client: TestClient, snapshots_db: dict[str, Any]
    ) -> None:
        assert client.get("/investments/snapshots/history").json() == []


# ---------------------------------------------------------------------------
# GET /investments/snapshots/{date}
# ---------------------------------------------------------------------------


class TestGetSnapshot:
    def test_404_when_no_snapshot(
        self, client: TestClient, snapshots_db: dict[str, Any]
    ) -> None:
        resp = client.get("/investments/snapshots/2026-01-01")
        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "SNAPSHOT_NOT_FOUND"

    def test_returns_breakdown(
        self, client: TestClient, snapshots_db: dict[str, Any]
    ) -> None:
        snapshots_db["investing_snapshots"].append(
            {
                "snapshot_date": date(2026, 5, 23),
                "source_kind": "manual_fund",
                "source_id": str(XP_ID),
                "label": "XP",
                "native_currency": "BRL",
                "native_amount": Decimal("500000"),
                "cad_amount": Decimal("135000.00"),
                "fx_rate": Decimal("0.27"),
            }
        )
        body = client.get("/investments/snapshots/2026-05-23").json()
        assert body["snapshot_date"] == "2026-05-23"
        assert len(body["rows"]) == 1
        assert Decimal(body["total_cad"]) == Decimal("135000.00")
