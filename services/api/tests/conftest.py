"""pytest configuration and shared fixtures.

Routers talk to Aurora through :mod:`app.db`; tests substitute that module's
``fetch_all`` / ``fetch_one`` / ``execute`` helpers with tiny in-memory stores
(one per table). Stores are reseeded before each test so mutations don't leak
across cases.

Substring-matching the SQL is enough because the routers only emit a small,
known set of patterns; if a future router adds a new pattern, extend the
dispatch below.
"""

from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from app import db as db_module
from app.main import app

# Deterministic UUIDs referenced across test files.
SEED_ID_1 = UUID("00000000-0000-0000-0000-000000000001")  # Sulpetro
SEED_ID_2 = UUID("00000000-0000-0000-0000-000000000002")  # Wenco
SEED_ID_3 = UUID("00000000-0000-0000-0000-000000000003")  # Nutrien (archived)
SEED_ID_CP = UUID("3729f4b7-0506-4222-b4f5-5030a711762a")  # CP (archived)

_SEED_TIME = datetime(2022, 3, 1, 9, 0, 0, tzinfo=timezone.utc)


def _seed_clients() -> dict[UUID, dict[str, Any]]:
    """Build a fresh in-memory store mirroring the legacy seed clients."""
    base: dict[str, Any] = {
        "address_line1": None,
        "address_line2": None,
        "postal_code": None,
        "tax_id": None,
        "notes": None,
        "contract_value": None,
        "contract_currency": "CAD",
        "default_task_description": None,
        "default_taxable": True,
        "default_tax_rate": Decimal("0.0500"),
        "default_payment_terms_days": 30,
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
            "default_task_description": "Consulting services in ETL, ML and AI",
            # Sulpetro doesn't charge GST per the legacy invoices.
            "default_taxable": False,
            "default_tax_rate": None,
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
            "contract_value": Decimal("190000.00"),
            # Wenco invoices on Net 15 per V1 spec.
            "default_payment_terms_days": 15,
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


def _seed_settings() -> dict[str, str]:
    return {
        "user_full_name": "Thiago Gonçalves Pinto",
        "user_email": "th.goncalves@gmail.com",
        "user_phone": "(647) 321 7834",
        "company_name": "2441735 ALBERTA INC.",
    }


@pytest.fixture(autouse=True)
def fake_data_api(monkeypatch: pytest.MonkeyPatch) -> None:
    """Replace ``app.db`` helpers with in-memory dict-backed fakes."""
    clients_store: dict[UUID, dict[str, Any]] = _seed_clients()
    # time_entries keyed by (client_id, work_date) for the V1 unique invariant.
    time_entries: dict[tuple[UUID, date], dict[str, Any]] = {}
    # invoices keyed by id; line_items list per invoice for ordering.
    invoices_store: dict[UUID, dict[str, Any]] = {}
    invoice_line_items: list[dict[str, Any]] = []
    settings_store: dict[str, str] = _seed_settings()

    def _between(work_date: date, params: dict[str, Any]) -> bool:
        return params["start"] <= work_date <= params["end"]

    def _match_invoice_filters(row: dict[str, Any], params: dict[str, Any]) -> bool:
        if "from_date" in params and row["issue_date"] < params["from_date"]:
            return False
        if "to_date" in params and row["issue_date"] > params["to_date"]:
            return False
        if "status" in params and row["status"] != params["status"]:
            return False
        if "client_id" in params and row["client_id"] != params["client_id"]:
            return False
        return True

    def fetch_all(
        sql: str, params: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        sql = sql.strip()
        params = params or {}
        if "WHERE is_active = TRUE" in sql:
            return sorted(
                (r for r in clients_store.values() if r["is_active"]),
                key=lambda r: r["name"],
            )
        if sql.startswith("SELECT * FROM clients ORDER BY name"):
            return sorted(clients_store.values(), key=lambda r: r["name"])
        if sql.startswith("SELECT * FROM time_entries"):
            return [
                row
                for (cid, wd), row in time_entries.items()
                if cid == params["client_id"] and _between(wd, params)
            ]
        if sql.startswith("SELECT work_date, hours FROM time_entries"):
            return [
                {"work_date": row["work_date"], "hours": row["hours"]}
                for (cid, wd), row in time_entries.items()
                if cid == params["client_id"] and _between(wd, params)
            ]
        if sql.startswith("SELECT id, hours FROM time_entries"):
            return [
                {"id": row["id"], "hours": row["hours"]}
                for (cid, wd), row in time_entries.items()
                if cid == params["client_id"]
                and _between(wd, params)
                and row["invoice_id"] is None
            ]
        if sql.startswith("SELECT * FROM invoices"):
            rows = [
                r for r in invoices_store.values() if _match_invoice_filters(r, params)
            ]
            return sorted(
                rows,
                key=lambda r: (r["issue_date"], r["invoice_number"]),
                reverse=True,
            )
        if sql.startswith("SELECT * FROM invoice_line_items"):
            return sorted(
                (
                    ln
                    for ln in invoice_line_items
                    if ln["invoice_id"] == params["invoice_id"]
                ),
                key=lambda ln: ln["line_order"],
            )
        raise NotImplementedError(f"fake fetch_all doesn't handle: {sql[:80]}")

    def fetch_one(
        sql: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any] | None:
        sql = sql.strip()
        params = params or {}
        if sql.startswith("SELECT * FROM clients WHERE id"):
            return clients_store.get(params["id"])
        if sql.startswith("INSERT INTO clients"):
            row = dict(params)
            clients_store[row["id"]] = row
            return row
        if sql.startswith("UPDATE clients"):
            cid = params["id"]
            existing = clients_store.get(cid)
            if existing is None:
                return None
            merged = {**existing, **params}
            clients_store[cid] = merged
            return merged
        if sql.startswith("SELECT value FROM settings"):
            value = settings_store.get(params["key"])
            return {"value": value} if value is not None else None
        if "COALESCE(SUM(hours), 0)" in sql and "BETWEEN" in sql:
            total = sum(
                (
                    row["hours"]
                    for (cid, wd), row in time_entries.items()
                    if cid == params["client_id"] and _between(wd, params)
                ),
                Decimal(0),
            )
            return {"hours": total}
        if "COALESCE(SUM(hours), 0)" in sql:
            # Lifetime total for the client.
            total = sum(
                (
                    row["hours"]
                    for (cid, _wd), row in time_entries.items()
                    if cid == params["client_id"]
                ),
                Decimal(0),
            )
            return {"hours": total}
        if sql.startswith("SELECT invoice_number FROM invoices"):
            # Look for the last invoice_number matching the LIKE prefix.
            prefix = params["prefix"].rstrip("%")
            matches = [
                r["invoice_number"]
                for r in invoices_store.values()
                if r["invoice_number"].startswith(prefix)
            ]
            if not matches:
                return None
            return {"invoice_number": max(matches)}
        if sql.startswith("SELECT * FROM invoices WHERE id"):
            return invoices_store.get(params["id"])
        if sql.startswith("INSERT INTO invoices"):
            row = {
                **params,
                # The router omits attachments_path from params; default it.
                "attachments_path": params.get("attachments_path"),
            }
            row.setdefault("status", "draft")
            invoices_store[row["id"]] = row
            return row
        if sql.startswith("UPDATE invoices") and "status = 'sent'" in sql:
            existing = invoices_store.get(params["id"])
            if existing is None:
                return None
            existing["status"] = "sent"
            existing["updated_at"] = params["updated_at"]
            return existing
        if sql.startswith("UPDATE invoices"):
            existing = invoices_store.get(params["id"])
            if existing is None:
                return None
            for k, v in params.items():
                if k == "id":
                    continue
                if k == "status" and v is None:
                    continue  # COALESCE(:status, status) — keep existing
                existing[k] = v
            invoices_store[params["id"]] = existing
            return existing
        raise NotImplementedError(f"fake fetch_one doesn't handle: {sql[:80]}")

    def execute(
        sql: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        sql = sql.strip()
        params = params or {}
        if sql.startswith("DELETE FROM time_entries") and "NOT IN" in sql:
            # The router builds the NOT IN list inline (no params for the
            # dates). Strip out any uninvoiced row in the period that is not
            # in the literal list — which we recover by parsing.
            literal_segment = sql.split("NOT IN (", 1)[1].split(")", 1)[0]
            kept_dates = {
                date.fromisoformat(s.strip().strip("'"))
                for s in literal_segment.split(",")
                if s.strip()
            }
            keys_to_delete = [
                (cid, wd)
                for (cid, wd), row in time_entries.items()
                if cid == params["client_id"]
                and _between(wd, params)
                and row["invoice_id"] is None
                and wd not in kept_dates
            ]
            for k in keys_to_delete:
                del time_entries[k]
            return {}
        if sql.startswith("DELETE FROM time_entries") and "work_date = :work_date" in sql:
            key = (params["client_id"], params["work_date"])
            row = time_entries.get(key)
            if row is not None and row["invoice_id"] is None:
                del time_entries[key]
            return {}
        if sql.startswith("DELETE FROM time_entries") and "BETWEEN" in sql:
            # Wipe the whole period (uninvoiced only).
            keys_to_delete = [
                (cid, wd)
                for (cid, wd), row in time_entries.items()
                if cid == params["client_id"]
                and _between(wd, params)
                and row["invoice_id"] is None
            ]
            for k in keys_to_delete:
                del time_entries[k]
            return {}
        if sql.startswith("INSERT INTO invoice_line_items"):
            invoice_line_items.append(dict(params))
            return {}
        if sql.startswith("DELETE FROM invoice_line_items"):
            nonlocal_id = params["invoice_id"]
            invoice_line_items[:] = [
                ln for ln in invoice_line_items if ln["invoice_id"] != nonlocal_id
            ]
            return {}
        if sql.startswith("UPDATE time_entries") and "invoice_id" in sql:
            for (cid, wd), row in time_entries.items():
                if row["id"] == params["id"]:
                    row["invoice_id"] = params["invoice_id"]
                    row["updated_at"] = params["now"]
                    break
            return {}
        if sql.startswith("INSERT INTO time_entries"):
            # Postgres numeric(5,2) normalises to two decimal places; mimic
            # that so JSON output is stable across tests.
            quantised = Decimal(params["hours"]).quantize(Decimal("0.01"))
            key = (params["client_id"], params["work_date"])
            existing = time_entries.get(key)
            if existing is None:
                time_entries[key] = {
                    "id": params["id"],
                    "client_id": params["client_id"],
                    "work_date": params["work_date"],
                    "hours": quantised,
                    "invoice_id": None,
                    "created_at": params["now"],
                    "updated_at": params["now"],
                }
            elif existing["invoice_id"] is None:
                # ON CONFLICT DO UPDATE path.
                existing["hours"] = quantised
                existing["updated_at"] = params["now"]
            return {}
        raise NotImplementedError(f"fake execute doesn't handle: {sql[:80]}")

    monkeypatch.setattr(db_module, "fetch_all", fetch_all)
    monkeypatch.setattr(db_module, "fetch_one", fetch_one)
    monkeypatch.setattr(db_module, "execute", execute)


@pytest.fixture
def client() -> TestClient:
    """Return a synchronous FastAPI test client."""
    return TestClient(app)


# Re-exported helpers so individual tests can poke at fixtures if needed.
__all__ = [
    "SEED_ID_1",
    "SEED_ID_2",
    "SEED_ID_3",
    "SEED_ID_CP",
]
