"""Integration tests for /personal/transactions."""

from datetime import datetime, timezone, date
from decimal import Decimal
from uuid import UUID, uuid4

from fastapi.testclient import TestClient

from app import db


def _make_account(client: TestClient, name: str = "RBC Chequing") -> str:
    res = client.post(
        "/personal/accounts/",
        json={
            "name": name,
            "institution": "RBC",
            "account_type": "checking",
            "currency": "CAD",
            "opening_balance": "0",
            "is_active": True,
            "notes": None,
        },
    )
    return res.json()["id"]


def _insert_tx(account_id: str, *, posted: str, amount: str, description: str) -> str:
    """Bypass the (unwritable) HTTP API and insert directly via the same
    SQL the processor uses — the dedup index applies."""
    new_id = uuid4()
    db.execute(
        """
        INSERT INTO personal_transactions (
            id, account_id, import_id, posted_date, description,
            amount, balance, external_id, created_at
        ) VALUES (
            :id, :account_id, :import_id, :posted_date, :description,
            :amount, :balance, :external_id, :now
        )
        ON CONFLICT (account_id, posted_date, amount, description)
        DO NOTHING
        """,
        {
            "id": new_id,
            "account_id": UUID(account_id),
            "import_id": None,
            "posted_date": date.fromisoformat(posted),
            "description": description,
            "amount": Decimal(amount),
            "balance": None,
            "external_id": None,
            "now": datetime.now(timezone.utc),
        },
    )
    return str(new_id)


class TestList:
    def test_filters_by_account_and_date(self, client: TestClient) -> None:
        acct_a = _make_account(client, "Account A")
        acct_b = _make_account(client, "Account B")
        _insert_tx(acct_a, posted="2026-05-01", amount="-25.00", description="Coffee A")
        _insert_tx(acct_a, posted="2026-04-01", amount="100.00", description="Refund A")
        _insert_tx(acct_b, posted="2026-05-01", amount="-50.00", description="Coffee B")

        rows = client.get(f"/personal/transactions/?account_id={acct_a}").json()
        assert {r["description"] for r in rows} == {"Coffee A", "Refund A"}

        scoped = client.get(
            f"/personal/transactions/?account_id={acct_a}&from=2026-04-15"
        ).json()
        assert {r["description"] for r in scoped} == {"Coffee A"}


class TestPatch:
    def test_updates_category_only(self, client: TestClient) -> None:
        acct = _make_account(client)
        tx_id = _insert_tx(
            acct, posted="2026-05-01", amount="-12.50", description="Test"
        )
        response = client.patch(
            f"/personal/transactions/{tx_id}",
            json={"category": "Coffee"},
        )
        assert response.status_code == 200
        assert response.json()["category"] == "Coffee"
