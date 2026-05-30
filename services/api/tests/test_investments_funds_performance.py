"""Tests for GET /investments/stocks/funds-performance.

The endpoint reports each manual/YNAB investing fund's current value, its
"original value" (earliest investing_snapshots row), and the change in $/%.

Follows the monkeypatch-on-top-of-autouse pattern used by the snapshots
tests: a small in-memory stand-in for the three query shapes the endpoint
issues, plus deterministic FX.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import db as db_module
from app.investments import fx as fx_module
from app.routers import investments_stocks as router_module

M1 = "11111111-1111-1111-1111-111111111111"  # CAD manual fund, has snapshot
M2 = "22222222-2222-2222-2222-222222222222"  # BRL manual fund, has snapshot
Y1 = "ynab-acct-1"  # ynab fund, has snapshot
Y2 = "ynab-acct-2"  # ynab fund, NO snapshot


@pytest.fixture
def perf_db(monkeypatch: pytest.MonkeyPatch) -> None:
    manual = [
        {"id": M1, "name": "Wealthsimple", "balance": Decimal("1000.00"), "currency": "CAD"},
        {"id": M2, "name": "XP Brazil", "balance": Decimal("1000.00"), "currency": "BRL"},
    ]
    ynab = [
        {"id": Y1, "name": "RSP", "balance": 5_000_000},  # milliunits -> 5000 CAD
        {"id": Y2, "name": "TFSA", "balance": 2_000_000},  # 2000 CAD, no snapshot
    ]
    # Earliest snapshot cad_amount per (source_kind, source_id).
    first_snap: dict[tuple[str, str], dict[str, Any]] = {
        ("manual_fund", M1): {"cad_amount": Decimal("800.00"), "snapshot_date": date(2026, 5, 1)},
        ("manual_fund", M2): {"cad_amount": Decimal("250.00"), "snapshot_date": date(2026, 5, 1)},
        ("ynab_fund", Y1): {"cad_amount": Decimal("4500.00"), "snapshot_date": date(2026, 5, 2)},
    }

    def fetch_all(sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        s = " ".join(sql.split())
        if "FROM manual_accounts" in s and "kind = 'investing_fund'" in s:
            return manual
        if "FROM ynab_accounts" in s and "helm_kind = 'investing_fund'" in s:
            return ynab
        raise NotImplementedError(f"perf_db.fetch_all: {s[:120]}")

    def fetch_one(sql: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
        s = " ".join(sql.split())
        params = params or {}
        if "FROM investing_snapshots" in s and "ORDER BY snapshot_date ASC" in s:
            return first_snap.get((params["kind"], params["id"]))
        raise NotImplementedError(f"perf_db.fetch_one: {s[:120]}")

    monkeypatch.setattr(db_module, "fetch_all", fetch_all)
    monkeypatch.setattr(db_module, "fetch_one", fetch_one)

    def fake_rate(f: str, t: str, on: date | None = None) -> fx_module.FxRate:
        rates = {("BRL", "CAD"): Decimal("0.27")}
        return fx_module.FxRate(f, t, on or date.today(), rates.get((f, t), Decimal(1)))

    monkeypatch.setattr(fx_module, "get_rate", fake_rate)
    monkeypatch.setattr(router_module, "fx_rate", fake_rate)


def _by_id(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {r["account_id"]: r for r in rows}


def test_reports_current_original_and_change(
    perf_db: None, client: TestClient
) -> None:
    res = client.get("/investments/stocks/funds-performance")
    assert res.status_code == 200, res.text
    rows = _by_id(res.json())

    # CAD manual fund: 1000 now vs 800 first snapshot → +200, +25%.
    m1 = rows[f"manual:{M1}"]
    assert m1["current_cad"] == "1000.00"
    assert m1["original_cad"] == "800.00"
    assert m1["change_cad"] == "200.00"
    assert m1["change_pct"] == "25.00"

    # BRL manual fund: 1000 BRL * 0.27 = 270 CAD now vs 250 → +20, +8%.
    m2 = rows[f"manual:{M2}"]
    assert m2["current_cad"] == "270.00"
    assert m2["original_cad"] == "250.00"
    assert m2["change_cad"] == "20.00"
    assert m2["change_pct"] == "8.00"

    # YNAB fund (milliunits → CAD): 5000 vs 4500 → +500, +11.11%.
    y1 = rows[f"ynab:{Y1}"]
    assert y1["current_cad"] == "5000.00"
    assert y1["original_cad"] == "4500.00"
    assert y1["change_cad"] == "500.00"
    assert y1["change_pct"] == "11.11"


def test_no_snapshot_yields_null_original_and_change(
    perf_db: None, client: TestClient
) -> None:
    rows = _by_id(client.get("/investments/stocks/funds-performance").json())
    y2 = rows[f"ynab:{Y2}"]
    assert y2["current_cad"] == "2000.00"
    assert y2["original_cad"] is None
    assert y2["change_cad"] is None
    assert y2["change_pct"] is None
