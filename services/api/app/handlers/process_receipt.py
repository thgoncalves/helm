"""Lambda handler: S3 ObjectCreated → Textract → expenses row update.

Wired by CDK as a second Lambda function sharing the same Docker image
as the API Lambda but pointing at this handler.

Trigger: ``s3:ObjectCreated:*`` on the helm-receipts bucket, prefix
``expenses/``. The S3 event delivers one record per object created in
the batch; we process each in turn.

Per record:
  1. Locate the matching ``expenses`` row by ``s3_key``. If none is
     found, swallow the event — the row may have been deleted between
     PUT and the event firing.
  2. Mark the row ``processing``.
  3. Call Textract ``AnalyzeExpense`` synchronously on the S3 object.
     Textract returns summary fields (VENDOR_NAME, INVOICE_RECEIPT_DATE,
     SUBTOTAL, TAX, TOTAL) with confidence scores.
  4. Parse the summary, persist the extracted values + the full Textract
     response (in ``ocr_raw``), set status to ``ready``.
  5. On any exception, set ``status='failed'`` + ``ocr_error`` so the
     user can still edit the row manually.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import unquote_plus
from uuid import UUID

from app import aws, db
from app.models.expenses import TextractSummary

# Textract returns these `Type.Text` values in its SUMMARY section. We
# map each to the matching DB column.
_FIELD_MAP = {
    "VENDOR_NAME": "supplier",
    "INVOICE_RECEIPT_DATE": "expense_date",
    "SUBTOTAL": "subtotal",
    "TAX": "tax_amount",
    "TOTAL": "total",
}


def _parse_money(raw: str | None) -> Decimal | None:
    """Best-effort parse of a Textract money string into a Decimal.

    Textract returns values like ``"$1,234.56"`` or ``"1234.56 CAD"``.
    Strip everything that isn't a digit, sign, or decimal point. Returns
    ``None`` on failure so the caller can ignore that field rather than
    blow up the whole row."""
    if raw is None:
        return None
    cleaned = "".join(c for c in raw if c.isdigit() or c in ".-")
    if not cleaned:
        return None
    try:
        return Decimal(cleaned).quantize(Decimal("0.01"))
    except InvalidOperation:
        return None


def _parse_date(raw: str | None) -> date | None:
    """Try a few common formats Textract returns. Returns ``None`` on
    failure."""
    if not raw:
        return None
    for fmt in (
        "%Y-%m-%d",
        "%m/%d/%Y",
        "%d/%m/%Y",
        "%d %b %Y",
        "%d-%b-%Y",
        "%b %d, %Y",
    ):
        try:
            return datetime.strptime(raw.strip(), fmt).date()
        except ValueError:
            continue
    return None


def parse_textract_summary(response: dict[str, Any]) -> TextractSummary:
    """Walk the Textract ``AnalyzeExpense`` response and pull the fields
    we care about. Stays type-safe — anything we can't parse is dropped
    silently (the user can fix it via the edit form)."""
    extracted: dict[str, Any] = {}
    for doc in response.get("ExpenseDocuments", []):
        for field in doc.get("SummaryFields", []):
            field_type = (
                field.get("Type", {}).get("Text") or ""
            ).upper()
            column = _FIELD_MAP.get(field_type)
            if column is None:
                continue
            value_text = (field.get("ValueDetection", {}) or {}).get("Text")
            if value_text is None:
                continue
            extracted[column] = value_text
        # Stop at the first document — V1 only handles single-receipt
        # uploads; multi-page invoices come later.
        break

    return TextractSummary(
        supplier=extracted.get("supplier"),
        expense_date=_parse_date(extracted.get("expense_date")),
        subtotal=_parse_money(extracted.get("subtotal")),
        tax_amount=_parse_money(extracted.get("tax_amount")),
        total=_parse_money(extracted.get("total")),
        raw=response,
    )


def _find_expense_by_s3_key(key: str) -> dict | None:
    return db.fetch_one(
        "SELECT * FROM expenses WHERE s3_key = :s3_key",
        {"s3_key": key},
    )


def _mark_processing(expense_id: UUID) -> None:
    db.execute(
        """
        UPDATE expenses
        SET status = 'processing', updated_at = :now
        WHERE id = :id
        """,
        {"id": expense_id, "now": datetime.now(timezone.utc)},
    )


def _mark_ready(expense_id: UUID, summary: TextractSummary) -> None:
    db.execute(
        """
        UPDATE expenses SET
            status = 'ready',
            supplier = COALESCE(:supplier, supplier),
            expense_date = COALESCE(:expense_date, expense_date),
            subtotal = COALESCE(:subtotal, subtotal),
            tax_amount = COALESCE(:tax_amount, tax_amount),
            total = COALESCE(:total, total),
            ocr_raw = CAST(:ocr_raw AS jsonb),
            ocr_error = NULL,
            updated_at = :now
        WHERE id = :id
        """,
        {
            "id": expense_id,
            "supplier": summary.supplier,
            "expense_date": summary.expense_date,
            "subtotal": summary.subtotal,
            "tax_amount": summary.tax_amount,
            "total": summary.total,
            "ocr_raw": _safe_json(summary.raw),
            "now": datetime.now(timezone.utc),
        },
    )


def _mark_failed(expense_id: UUID, message: str) -> None:
    db.execute(
        """
        UPDATE expenses
        SET status = 'failed',
            ocr_error = :ocr_error,
            updated_at = :now
        WHERE id = :id
        """,
        {
            "id": expense_id,
            "ocr_error": message[:2000],
            "now": datetime.now(timezone.utc),
        },
    )


def _safe_json(payload: Any) -> str:
    """JSON-encode ``payload`` while tolerating Decimals / datetimes."""
    import json

    def _default(value: Any) -> Any:
        if isinstance(value, Decimal):
            return str(value)
        if isinstance(value, (datetime, date)):
            return value.isoformat()
        if isinstance(value, set):
            return list(value)
        raise TypeError(
            f"Object of type {type(value).__name__} is not JSON serializable"
        )

    return json.dumps(payload or {}, default=_default)


def handler(event: dict, _context: Any | None = None) -> dict:
    """Lambda entrypoint for the S3 ``ObjectCreated`` trigger."""
    processed = 0
    skipped = 0
    failed = 0
    for record in event.get("Records", []):
        bucket = record.get("s3", {}).get("bucket", {}).get("name")
        key_raw = record.get("s3", {}).get("object", {}).get("key")
        if not bucket or not key_raw:
            skipped += 1
            continue
        key = unquote_plus(key_raw)

        row = _find_expense_by_s3_key(key)
        if row is None:
            # Row was deleted between PUT and event delivery. Nothing
            # actionable; CloudWatch will show this as a NOOP run.
            skipped += 1
            continue
        expense_id: UUID = row["id"]

        try:
            _mark_processing(expense_id)
            response = aws.textract().analyze_expense(
                Document={"S3Object": {"Bucket": bucket, "Name": key}},
            )
            summary = parse_textract_summary(response)
            _mark_ready(expense_id, summary)
            processed += 1
        except Exception as exc:  # broad on purpose — we want a failed
            # status, not a crash that masks the failure forever.
            _mark_failed(expense_id, f"{type(exc).__name__}: {exc}")
            failed += 1

    return {"processed": processed, "skipped": skipped, "failed": failed}
