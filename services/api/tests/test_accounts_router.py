"""Tests for the unified Accounts surface.

Covers four behaviours called out in ``docs/specs/accounts-management-v1.md``:

* the ``GET /accounts`` aggregator returns correctly-shaped rows from each
  of the three sources,
* ``PATCH /accounts/ynab/{id}/tags`` updates ``helm_kind`` / ``helm_owner``
  on a YNAB row and nothing else,
* the manual-account CRUD round-trips,
* and the YNAB sync's account-upsert step refreshes upstream columns
  without clobbering the Helm-side ``helm_kind`` / ``helm_owner`` tags.

The autouse ``fake_data_api`` in ``conftest.py`` covers the Business
surface (clients, invoices, …). We re-monkeypatch ``app.db`` on top of
that with smaller in-memory stores scoped to the Accounts surface — it
keeps the giant conftest fakes from gaining one-off SQL patterns for
every new module.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Callable
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app import db as db_module
from app.investments import fx as fx_module
from app.routers import accounts as accounts_router_module
from app.ynab import sync as sync_module

# ---------------------------------------------------------------------------
# Fixture: in-memory stores + SQL dispatch
# ---------------------------------------------------------------------------

_BUDGET_ID = "budget-1"
_YNAB_ROW_ID = "ynab-acct-1"


@pytest.fixture
def accounts_db(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Replace ``app.db`` helpers with tiny stores for the Accounts surface.

    Returns the store dict so individual tests can seed / inspect rows
    directly. Stores are fresh per test.
    """
    ynab_budgets: dict[str, dict[str, Any]] = {
        _BUDGET_ID: {
            "id": _BUDGET_ID,
            "name": "Personal",
            "currency_code": "CAD",
            "is_active": True,
            "last_synced_at": datetime(2026, 5, 18, tzinfo=timezone.utc),
        }
    }
    ynab_accounts: dict[str, dict[str, Any]] = {}
    manual_accounts: dict[UUID, dict[str, Any]] = {}
    investment_accounts: dict[UUID, dict[str, Any]] = {}
    # Holdings keyed by account_id → list[row], so the aggregator's
    # SUM/COUNT query can read totals per account.
    investment_holdings: dict[UUID, list[dict[str, Any]]] = {}

    stores = {
        "ynab_budgets": ynab_budgets,
        "ynab_accounts": ynab_accounts,
        "manual_accounts": manual_accounts,
        "investment_accounts": investment_accounts,
        "investment_holdings": investment_holdings,
    }

    def fetch_all(
        sql: str, params: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        sql = sql.strip()
        params = params or {}
        if "FROM ynab_budgets" in sql and "is_active = TRUE" in sql:
            return [b for b in ynab_budgets.values() if b["is_active"]]
        if "FROM ynab_accounts" in sql:
            return sorted(
                (
                    r
                    for r in ynab_accounts.values()
                    if not r.get("closed") and not r.get("deleted")
                ),
                key=lambda r: r["name"],
            )
        if "FROM manual_accounts" in sql and "WHERE is_active = TRUE" in sql:
            return sorted(
                (r for r in manual_accounts.values() if r["is_active"]),
                key=lambda r: r["name"],
            )
        if "FROM manual_accounts" in sql:
            return sorted(manual_accounts.values(), key=lambda r: r["name"])
        if "FROM investment_accounts" in sql and "WHERE is_active = TRUE" in sql:
            return sorted(
                (
                    r
                    for r in investment_accounts.values()
                    if r["is_active"]
                ),
                key=lambda r: r["name"],
            )
        raise NotImplementedError(f"accounts_db.fetch_all: {sql[:120]}")

    def fetch_one(
        sql: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any] | None:
        sql = sql.strip()
        params = params or {}
        # ---- Aggregator's holdings summary --------------------------------
        if "FROM investment_holdings" in sql and "SUM(shares * current_price)" in sql:
            rows = investment_holdings.get(params["id"], [])
            total = sum(
                Decimal(r["shares"]) * Decimal(r["current_price"]) for r in rows
            )
            return {"total": total, "n": len(rows)}
        # ---- ynab_budgets currency lookup ---------------------------------
        if "FROM ynab_budgets WHERE id = :id" in sql:
            return ynab_budgets.get(params["id"])
        # ---- existence checks before UPDATE ------------------------------
        if "FROM manual_accounts WHERE id = :id" in sql:
            return manual_accounts.get(params["id"])
        if "FROM investment_accounts WHERE id = :id" in sql:
            return investment_accounts.get(params["id"])
        # ---- UPDATE ... RETURNING * --------------------------------------
        if sql.startswith("UPDATE ynab_accounts"):
            row = ynab_accounts.get(params["id"])
            if row is None:
                return None
            _apply_assignments(row, sql, params)
            return row
        if sql.startswith("UPDATE manual_accounts"):
            row = manual_accounts.get(params["id"])
            if row is None:
                return None
            _apply_assignments(row, sql, params)
            return row
        if sql.startswith("UPDATE investment_accounts"):
            row = investment_accounts.get(params["id"])
            if row is None:
                return None
            _apply_assignments(row, sql, params)
            return row
        # ---- INSERT INTO manual_accounts ... RETURNING * -----------------
        if sql.startswith("INSERT INTO manual_accounts"):
            row = _new_manual_row(params)
            manual_accounts[row["id"]] = row
            return row
        raise NotImplementedError(f"accounts_db.fetch_one: {sql[:120]}")

    def execute(
        sql: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        sql = sql.strip()
        params = params or {}
        # ---- YNAB sync: account upsert ------------------------------------
        # Only updates the upstream-controlled columns on conflict —
        # helm_kind / helm_owner are NOT in the EXCLUDED set so they
        # must be left untouched. This mirrors the real SQL.
        if sql.startswith("INSERT INTO ynab_accounts"):
            existing = ynab_accounts.get(params["id"])
            if existing is None:
                ynab_accounts[params["id"]] = {
                    "id": params["id"],
                    "budget_id": params["budget_id"],
                    "name": params["name"],
                    "type": params["type"],
                    "on_budget": params["on_budget"],
                    "closed": params["closed"],
                    "deleted": params["deleted"],
                    "balance": params["balance"],
                    "cleared_balance": params["cleared_balance"],
                    "uncleared_balance": params["uncleared_balance"],
                    "helm_kind": None,
                    "helm_owner": None,
                    "last_synced_at": params["now"],
                }
            else:
                for k in (
                    "budget_id",
                    "name",
                    "type",
                    "on_budget",
                    "closed",
                    "deleted",
                    "balance",
                    "cleared_balance",
                    "uncleared_balance",
                ):
                    existing[k] = params[k]
                existing["last_synced_at"] = params["now"]
                # helm_kind / helm_owner intentionally NOT touched.
            return {}
        # ---- DELETE manual / investment ----------------------------------
        if sql.startswith("DELETE FROM manual_accounts"):
            manual_accounts.pop(params["id"], None)
            return {}
        if sql.startswith("DELETE FROM investment_accounts"):
            investment_accounts.pop(params["id"], None)
            return {}
        # Anything else (the rest of the YNAB sync — budgets, categories,
        # months, transactions) — silently no-op so we can call into
        # sync.refresh() with stubbed client methods covering only the
        # account step.
        return {}

    monkeypatch.setattr(db_module, "fetch_all", fetch_all)
    monkeypatch.setattr(db_module, "fetch_one", fetch_one)
    monkeypatch.setattr(db_module, "execute", execute)
    # Mock FX so the aggregator's CAD conversion is deterministic. BRL→CAD
    # at 0.27 (close to real value). USD→CAD at 1.36. CAD→CAD short-circuits
    # in get_rate without hitting the cache.
    #
    # Patch the binding inside the router module (which did
    # ``from app.investments.fx import get_rate``) — patching fx_module
    # alone wouldn't reach the already-bound name.
    fake_rate: Callable[..., Any] = lambda f, t, on=None: fx_module.FxRate(
        f,
        t,
        on or date.today(),
        {"BRL": Decimal("0.27"), "USD": Decimal("1.36")}.get(f, Decimal("1")),
    )
    monkeypatch.setattr(fx_module, "get_rate", fake_rate)
    monkeypatch.setattr(accounts_router_module, "get_rate", fake_rate)
    return stores


def _apply_assignments(
    row: dict[str, Any], sql: str, params: dict[str, Any]
) -> None:
    """Apply ``SET col = :col`` assignments parsed from the UPDATE SQL.

    Hand-parses the comma-separated SET clause — good enough for the
    fixed handful of update statements the routers emit.
    """
    set_idx = sql.upper().find("SET ")
    where_idx = sql.upper().find(" WHERE ")
    if set_idx == -1 or where_idx == -1:
        return
    assignments = sql[set_idx + 4 : where_idx]
    for piece in assignments.split(","):
        piece = piece.strip()
        if "=" not in piece:
            continue
        col, expr = (s.strip() for s in piece.split("=", 1))
        # The router-emitted SQL only uses bind params (``:name``).
        if expr.startswith(":") and expr[1:] in params:
            row[col] = params[expr[1:]]


def _new_manual_row(params: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": params["id"],
        "name": params["name"],
        "bank": params["bank"],
        "currency": params["currency"],
        "balance": params["balance"],
        "balance_as_of": params["today"],
        "kind": params["kind"],
        "owner": params["owner"],
        "notes": params["notes"],
        "is_active": params["is_active"],
        "created_at": params["now"],
        "updated_at": params["now"],
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestAccountsAggregator:
    def test_unions_rows_from_all_three_sources(
        self, client: TestClient, accounts_db: dict[str, Any]
    ) -> None:
        """One row per source, correctly namespaced and shaped."""
        manual_id = uuid4()
        inv_id = uuid4()

        accounts_db["ynab_accounts"][_YNAB_ROW_ID] = {
            "id": _YNAB_ROW_ID,
            "budget_id": _BUDGET_ID,
            "name": "TD Checking",
            "type": "checking",
            "on_budget": True,
            "closed": False,
            "deleted": False,
            # CAD 4,321.99 in milliunits.
            "balance": 4_321_990,
            "cleared_balance": 4_321_990,
            "uncleared_balance": 0,
            "helm_kind": None,
            "helm_owner": None,
            "last_synced_at": datetime(2026, 5, 18, tzinfo=timezone.utc),
        }
        accounts_db["manual_accounts"][manual_id] = {
            "id": manual_id,
            "name": "Itaú",
            "bank": "Itaú",
            "currency": "BRL",
            "balance": Decimal("18600.00"),
            "balance_as_of": date(2026, 4, 30),
            "kind": "checking",
            "owner": "personal",
            "notes": None,
            "is_active": True,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
        }
        accounts_db["investment_accounts"][inv_id] = {
            "id": inv_id,
            "name": "Scotia iTrade",
            "kind": "itrade",
            "currency": "CAD",
            "owner_label": None,
            "contribution_limit": None,
            "notes": None,
            "is_active": True,
            "owner": "personal",
            "helm_kind": "investing_stock",
            "bank": "Scotia iTrade",
            "cash_balance": Decimal("1234.00"),
            "cash_currency": "CAD",
            "balance_as_of": None,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
        }
        # One holding worth $3,320.
        accounts_db["investment_holdings"][inv_id] = [
            {"shares": Decimal("10"), "current_price": Decimal("332.00")}
        ]

        resp = client.get("/accounts")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        rows = body["accounts"]
        by_source = {r["source"]: r for r in rows}
        assert set(by_source) == {"ynab", "manual", "investment"}

        ynab = by_source["ynab"]
        assert ynab["id"] == f"ynab:{_YNAB_ROW_ID}"
        assert ynab["name"] == "TD Checking"
        # Auto-mapped from YNAB's "checking" type since helm_kind was NULL.
        assert ynab["kind"] == "checking"
        assert ynab["owner"] == "unassigned"
        # Milliunits → dollars at the boundary.
        assert Decimal(str(ynab["balance"])) == Decimal("4321.99")
        assert ynab["is_editable"] is False

        manual = by_source["manual"]
        assert manual["id"] == f"manual:{manual_id}"
        assert manual["currency"] == "BRL"
        # BRL 18,600 × 0.27 → CAD 5,022.00.
        assert Decimal(str(manual["balance_cad"])) == Decimal("5022.00")
        assert manual["is_editable"] is True

        inv = by_source["investment"]
        # Cash + holdings: 1,234 + (10 × 332) = 4,554.
        assert Decimal(str(inv["balance"])) == Decimal("4554.00")
        assert inv["extra"]["holdings_count"] == 1
        assert inv["extra"]["cash_balance"] == 1234.0
        assert inv["kind"] == "investing_stock"


class TestTagsPatch:
    def test_ynab_tags_update_helm_columns_only(
        self, client: TestClient, accounts_db: dict[str, Any]
    ) -> None:
        """A tags PATCH on a YNAB row only mutates helm_kind / helm_owner."""
        baseline_balance = 9_999_000
        accounts_db["ynab_accounts"][_YNAB_ROW_ID] = {
            "id": _YNAB_ROW_ID,
            "budget_id": _BUDGET_ID,
            "name": "TD Checking",
            "type": "checking",
            "on_budget": True,
            "closed": False,
            "deleted": False,
            "balance": baseline_balance,
            "cleared_balance": baseline_balance,
            "uncleared_balance": 0,
            "helm_kind": None,
            "helm_owner": None,
            "last_synced_at": datetime(2026, 5, 18, tzinfo=timezone.utc),
        }

        resp = client.patch(
            f"/accounts/ynab/{_YNAB_ROW_ID}/tags",
            json={"kind": "savings", "owner": "business"},
        )
        assert resp.status_code == 200, resp.text

        row = accounts_db["ynab_accounts"][_YNAB_ROW_ID]
        assert row["helm_kind"] == "savings"
        assert row["helm_owner"] == "business"
        # Upstream columns untouched.
        assert row["balance"] == baseline_balance
        assert row["name"] == "TD Checking"
        assert row["type"] == "checking"


class TestManualCrud:
    def test_create_then_read_then_update_then_delete(
        self, client: TestClient, accounts_db: dict[str, Any]
    ) -> None:
        # Create.
        create = client.post(
            "/accounts/manual",
            json={
                "name": "Itaú",
                "bank": "Itaú",
                "currency": "brl",
                "balance": "1200.00",
                "kind": "checking",
                "owner": "personal",
                "notes": "vacation fund",
            },
        )
        assert create.status_code == 201, create.text
        created = create.json()
        new_id = created["id"]
        assert created["currency"] == "BRL"  # router uppercases.
        assert Decimal(created["balance"]) == Decimal("1200.00")

        # Read (list).
        listing = client.get("/accounts/manual").json()
        assert any(r["id"] == new_id for r in listing)

        # Patch (balance + name). balance_as_of should bump to today.
        before_as_of = created["balance_as_of"]
        patch = client.patch(
            f"/accounts/manual/{new_id}",
            json={"balance": "1500.00", "name": "Itaú Pessoal"},
        )
        assert patch.status_code == 200, patch.text
        patched = patch.json()
        assert patched["name"] == "Itaú Pessoal"
        assert Decimal(patched["balance"]) == Decimal("1500.00")
        # balance_as_of was bumped (the router always sets :today on a
        # balance update; comparing equal-or-later survives same-day runs).
        assert patched["balance_as_of"] >= before_as_of

        # Hard delete — the row disappears from the store entirely.
        delete = client.delete(f"/accounts/manual/{new_id}")
        assert delete.status_code == 204
        assert UUID(new_id) not in accounts_db["manual_accounts"]


class TestYnabSyncPreservesHelmTags:
    def test_account_upsert_does_not_overwrite_helm_kind_or_owner(
        self, accounts_db: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Re-syncing a YNAB account preserves Helm-side annotations."""
        # Seed: user has previously synced this account and tagged it.
        accounts_db["ynab_accounts"][_YNAB_ROW_ID] = {
            "id": _YNAB_ROW_ID,
            "budget_id": _BUDGET_ID,
            "name": "Old Name",
            "type": "checking",
            "on_budget": True,
            "closed": False,
            "deleted": False,
            "balance": 100_000,
            "cleared_balance": 100_000,
            "uncleared_balance": 0,
            "helm_kind": "savings",
            "helm_owner": "personal",
            "last_synced_at": datetime(2026, 5, 1, tzinfo=timezone.utc),
        }

        # Stub a YnabClient with only the methods sync.refresh needs.
        class _StubClient:
            def list_budgets(self) -> list[dict[str, Any]]:
                return [
                    {
                        "id": _BUDGET_ID,
                        "name": "Personal",
                        "currency_format": {"iso_code": "CAD"},
                    }
                ]

            def get_accounts(self, budget_id: str) -> list[dict[str, Any]]:
                # Upstream pushes a new name + new balance.
                return [
                    {
                        "id": _YNAB_ROW_ID,
                        "name": "TD Checking (renamed)",
                        "type": "checking",
                        "on_budget": True,
                        "closed": False,
                        "deleted": False,
                        "balance": 555_555,
                        "cleared_balance": 555_555,
                        "uncleared_balance": 0,
                    }
                ]

            def get_categories(self, _bid: str) -> list[dict[str, Any]]:
                return []

            def get_month(self, _bid: str, _m: str) -> dict[str, Any]:
                return {"categories": []}

            def get_transactions(
                self, _bid: str, *, since_date: str | None = None
            ) -> list[dict[str, Any]]:
                return []

        result = sync_module.refresh(client=_StubClient(), budget_id=_BUDGET_ID)
        assert result.accounts_upserted == 1

        row = accounts_db["ynab_accounts"][_YNAB_ROW_ID]
        # Upstream-controlled columns refreshed.
        assert row["name"] == "TD Checking (renamed)"
        assert row["balance"] == 555_555
        # Helm-side tags survived.
        assert row["helm_kind"] == "savings"
        assert row["helm_owner"] == "personal"
