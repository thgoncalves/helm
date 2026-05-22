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
from app.money import balances as balances_module
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
    # YNAB transactions for the 12-month flow math. Each row: dict with
    # amount (signed milliunits), posted_date (date), transfer_account_id.
    ynab_transactions: list[dict[str, Any]] = []
    # Seeded monthly snapshots keyed by snapshot_month (date).
    net_worth_snapshots: dict[date, dict[str, Any]] = {}
    # KV settings — tests can seed user-overridden targets here.
    settings_rows: dict[str, str] = {}

    stores = {
        "ynab_budgets": ynab_budgets,
        "ynab_accounts": ynab_accounts,
        "manual_accounts": manual_accounts,
        "ynab_transactions": ynab_transactions,
        "net_worth_snapshots": net_worth_snapshots,
        "settings": settings_rows,
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
        if (
            "FROM manual_accounts" in sql
            and "balance_as_of <" in sql
        ):
            # Stale-balance lookup for the Needs-attention panel.
            cutoff = params["cutoff"]
            return sorted(
                (
                    r
                    for r in manual_accounts.values()
                    if r["is_active"]
                    and r.get("balance_as_of") is not None
                    and r["balance_as_of"] < cutoff
                ),
                key=lambda r: r["balance_as_of"],
            )
        if "FROM manual_accounts" in sql:
            return [r for r in manual_accounts.values() if r["is_active"]]
        if "FROM settings" in sql:
            # money_health._load_targets queries by key list. Return any
            # rows seeded by the test; empty list → defaults fire.
            return [
                {"key": k, "value": v}
                for k, v in settings_rows.items()
            ]
        if "FROM net_worth_snapshots" in sql:
            # Return the snapshots seeded by the test, newest first
            # (matches the router's ORDER BY DESC).
            rows = sorted(
                net_worth_snapshots.values(),
                key=lambda r: r["snapshot_month"],
                reverse=True,
            )
            return rows[: params.get("limit", len(rows))]
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
    fake_rate = lambda f, t, on=None: fx_module.FxRate(
        f,
        t,
        on or date.today(),
        {"BRL": Decimal("0.25"), "USD": Decimal("1.35")}.get(
            f, Decimal("1")
        ),
    )
    monkeypatch.setattr(fx_module, "get_rate", fake_rate)
    # The shared aggregator imports `get_rate` directly, so we patch the
    # binding in that module too.
    monkeypatch.setattr(balances_module, "get_rate", fake_rate)
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
        resp = client.get("/money/health")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # Assets: 5000 (TD) + 5000 (Itaú BRL→CAD) = 10000.
        assert Decimal(body["assets_cad"]) == Decimal("10000.00")
        # Liabilities: 1200 (Visa, abs value).
        assert Decimal(body["liabilities_cad"]) == Decimal("1200.00")
        assert Decimal(body["net_worth_cad"]) == Decimal("8800.00")
        # All sources owned by Personal in this fixture.
        assert Decimal(body["personal_net_worth_cad"]) == Decimal("8800.00")
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


class TestNetWorthGrowth:
    def test_returns_unavailable_with_no_history(
        self, client: TestClient, money_db: dict[str, Any]
    ) -> None:
        resp = client.get("/money/health")
        body = resp.json()
        assert body["net_worth_growth"]["value"] is None
        assert body["net_worth_growth"]["status"] == "unavailable"
        assert body["net_worth_trend"] == []

    def test_computes_growth_pct_against_oldest_snapshot(
        self, client: TestClient, money_db: dict[str, Any]
    ) -> None:
        """4 monthly snapshots: 100k → current 120k = +20% growth."""
        # Seed an account so the live net worth comes back at 120k.
        money_db["ynab_accounts"]["chk"] = {
            "id": "chk",
            "budget_id": _BUDGET_ID,
            "name": "TD",
            "type": "checking",
            "on_budget": True,
            "closed": False,
            "deleted": False,
            "balance": 120_000_000,  # $120k
            "cleared_balance": 120_000_000,
            "uncleared_balance": 0,
            "helm_kind": None,
            "helm_owner": "personal",
            "last_synced_at": datetime.now(timezone.utc),
        }
        today = date.today()
        for i, value in enumerate(["100000", "105000", "110000", "115000"]):
            # Oldest first → month 4 ago, 3 ago, 2 ago, 1 ago.
            year = today.year
            month = today.month - (4 - i)
            while month <= 0:
                month += 12
                year -= 1
            m = date(year, month, 1)
            money_db["net_worth_snapshots"][m] = {
                "snapshot_month": m,
                "assets_cad": Decimal(value),
                "liabilities_cad": Decimal("0"),
                "checking_cad": Decimal(value),
                "savings_cad": Decimal("0"),
                "investing_cad": Decimal("0"),
                "lending_cad": Decimal("0"),
                "personal_cad": Decimal(value),
                "business_cad": Decimal("0"),
            }

        resp = client.get("/money/health")
        body = resp.json()
        trend = body["net_worth_trend"]
        # Trend returns 12 snapshots max, oldest first.
        assert len(trend) == 4
        assert Decimal(trend[0]["net_worth_cad"]) == Decimal("100000.00")
        # Growth: (120000 − 100000) / 100000 × 100 = 20%.
        assert Decimal(body["net_worth_growth"]["value"]) == Decimal("20.00")
        assert body["net_worth_growth"]["status"] == "above"


class TestAttentionItems:
    def test_below_target_savings_surfaces_warning(
        self, client: TestClient, money_db: dict[str, Any]
    ) -> None:
        """Savings ratio at 5% (target 20%) triggers a warning item."""
        today = date.today()
        # $10k inflow, $9.5k outflow → 5% savings ratio (well below 20%).
        for i in range(12):
            money_db["ynab_transactions"].append(
                {
                    "amount": 10_000_000,
                    "posted_date": today - timedelta(days=30 * i + 1),
                    "transfer_account_id": None,
                }
            )
            money_db["ynab_transactions"].append(
                {
                    "amount": -9_500_000,
                    "posted_date": today - timedelta(days=30 * i + 1),
                    "transfer_account_id": None,
                }
            )

        resp = client.get("/money/health")
        body = resp.json()
        kpi_ids = [a["kpi_id"] for a in body["attention"]]
        assert "savings_ratio" in kpi_ids
        savings_item = next(
            a for a in body["attention"] if a["kpi_id"] == "savings_ratio"
        )
        assert savings_item["severity"] == "warning"

    def test_stale_manual_balance_surfaces_info_item(
        self, client: TestClient, money_db: dict[str, Any]
    ) -> None:
        """A manual account whose balance is >14 days old shows up."""
        from uuid import uuid4

        money_db["manual_accounts"][uuid4()] = {
            "id": uuid4(),
            "name": "Itaú",
            "bank": "Itaú",
            "currency": "BRL",
            "balance": Decimal("0"),
            "balance_as_of": date.today() - timedelta(days=30),
            "kind": "checking",
            "owner": "personal",
            "notes": None,
            "is_active": True,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
        }

        resp = client.get("/money/health")
        body = resp.json()
        stale = [a for a in body["attention"] if a["severity"] == "info"]
        assert len(stale) == 1
        assert "Itaú" in stale[0]["title"]


class TestTargetOverrides:
    def test_settings_row_overrides_default_target(
        self, client: TestClient, money_db: dict[str, Any]
    ) -> None:
        """Setting `money_target_savings_pct` to 25 changes the target."""
        money_db["settings"]["money_target_savings_pct"] = "25"

        resp = client.get("/money/health")
        body = resp.json()
        assert Decimal(body["savings_ratio"]["target"]) == Decimal("25")

    def test_malformed_setting_falls_back_to_default(
        self, client: TestClient, money_db: dict[str, Any]
    ) -> None:
        """A non-numeric setting value doesn't break the response."""
        money_db["settings"]["money_target_liquidity_months"] = "not-a-number"

        resp = client.get("/money/health")
        body = resp.json()
        # Falls back to the default of 3.
        assert Decimal(body["liquidity_months"]["target"]) == Decimal("3")


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
        # $5,000 manual fund (investing_fund tagged) in CAD.
        money_db["manual_accounts"][uuid4()] = {
            "id": uuid4(),
            "name": "iTrade",
            "bank": None,
            "currency": "CAD",
            "balance": Decimal("5000.00"),
            "balance_as_of": date.today(),
            "kind": "investing_fund",
            "owner": "personal",
            "notes": None,
            "is_active": True,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
        }

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
