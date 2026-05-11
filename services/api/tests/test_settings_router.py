"""Integration tests for /business/settings."""

from fastapi.testclient import TestClient


class TestSettings:
    def test_get_returns_seeded_settings(self, client: TestClient) -> None:
        response = client.get("/business/settings/")
        assert response.status_code == 200
        data = response.json()
        assert data["user_full_name"] == "Thiago Gonçalves Pinto"
        assert data["transfer_tax_rate_company"] == "0.30"
        assert data["transfer_tax_rate_personal"] == "0.325"

    def test_put_bulk_upserts_subset_and_preserves_others(
        self, client: TestClient
    ) -> None:
        response = client.put(
            "/business/settings/",
            json={
                "theme": "catppuccin",
                "invoice_number_prefix": "INV",
                "transfer_tax_rate_company": "0.31",
            },
        )
        assert response.status_code == 200
        data = response.json()
        # Updated values
        assert data["theme"] == "catppuccin"
        assert data["invoice_number_prefix"] == "INV"
        assert data["transfer_tax_rate_company"] == "0.31"
        # Untouched seeded values still present
        assert data["user_email"] == "th.goncalves@gmail.com"

    def test_put_then_get_round_trips(self, client: TestClient) -> None:
        client.put("/business/settings/", json={"theme": "tokyo-night"})
        data = client.get("/business/settings/").json()
        assert data["theme"] == "tokyo-night"
