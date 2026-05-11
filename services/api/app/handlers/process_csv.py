"""Lambda handler: S3 ObjectCreated under ``imports/`` → CSV parsing.

Wired by CDK as a third Lambda function (after the API + the receipt
processor) sharing the same Docker image. The handler:

  1. Locates the matching ``personal_imports`` row by ``s3_key``.
  2. Marks it ``processing``.
  3. Downloads the CSV from S3 (small files, sync GET is fine).
  4. Dispatches to an institution-specific parser based on
     ``import_row.institution``.
  5. Inserts each parsed transaction with ``ON CONFLICT DO NOTHING``
     on the dedup index — duplicate rows from an overlapping statement
     are silently skipped.
  6. Updates the import row with ``status='ready'`` and the
     imported/skipped counts.

  On any exception, marks the row ``status='failed'`` with the error
  message so the user can re-export from their bank and retry.
"""

from __future__ import annotations

import csv
import io
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable
from urllib.parse import unquote_plus
from uuid import UUID, uuid4

from app import aws, db


# ---------------------------------------------------------------------------
# Parsed row shape — what every parser returns.
# ---------------------------------------------------------------------------


class ParsedTransaction:
    """Plain container — Pydantic would be overkill for an internal
    intermediate."""

    __slots__ = ("posted_date", "description", "amount", "balance", "external_id")

    def __init__(
        self,
        *,
        posted_date: date,
        description: str,
        amount: Decimal,
        balance: Decimal | None = None,
        external_id: str | None = None,
    ) -> None:
        self.posted_date = posted_date
        self.description = description
        self.amount = amount
        self.balance = balance
        self.external_id = external_id


# ---------------------------------------------------------------------------
# Money / date helpers
# ---------------------------------------------------------------------------


def _money(value: str | None) -> Decimal | None:
    """Tolerant money parser — handles ``"$1,234.56"``, ``"-1234"``,
    ``""`` (treated as None), parentheses for negatives, etc."""
    if value is None:
        return None
    raw = value.strip()
    if not raw or raw in {"-", "—"}:
        return None
    negative = False
    if raw.startswith("(") and raw.endswith(")"):
        negative = True
        raw = raw[1:-1]
    cleaned = "".join(c for c in raw if c.isdigit() or c in ".-")
    if not cleaned:
        return None
    try:
        v = Decimal(cleaned)
    except InvalidOperation:
        return None
    if negative:
        v = -v
    return v.quantize(Decimal("0.01"))


_DATE_FORMATS = (
    "%Y-%m-%d",      # 2024-03-01
    "%m/%d/%Y",      # 03/01/2024  (RBC/Scotia US-style)
    "%d/%m/%Y",      # 01/03/2024  (TD UK-style)
    "%m/%d/%y",
    "%d/%m/%y",
    "%d-%b-%Y",      # 01-Mar-2024
    "%b %d, %Y",
)


def _date(raw: str | None) -> date | None:
    if not raw:
        return None
    s = raw.strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------------------
# Institution-specific parsers
# ---------------------------------------------------------------------------


def parse_rbc(rows: list[dict[str, str]]) -> Iterable[ParsedTransaction]:
    """RBC Personal Banking export.

    Typical header:
        Account Type, Account Number, Transaction Date, Cheque Number,
        Description 1, Description 2, CAD$, USD$

    The amount column is a single signed value in CAD$ (or USD$ for
    cross-border accounts; we use whichever is non-empty).
    """
    for row in rows:
        d = _date(row.get("Transaction Date") or row.get("transaction date"))
        if d is None:
            continue
        desc = " ".join(
            s.strip()
            for s in (
                row.get("Description 1") or row.get("description 1") or "",
                row.get("Description 2") or row.get("description 2") or "",
            )
            if s.strip()
        )
        cad = _money(row.get("CAD$") or row.get("cad$"))
        usd = _money(row.get("USD$") or row.get("usd$"))
        amount = cad if cad is not None else usd
        if amount is None:
            continue
        yield ParsedTransaction(
            posted_date=d,
            description=desc or "(no description)",
            amount=amount,
        )


def parse_td(rows: list[dict[str, str]]) -> Iterable[ParsedTransaction]:
    """TD Canada Trust export.

    Typical header:
        Date, Description, Withdrawals, Deposits, Balance

    Withdrawals and Deposits are separate unsigned columns.
    """
    for row in rows:
        d = _date(row.get("Date") or row.get("date"))
        if d is None:
            continue
        desc = (row.get("Description") or row.get("description") or "").strip()
        withdraw = _money(row.get("Withdrawals") or row.get("withdrawals"))
        deposit = _money(row.get("Deposits") or row.get("deposits"))
        if withdraw is not None and withdraw != 0:
            amount = -withdraw
        elif deposit is not None and deposit != 0:
            amount = deposit
        else:
            continue
        balance = _money(row.get("Balance") or row.get("balance"))
        yield ParsedTransaction(
            posted_date=d,
            description=desc or "(no description)",
            amount=amount,
            balance=balance,
        )


def parse_scotia(rows: list[dict[str, str]]) -> Iterable[ParsedTransaction]:
    """Scotiabank Personal Banking export.

    Typical header:
        Date, Description, Sub-description, Status, Type of Transaction, Amount

    Amount is signed in the export.
    """
    for row in rows:
        d = _date(row.get("Date") or row.get("date"))
        if d is None:
            continue
        primary = (row.get("Description") or row.get("description") or "").strip()
        sub = (row.get("Sub-description") or row.get("sub-description") or "").strip()
        desc = " — ".join(s for s in (primary, sub) if s) or "(no description)"
        amount = _money(row.get("Amount") or row.get("amount"))
        if amount is None:
            continue
        yield ParsedTransaction(posted_date=d, description=desc, amount=amount)


def parse_other(rows: list[dict[str, str]]) -> Iterable[ParsedTransaction]:
    """Generic 3-column fallback: Date / Description / Amount (signed).

    For when the user has a CSV that doesn't match the three named
    institutions. Best-effort — they can re-export from their bank if
    the headers don't match.
    """
    for row in rows:
        # Try common header variants.
        d = _date(
            row.get("Date")
            or row.get("date")
            or row.get("Posted Date")
            or row.get("posted_date")
            or row.get("Transaction Date")
        )
        if d is None:
            continue
        desc = (
            row.get("Description")
            or row.get("description")
            or row.get("Memo")
            or row.get("memo")
            or "(no description)"
        ).strip()
        amount = _money(
            row.get("Amount")
            or row.get("amount")
            or row.get("Value")
            or row.get("value")
        )
        if amount is None:
            continue
        yield ParsedTransaction(posted_date=d, description=desc, amount=amount)


_PARSERS = {
    "RBC": parse_rbc,
    "TD": parse_td,
    "Scotia": parse_scotia,
    "Other": parse_other,
}


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------


def _find_import_by_s3_key(key: str) -> dict | None:
    return db.fetch_one(
        "SELECT * FROM personal_imports WHERE s3_key = :s3_key",
        {"s3_key": key},
    )


def _mark_processing(import_id: UUID) -> None:
    db.execute(
        """
        UPDATE personal_imports
        SET status = 'processing', updated_at = :now
        WHERE id = :id
        """,
        {"id": import_id, "now": datetime.now(timezone.utc)},
    )


def _mark_ready(
    import_id: UUID, *, row_count: int, imported: int, skipped: int
) -> None:
    db.execute(
        """
        UPDATE personal_imports
        SET status = 'ready',
            row_count = :row_count,
            imported_count = :imported_count,
            skipped_count = :skipped_count,
            error = NULL,
            updated_at = :now
        WHERE id = :id
        """,
        {
            "id": import_id,
            "row_count": row_count,
            "imported_count": imported,
            "skipped_count": skipped,
            "now": datetime.now(timezone.utc),
        },
    )


def _mark_failed(import_id: UUID, message: str) -> None:
    db.execute(
        """
        UPDATE personal_imports
        SET status = 'failed',
            error = :error,
            updated_at = :now
        WHERE id = :id
        """,
        {
            "id": import_id,
            "error": message[:2000],
            "now": datetime.now(timezone.utc),
        },
    )


def _insert_transaction(
    *,
    account_id: UUID,
    import_id: UUID,
    tx: ParsedTransaction,
) -> bool:
    """Returns True if inserted, False if the dedup index skipped it."""
    response = db.execute(
        """
        INSERT INTO personal_transactions (
            id, account_id, import_id, posted_date, description,
            amount, balance, external_id, created_at
        ) VALUES (
            :id, :account_id, :import_id, :posted_date, :description,
            :amount, :balance, :external_id, :now
        )
        ON CONFLICT (account_id, posted_date, amount, description)
        DO NOTHING
        """,
        {
            "id": uuid4(),
            "account_id": account_id,
            "import_id": import_id,
            "posted_date": tx.posted_date,
            "description": tx.description,
            "amount": tx.amount,
            "balance": tx.balance,
            "external_id": tx.external_id,
            "now": datetime.now(timezone.utc),
        },
    )
    # The RDS Data API returns numberOfRecordsUpdated only on UPDATE/DELETE;
    # on INSERT … ON CONFLICT it returns generatedFields/empty for skipped.
    return bool(response.get("numberOfRecordsUpdated", 1))


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


def _decode(body: bytes) -> str:
    """Decode bank CSVs that occasionally show up as UTF-16 (TD) or
    Windows-1252 (Scotia)."""
    for encoding in ("utf-8-sig", "utf-16", "windows-1252", "latin-1"):
        try:
            return body.decode(encoding)
        except UnicodeDecodeError:
            continue
    return body.decode("utf-8", errors="replace")


def parse_csv_text(institution: str, text: str) -> list[ParsedTransaction]:
    parser = _PARSERS.get(institution, parse_other)
    reader = csv.DictReader(io.StringIO(text))
    return list(parser(list(reader)))


def handler(event: dict, _context: Any | None = None) -> dict:
    """Lambda entrypoint for S3 ObjectCreated under ``imports/``."""
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
        # Only handle import objects — the receipt processor handles
        # everything under expenses/.
        if not key.startswith("imports/"):
            skipped += 1
            continue

        row = _find_import_by_s3_key(key)
        if row is None:
            skipped += 1
            continue
        import_id: UUID = row["id"]

        try:
            _mark_processing(import_id)
            obj = aws.s3().get_object(Bucket=bucket, Key=key)
            body = obj["Body"].read()
            text = _decode(body)
            transactions = parse_csv_text(row["institution"], text)

            inserted_n = 0
            skipped_n = 0
            for tx in transactions:
                if _insert_transaction(
                    account_id=row["account_id"],
                    import_id=import_id,
                    tx=tx,
                ):
                    inserted_n += 1
                else:
                    skipped_n += 1

            _mark_ready(
                import_id,
                row_count=len(transactions),
                imported=inserted_n,
                skipped=skipped_n,
            )
            processed += 1
        except Exception as exc:
            _mark_failed(import_id, f"{type(exc).__name__}: {exc}")
            failed += 1

    return {"processed": processed, "skipped": skipped, "failed": failed}
