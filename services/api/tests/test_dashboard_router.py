"""Integration tests for /business/dashboard."""

from datetime import date

from fastapi.testclient import TestClient
from freezegun import freeze_time  # type: ignore[import-not-found]

from tests.conftest import SEED_ID_1, SEED_ID_2, SEED_ID_CP


def _invoice(
    client: TestClient,
    *,
    client_id: str,
    invoice_number: str,
    qty: str,
    unit_price: str,
    is_taxable: bool,
    tax_rate: str | None,
    issue_date: str,
    status: str = "sent",
) -> dict:
    body = {
        "invoice_number": invoice_number,
        "client_id": client_id,
        "issue_date": issue_date,
        "due_date": issue_date,
        "status": status,
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
    res = client.post("/business/invoices/", json=body)
    assert res.status_code == 201, res.text
    return res.json()["invoice"]


def _payment(
    client: TestClient,
    *,
    invoice_id: str,
    amount: str,
    payment_date: str,
) -> dict:
    body = {
        "invoice_id": invoice_id,
        "payment_date": payment_date,
        "amount": amount,
        "payment_method": "EFT",
        "reference": None,
        "notes": None,
        "deduction_amount": "0",
        "deduction_description": None,
    }
    res = client.post("/business/payments/", json=body)
    assert res.status_code == 201, res.text
    return res.json()


def _transfer(
    client: TestClient,
    *,
    transfer_date: str,
    amount: str,
    est_company: str,
    est_personal: str,
) -> dict:
    body = {
        "transfer_date": transfer_date,
        "amount": amount,
        "method": "EFT",
        "purpose": None,
        "category": "Salary",
        "estimated_tax_company": est_company,
        "estimated_tax_personal": est_personal,
        "actual_tax_paid_company": None,
        "actual_tax_paid_personal": None,
        "tax_ledger_link_company": None,
        "tax_ledger_link_personal": None,
        "notes": None,
    }
    res = client.post("/business/transfers/", json=body)
    assert res.status_code == 201, res.text
    return res.json()


@freeze_time("2026-05-11")
class TestKPIs:
    """Today is 2026-05-11 → current FY = 2026/27 (Apr 1 2026 → Mar 31 2027).

    "Same point last FY" maps today back a year → 2025-05-11, which is in
    FY 2025/26 (Apr 1 2025 → Mar 31 2026). KPIs compare current-FY-so-far
    against the same-window in the prev FY."""

    def test_fy_invoiced_and_delta_against_same_point_last_fy(
        self, client: TestClient
    ) -> None:
        # Current FY (2026/27, Apr 1 2026 → today=May 11 2026):
        _invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-D001",
            qty="10",
            unit_price="100",
            is_taxable=True,
            tax_rate="0.0500",
            issue_date="2026-04-15",  # total = 1050
        )
        # Same-point-last-FY window (Apr 1 2025 → May 11 2025):
        _invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2025-D001",
            qty="20",
            unit_price="100",
            is_taxable=True,
            tax_rate="0.0500",
            issue_date="2025-05-01",  # total = 2100
        )
        # Outside both windows — should not influence the delta.
        _invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2025-D002",
            qty="5",
            unit_price="100",
            is_taxable=True,
            tax_rate="0.0500",
            issue_date="2025-09-01",  # total = 525, still in FY 2025/26 but past today-1yr
        )

        data = client.get("/business/dashboard/").json()
        kpi = data["kpis"]["fy_invoiced"]
        assert kpi["value"] == "1050.00"
        assert kpi["prev_value"] == "2100.00"
        # (1050 - 2100) / 2100 * 100 = -50.0
        assert kpi["delta_pct"] == "-50.0"

    def test_outstanding_counts_sent_and_draft_only(
        self, client: TestClient
    ) -> None:
        # Two sent invoices and one paid one — paid invoice excluded.
        inv_a = _invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-D010",
            qty="10",
            unit_price="100",
            is_taxable=False,
            tax_rate=None,
            issue_date="2026-04-05",
            status="sent",
        )
        _invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-D011",
            qty="5",
            unit_price="100",
            is_taxable=False,
            tax_rate=None,
            issue_date="2026-04-12",
            status="sent",
        )
        # Mark inv_a paid by linking a full payment.
        _payment(
            client,
            invoice_id=inv_a["id"],
            amount=inv_a["total"],
            payment_date="2026-04-20",
        )

        data = client.get("/business/dashboard/").json()
        # Only the second invoice (500.00) remains outstanding.
        assert data["kpis"]["outstanding"]["value"] == "500.00"
        assert data["kpis"]["outstanding"]["detail"] == "1 invoice"

    def test_gst_owed_excludes_invoices_linked_to_a_payment(
        self, client: TestClient
    ) -> None:
        # Both invoices are taxable.
        linked = _invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-D020",
            qty="10",
            unit_price="100",
            is_taxable=True,
            tax_rate="0.0500",
            issue_date="2026-04-05",
        )
        _invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-D021",
            qty="20",
            unit_price="100",
            is_taxable=True,
            tax_rate="0.0500",
            issue_date="2026-04-12",
        )
        # Link the first one to a GST payment.
        res = client.post(
            "/business/tax-payments/",
            json={
                "payment_date": "2026-04-30",
                "amount": "50.00",
                "payment_method": "ATO",
                "payment_reference": "X",
                "notes": None,
                "invoice_ids": [linked["id"]],
            },
        )
        assert res.status_code == 201, res.text

        data = client.get("/business/dashboard/").json()
        # GST owed = unlinked tax_amount only = 100.00.
        assert data["kpis"]["gst_owed"]["value"] == "100.00"


@freeze_time("2026-05-11")
class TestCharts:
    def test_monthly_revenue_uses_payment_date_and_client(
        self, client: TestClient
    ) -> None:
        # Two invoices paid in April land in the Apr bucket, split by the
        # client of the invoice each payment settles.
        inv_sulp = _invoice(
            client,
            client_id=str(SEED_ID_1),  # Sulpetro
            invoice_number="INV-2026-D050",
            qty="10",
            unit_price="100",
            is_taxable=False,
            tax_rate=None,
            issue_date="2026-04-15",  # total = 1000
        )
        inv_cp = _invoice(
            client,
            client_id=str(SEED_ID_CP),  # CP
            invoice_number="INV-2026-D051",
            qty="5",
            unit_price="100",
            is_taxable=False,
            tax_rate=None,
            issue_date="2026-04-20",  # total = 500
        )
        # An issued-but-unpaid invoice contributes nothing on a cash basis.
        _invoice(
            client,
            client_id=str(SEED_ID_1),
            invoice_number="INV-2026-D052",
            qty="20",
            unit_price="100",
            is_taxable=False,
            tax_rate=None,
            issue_date="2026-04-25",  # total = 2000, never paid
        )
        _payment(
            client,
            invoice_id=inv_sulp["id"],
            amount=inv_sulp["total"],
            payment_date="2026-04-28",
        )
        _payment(
            client,
            invoice_id=inv_cp["id"],
            amount=inv_cp["total"],
            payment_date="2026-04-29",
        )

        data = client.get("/business/dashboard/").json()
        apr = next(m for m in data["monthly_revenue"] if m["month"] == "Apr")
        assert apr["total"] == "1500.00"  # unpaid 2000 excluded
        names = {s["client_name"]: s["amount"] for s in apr["by_client"]}
        assert names == {"Sulpetro": "1000.00", "CP": "500.00"}

    def test_top_clients_rank_by_cash_received(self, client: TestClient) -> None:
        # CP is invoiced more (5000) but pays only 1000; Sulpetro is invoiced
        # less (2000) but pays in full → Sulpetro ranks first on a cash basis.
        inv_cp = _invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-D060",
            qty="50",
            unit_price="100",
            is_taxable=False,
            tax_rate=None,
            issue_date="2026-04-15",  # total = 5000
        )
        inv_sulp = _invoice(
            client,
            client_id=str(SEED_ID_1),
            invoice_number="INV-2026-D061",
            qty="20",
            unit_price="100",
            is_taxable=False,
            tax_rate=None,
            issue_date="2026-04-20",  # total = 2000
        )
        _payment(
            client,
            invoice_id=inv_cp["id"],
            amount="1000",  # partial
            payment_date="2026-04-25",
        )
        _payment(
            client,
            invoice_id=inv_sulp["id"],
            amount=inv_sulp["total"],
            payment_date="2026-04-26",
        )

        data = client.get("/business/dashboard/").json()
        top = data["top_clients"]
        assert len(top) == 2
        assert top[0]["client_name"] == "Sulpetro"
        assert top[0]["total"] == "2000.00"
        assert top[1]["client_name"] == "CP"
        assert top[1]["total"] == "1000.00"

    def test_cash_flow_registers_on_payment_month(
        self, client: TestClient
    ) -> None:
        # Issued in April, paid in May → the money shows up in May only.
        inv = _invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-D070",
            qty="10",
            unit_price="100",
            is_taxable=False,
            tax_rate=None,
            issue_date="2026-04-05",
        )
        _payment(
            client,
            invoice_id=inv["id"],
            amount=inv["total"],
            payment_date="2026-05-10",
        )

        data = client.get("/business/dashboard/").json()
        cf = {p["month"]: p for p in data["cash_flow"]}
        assert "invoiced" not in cf["Apr"]  # cash-basis: invoiced series dropped
        assert cf["Apr"]["received"] == "0.00"
        assert cf["May"]["received"] == "1000.00"

    def test_quarterly_registers_on_payment_quarter(
        self, client: TestClient
    ) -> None:
        # Issued in Q1 (May) but paid in Q2 (Aug) → lands in Q2. The FY window
        # (not "today") bounds the chart, so a later-dated payment still counts.
        inv = _invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-D080",
            qty="10",
            unit_price="100",
            is_taxable=False,
            tax_rate=None,
            issue_date="2026-05-15",
        )
        _payment(
            client,
            invoice_id=inv["id"],
            amount=inv["total"],
            payment_date="2026-08-01",
        )

        data = client.get("/business/dashboard/").json()
        q = {p["quarter"]: p for p in data["quarterly"]}
        assert "invoiced" not in q["Q1"]
        assert q["Q1"]["received"] == "0.00"
        assert q["Q2"]["received"] == "1000.00"

    def test_by_fiscal_year_groups_by_payment_date(
        self, client: TestClient
    ) -> None:
        # Issued in FY 2025/26 (Mar 2026) but paid in FY 2026/27 (Apr 2026) →
        # its cash lands in 2026/27, proving payment-date grouping.
        inv_late = _invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2026-D090",
            qty="10",
            unit_price="100",
            is_taxable=False,
            tax_rate=None,
            issue_date="2026-03-20",  # FY 2025/26
        )
        # Issued and paid within FY 2025/26.
        inv_early = _invoice(
            client,
            client_id=str(SEED_ID_CP),
            invoice_number="INV-2025-D090",
            qty="20",
            unit_price="100",
            is_taxable=False,
            tax_rate=None,
            issue_date="2025-09-01",  # FY 2025/26
        )
        _payment(
            client,
            invoice_id=inv_late["id"],
            amount=inv_late["total"],
            payment_date="2026-04-20",  # FY 2026/27
        )
        _payment(
            client,
            invoice_id=inv_early["id"],
            amount=inv_early["total"],
            payment_date="2025-10-01",  # FY 2025/26
        )

        data = client.get("/business/dashboard/").json()
        rows = {r["fy_label"]: r for r in data["by_fiscal_year"]}
        assert "invoiced" not in rows["2025/26"]
        assert rows["2025/26"]["received"] == "2000.00"  # inv_early
        assert rows["2026/27"]["received"] == "1000.00"  # inv_late, paid Apr

    def test_aging_buckets_use_days_since_issue(
        self, client: TestClient
    ) -> None:
        # Today is 2026-05-11. Issue dates relative to that:
        #   2026-05-01 → 10 days → 0-30
        #   2026-04-01 → 40 days → 31-60
        #   2026-03-01 → 71 days → 61-90
        #   2026-01-01 → 130 days → 90+
        for n, iso in enumerate(
            ["2026-05-01", "2026-04-01", "2026-03-01", "2026-01-01"]
        ):
            _invoice(
                client,
                client_id=str(SEED_ID_CP),
                invoice_number=f"INV-D100-{n}",
                qty="1",
                unit_price="100",
                is_taxable=False,
                tax_rate=None,
                issue_date=iso,
                status="sent",
            )
        data = client.get("/business/dashboard/").json()
        buckets = {b["label"]: b for b in data["aging"]}
        assert buckets["0-30"]["count"] == 1
        assert buckets["31-60"]["count"] == 1
        assert buckets["61-90"]["count"] == 1
        assert buckets["90+"]["count"] == 1


@freeze_time("2026-05-11")
class TestEmpty:
    def test_returns_zeros_when_no_data(self, client: TestClient) -> None:
        data = client.get("/business/dashboard/").json()
        assert data["kpis"]["fy_invoiced"]["value"] == "0.00"
        assert data["kpis"]["outstanding"]["value"] == "0.00"
        assert data["top_clients"] == []
        assert data["by_fiscal_year"] == []
        assert len(data["monthly_revenue"]) == 12  # always 12 months
        assert len(data["quarterly"]) == 4
