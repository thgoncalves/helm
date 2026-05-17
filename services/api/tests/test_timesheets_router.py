"""Integration tests for /business/timesheets (summary + PDF)."""

from fastapi.testclient import TestClient

from tests.conftest import SEED_ID_1, SEED_ID_2, SEED_ID_3


def _seed_entries(client: TestClient, client_id: str, entries: list[tuple[str, str]]) -> None:
    client.put(
        "/business/time-entries/bulk",
        json={
            "client_id": client_id,
            "period_start": "2026-05-01",
            "period_end": "2026-05-31",
            "entries": [
                {"work_date": d, "hours": h} for (d, h) in entries
            ],
        },
    )


class TestSummary:
    def test_period_totals_match_seeded_entries(self, client: TestClient) -> None:
        _seed_entries(
            client,
            str(SEED_ID_1),
            entries=[("2026-05-01", "4.0"), ("2026-05-02", "7.0")],
        )
        response = client.get(
            "/business/timesheets/summary",
            params={
                "client_id": str(SEED_ID_1),
                "start": "2026-05-01",
                "end": "2026-05-31",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["period_hours"] == "11.00"
        # Sulpetro rate is $100, so 11 hrs = $1,100.
        assert data["period_amount"] == "1100.00"

    def test_remaining_uses_lifetime_not_just_period(
        self, client: TestClient
    ) -> None:
        # Wenco has contract_value=190000 and rate=95.38 in the fixtures.
        _seed_entries(
            client,
            str(SEED_ID_2),
            entries=[("2026-05-01", "10.0")],
        )
        response = client.get(
            "/business/timesheets/summary",
            params={
                "client_id": str(SEED_ID_2),
                "start": "2026-05-01",
                "end": "2026-05-31",
            },
        )
        data = response.json()
        # 190000 - (10 * 95.38) = 190000 - 953.80 = 189046.20
        assert data["contract_remaining_amount"] == "189046.20"
        # 190000 / 95.38 = 1992.03 → minus 10 hrs lifetime = 1982.03
        assert data["contract_remaining_hours"] == "1982.03"

    def test_remaining_is_null_when_no_contract_value(
        self, client: TestClient
    ) -> None:
        response = client.get(
            "/business/timesheets/summary",
            params={
                "client_id": str(SEED_ID_1),  # Sulpetro has no contract_value
                "start": "2026-05-01",
                "end": "2026-05-31",
            },
        )
        data = response.json()
        assert data["contract_remaining_amount"] is None
        assert data["contract_remaining_hours"] is None

    def test_invalid_range_returns_400(self, client: TestClient) -> None:
        response = client.get(
            "/business/timesheets/summary",
            params={
                "client_id": str(SEED_ID_1),
                "start": "2026-05-31",
                "end": "2026-05-01",
            },
        )
        assert response.status_code == 400


class TestPdfExport:
    def test_returns_pdf_for_client_with_rate(self, client: TestClient) -> None:
        _seed_entries(
            client,
            str(SEED_ID_1),
            entries=[("2026-05-04", "4.0")],
        )
        response = client.get(
            "/business/timesheets/pdf",
            params={
                "client_id": str(SEED_ID_1),
                "year": 2026,
                "month": 5,
            },
        )
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/pdf"
        # PDF magic header
        assert response.content.startswith(b"%PDF-")
        # Filename hint
        assert "Timesheet" in response.headers.get("content-disposition", "")

    def test_returns_400_when_client_has_no_rate(
        self, client: TestClient
    ) -> None:
        # Nutrien has hourly_rate=None in the fixture.
        response = client.get(
            "/business/timesheets/pdf",
            params={
                "client_id": str(SEED_ID_3),
                "year": 2026,
                "month": 5,
            },
        )
        assert response.status_code == 400


class TestSubmitTimesheet:
    def test_creates_invoice_with_sulpetro_defaults(
        self, client: TestClient
    ) -> None:
        _seed_entries(
            client,
            str(SEED_ID_1),
            entries=[("2026-05-01", "8.0"), ("2026-05-02", "8.0")],
        )
        response = client.post(
            "/business/timesheets/submit",
            json={"client_id": str(SEED_ID_1), "year": 2026, "month": 5},
        )
        assert response.status_code == 201, response.text
        inv = response.json()["invoice"]
        # Sulpetro: non-taxable, rate 100, 16 hrs → 1600 / 0 / 1600
        assert inv["subtotal"] == "1600.00"
        assert inv["tax_amount"] == "0.00"
        assert inv["total"] == "1600.00"
        assert inv["payment_terms"] == "Net 30"
        # Notes include the period covered.
        assert "2026-05-01" in inv["notes"] and "2026-05-31" in inv["notes"]

    def test_creates_invoice_for_wenco_with_net_15_due_date(
        self, client: TestClient
    ) -> None:
        from datetime import date as dt_date, timedelta as dt_td

        _seed_entries(
            client,
            str(SEED_ID_2),
            entries=[("2026-05-01", "10.0")],
        )
        response = client.post(
            "/business/timesheets/submit",
            json={"client_id": str(SEED_ID_2), "year": 2026, "month": 5},
        )
        assert response.status_code == 201, response.text
        inv = response.json()["invoice"]
        # Wenco rate 95.38, 10 hrs → 953.80, GST 5% → 47.69, total 1001.49.
        assert inv["subtotal"] == "953.80"
        assert inv["tax_amount"] == "47.69"
        assert inv["total"] == "1001.49"
        # Due date = today + 15 days (Wenco's payment terms).
        expected_due = (dt_date.today() + dt_td(days=15)).isoformat()
        assert inv["due_date"] == expected_due
        assert inv["payment_terms"] == "Net 15"

    def test_rejects_when_no_uninvoiced_entries(self, client: TestClient) -> None:
        response = client.post(
            "/business/timesheets/submit",
            json={"client_id": str(SEED_ID_1), "year": 2026, "month": 5},
        )
        assert response.status_code == 400

    def test_rejects_when_client_has_no_rate(self, client: TestClient) -> None:
        response = client.post(
            "/business/timesheets/submit",
            json={"client_id": str(SEED_ID_3), "year": 2026, "month": 5},
        )
        assert response.status_code == 400
