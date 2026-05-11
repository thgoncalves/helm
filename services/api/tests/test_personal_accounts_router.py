"""Integration tests for /personal/accounts."""

from fastapi.testclient import TestClient


def _make(client: TestClient, **over) -> dict:
    body = {
        "name": "RBC Chequing",
        "institution": "RBC",
        "account_type": "checking",
        "currency": "CAD",
        "opening_balance": "0",
        "is_active": True,
        "notes": None,
        **over,
    }
    response = client.post("/personal/accounts/", json=body)
    assert response.status_code == 201, response.text
    return response.json()


class TestCRUD:
    def test_create_then_read(self, client: TestClient) -> None:
        out = _make(client, name="TD Visa", institution="TD", account_type="credit_card")
        assert out["name"] == "TD Visa"
        assert out["institution"] == "TD"
        assert out["account_type"] == "credit_card"

        read = client.get(f"/personal/accounts/{out['id']}").json()
        assert read["id"] == out["id"]

    def test_list_excludes_archived_by_default(self, client: TestClient) -> None:
        _make(client, name="Active")
        archived = _make(client, name="Archived")
        # Archive via PUT.
        client.put(
            f"/personal/accounts/{archived['id']}",
            json={**archived, "is_active": False},
        )
        rows = client.get("/personal/accounts/").json()
        names = [r["name"] for r in rows]
        assert "Active" in names
        assert "Archived" not in names

        # include_archived=true returns both.
        all_rows = client.get(
            "/personal/accounts/?include_archived=true"
        ).json()
        assert sorted(r["name"] for r in all_rows) == ["Active", "Archived"]


class TestDelete:
    def test_hard_delete_when_no_transactions(self, client: TestClient) -> None:
        acc = _make(client, name="To Delete")
        response = client.delete(f"/personal/accounts/{acc['id']}")
        assert response.status_code == 204
        # GET returns 404.
        assert (
            client.get(f"/personal/accounts/{acc['id']}").status_code == 404
        )

    def test_rejects_delete_when_transactions_exist(
        self, client: TestClient
    ) -> None:
        acc = _make(client, name="Has Txns")
        # Force a transaction so the FK is referenced.
        from app import db
        from uuid import UUID, uuid4
        from datetime import datetime, timezone, date

        db.execute(
            """
            INSERT INTO personal_transactions (
                id, account_id, import_id, posted_date, description,
                amount, balance, external_id, created_at
            ) VALUES (
                :id, :account_id, :import_id, :posted_date, :description,
                :amount, :balance, :external_id, :now
            )
            ON CONFLICT ON CONSTRAINT personal_transactions_dedup_idx
            DO NOTHING
            """,
            {
                "id": uuid4(),
                "account_id": UUID(acc["id"]),
                "import_id": None,
                "posted_date": date(2026, 5, 1),
                "description": "TEST",
                "amount": "-10",
                "balance": None,
                "external_id": None,
                "now": datetime.now(timezone.utc),
            },
        )

        response = client.delete(f"/personal/accounts/{acc['id']}")
        assert response.status_code == 409
        assert "archive" in response.json()["detail"].lower()
