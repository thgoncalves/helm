"""Tests for the CSV processor Lambda handler + per-institution parsers."""

from datetime import date
from decimal import Decimal

from fastapi.testclient import TestClient

from app.handlers import process_csv


def _make_account(client: TestClient, institution: str) -> str:
    res = client.post(
        "/personal/accounts/",
        json={
            "name": f"{institution} Account",
            "institution": institution,
            "account_type": "checking",
            "currency": "CAD",
            "opening_balance": "0",
            "is_active": True,
            "notes": None,
        },
    )
    return res.json()["id"]


def _make_import(client: TestClient, account_id: str, institution: str) -> dict:
    res = client.post(
        "/personal/imports/",
        json={
            "account_id": account_id,
            "institution": institution,
            "filename": f"{institution.lower()}.csv",
        },
    )
    return res.json()["import_"]


def _s3_event(bucket: str, key: str) -> dict:
    return {
        "Records": [
            {"s3": {"bucket": {"name": bucket}, "object": {"key": key}}}
        ]
    }


# ---------------------------------------------------------------------------
# Parser unit tests — talk to the parser functions directly so the
# dispatch + DB round-trip is out of scope.
# ---------------------------------------------------------------------------


class TestRBC:
    def test_signed_amount_in_cad(self) -> None:
        text = (
            "Account Type,Account Number,Transaction Date,Cheque Number,"
            "Description 1,Description 2,CAD$,USD$\n"
            "Chequing,12345-67890,3/1/2024,,POS PURCHASE,STARBUCKS,-5.45,\n"
            "Chequing,12345-67890,3/2/2024,,DEPOSIT,PAYROLL,2500.00,\n"
        )
        out = process_csv.parse_csv_text("RBC", text)
        assert len(out) == 2
        assert out[0].posted_date == date(2024, 3, 1)
        assert out[0].description == "POS PURCHASE STARBUCKS"
        assert out[0].amount == Decimal("-5.45")
        assert out[1].amount == Decimal("2500.00")


class TestTD:
    def test_separate_withdrawal_deposit(self) -> None:
        text = (
            "Date,Description,Withdrawals,Deposits,Balance\n"
            "03/01/2024,POS STARBUCKS,5.45,,1234.56\n"
            "03/02/2024,PAYROLL,,2500.00,3734.56\n"
        )
        out = process_csv.parse_csv_text("TD", text)
        assert len(out) == 2
        # MM/DD/YYYY first (US-style) is what TD typically emits.
        assert out[0].posted_date == date(2024, 3, 1)
        assert out[0].amount == Decimal("-5.45")
        assert out[0].balance == Decimal("1234.56")
        assert out[1].amount == Decimal("2500.00")


class TestScotia:
    def test_signed_amount(self) -> None:
        text = (
            "Date,Description,Sub-description,Status,Type of Transaction,Amount\n"
            "3/1/2024,POS PURCHASE,STARBUCKS,POSTED,Debit,-5.45\n"
            "3/2/2024,DEPOSIT,PAYROLL,POSTED,Credit,2500.00\n"
        )
        out = process_csv.parse_csv_text("Scotia", text)
        assert len(out) == 2
        assert out[0].description == "POS PURCHASE — STARBUCKS"
        assert out[0].amount == Decimal("-5.45")


# ---------------------------------------------------------------------------
# Handler end-to-end (parse + insert + dedup)
# ---------------------------------------------------------------------------


class TestHandler:
    def test_inserts_and_marks_ready(
        self, client: TestClient, fake_aws_clients: dict
    ) -> None:
        account_id = _make_account(client, "RBC")
        imp = _make_import(client, account_id, "RBC")
        s3_key = imp["s3_key"]

        # Seed the fake S3 with CSV bytes the processor will GET.
        fake_aws_clients["s3"].objects[("helm-receipts-test", s3_key)] = (
            "Account Type,Account Number,Transaction Date,Cheque Number,"
            "Description 1,Description 2,CAD$,USD$\n"
            "Chequing,X,3/1/2024,,COFFEE,STARBUCKS,-5.45,\n"
            "Chequing,X,3/2/2024,,SALARY,EMPLOYER,2500.00,\n"
        ).encode("utf-8")

        result = process_csv.handler(_s3_event("helm-receipts-test", s3_key))
        assert result == {"processed": 1, "skipped": 0, "failed": 0}

        # Import flipped to ready with counts.
        imports = client.get("/personal/imports/").json()
        row = next(i for i in imports if i["id"] == imp["id"])
        assert row["status"] == "ready"
        assert row["row_count"] == 2
        assert row["imported_count"] == 2
        assert row["skipped_count"] == 0

        # Transactions are visible via the API.
        txns = client.get(
            f"/personal/transactions/?account_id={account_id}"
        ).json()
        assert {t["amount"] for t in txns} == {"-5.45", "2500.00"}

    def test_dedup_skips_duplicate_rows(
        self, client: TestClient, fake_aws_clients: dict
    ) -> None:
        account_id = _make_account(client, "TD")
        # First import: 1 row.
        imp_a = _make_import(client, account_id, "TD")
        fake_aws_clients["s3"].objects[
            ("helm-receipts-test", imp_a["s3_key"])
        ] = (
            "Date,Description,Withdrawals,Deposits,Balance\n"
            "03/01/2024,STARBUCKS,5.45,,1000.00\n"
        ).encode("utf-8")
        process_csv.handler(_s3_event("helm-receipts-test", imp_a["s3_key"]))

        # Second import: same row.
        imp_b = _make_import(client, account_id, "TD")
        fake_aws_clients["s3"].objects[
            ("helm-receipts-test", imp_b["s3_key"])
        ] = (
            "Date,Description,Withdrawals,Deposits,Balance\n"
            "03/01/2024,STARBUCKS,5.45,,1000.00\n"
        ).encode("utf-8")
        process_csv.handler(_s3_event("helm-receipts-test", imp_b["s3_key"]))

        imp_b_row = next(
            i
            for i in client.get("/personal/imports/").json()
            if i["id"] == imp_b["id"]
        )
        assert imp_b_row["imported_count"] == 0
        assert imp_b_row["skipped_count"] == 1
        # Still only one transaction on the account.
        txns = client.get(
            f"/personal/transactions/?account_id={account_id}"
        ).json()
        assert len(txns) == 1

    def test_marks_failed_on_exception(
        self, client: TestClient, fake_aws_clients: dict, monkeypatch
    ) -> None:
        account_id = _make_account(client, "RBC")
        imp = _make_import(client, account_id, "RBC")

        def explode(*, Bucket: str, Key: str) -> dict:
            raise RuntimeError("S3 is down")

        monkeypatch.setattr(fake_aws_clients["s3"], "get_object", explode)

        result = process_csv.handler(
            _s3_event("helm-receipts-test", imp["s3_key"])
        )
        assert result == {"processed": 0, "skipped": 0, "failed": 1}
        row = next(
            i
            for i in client.get("/personal/imports/").json()
            if i["id"] == imp["id"]
        )
        assert row["status"] == "failed"
        assert "S3 is down" in row["error"]
