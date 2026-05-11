"""Tests for the S3-triggered processor Lambda handler."""

from fastapi.testclient import TestClient

from app.handlers import process_receipt


def _textract_response_with(supplier: str, total: str, tax: str, date_str: str) -> dict:
    """Build a Textract-shaped AnalyzeExpense response."""
    return {
        "ExpenseDocuments": [
            {
                "SummaryFields": [
                    {
                        "Type": {"Text": "VENDOR_NAME"},
                        "ValueDetection": {"Text": supplier},
                    },
                    {
                        "Type": {"Text": "INVOICE_RECEIPT_DATE"},
                        "ValueDetection": {"Text": date_str},
                    },
                    {
                        "Type": {"Text": "TOTAL"},
                        "ValueDetection": {"Text": total},
                    },
                    {
                        "Type": {"Text": "TAX"},
                        "ValueDetection": {"Text": tax},
                    },
                ]
            }
        ]
    }


def _make_pending_expense(client: TestClient) -> str:
    res = client.post(
        "/business/expenses/",
        json={"file_extension": "jpg", "content_type": "image/jpeg"},
    )
    return res.json()["expense"]["s3_key"]


def _s3_event(bucket: str, key: str) -> dict:
    return {
        "Records": [
            {"s3": {"bucket": {"name": bucket}, "object": {"key": key}}}
        ]
    }


class TestHappyPath:
    def test_sets_status_ready_and_extracts_fields(
        self, client: TestClient, fake_aws_clients: dict
    ) -> None:
        s3_key = _make_pending_expense(client)
        fake_aws_clients["textract"].response = _textract_response_with(
            supplier="ACME Corp",
            total="$123.45",
            tax="$5.88",
            date_str="2026-04-15",
        )

        result = process_receipt.handler(
            _s3_event("helm-receipts-test", s3_key)
        )
        assert result == {"processed": 1, "skipped": 0, "failed": 0}

        # The expense row should now be 'ready' with extracted fields.
        expenses = client.get("/business/expenses/").json()
        row = next(r for r in expenses if r["s3_key"] == s3_key)
        assert row["status"] == "ready"
        assert row["supplier"] == "ACME Corp"
        assert row["total"] == "123.45"
        assert row["tax_amount"] == "5.88"
        assert row["expense_date"] == "2026-04-15"


class TestFailurePaths:
    def test_textract_exception_marks_row_failed(
        self, client: TestClient, fake_aws_clients: dict, monkeypatch
    ) -> None:
        s3_key = _make_pending_expense(client)

        def explode(*, Document: dict) -> dict:
            raise RuntimeError("Textract is sad today")

        monkeypatch.setattr(
            fake_aws_clients["textract"], "analyze_expense", explode
        )

        result = process_receipt.handler(
            _s3_event("helm-receipts-test", s3_key)
        )
        assert result == {"processed": 0, "skipped": 0, "failed": 1}

        row = next(
            r
            for r in client.get("/business/expenses/").json()
            if r["s3_key"] == s3_key
        )
        assert row["status"] == "failed"
        assert "Textract is sad today" in row["ocr_error"]

    def test_unknown_s3_key_is_skipped(
        self, client: TestClient, fake_aws_clients: dict
    ) -> None:
        # No matching row — handler should swallow the event.
        result = process_receipt.handler(
            _s3_event(
                "helm-receipts-test", "expenses/2026-04/orphan.jpg"
            )
        )
        assert result == {"processed": 0, "skipped": 1, "failed": 0}


class TestParseTextractSummary:
    def test_handles_dirty_money_strings(self) -> None:
        summary = process_receipt.parse_textract_summary(
            _textract_response_with(
                supplier="Coffee Co",
                total="CA$ 4,256.00",
                tax="$212.80",
                date_str="04/15/2026",
            )
        )
        assert summary.supplier == "Coffee Co"
        assert str(summary.total) == "4256.00"
        assert str(summary.tax_amount) == "212.80"
        # MM/DD/YYYY parsed correctly.
        assert summary.expense_date and summary.expense_date.year == 2026

    def test_ignores_unrecognised_fields(self) -> None:
        response = {
            "ExpenseDocuments": [
                {
                    "SummaryFields": [
                        {
                            "Type": {"Text": "RANDOM_TYPE"},
                            "ValueDetection": {"Text": "noise"},
                        }
                    ]
                }
            ]
        }
        summary = process_receipt.parse_textract_summary(response)
        assert summary.supplier is None
        assert summary.total is None
