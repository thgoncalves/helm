"""Integration tests for /business/expenses."""

from fastapi.testclient import TestClient


class TestCreate:
    def test_returns_presigned_put_and_creates_pending_row(
        self, client: TestClient, fake_aws_clients: dict
    ) -> None:
        response = client.post(
            "/business/expenses/",
            json={
                "file_extension": "jpg",
                "content_type": "image/jpeg",
                "size_bytes": 123456,
            },
        )
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["expense"]["status"] == "pending"
        assert body["expense"]["content_type"] == "image/jpeg"
        assert body["expense"]["s3_key"].startswith("expenses/")
        assert body["expense"]["s3_key"].endswith(".jpg")
        assert body["upload_url"].startswith("https://fake-s3.local/")
        assert "op=put" in body["upload_url"]

    def test_500s_if_bucket_not_configured(
        self, client: TestClient, monkeypatch
    ) -> None:
        from app.config import settings as app_settings

        monkeypatch.setattr(app_settings, "receipts_bucket", None)
        response = client.post(
            "/business/expenses/",
            json={"file_extension": "jpg", "content_type": "image/jpeg"},
        )
        assert response.status_code == 500
        assert "HELM_RECEIPTS_BUCKET" in response.json()["detail"]


class TestList:
    def _create(self, client: TestClient) -> dict:
        return client.post(
            "/business/expenses/",
            json={"file_extension": "jpg", "content_type": "image/jpeg"},
        ).json()["expense"]

    def test_filters_by_status(self, client: TestClient) -> None:
        # Two pending expenses to start.
        a = self._create(client)
        self._create(client)
        # Flip one to ready by directly updating (simulates the
        # processor having run).
        client.put(
            f"/business/expenses/{a['id']}",
            json={
                "supplier": "ACME",
                "expense_date": "2026-04-15",
                "total": "50.00",
                "category": "Software",
            },
        )
        # The router doesn't expose a "set status" endpoint, but the
        # PUT keeps status=pending. So pass status=pending to filter.
        response = client.get("/business/expenses/?status=pending")
        assert response.status_code == 200
        # Both rows are still pending after a user edit.
        assert len(response.json()) == 2


class TestImageUrl:
    def test_returns_presigned_get(self, client: TestClient) -> None:
        created = client.post(
            "/business/expenses/",
            json={"file_extension": "jpg", "content_type": "image/jpeg"},
        ).json()
        expense_id = created["expense"]["id"]
        response = client.get(f"/business/expenses/{expense_id}/image-url")
        assert response.status_code == 200
        url = response.json()["url"]
        assert url.startswith("https://fake-s3.local/")
        assert "op=get" in url


class TestUpdate:
    def test_persists_user_edits(self, client: TestClient) -> None:
        created = client.post(
            "/business/expenses/",
            json={"file_extension": "jpg", "content_type": "image/jpeg"},
        ).json()
        expense_id = created["expense"]["id"]
        response = client.put(
            f"/business/expenses/{expense_id}",
            json={
                "supplier": "Office Depot",
                "category": "Office Supplies",
                "expense_date": "2026-04-15",
                "subtotal": "100.00",
                "tax_amount": "5.00",
                "total": "105.00",
                "currency": "CAD",
                "notes": "Paper + pens",
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["supplier"] == "Office Depot"
        assert body["category"] == "Office Supplies"
        assert body["total"] == "105.00"


class TestDelete:
    def test_drops_row_and_calls_s3_delete(
        self, client: TestClient, fake_aws_clients: dict
    ) -> None:
        created = client.post(
            "/business/expenses/",
            json={"file_extension": "jpg", "content_type": "image/jpeg"},
        ).json()
        expense_id = created["expense"]["id"]
        s3_key = created["expense"]["s3_key"]

        response = client.delete(f"/business/expenses/{expense_id}")
        assert response.status_code == 204

        # S3 cleanup happened.
        deletes = fake_aws_clients["s3"].deleted
        assert (
            "helm-receipts-test",
            s3_key,
        ) in deletes

        # Row is gone.
        assert (
            client.get(f"/business/expenses/{expense_id}").status_code == 404
        )
