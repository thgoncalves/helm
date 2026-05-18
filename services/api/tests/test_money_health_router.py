"""Tests for the health-first Money dashboard endpoint.

Covers the four KPIs the dashboard renders plus the empty-state paths
when YNAB data is missing. Uses a local in-memory fixture layered on
top of the autouse business-side fakes, same pattern as
``test_accounts_router.py``.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app import db as db_module
from app.investments import fx as fx_module
from app.routers import money_health as health_module


_BUDGET_ID = "budget-1"


@pytest.fixture
def money_db(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Tiny db.* fakes scoped to the health endpoint's SQL surface.

    Each store is fresh per test so seeding doesn't leak.
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
    investment_holdings: dict[UUID, list[dict[str, Any]]] = {}
    # YNAB transactions for the 12-month flow math. Each row: dict with
    # amount (signed milliunits), posted_date (date), transfer_account_id.
    ynab_transactions: list[dict[str, Any]] = []

    stores = {
        "ynab_budgets": ynab_budgets,
        "ynab_accounts": ynab_accounts,
        "manual_accounts": manual_accounts,
        "investment_accounts": investment_accounts,
        "investment_holdings": investment_holdings,
        "ynab_transactions": ynab_transactions,
    }

    def fetch_all(
        sql: str, params: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        sql = sql.strip()
        params = params or {}
        if "FROM ynab_budgets" in sql and "is_active = TRUE" in sql:
            return [b for b in ynab_budgets.values() if b["is_active"]]
        if "FROM ynab_accounts" in sql:
            return [
                r
                for r in ynab_accounts.values()
                if not r.get("closed") and not r.get("deleted")
            ]
        if "FROM manual_accounts" in sql:
            return [r for r in manual_accounts.values() if r["is_active"]]
        if "FROM investment_accounts" in sql:
            return [
                r for r in investment_accounts.values() if r["is_active"]
            ]
        if (
            "FROM ynab_transactions" in sql
            and "GROUP BY" in sql
            and "date_trunc" in sql
        ):
            # Monthly-flow aggregation. Bucket each non-transfer txn by
            # the first day of its month; sum inflow/outflow per bucket.
            since = params["since"]
            buckets: dict[date, dict[str, int]] = {}
            for txn in ynab_transactions:
                if txn.get("transfer_account_id") is not None:
                    continue
                if txn["posted_date"] < since:
                    continue
                month_first = txn["posted_date"].replace(day=1)
                slot = buckets.setdefault(
                    month_first, {"inflow": 0, "outflow": 0}
                )
                amount = int(txn["amount"])
                if amount > 0:
                    slot["inflow"] += amount
                else:
                    slot["outflow"] += amount
            return [
                {
                    "month": m,
                    "inflow": v["inflow"],
                    "outflow": v["outflow"],
                }
                for m, v in sorted(buckets.items())
            ]
        raise NotImplementedError(f"money_db.fetch_all: {sql[:120]}")

    def fetch_one(
        sql: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any] | None:
        sql = sql.strip()
        params = params or {}
        if "FROM ynab_budgets" in sql and "is_active = TRUE" in sql:
            for b in ynab_budgets.values():
                if b["is_active"]:
                    return b
            return None
        if "FROM investment_holdings" in sql and "SUM(shares * current_price)" in sql:
            rows = investment_holdings.get(params["id"], [])
            total = sum(
                Decimal(r["shares"]) * Decimal(r["current_price"])
                for r in rows
            )
            return {"total": total, "n": len(rows)}
        if "FROM ynab_transactions" in sql and "SUM(CASE" in sql:
            # Aggregate inflow + outflow over the trailing window.
            since = params["since"]
            inflow = 0
            outflow = 0
            n = 0
            for txn in ynab_transactions:
                if txn.get("transfer_account_id") is not None:
                    continue
                if txn["posted_date"] < since:
                    continue
                amount = int(txn["amount"])
                if amount > 0:
                    inflow += amount
                else:
                    outflow += amount
                n += 1
            return {"inflow": inflow, "outflow": outflow, "n": n}
        raise NotImplementedError(f"money_db.fetch_one: {sql[:120]}")

    def execute(
        sql: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return {}

    monkeypatch.setattr(db_module, "fetch_all", fetch_all)
    monkeypatch.setattr(db_module, "fetch_one", fetch_one)
    monkeypatch.setattr(db_module, "execute", execute)

    # Force the router's db-configured guard to pass so we exercise the
    # real aggregation logic. The autouse business-fakes leave settings
    # in their default state which doesn't include the database ARNs.
    from app.config import settings

    monkeypatch.setattr(settings, "database_resource_arn", "arn:test:rds")
    monkeypatch.setattr(
        settings, "database_secret_arn", "arn:test:secret"
    )

    # FX: deterministic rates. CAD short-circuits to 1.0.
    monkeypatch.setattr(
        fx_module,
        "get_rate",
        lambda f, t, on=None: fx_module.FxRate(
            f,
            t,
            on or date.today(),
            {"BRL": Decimal("0.25"), "USD": Decimal("1.35")}.get(
                f, Decimal("1")
            ),
        ),
    )
    monkeypatch.setattr(
        health_module,
        "get_rate",
        lambda f, t, on=None: fx_module.FxRate(
            f,
            t,
            on or date.today(),
            {"BRL": Decimal("0.25"), "USD": Decimal("1.35")}.get(
                f, Decimal("1")
            ),
        ),
    )
    return stores


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestNetWorth:
    def test_sums_assets_and_liabilities_across_sources(
        self, client: TestClient, money_db: dict[str, Any]
    ) -> None:
        """Net worth = (cash + savings + investments) − (credit + LOC)."""
        # Personal cash, CAD: $5,000 in checking via YNAB.
        money_db["ynab_accounts"]["ynab-1"] = {
            "id": "ynab-1",
            "budget_id": _BUDGET_ID,
            "name": "TD Checking",
            "type": "checking",
            "on_budget": True,
            "closed": False,
            "deleted": False,
            "balance": 5_000_000,  # milliunits
            "cleared_balance": 5_000_000,
            "uncleared_balance": 0,
            "helm_kind": None,  # auto-maps from type
            "helm_owner": "personal",
            "last_synced_at": datetime.now(timezone.utc),
        }
        # Personal credit card, CAD: -$1,200 (a debt).
        money_db["ynab_accounts"]["ynab-2"] = {
            "id": "ynab-2",
            "budget_id": _BUDGET_ID,
            "name": "Visa",
            "type": "creditCard",
            "on_budget": True,
            "closed": False,
            "deleted": False,
            "balance": -1_200_000,
            "cleared_balance": -1_200_000,
            "uncleared_balance": 0,
            "helm_kind": None,
            "helm_owner": "personal",
            "last_synced_at": datetime.now(timezone.utc),
        }
        # Brazilian checking, BRL 20,000 = CAD 5,000 at 0.25 rate.
        money_db["manual_accounts"][uuid4()] = {
            "id": uuid4(),
            "name": "Itaú",
            "bank": "Itaú",
            "currency": "BRL",
            "balance": Decimal("20000.00"),
            "balance_as_of": date.today(),
            "kind": "checking",
            "owner": "personal",
            "notes": None,
            "is_active": True,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
        }
        # Investment account with $3,000 in holdings + $500 cash, CAD.
        inv_id = uuid4()
        money_db["investment_accounts"][inv_id] = {
            "id": inv_id,
            "name": "iTrade",
            "kind": "itrade",
            "currency": "CAD",
            "owner_label": None,
            "contribution_limit": None,
            "notes": None,
            "is_active": True,
            "owner": "personal",
            "helm_kind": "investing_stock",
            "bank": "Scotia iTrade",
            "cash_balance": Decimal("500.00"),
            "cash_currency": "CAD",
            "balance_as_of": None,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
        }
        money_db["investment_holdings"][inv_id] = [
            {"shares": Decimal("30"), "current_price": Decimal("100.00")},
        ]

        resp = client.get("/money/health")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # Assets: 5000 (TD) + 5000 (Itaú BRL→CAD) + 3500 (iTrade) = 13500.
        assert Decimal(body["assets_cad"]) == Decimal("13500.00")
        # Liabilities: 1200 (Visa, abs value).
        assert Decimal(body["liabilities_cad"]) == Decimal("1200.00")
        assert Decimal(body["net_worth_cad"]) == Decimal("12300.00")
        # All sources owned by Personal in this fixture.
        assert Decimal(body["personal_net_worth_cad"]) == Decimal("12300.00")
        assert Decimal(body["business_net_worth_cad"]) == Decimal("0.00")


class TestSavingsRatio:
    def test_computed_from_ynab_flows(
        self, client: TestClient, money_db: dict[str, Any]
    ) -> None:
        """Trailing-12mo: $120k inflow + $96k outflow → 20% savings ratio."""
        today = date.today()
        # 12 monthly inflows of $10k → $120k annual, $10k/mo income.
        for i in range(12):
            money_db["ynab_transactions"].append(
                {
                    "amount": 10_000_000,
                    "posted_date": today - timedelta(days=30 * i + 1),
                    "transfer_account_id": None,
                }
            )
        # 12 monthly outflows of $8k → $96k annual, $8k/mo expenses.
        for i in range(12):
            money_db["ynab_transactions"].append(
                {
                    "amount": -8_000_000,
                    "posted_date": today - timedelta(days=30 * i + 1),
                    "transfer_account_id": None,
                }
            )

        resp = client.get("/money/health")
        body = resp.json()
        ratio = Decimal(body["savings_ratio"]["value"])
        # (10000 − 8000) / 10000 = 20%.
        assert ratio == Decimal("20.00")
        assert body["savings_ratio"]["status"] == "above"

    def test_returns_unavailable_when_no_income(
        self, client: TestClient, money_db: dict[str, Any]
    ) -> None:
        resp = client.get("/money/health")
        body = resp.json()
        assert body["savings_ratio"]["value"] is None
        assert body["savings_ratio"]["status"] == "unavailable"
        assert body["savings_ratio"]["reason"] is not None

    def test_excludes_transfers(
        self, client: TestClient, money_db: dict[str, Any]
    ) -> None:
        """Transfers between accounts must not inflate inflow / outflow."""
        today = date.today()
        money_db["ynab_transactions"].append(
            {
                "amount": 50_000_000,  # $50k inflow — but it's a transfer.
                "posted_date": today,
                "transfer_account_id": "some-other-account",
            }
        )
        money_db["ynab_transactions"].append(
            {
                "amount": -50_000_000,  # the other side of the transfer.
                "posted_date": today,
                "transfer_account_id": "some-account",
            }
        )

        resp = client.get("/money/health")
        body = resp.json()
        # No real income or expenses → unavailable.
        assert body["savings_ratio"]["value"] is None


class TestDebtToIncome:
    def test_uses_annualised_income_against_total_lending(
        self, client: TestClient, money_db: dict[str, Any]
    ) -> None:
        """$1,200 debt / ($10k × 12) annualised = 1% — well under target."""
        today = date.today()
        for i in range(12):
            money_db["ynab_transactions"].append(
                {
                    "amount": 10_000_000,
                    "posted_date": today - timedelta(days=30 * i + 1),
                    "transfer_account_id": None,
                }
            )
        money_db["ynab_accounts"]["visa"] = {
            "id": "visa",
            "budget_id": _BUDGET_ID,
            "name": "Visa",
            "type": "creditCard",
            "on_budget": True,
            "closed": False,
            "deleted": False,
            "balance": -1_200_000,
            "cleared_balance": -1_200_000,
            "uncleared_balance": 0,
            "helm_kind": None,
            "helm_owner": "personal",
            "last_synced_at": datetime.now(timezone.utc),
        }

        resp = client.get("/money/health")
        body = resp.json()
        # 1200 / 120000 = 1%.
        assert Decimal(body["debt_to_income"]["value"]) == Decimal("1.00")
        # Below 30% target = healthy ("above" in the higher-is-better sense
        # of the status enum, which means on or beyond the goal).
        assert body["debt_to_income"]["status"] == "above"


class TestAllocation:
    def test_collapses_funds_and_stocks_into_one_investing_slice(
        self, client: TestClient, money_db: dict[str, Any]
    ) -> None:
        """Donut shows Checking / Savings / Investing only — no kind split."""
        # $4,000 checking + $1,000 savings + $5,000 investing (funds).
        money_db["ynab_accounts"]["chk"] = {
            "id": "chk",
            "budget_id": _BUDGET_ID,
            "name": "TD",
            "type": "checking",
            "on_budget": True,
            "closed": False,
            "deleted": False,
            "balance": 4_000_000,
            "cleared_balance": 4_000_000,
            "uncleared_balance": 0,
            "helm_kind": None,
            "helm_owner": "personal",
            "last_synced_at": datetime.now(timezone.utc),
        }
        money_db["ynab_accounts"]["sav"] = {
            "id": "sav",
            "budget_id": _BUDGET_ID,
            "name": "TD Savings",
            "type": "savings",
            "on_budget": True,
            "closed": False,
            "deleted": False,
            "balance": 1_000_000,
            "cleared_balance": 1_000_000,
            "uncleared_balance": 0,
            "helm_kind": None,
            "helm_owner": "personal",
            "last_synced_at": datetime.now(timezone.utc),
        }
        inv_id = uuid4()
        money_db["investment_accounts"][inv_id] = {
            "id": inv_id,
            "name": "iTrade",
            "kind": "itrade",
            "currency": "CAD",
            "owner_label": None,
            "contribution_limit": None,
            "notes": None,
            "is_active": True,
            "owner": "personal",
            "helm_kind": "investing_fund",
            "bank": None,
            "cash_balance": Decimal("5000.00"),
            "cash_currency": "CAD",
            "balance_as_of": None,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
        }
        money_db["investment_holdings"][inv_id] = []

        resp = client.get("/money/health")
        body = resp.json()
        alloc = {a["kind"]: a for a in body["allocation"]}
        assert set(alloc) == {"checking", "savings", "investing"}
        assert Decimal(alloc["checking"]["cad_amount"]) == Decimal("4000.00")
        assert Decimal(alloc["savings"]["cad_amount"]) == Decimal("1000.00")
        assert Decimal(alloc["investing"]["cad_amount"]) == Decimal("5000.00")
        # Shares sum to 100% (within rounding).
        share_sum = sum(Decimal(a["share_pct"]) for a in body["allocation"])
        assert share_sum == Decimal("100.00")


class TestMonthlyFlows:
    def test_returns_12_buckets_with_zero_fill(
        self, client: TestClient, money_db: dict[str, Any]
    ) -> None:
        """12 months returned even when some have no transactions."""
        # Single $10k inflow in the current month.
        today = date.today()
        money_db["ynab_transactions"].append(
            {
                "amount": 10_000_000,
                "posted_date": today,
                "transfer_account_id": None,
            }
        )

        resp = client.get("/money/health")
        flows = resp.json()["monthly_flows"]
        assert len(flows) == 12
        # Current-month bucket holds the inflow; the rest are zero.
        last = flows[-1]
        assert Decimal(last["income_cad"]) == Decimal("10000.00")
        assert Decimal(last["expenses_cad"]) == Decimal("0.00")
        for f in flows[:-1]:
            assert Decimal(f["income_cad"]) == Decimal("0.00")
            assert Decimal(f["expenses_cad"]) == Decimal("0.00")


class TestLiquidity:
    def test_months_of_cash_runway(
        self, client: TestClient, money_db: dict[str, Any]
    ) -> None:
        """$32k cash / $8k monthly expenses = 4.0 months."""
        today = date.today()
        for i in range(12):
            money_db["ynab_transactions"].append(
                {
                    "amount": -8_000_000,
                    "posted_date": today - timedelta(days=30 * i + 1),
                    "transfer_account_id": None,
                }
            )
        money_db["ynab_accounts"]["td"] = {
            "id": "td",
            "budget_id": _BUDGET_ID,
            "name": "TD Checking",
            "type": "checking",
            "on_budget": True,
            "closed": False,
            "deleted": False,
            "balance": 32_000_000,  # $32k
            "cleared_balance": 32_000_000,
            "uncleared_balance": 0,
            "helm_kind": None,
            "helm_owner": "personal",
            "last_synced_at": datetime.now(timezone.utc),
        }

        resp = client.get("/money/health")
        body = resp.json()
        assert Decimal(body["liquidity_months"]["value"]) == Decimal("4.00")
        # 4 ≥ 3 target → above.
        assert body["liquidity_months"]["status"] == "above"
