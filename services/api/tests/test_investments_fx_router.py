"""Tests for GET /investments/fx/cad-brl.

The cache stores BoC's BRL→CAD series; the endpoint returns its inverse
(CAD/BRL) and a direction derived from the two most recent cached dates.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import db as db_module
from app.investments import fx as fx_module
from app.routers import investments_fx as router_module


@pytest.fixture
def fx_db(monkeypatch: pytest.MonkeyPatch):
    """Stub the fx_rates query + make get_rate a no-op (no network)."""
    state: dict[str, list[dict[str, Any]]] = {"rows": []}

    def fetch_all(sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        s = " ".join(sql.split())
        if "FROM fx_rates" in s and "ORDER BY rate_date DESC" in s:
            return state["rows"][:2]
        raise NotImplementedError(f"fx_db.fetch_all: {s[:100]}")

    monkeypatch.setattr(db_module, "fetch_all", fetch_all)
    # get_rate would hit BoC; the endpoint already swallows failures, but
    # stub it so the test never touches the network.
    monkeypatch.setattr(
        router_module.fx, "get_rate", lambda *a, **k: None, raising=True
    )
    return state


def test_inverts_and_reports_up_when_cad_strengthens(
    fx_db: dict[str, list[dict[str, Any]]], client: TestClient
) -> None:
    # latest BRL→CAD lower than previous → fewer CAD per BRL → CAD/BRL up.
    fx_db["rows"] = [
        {"rate": Decimal("0.2700"), "rate_date": date(2026, 5, 28)},
        {"rate": Decimal("0.2750"), "rate_date": date(2026, 5, 27)},
    ]
    body = client.get("/investments/fx/cad-brl").json()
    assert body["pair"] == "CAD/BRL"
    # 1/0.27 = 3.7037, 1/0.275 = 3.6364 → up.
    assert body["rate"] == "3.7037"
    assert body["prev_rate"] == "3.6364"
    assert body["direction"] == "up"
    assert body["as_of"] == "2026-05-28"


def test_down_when_cad_weakens(
    fx_db: dict[str, list[dict[str, Any]]], client: TestClient
) -> None:
    fx_db["rows"] = [
        {"rate": Decimal("0.2800"), "rate_date": date(2026, 5, 28)},
        {"rate": Decimal("0.2750"), "rate_date": date(2026, 5, 27)},
    ]
    body = client.get("/investments/fx/cad-brl").json()
    assert body["direction"] == "down"


def test_single_rate_has_no_direction(
    fx_db: dict[str, list[dict[str, Any]]], client: TestClient
) -> None:
    fx_db["rows"] = [{"rate": Decimal("0.2700"), "rate_date": date(2026, 5, 28)}]
    body = client.get("/investments/fx/cad-brl").json()
    assert body["rate"] == "3.7037"
    assert body["prev_rate"] is None
    assert body["direction"] is None


def test_503_when_no_rate_cached(
    fx_db: dict[str, list[dict[str, Any]]], client: TestClient
) -> None:
    fx_db["rows"] = []
    assert client.get("/investments/fx/cad-brl").status_code == 503
