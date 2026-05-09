"""pytest configuration and shared fixtures.

The router talks to Aurora through :mod:`app.db`; tests substitute that
module's ``fetch_all`` / ``fetch_one`` / ``execute`` helpers with a tiny
in-memory store. The store is reseeded before each test so mutations
don't leak across cases.

Substring-matching the SQL is enough because ``app/routers/clients.py``
only emits a small handful of distinct queries; if a future router adds a
new pattern, extend the dispatch below.
"""

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from app import db as db_module
from app.main import app

# Deterministic UUIDs referenced by tests/test_clients_router.py.
SEED_ID_1 = UUID("00000000-0000-0000-0000-000000000001")  # Sulpetro
SEED_ID_2 = UUID("00000000-0000-0000-0000-000000000002")  # Wenco
SEED_ID_3 = UUID("00000000-0000-0000-0000-000000000003")  # Nutrien (archived)
SEED_ID_CP = UUID("3729f4b7-0506-4222-b4f5-5030a711762a")  # CP (archived)

_SEED_TIME = datetime(2022, 3, 1, 9, 0, 0, tzinfo=timezone.utc)


def _seed_store() -> dict[UUID, dict[str, Any]]:
    """Build a fresh in-memory store mirroring the legacy seed clients."""
    base: dict[str, Any] = {
        "address_line1": None,
        "address_line2": None,
        "postal_code": None,
        "tax_id": None,
        "notes": None,
        "created_at": _SEED_TIME,
        "updated_at": _SEED_TIME,
    }
    return {
        SEED_ID_1: {
            **base,
            "id": SEED_ID_1,
            "name": "Sulpetro",
            "email": "ckingsford@sulpetro.com",
            "phone": "(403) 619-7785",
            "city": "Calgary",
            "state": "Alberta",
            "country": "Canada",
            "is_active": True,
            "hourly_rate": Decimal("100.00"),
            "timesheet_frequency": "monthly",
        },
        SEED_ID_2: {
            **base,
            "id": SEED_ID_2,
            "name": "Wenco",
            "email": None,
            "phone": None,
            "city": None,
            "state": None,
            "country": "Australia",
            "is_active": True,
            "hourly_rate": Decimal("95.38"),
            "timesheet_frequency": "monthly",
        },
        SEED_ID_3: {
            **base,
            "id": SEED_ID_3,
            "name": "Nutrien",
            "email": None,
            "phone": None,
            "city": None,
            "state": None,
            "country": "Canada",
            "is_active": False,
            "hourly_rate": None,
            "timesheet_frequency": "monthly",
        },
        SEED_ID_CP: {
            **base,
            "id": SEED_ID_CP,
            "name": "CP",
            "email": None,
            "phone": None,
            "city": None,
            "state": None,
            "country": "Canada",
            "is_active": False,
            "hourly_rate": Decimal("95.00"),
            "timesheet_frequency": "weekly",
        },
    }


@pytest.fixture(autouse=True)
def fake_data_api(monkeypatch: pytest.MonkeyPatch) -> None:
    """Replace ``app.db`` helpers with an in-memory dict-backed fake."""
    store: dict[UUID, dict[str, Any]] = _seed_store()

    def fetch_all(
        sql: str, params: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        sql = sql.strip()
        if "WHERE is_active = TRUE" in sql:
            return sorted(
                (r for r in store.values() if r["is_active"]),
                key=lambda r: r["name"],
            )
        if sql.startswith("SELECT * FROM clients ORDER BY name"):
            return sorted(store.values(), key=lambda r: r["name"])
        raise NotImplementedError(f"fake fetch_all doesn't handle: {sql[:80]}")

    def fetch_one(
        sql: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any] | None:
        sql = sql.strip()
        params = params or {}
        if sql.startswith("SELECT * FROM clients WHERE id"):
            return store.get(params["id"])
        if sql.startswith("INSERT INTO clients"):
            row = dict(params)
            store[row["id"]] = row
            return row
        if sql.startswith("UPDATE clients"):
            cid = params["id"]
            existing = store.get(cid)
            if existing is None:
                return None
            merged = {**existing, **params}
            store[cid] = merged
            return merged
        raise NotImplementedError(f"fake fetch_one doesn't handle: {sql[:80]}")

    def execute(
        sql: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        raise NotImplementedError(f"fake execute doesn't handle: {sql[:80]}")

    monkeypatch.setattr(db_module, "fetch_all", fetch_all)
    monkeypatch.setattr(db_module, "fetch_one", fetch_one)
    monkeypatch.setattr(db_module, "execute", execute)


@pytest.fixture
def client() -> TestClient:
    """Return a synchronous FastAPI test client."""
    return TestClient(app)
