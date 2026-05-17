"""Integration tests for /personal/imports."""

from fastapi.testclient import TestClient


def _make_account(client: TestClient) -> str:
    res = client.post(
        "/personal/accounts/",
        json={
            "name": "RBC Chequing",
            "institution": "RBC",
            "account_type": "checking",
            "currency": "CAD",
            "opening_balance": "0",
            "is_active": True,
            "notes": None,
        },
    )
    return res.json()["id"]


class TestCreate:
    def test_returns_presigned_put_and_pending_row(
        self, client: TestClient, fake_aws_clients: dict
    ) -> None:
        account_id = _make_account(client)
        response = client.post(
            "/personal/imports/",
            json={
                "account_id": account_id,
                "institution": "RBC",
                "filename": "rbc-mar-2026.csv",
                "size_bytes": 4096,
            },
        )
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["import_"]["status"] == "pending"
        assert body["import_"]["s3_key"].startswith("imports/")
        assert body["import_"]["s3_key"].endswith(".csv")
        assert body["upload_url"].startswith("https://fake-s3.local/")
        assert "op=put" in body["upload_url"]

    def test_404_for_unknown_account(self, client: TestClient) -> None:
        response = client.post(
            "/personal/imports/",
            json={
                "account_id": "00000000-0000-0000-0000-000000000099",
                "institution": "TD",
            },
        )
        assert response.status_code == 404


class TestList:
    def test_returns_imports_newest_first(self, client: TestClient) -> None:
        account_id = _make_account(client)
        client.post(
            "/personal/imports/",
            json={"account_id": account_id, "institution": "RBC"},
        )
        client.post(
            "/personal/imports/",
            json={"account_id": account_id, "institution": "TD"},
        )
        rows = client.get("/personal/imports/").json()
        assert len(rows) == 2
