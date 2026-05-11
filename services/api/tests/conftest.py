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

from app import aws as aws_module
from app import db as db_module
from app.config import settings as app_settings
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
        "transfer_tax_rate_company": "0.30",
        "transfer_tax_rate_personal": "0.325",
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
    payments_store: dict[UUID, dict[str, Any]] = {}
    tax_payments_store: dict[UUID, dict[str, Any]] = {}
    invoice_tax_links: list[dict[str, Any]] = []
    transfers_store: dict[UUID, dict[str, Any]] = {}
    expenses_store: dict[UUID, dict[str, Any]] = {}
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
        if sql.startswith("SELECT key, value FROM settings"):
            return [
                {"key": k, "value": v}
                for k, v in sorted(settings_store.items())
            ]
        if sql.startswith("SELECT * FROM payments_received") and "WHERE" not in sql:
            # Dashboard / bulk read of all payments.
            return list(payments_store.values())
        if sql.startswith("SELECT id, name FROM clients"):
            return [
                {"id": c["id"], "name": c["name"]}
                for c in clients_store.values()
            ]
        if sql.startswith("SELECT invoice_id FROM invoice_tax_links"):
            return [{"invoice_id": l["invoice_id"]} for l in invoice_tax_links]
        if sql.startswith("SELECT * FROM transfers"):
            rows = list(transfers_store.values())
            if "from_date" in params:
                rows = [r for r in rows if r["transfer_date"] >= params["from_date"]]
            if "to_date" in params:
                rows = [r for r in rows if r["transfer_date"] <= params["to_date"]]
            return sorted(
                rows,
                key=lambda r: (r["transfer_date"], r["created_at"]),
                reverse=True,
            )
        if sql.startswith("SELECT * FROM expenses") and "WHERE id" not in sql:
            rows = list(expenses_store.values())
            if "from_date" in params:
                rows = [
                    r
                    for r in rows
                    if r.get("expense_date")
                    and r["expense_date"] >= params["from_date"]
                ]
            if "to_date" in params:
                rows = [
                    r
                    for r in rows
                    if r.get("expense_date")
                    and r["expense_date"] <= params["to_date"]
                ]
            if "status" in params:
                rows = [r for r in rows if r["status"] == params["status"]]
            return sorted(
                rows,
                key=lambda r: (
                    r.get("expense_date") or r["created_at"].date(),
                    r["created_at"],
                ),
                reverse=True,
            )
        if "FROM payments_received p" in sql and "JOIN invoices i" in sql:
            # Enriched list join: payments + invoices + clients.
            rows: list[dict[str, Any]] = []
            for p in payments_store.values():
                inv = invoices_store.get(p["invoice_id"])
                if inv is None:
                    continue
                client_row = clients_store.get(inv["client_id"])
                if client_row is None:
                    continue
                if "from_date" in params and p["payment_date"] < params["from_date"]:
                    continue
                if "to_date" in params and p["payment_date"] > params["to_date"]:
                    continue
                if "client_id" in params and inv["client_id"] != params["client_id"]:
                    continue
                if "invoice_id" in params and p["invoice_id"] != params["invoice_id"]:
                    continue
                rows.append(
                    {
                        **p,
                        "invoice_number": inv["invoice_number"],
                        "client_id": inv["client_id"],
                        "client_name": client_row["name"],
                    }
                )
            return sorted(
                rows,
                key=lambda r: (r["payment_date"], r["created_at"]),
                reverse=True,
            )
        if "FROM tax_payments p" in sql and "LEFT JOIN invoice_tax_links" in sql:
            # List GST payments enriched with counts/income.
            rows: list[dict[str, Any]] = []
            for p in tax_payments_store.values():
                linked = [
                    l for l in invoice_tax_links if l["tax_payment_id"] == p["id"]
                ]
                income = Decimal(0)
                for l in linked:
                    inv = invoices_store.get(l["invoice_id"])
                    if inv is not None and isinstance(inv["total"], Decimal):
                        income += inv["total"]
                rows.append(
                    {
                        "id": p["id"],
                        "payment_date": p["payment_date"],
                        "amount": p["amount"],
                        "payment_method": p["payment_method"],
                        "payment_reference": p["payment_reference"],
                        "notes": p["notes"],
                        "invoice_count": len(linked),
                        "income": income,
                    }
                )
            return sorted(rows, key=lambda r: r["payment_date"], reverse=True)
        if "FROM invoice_tax_links l" in sql and "JOIN invoices i" in sql:
            # Linked invoices for a single tax_payment.
            out: list[dict[str, Any]] = []
            for l in invoice_tax_links:
                if l["tax_payment_id"] != params["payment_id"]:
                    continue
                inv = invoices_store.get(l["invoice_id"])
                if inv is None:
                    continue
                cli = clients_store.get(inv["client_id"])
                if cli is None:
                    continue
                out.append(
                    {
                        "invoice_id": inv["id"],
                        "invoice_number": inv["invoice_number"],
                        "client_id": inv["client_id"],
                        "issue_date": inv["issue_date"],
                        "total": inv["total"],
                        "tax_amount": inv["tax_amount"],
                        "client_name": cli["name"],
                    }
                )
            return sorted(
                out, key=lambda r: (r["issue_date"], r["invoice_number"])
            )
        if (
            "FROM invoices i" in sql
            and "JOIN clients c" in sql
            and "WHERE i.tax_amount > 0" in sql
            and "NOT EXISTS" in sql
        ):
            # Unpaid invoices feed.
            out = []
            linked_ids = {l["invoice_id"] for l in invoice_tax_links}
            for inv in invoices_store.values():
                if not isinstance(inv["tax_amount"], Decimal):
                    continue
                if inv["tax_amount"] <= 0:
                    continue
                if inv["id"] in linked_ids:
                    continue
                cli = clients_store.get(inv["client_id"])
                if cli is None:
                    continue
                out.append(
                    {
                        "invoice_id": inv["id"],
                        "invoice_number": inv["invoice_number"],
                        "client_id": inv["client_id"],
                        "issue_date": inv["issue_date"],
                        "total": inv["total"],
                        "tax_amount": inv["tax_amount"],
                        "client_name": cli["name"],
                    }
                )
            return sorted(
                out,
                key=lambda r: (r["issue_date"], r["invoice_number"]),
                reverse=True,
            )
        if (
            "FROM invoices i" in sql
            and "LEFT JOIN invoice_tax_links l" in sql
        ):
            # Linkable invoices for the Link/Unlink dialog.
            payment_id = params["payment_id"]
            out = []
            for inv in invoices_store.values():
                if not isinstance(inv["tax_amount"], Decimal):
                    continue
                if inv["tax_amount"] <= 0:
                    continue
                link = next(
                    (
                        l
                        for l in invoice_tax_links
                        if l["invoice_id"] == inv["id"]
                    ),
                    None,
                )
                linked_payment_id = link["tax_payment_id"] if link else None
                if linked_payment_id is not None and linked_payment_id != payment_id:
                    continue
                cli = clients_store.get(inv["client_id"])
                if cli is None:
                    continue
                out.append(
                    {
                        "invoice_id": inv["id"],
                        "invoice_number": inv["invoice_number"],
                        "client_id": inv["client_id"],
                        "issue_date": inv["issue_date"],
                        "total": inv["total"],
                        "tax_amount": inv["tax_amount"],
                        "client_name": cli["name"],
                        "linked_payment_id": linked_payment_id,
                    }
                )
            return sorted(
                out, key=lambda r: (r["issue_date"], r["invoice_number"])
            )
        if "FROM invoices i" in sql and "JOIN clients c" in sql and "LEFT JOIN payments_received p" in sql:
            # invoice-options endpoint
            out: list[dict[str, Any]] = []
            for inv in invoices_store.values():
                cli = clients_store.get(inv["client_id"])
                if cli is None:
                    continue
                paid = sum(
                    (
                        p["amount"]
                        for p in payments_store.values()
                        if p["invoice_id"] == inv["id"]
                    ),
                    Decimal(0),
                )
                out.append(
                    {
                        "invoice_id": inv["id"],
                        "invoice_number": inv["invoice_number"],
                        "client_id": inv["client_id"],
                        "client_name": cli["name"],
                        "total": inv["total"],
                        "status": inv["status"],
                        "paid": paid,
                    }
                )
            return out
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
            existing["updated_at"] = params["now"] if "now" in params else params.get("updated_at")
            return existing
        if sql.startswith("UPDATE invoices") and "status = 'paid'" in sql:
            existing = invoices_store.get(params["id"])
            if existing is None:
                return None
            existing["status"] = "paid"
            existing["updated_at"] = params["now"] if "now" in params else params.get("updated_at")
            return existing
        if sql.startswith("SELECT i.total AS total"):
            inv = invoices_store.get(params["invoice_id"])
            if inv is None:
                return None
            paid = sum(
                (
                    p["amount"]
                    for p in payments_store.values()
                    if p["invoice_id"] == params["invoice_id"]
                ),
                Decimal(0),
            )
            return {
                "total": inv["total"],
                "status": inv["status"],
                "paid": paid,
            }
        if sql.startswith("SELECT id FROM invoices"):
            inv = invoices_store.get(params["id"])
            if inv is None:
                return None
            return {"id": inv["id"]}
        if sql.startswith("SELECT * FROM payments_received WHERE id"):
            return payments_store.get(params["id"])
        if sql.startswith("SELECT * FROM tax_payments WHERE id"):
            return tax_payments_store.get(params["id"])
        if "FROM invoices i" in sql and "WHERE i.tax_amount > 0" in sql and "NOT EXISTS" in sql and "SUM" in sql:
            # Summary KPIs: gst_unpaid + unpaid_income.
            linked_ids = {l["invoice_id"] for l in invoice_tax_links}
            gst_unpaid = Decimal(0)
            unpaid_income = Decimal(0)
            for inv in invoices_store.values():
                if not isinstance(inv["tax_amount"], Decimal):
                    continue
                if inv["tax_amount"] <= 0:
                    continue
                if inv["id"] in linked_ids:
                    continue
                gst_unpaid += inv["tax_amount"]
                if isinstance(inv["total"], Decimal):
                    unpaid_income += inv["total"]
            return {"gst_unpaid": gst_unpaid, "unpaid_income": unpaid_income}
        if "FROM tax_payments" in sql and "SUM(amount)" in sql:
            total = sum(
                (
                    p["amount"]
                    for p in tax_payments_store.values()
                    if isinstance(p["amount"], Decimal)
                ),
                Decimal(0),
            )
            return {"total_gst_paid": total}
        if sql.startswith("SELECT tax_amount FROM invoices"):
            inv = invoices_store.get(params["id"])
            if inv is None:
                return None
            return {"tax_amount": inv["tax_amount"]}
        if sql.startswith("INSERT INTO tax_payments"):
            row = {**params}
            if isinstance(row.get("amount"), Decimal):
                row["amount"] = row["amount"].quantize(Decimal("0.01"))
            row.setdefault("tax_id", None)
            row.setdefault("fiscal_year", None)
            tax_payments_store[row["id"]] = row
            return row
        if sql.startswith("SELECT * FROM transfers"):
            return transfers_store.get(params["id"])
        if "FROM transfers" in sql and "COUNT(*)" in sql:
            # Summary aggregate over an optional date window.
            rows = list(transfers_store.values())
            if "from_date" in params:
                rows = [r for r in rows if r["transfer_date"] >= params["from_date"]]
            if "to_date" in params:
                rows = [r for r in rows if r["transfer_date"] <= params["to_date"]]
            total = sum(
                (r["amount"] for r in rows if isinstance(r["amount"], Decimal)),
                Decimal(0),
            )
            company = sum(
                (
                    r["estimated_tax_company"]
                    for r in rows
                    if isinstance(r.get("estimated_tax_company"), Decimal)
                ),
                Decimal(0),
            )
            personal = sum(
                (
                    r["estimated_tax_personal"]
                    for r in rows
                    if isinstance(r.get("estimated_tax_personal"), Decimal)
                ),
                Decimal(0),
            )
            return {
                "total_transferred": total,
                "transaction_count": len(rows),
                "est_company_tax": company,
                "est_personal_tax": personal,
            }
        if sql.startswith("INSERT INTO transfers"):
            row = {**params}
            for k in (
                "amount",
                "estimated_tax_company",
                "estimated_tax_personal",
                "actual_tax_paid_company",
                "actual_tax_paid_personal",
            ):
                if isinstance(row.get(k), Decimal):
                    row[k] = row[k].quantize(Decimal("0.01"))
            transfers_store[row["id"]] = row
            return row
        if sql.startswith("SELECT * FROM expenses WHERE id"):
            return expenses_store.get(params["id"])
        if sql.startswith("SELECT * FROM expenses WHERE s3_key"):
            return next(
                (
                    e
                    for e in expenses_store.values()
                    if e.get("s3_key") == params["s3_key"]
                ),
                None,
            )
        if sql.startswith("INSERT INTO expenses"):
            now = params.get("now")
            row = {
                "ocr_raw": None,
                "ocr_error": None,
                "expense_date": None,
                "supplier": None,
                "category": None,
                "subtotal": None,
                "tax_amount": None,
                "total": None,
                "notes": None,
                # Literals from the router's INSERT SQL.
                "status": "pending",
                "currency": "CAD",
                "created_at": now,
                "updated_at": now,
                **params,
            }
            for k in ("subtotal", "tax_amount", "total", "size_bytes"):
                v = row.get(k)
                if isinstance(v, Decimal):
                    row[k] = v.quantize(Decimal("0.01"))
            expenses_store[row["id"]] = row
            return row
        if sql.startswith("UPDATE expenses"):
            existing = expenses_store.get(params["id"])
            if existing is None:
                return None
            for k, v in params.items():
                if k == "id":
                    continue
                # The processor handler stores `ocr_raw` as a JSON
                # string (via CAST :ocr_raw AS jsonb in real SQL).
                # Tests pass the raw dict — fall through to plain set.
                existing[k] = v
            for k in ("subtotal", "tax_amount", "total"):
                if isinstance(existing.get(k), Decimal):
                    existing[k] = existing[k].quantize(Decimal("0.01"))
            return existing
        if sql.startswith("UPDATE transfers"):
            existing = transfers_store.get(params["id"])
            if existing is None:
                return None
            for k, v in params.items():
                if k == "id":
                    continue
                existing[k] = v
            for k in (
                "amount",
                "estimated_tax_company",
                "estimated_tax_personal",
                "actual_tax_paid_company",
                "actual_tax_paid_personal",
            ):
                if isinstance(existing.get(k), Decimal):
                    existing[k] = existing[k].quantize(Decimal("0.01"))
            return existing
        if sql.startswith("UPDATE tax_payments"):
            existing = tax_payments_store.get(params["id"])
            if existing is None:
                return None
            for k, v in params.items():
                if k == "id":
                    continue
                existing[k] = v
            if isinstance(existing.get("amount"), Decimal):
                existing["amount"] = existing["amount"].quantize(Decimal("0.01"))
            return existing
        if sql.startswith("INSERT INTO payments_received"):
            row = {**params}
            # Real PG numeric(15,2) quantises to 2dp; mimic so JSON is stable.
            for k in ("amount", "deduction_amount"):
                if isinstance(row.get(k), Decimal):
                    row[k] = row[k].quantize(Decimal("0.01"))
            payments_store[row["id"]] = row
            return row
        if sql.startswith("UPDATE payments_received"):
            existing = payments_store.get(params["id"])
            if existing is None:
                return None
            for k, v in params.items():
                existing[k] = v
            payments_store[params["id"]] = existing
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
        if sql.startswith("UPDATE invoices") and "status = 'paid'" in sql:
            inv = invoices_store.get(params["id"])
            if inv is not None:
                inv["status"] = "paid"
                inv["updated_at"] = params.get("now") or params.get("updated_at")
            return {}
        if sql.startswith("UPDATE invoices") and "status = 'sent'" in sql:
            inv = invoices_store.get(params["id"])
            if inv is not None:
                inv["status"] = "sent"
                inv["updated_at"] = params.get("now") or params.get("updated_at")
            return {}
        if sql.startswith("DELETE FROM payments_received"):
            payments_store.pop(params["id"], None)
            return {}
        if sql.startswith("DELETE FROM invoice_tax_links"):
            invoice_tax_links[:] = [
                l
                for l in invoice_tax_links
                if l["tax_payment_id"] != params["payment_id"]
            ]
            return {}
        if sql.startswith("INSERT INTO invoice_tax_links"):
            # Enforce the unique-on-invoice_id constraint.
            if any(
                l["invoice_id"] == params["invoice_id"] for l in invoice_tax_links
            ):
                raise RuntimeError(
                    f"duplicate key on invoice_tax_links_invoice_unique: "
                    f"{params['invoice_id']}"
                )
            invoice_tax_links.append(
                {
                    "id": params["id"],
                    "invoice_id": params["invoice_id"],
                    "tax_payment_id": params["payment_id"],
                    "gst_amount": params["gst_amount"],
                    "created_at": params["now"],
                }
            )
            return {}
        if sql.startswith("DELETE FROM tax_payments"):
            tax_payments_store.pop(params["id"], None)
            return {}
        if sql.startswith("DELETE FROM transfers"):
            transfers_store.pop(params["id"], None)
            return {}
        if sql.startswith("DELETE FROM expenses"):
            expenses_store.pop(params["id"], None)
            return {}
        if sql.startswith("UPDATE expenses"):
            existing = expenses_store.get(params["id"])
            if existing is None:
                return {}
            # The processor handler bakes status literals into the SQL
            # (status = 'processing' / 'ready' / 'failed'); detect those
            # so the fake DB mirrors the real one.
            if "status = 'processing'" in sql:
                existing["status"] = "processing"
            elif "status = 'ready'" in sql:
                existing["status"] = "ready"
            elif "status = 'failed'" in sql:
                existing["status"] = "failed"
            for k, v in params.items():
                if k == "id":
                    continue
                existing[k] = v
            return {}
        if sql.startswith("INSERT INTO settings"):
            settings_store[params["key"]] = params["value"]
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


# ---------------------------------------------------------------------------
# S3 / Textract fakes for the expenses feature
# ---------------------------------------------------------------------------


class _FakeS3Client:
    """Minimal boto3 ``s3`` stub.

    Tracks PUT-object content via the presigned URL the test code reads;
    in unit tests we don't actually upload anything, so the URL is just
    a deterministic string. ``delete_object`` records calls so the
    delete-expense test can assert it ran.
    """

    def __init__(self) -> None:
        self.deleted: list[tuple[str, str]] = []

    def generate_presigned_url(
        self, *, ClientMethod: str, Params: dict, ExpiresIn: int
    ) -> str:
        kind = "put" if ClientMethod == "put_object" else "get"
        return f"https://fake-s3.local/{Params['Bucket']}/{Params['Key']}?op={kind}&expires={ExpiresIn}"

    def delete_object(self, *, Bucket: str, Key: str) -> dict:
        self.deleted.append((Bucket, Key))
        return {"DeleteMarker": False}


class _FakeTextractClient:
    """Boto3 ``textract`` stub.

    Tests use ``monkeypatch.setattr(aws_module, "_TEXTRACT_CLIENT",
    fake)`` to control what ``analyze_expense`` returns per test.
    """

    def __init__(self, response: dict | None = None) -> None:
        self.response: dict = response or {"ExpenseDocuments": []}
        self.calls: list[dict] = []

    def analyze_expense(self, *, Document: dict) -> dict:
        self.calls.append(Document)
        return self.response


@pytest.fixture(autouse=True)
def fake_aws_clients(monkeypatch: pytest.MonkeyPatch) -> dict:
    """Substitute the boto3 S3 + Textract clients with in-process fakes.

    Returns the fake instances so individual tests can inspect them
    (e.g. assert ``delete_object`` was called).
    """
    s3 = _FakeS3Client()
    textract = _FakeTextractClient()
    monkeypatch.setattr(aws_module, "_S3_CLIENT", s3)
    monkeypatch.setattr(aws_module, "_TEXTRACT_CLIENT", textract)
    # Tests assume the bucket is configured; the production env sets
    # this via HELM_RECEIPTS_BUCKET.
    monkeypatch.setattr(app_settings, "receipts_bucket", "helm-receipts-test")
    return {"s3": s3, "textract": textract}


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
