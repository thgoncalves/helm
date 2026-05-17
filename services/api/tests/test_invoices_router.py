"""Integration tests for /business/invoices."""

from datetime import date, timedelta

from fastapi.testclient import TestClient

from tests.conftest import SEED_ID_1, SEED_ID_2, SEED_ID_CP


def _make_invoice(
    client: TestClient,
    *,
    client_id: str,
    issue_date: str,
    status: str = "draft",
    qty: str = "10",
    unit_price: str = "100.00",
    is_taxable: bool = True,
    tax_rate: str | None = "0.0500",
    due_date: str | None = None,
    invoice_number: str | None = None,
) -> dict:
    body = {
        "invoice_number": invoice_number or f"INV-2026-{abs(hash(issue_date)) % 9999:04d}",
        "client_id": client_id,
        "issue_date": issue_date,
        "due_date": due_date or issue_date,
        "status": status,
        "currency": "CAD",
        "notes": None,
        "payment_terms": "Net 30",
        "line_items": [
            {
                "line_order": 1,
                "description": "Consulting Services",
                "quantity": qty,
                "unit_price": unit_price,
                "is_taxable": is_taxable,
                "tax_rate": tax_rate,
                "tax_category": "GST" if is_taxable else None,
            }
        ],
    }
    response = client.post("/business/invoices/", json=body)
    assert response.status_code == 201, response.text
    return response.json()


class TestCreate:
    def test_computes_subtotal_tax_and_total(self, client: TestClient) -> None:
        out = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            issue_date="2026-05-01",
            qty="26",
            unit_price="95.00",
            is_taxable=True,
            tax_rate="0.0500",
        )
        inv = out["invoice"]
        # 26 * 95 = 2470, GST = 123.50, total = 2593.50
        assert inv["subtotal"] == "2470.00"
        assert inv["tax_amount"] == "123.50"
        assert inv["total"] == "2593.50"
        assert len(out["line_items"]) == 1

    def test_no_tax_when_line_marked_non_taxable(self, client: TestClient) -> None:
        out = _make_invoice(
            client,
            client_id=str(SEED_ID_1),  # Sulpetro
            issue_date="2026-05-01",
            qty="31",
            unit_price="100.00",
            is_taxable=False,
            tax_rate=None,
        )
        inv = out["invoice"]
        assert inv["subtotal"] == "3100.00"
        assert inv["tax_amount"] == "0.00"
        assert inv["total"] == "3100.00"

    def test_rejects_no_line_items(self, client: TestClient) -> None:
        body = {
            "invoice_number": "INV-2026-9999",
            "client_id": str(SEED_ID_1),
            "issue_date": "2026-05-01",
            "currency": "CAD",
            "line_items": [],
        }
        response = client.post("/business/invoices/", json=body)
        assert response.status_code == 400


class TestList:
    def test_filters_by_date_range_and_returns_totals_by_status(
        self, client: TestClient
    ) -> None:
        _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            issue_date="2026-05-01",
            qty="10",
            unit_price="100",
            is_taxable=False,
            tax_rate=None,
            status="draft",
            invoice_number="INV-2026-0001",
        )
        _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            issue_date="2026-05-15",
            qty="20",
            unit_price="100",
            is_taxable=False,
            tax_rate=None,
            status="paid",
            invoice_number="INV-2026-0002",
        )
        # Outside the requested window.
        _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            issue_date="2026-04-01",
            qty="5",
            unit_price="100",
            is_taxable=False,
            tax_rate=None,
            status="sent",
            invoice_number="INV-2026-0003",
        )

        response = client.get(
            "/business/invoices/",
            params={"from": "2026-05-01", "to": "2026-05-31"},
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data["invoices"]) == 2
        totals = data["totals_by_status"]
        assert totals["draft"] == "1000.00"
        assert totals["paid"] == "2000.00"
        assert totals["sent"] == "0.00"
        assert totals["overdue"] == "0.00"
        assert totals["total"] == "3000.00"

    def test_overdue_bucket_for_past_due_sent_invoice(
        self, client: TestClient
    ) -> None:
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            issue_date="2026-01-01",
            due_date=yesterday,
            qty="10",
            unit_price="100",
            is_taxable=False,
            tax_rate=None,
            status="sent",
            invoice_number="INV-2026-0010",
        )
        response = client.get("/business/invoices/")
        totals = response.json()["totals_by_status"]
        assert totals["overdue"] == "1000.00"
        assert totals["sent"] == "0.00"


class TestUpdate:
    def test_replaces_line_items_and_recomputes_totals(
        self, client: TestClient
    ) -> None:
        out = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            issue_date="2026-05-01",
            qty="10",
            unit_price="100",
            is_taxable=False,
            tax_rate=None,
            invoice_number="INV-2026-0020",
        )
        invoice_id = out["invoice"]["id"]

        body = {
            "invoice_number": out["invoice"]["invoice_number"],
            "client_id": str(SEED_ID_CP),
            "issue_date": "2026-05-01",
            "due_date": "2026-05-31",
            "status": None,
            "currency": "CAD",
            "notes": "Updated",
            "payment_terms": "Net 30",
            "line_items": [
                {
                    "line_order": 1,
                    "description": "Consulting Services",
                    "quantity": "20",
                    "unit_price": "100",
                    "is_taxable": True,
                    "tax_rate": "0.0500",
                    "tax_category": "GST",
                }
            ],
        }
        response = client.put(f"/business/invoices/{invoice_id}", json=body)
        assert response.status_code == 200
        inv = response.json()["invoice"]
        # 20 * 100 = 2000, GST 100, total 2100
        assert inv["subtotal"] == "2000.00"
        assert inv["tax_amount"] == "100.00"
        assert inv["total"] == "2100.00"


class TestMarkSent:
    def test_flips_status_to_sent(self, client: TestClient) -> None:
        out = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            issue_date="2026-05-01",
            qty="10",
            unit_price="100",
            is_taxable=False,
            tax_rate=None,
            status="draft",
            invoice_number="INV-2026-0030",
        )
        invoice_id = out["invoice"]["id"]
        response = client.post(f"/business/invoices/{invoice_id}/mark-sent")
        assert response.status_code == 200
        assert response.json()["status"] == "sent"

    def test_404_for_unknown_id(self, client: TestClient) -> None:
        response = client.post(
            "/business/invoices/00000000-0000-0000-0000-000000000099/mark-sent"
        )
        assert response.status_code == 404


class TestPdf:
    def test_returns_pdf_bytes(self, client: TestClient) -> None:
        out = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            issue_date="2026-05-01",
            qty="26",
            unit_price="95",
            is_taxable=True,
            tax_rate="0.0500",
            invoice_number="INV-2026-0040",
        )
        invoice_id = out["invoice"]["id"]
        response = client.get(f"/business/invoices/{invoice_id}/pdf")
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/pdf"
        assert response.content.startswith(b"%PDF-")
