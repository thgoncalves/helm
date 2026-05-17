"""Integration tests for /business/transfers."""

from fastapi.testclient import TestClient


def _create(
    client: TestClient,
    *,
    transfer_date: str,
    amount: str,
    est_company: str | None = None,
    est_personal: str | None = None,
    method: str | None = "EFT",
    category: str | None = "Salary",
) -> dict:
    body = {
        "transfer_date": transfer_date,
        "amount": amount,
        "method": method,
        "purpose": None,
        "category": category,
        "estimated_tax_company": est_company,
        "estimated_tax_personal": est_personal,
        "actual_tax_paid_company": None,
        "actual_tax_paid_personal": None,
        "tax_ledger_link_company": None,
        "tax_ledger_link_personal": None,
        "notes": None,
    }
    response = client.post("/business/transfers/", json=body)
    assert response.status_code == 201, response.text
    return response.json()


class TestCreateRead:
    def test_create_and_round_trip(self, client: TestClient) -> None:
        t = _create(
            client,
            transfer_date="2025-07-04",
            amount="2000.00",
            est_company="600.00",
            est_personal="650.00",
        )
        response = client.get(f"/business/transfers/{t['id']}")
        assert response.status_code == 200
        got = response.json()
        assert got["amount"] == "2000.00"
        assert got["estimated_tax_company"] == "600.00"
        assert got["estimated_tax_personal"] == "650.00"
        assert got["category"] == "Salary"
        assert got["method"] == "EFT"

    def test_404_for_missing(self, client: TestClient) -> None:
        response = client.get(
            "/business/transfers/00000000-0000-0000-0000-000000000099"
        )
        assert response.status_code == 404


class TestList:
    def test_filters_by_date_window(self, client: TestClient) -> None:
        _create(
            client,
            transfer_date="2025-05-01",
            amount="1000",
        )
        _create(
            client,
            transfer_date="2025-07-04",
            amount="2000",
        )
        _create(
            client,
            transfer_date="2026-08-01",
            amount="3000",
        )
        response = client.get(
            "/business/transfers/",
            params={"from": "2025-07-01", "to": "2025-12-31"},
        )
        assert response.status_code == 200
        rows = response.json()
        assert len(rows) == 1
        assert rows[0]["amount"] == "2000.00"


class TestSummary:
    def test_sums_amounts_and_taxes_within_window(
        self, client: TestClient
    ) -> None:
        _create(
            client,
            transfer_date="2025-07-04",
            amount="2000.00",
            est_company="600.00",
            est_personal="650.00",
        )
        _create(
            client,
            transfer_date="2025-08-25",
            amount="8000.00",
            est_company="2400.00",
            est_personal="2600.00",
        )
        # Outside the FY 2025/26 window — should not contribute.
        _create(
            client,
            transfer_date="2026-04-15",
            amount="999.00",
            est_company="299.70",
            est_personal="324.68",
        )

        response = client.get(
            "/business/transfers/summary",
            params={"from": "2025-04-01", "to": "2026-03-31"},
        )
        data = response.json()
        assert data["total_transferred"] == "10000.00"
        assert data["transaction_count"] == 2
        assert data["est_company_tax"] == "3000.00"
        assert data["est_personal_tax"] == "3250.00"
        # Exposure = company + personal
        assert data["tax_exposure"] == "6250.00"


class TestTaxRates:
    def test_returns_rates_from_settings(self, client: TestClient) -> None:
        response = client.get("/business/transfers/tax-rates")
        assert response.status_code == 200
        data = response.json()
        assert data["company_rate"] == "0.30"
        assert data["personal_rate"] == "0.325"


class TestUpdateDelete:
    def test_update_recomputes_fields(self, client: TestClient) -> None:
        t = _create(
            client,
            transfer_date="2025-07-04",
            amount="2000.00",
            est_company="600.00",
            est_personal="650.00",
        )
        body = {
            "transfer_date": "2025-07-04",
            "amount": "3000.00",
            "method": "EFT",
            "purpose": "Bonus",
            "category": "Salary",
            "estimated_tax_company": "900.00",
            "estimated_tax_personal": "975.00",
            "actual_tax_paid_company": None,
            "actual_tax_paid_personal": None,
            "tax_ledger_link_company": None,
            "tax_ledger_link_personal": None,
            "notes": None,
        }
        response = client.put(f"/business/transfers/{t['id']}", json=body)
        assert response.status_code == 200
        updated = response.json()
        assert updated["amount"] == "3000.00"
        assert updated["estimated_tax_company"] == "900.00"
        assert updated["purpose"] == "Bonus"

    def test_delete_removes_row(self, client: TestClient) -> None:
        t = _create(
            client,
            transfer_date="2025-07-04",
            amount="2000.00",
        )
        response = client.delete(f"/business/transfers/{t['id']}")
        assert response.status_code == 204
        assert (
            client.get(f"/business/transfers/{t['id']}").status_code == 404
        )
