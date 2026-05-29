"""Integration tests for /business/payments."""

from datetime import date

from fastapi.testclient import TestClient

from tests.conftest import SEED_ID_1, SEED_ID_CP


def _make_invoice(
    client: TestClient,
    *,
    client_id: str,
    invoice_number: str,
    qty: str = "10",
    unit_price: str = "100",
    is_taxable: bool = False,
    tax_rate: str | None = None,
    status: str = "sent",
    issue_date: str = "2026-05-01",
    due_date: str = "2026-05-31",
) -> dict:
    body = {
        "invoice_number": invoice_number,
        "client_id": client_id,
        "issue_date": issue_date,
        "due_date": due_date,
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
                "tax_category": None,
            }
        ],
    }
    response = client.post("/business/invoices/", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _record_payment(
    client: TestClient,
    *,
    invoice_id: str,
    amount: str,
    payment_date: str = "2026-06-01",
    deduction_amount: str = "0",
    deduction_description: str | None = None,
    payment_method: str = "EFT",
    reference: str | None = "EFT001",
    notes: str | None = None,
) -> dict:
    body = {
        "invoice_id": invoice_id,
        "payment_date": payment_date,
        "amount": amount,
        "payment_method": payment_method,
        "reference": reference,
        "notes": notes,
        "deduction_amount": deduction_amount,
        "deduction_description": deduction_description,
    }
    response = client.post("/business/payments/", json=body)
    assert response.status_code == 201, response.text
    return response.json()


class TestCreate:
    def test_records_payment_and_flips_invoice_to_paid(
        self, client: TestClient
    ) -> None:
        inv = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-1000",
        )["invoice"]
        assert inv["status"] == "sent"

        _record_payment(
            client,
            invoice_id=inv["id"],
            amount=inv["total"],
        )

        # Re-fetch the invoice and confirm status flipped.
        response = client.get(f"/business/invoices/{inv['id']}")
        assert response.json()["invoice"]["status"] == "paid"

    def test_partial_payment_does_not_flip_to_paid(
        self, client: TestClient
    ) -> None:
        inv = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-1001",
            qty="20",
            unit_price="100",
        )["invoice"]
        # Pay only $500 of $2000.
        _record_payment(client, invoice_id=inv["id"], amount="500.00")

        response = client.get(f"/business/invoices/{inv['id']}")
        assert response.json()["invoice"]["status"] == "sent"

    def test_404_when_invoice_missing(self, client: TestClient) -> None:
        body = {
            "invoice_id": "00000000-0000-0000-0000-000000000099",
            "payment_date": "2026-06-01",
            "amount": "100",
            "payment_method": "EFT",
            "reference": None,
            "notes": None,
            "deduction_amount": "0",
            "deduction_description": None,
        }
        response = client.post("/business/payments/", json=body)
        assert response.status_code == 404


class TestList:
    def test_enriches_rows_with_invoice_and_client_and_filters_by_date(
        self, client: TestClient
    ) -> None:
        inv_a = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-1010",
            qty="10",
            unit_price="100",
        )["invoice"]
        inv_b = _make_invoice(
            client,
            client_id=str(SEED_ID_1),  # Sulpetro
            invoice_number="INV-2026-1011",
            qty="5",
            unit_price="100",
        )["invoice"]

        _record_payment(
            client,
            invoice_id=inv_a["id"],
            amount="1000",
            payment_date="2026-06-01",
            deduction_amount="18",
            deduction_description="CTADMINFEE",
            reference="EFTREF-A",
        )
        _record_payment(
            client,
            invoice_id=inv_b["id"],
            amount="500",
            payment_date="2026-07-15",
            reference="EFTREF-B",
        )

        response = client.get(
            "/business/payments/",
            params={"from": "2026-06-01", "to": "2026-06-30"},
        )
        assert response.status_code == 200
        rows = response.json()
        assert len(rows) == 1
        row = rows[0]
        assert row["invoice_number"] == "INV-2026-1010"
        assert row["client_name"] == "CP"
        assert row["amount"] == "1000.00"
        assert row["deduction_amount"] == "18.00"
        assert row["net"] == "982.00"
        assert row["reference"] == "EFTREF-A"


class TestInvoiceOptions:
    def test_returns_balance_due_per_invoice(self, client: TestClient) -> None:
        inv = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-1020",
            qty="10",
            unit_price="100",  # total 1000
        )["invoice"]
        _record_payment(client, invoice_id=inv["id"], amount="400.00")

        response = client.get("/business/payments/invoice-options")
        assert response.status_code == 200
        options = response.json()
        # Find the one we care about
        opt = next((o for o in options if o["invoice_id"] == inv["id"]), None)
        assert opt is not None
        assert opt["total"] == "1000.00"
        assert opt["balance_due"] == "600.00"
        assert opt["status"] == "sent"  # partial payment, not flipped

    def test_open_only_excludes_settled_keeps_partial(
        self, client: TestClient
    ) -> None:
        # Fully paid → balance 0 → excluded when recording a new payment.
        settled = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-1021",
            qty="5",
            unit_price="100",
        )["invoice"]
        _record_payment(client, invoice_id=settled["id"], amount=settled["total"])

        # Partially paid → balance still owing → stays in the list.
        partial = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-1022",
            qty="5",
            unit_price="100",  # total 500
        )["invoice"]
        _record_payment(client, invoice_id=partial["id"], amount="200.00")

        response = client.get(
            "/business/payments/invoice-options", params={"open_only": "true"}
        )
        ids = [o["invoice_id"] for o in response.json()]
        assert settled["id"] not in ids
        assert partial["id"] in ids


class TestDelete:
    def test_removes_payment_and_downgrades_paid_to_sent(
        self, client: TestClient
    ) -> None:
        inv = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-1030",
        )["invoice"]
        pay = _record_payment(client, invoice_id=inv["id"], amount=inv["total"])

        # Confirm flipped.
        assert client.get(f"/business/invoices/{inv['id']}").json()["invoice"]["status"] == "paid"

        response = client.delete(f"/business/payments/{pay['id']}")
        assert response.status_code == 204

        assert (
            client.get(f"/business/invoices/{inv['id']}").json()["invoice"]["status"]
            == "sent"
        )


class TestUpdate:
    def test_replaces_amount_and_recomputes_status(
        self, client: TestClient
    ) -> None:
        inv = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-1040",
            qty="10",
            unit_price="100",  # total 1000
        )["invoice"]
        pay = _record_payment(client, invoice_id=inv["id"], amount="1000.00")

        # Confirm paid.
        assert client.get(f"/business/invoices/{inv['id']}").json()["invoice"]["status"] == "paid"

        # Adjust down to 500 — should downgrade.
        response = client.put(
            f"/business/payments/{pay['id']}",
            json={
                "invoice_id": inv["id"],
                "payment_date": "2026-06-01",
                "amount": "500.00",
                "payment_method": "EFT",
                "reference": "X",
                "notes": None,
                "deduction_amount": "0",
                "deduction_description": None,
            },
        )
        assert response.status_code == 200
        assert (
            client.get(f"/business/invoices/{inv['id']}").json()["invoice"]["status"]
            == "sent"
        )
