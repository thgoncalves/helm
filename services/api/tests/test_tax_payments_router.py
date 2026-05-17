"""Integration tests for /business/tax-payments."""

from fastapi.testclient import TestClient

from tests.conftest import SEED_ID_1, SEED_ID_CP


def _make_invoice(
    client: TestClient,
    *,
    client_id: str,
    invoice_number: str,
    qty: str = "10",
    unit_price: str = "100",
    is_taxable: bool = True,
    tax_rate: str | None = "0.0500",
    issue_date: str = "2026-05-01",
) -> dict:
    body = {
        "invoice_number": invoice_number,
        "client_id": client_id,
        "issue_date": issue_date,
        "due_date": issue_date,
        "status": "sent",
        "currency": "CAD",
        "notes": None,
        "payment_terms": "Net 30",
        "line_items": [
            {
                "line_order": 1,
                "description": "Consulting",
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
    return response.json()["invoice"]


def _make_payment(
    client: TestClient,
    *,
    amount: str,
    invoice_ids: list[str],
    payment_date: str = "2026-06-01",
    reference: str | None = "REF1",
) -> dict:
    response = client.post(
        "/business/tax-payments/",
        json={
            "payment_date": payment_date,
            "amount": amount,
            "payment_method": "ATO",
            "payment_reference": reference,
            "notes": None,
            "invoice_ids": invoice_ids,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


class TestSummary:
    def test_kpis_reflect_unlinked_invoices_only(self, client: TestClient) -> None:
        inv_a = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-T001",
            qty="10",
            unit_price="100",
        )  # subtotal 1000, GST 50, total 1050
        inv_b = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-T002",
            qty="20",
            unit_price="100",
        )  # subtotal 2000, GST 100, total 2100

        # Link inv_a only.
        _make_payment(client, amount="50.00", invoice_ids=[inv_a["id"]])

        response = client.get("/business/tax-payments/summary")
        data = response.json()
        # Unpaid = inv_b only.
        assert data["gst_unpaid"] == "100.00"
        assert data["unpaid_income"] == "2100.00"
        assert data["total_gst_paid"] == "50.00"


class TestListAndCreate:
    def test_create_with_links_returns_enriched_payment(
        self, client: TestClient
    ) -> None:
        inv = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-T010",
            qty="10",
            unit_price="100",
        )
        result = _make_payment(client, amount="50.00", invoice_ids=[inv["id"]])
        assert len(result["linked_invoices"]) == 1
        link = result["linked_invoices"][0]
        assert link["is_linked"] is True
        assert link["tax_amount"] == "50.00"

    def test_list_includes_invoice_count_and_income(
        self, client: TestClient
    ) -> None:
        inv_a = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-T020",
            qty="10",
            unit_price="100",  # total 1050
        )
        inv_b = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-T021",
            qty="20",
            unit_price="100",  # total 2100
        )
        _make_payment(
            client, amount="150.00", invoice_ids=[inv_a["id"], inv_b["id"]]
        )

        response = client.get("/business/tax-payments/")
        rows = response.json()
        assert len(rows) == 1
        row = rows[0]
        assert row["invoice_count"] == 2
        assert row["income"] == "3150.00"  # 1050 + 2100


class TestUnpaidInvoices:
    def test_unpaid_invoices_excludes_already_linked(
        self, client: TestClient
    ) -> None:
        linked = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-T030",
        )
        unlinked = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-T031",
        )
        # A non-taxable invoice should never appear.
        _make_invoice(
            client,
            client_id=str(SEED_ID_1),
            invoice_number="INV-2026-T032",
            is_taxable=False,
            tax_rate=None,
        )

        _make_payment(client, amount="50.00", invoice_ids=[linked["id"]])

        rows = client.get("/business/tax-payments/unpaid-invoices").json()
        ids = [r["invoice_id"] for r in rows]
        assert unlinked["id"] in ids
        assert linked["id"] not in ids


class TestLinkableInvoices:
    def test_dialog_feed_returns_self_links_and_unlinked(
        self, client: TestClient
    ) -> None:
        a = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-T040",
        )
        b = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-T041",
        )
        # Linked to a DIFFERENT payment — should NOT appear in p1's feed.
        c = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-T042",
        )

        p1 = _make_payment(client, amount="50.00", invoice_ids=[a["id"]])
        _make_payment(client, amount="50.00", invoice_ids=[c["id"]])

        feed = client.get(
            f"/business/tax-payments/{p1['payment']['id']}/linkable-invoices"
        ).json()
        ids = {row["invoice_id"]: row["is_linked"] for row in feed}
        assert ids.get(a["id"]) is True  # already linked to p1
        assert ids.get(b["id"]) is False  # unlinked anywhere
        assert c["id"] not in ids  # linked to a different payment


class TestReplaceLinks:
    def test_replace_swaps_invoices(self, client: TestClient) -> None:
        a = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-T050",
        )
        b = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-T051",
        )
        p = _make_payment(client, amount="50.00", invoice_ids=[a["id"]])

        # Replace [a] with [b].
        response = client.put(
            f"/business/tax-payments/{p['payment']['id']}/links",
            json={"invoice_ids": [b["id"]]},
        )
        assert response.status_code == 200
        result = response.json()
        ids = [r["invoice_id"] for r in result]
        assert ids == [b["id"]]


class TestDelete:
    def test_delete_unlinks_invoices(self, client: TestClient) -> None:
        a = _make_invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-T060",
        )
        p = _make_payment(client, amount="50.00", invoice_ids=[a["id"]])

        response = client.delete(f"/business/tax-payments/{p['payment']['id']}")
        assert response.status_code == 204

        # Invoice should now appear in unpaid-invoices.
        rows = client.get("/business/tax-payments/unpaid-invoices").json()
        assert any(r["invoice_id"] == a["id"] for r in rows)
