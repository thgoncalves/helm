# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "boto3>=1.35",
# ]
# ///
"""One-shot import of legacy CSV data into Aurora via the RDS Data API.

V1 scope: ``clients``, ``invoices`` and ``invoice_line_items``. Other
entities (time_entries, payments_received, etc.) follow with their
respective feature branches because they reference each other and need
the schema-aware routers in place first.

Idempotent — uses ``ON CONFLICT (id) DO NOTHING`` so re-runs only insert
rows that aren't yet present. UUIDs and timestamps from the legacy CSV are
preserved exactly.

Required env vars:
    HELM_DATABASE_RESOURCE_ARN
    HELM_DATABASE_SECRET_ARN
    HELM_DATABASE_NAME (default: helm)

Run:
    AWS_PROFILE=helm uv run scripts/import_legacy.py
"""

from __future__ import annotations

import csv
import os
import sys
import time
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID

import boto3
from botocore.exceptions import ClientError

REPO_ROOT = Path(__file__).resolve().parent.parent
LEGACY_DIR = REPO_ROOT / "old_database"
CLIENTS_CSV = LEGACY_DIR / "clients.csv"
INVOICES_CSV = LEGACY_DIR / "invoices.csv"
INVOICE_LINE_ITEMS_CSV = LEGACY_DIR / "invoice_line_items.csv"
PAYMENTS_RECEIVED_CSV = LEGACY_DIR / "payments_received.csv"
TAX_LEDGER_CSV = LEGACY_DIR / "tax_ledger.csv"
TAX_PAYMENTS_CSV = LEGACY_DIR / "tax_payments.csv"
INVOICE_TAX_LINKS_CSV = LEGACY_DIR / "invoice_tax_links.csv"
TRANSFERS_CSV = LEGACY_DIR / "transfers.csv"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def require_env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        sys.exit(f"error: env var {name} is required")
    return val


def parse_optional_str(s: str) -> str | None:
    return s if s else None


def parse_optional_decimal(s: str) -> Decimal | None:
    return Decimal(s) if s else None


def parse_bool(s: str) -> bool:
    return s.strip().lower() in ("true", "1", "yes", "y")


def parse_iso_utc(s: str) -> datetime:
    """Parse a legacy ISO timestamp, treating naive values as UTC."""
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def parse_optional_date(s: str) -> date | None:
    return date.fromisoformat(s) if s else None


def parse_int(s: str) -> int:
    return int(s)


def to_param(name: str, value: Any) -> dict[str, Any]:
    """Mirror of ``app.db._to_param`` — Python value → Data API parameter."""
    if value is None:
        return {"name": name, "value": {"isNull": True}}
    if isinstance(value, bool):
        return {"name": name, "value": {"booleanValue": value}}
    # int must be checked BEFORE bool — but isinstance(True, int) is also True
    # so the bool check above handles that case first.
    if isinstance(value, int):
        return {"name": name, "value": {"longValue": value}}
    if isinstance(value, UUID):
        return {
            "name": name,
            "value": {"stringValue": str(value)},
            "typeHint": "UUID",
        }
    if isinstance(value, Decimal):
        return {
            "name": name,
            "value": {"stringValue": str(value)},
            "typeHint": "DECIMAL",
        }
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            value = value.astimezone(timezone.utc).replace(tzinfo=None)
        return {
            "name": name,
            "value": {
                "stringValue": value.isoformat(sep=" ", timespec="milliseconds")
            },
            "typeHint": "TIMESTAMP",
        }
    if isinstance(value, date):
        return {
            "name": name,
            "value": {"stringValue": value.isoformat()},
            "typeHint": "DATE",
        }
    if isinstance(value, str):
        return {"name": name, "value": {"stringValue": value}}
    raise TypeError(
        f"Unsupported parameter type for {name}: {type(value).__name__}"
    )


def warm_up(
    client: Any, *, resource_arn: str, secret_arn: str, database: str
) -> None:
    """Wake Aurora if paused; retry until ready or 30s elapses."""
    delay = 1.0
    deadline = time.monotonic() + 30.0
    while True:
        try:
            client.execute_statement(
                resourceArn=resource_arn,
                secretArn=secret_arn,
                database=database,
                sql="SELECT 1",
            )
            return
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code")
            if code == "DatabaseResumingException" and time.monotonic() < deadline:
                print(f"  Aurora resuming, retrying in {delay:.1f}s")
                time.sleep(delay)
                delay = min(delay * 2, 5.0)
                continue
            raise


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------


INSERT_SQL = """
INSERT INTO clients (
    id, name, email, phone, address_line1, address_line2,
    city, state, postal_code, country, tax_id, notes,
    is_active, hourly_rate, timesheet_frequency,
    created_at, updated_at
) VALUES (
    :id, :name, :email, :phone, :address_line1, :address_line2,
    :city, :state, :postal_code, :country, :tax_id, :notes,
    :is_active, :hourly_rate, :timesheet_frequency,
    :created_at, :updated_at
)
ON CONFLICT (id) DO NOTHING
""".strip()


def import_clients(
    client: Any, *, resource_arn: str, secret_arn: str, database: str
) -> tuple[int, int]:
    """Import clients.csv. Returns (inserted, skipped) counts."""
    inserted = 0
    skipped = 0
    with CLIENTS_CSV.open(newline="") as f:
        reader = csv.DictReader(f)
        for raw in reader:
            row = {
                "id": UUID(raw["id"]),
                "name": raw["name"],
                "email": parse_optional_str(raw["email"]),
                "phone": parse_optional_str(raw["phone"]),
                "address_line1": parse_optional_str(raw["address_line1"]),
                "address_line2": parse_optional_str(raw["address_line2"]),
                "city": parse_optional_str(raw["city"]),
                "state": parse_optional_str(raw["state"]),
                "postal_code": parse_optional_str(raw["postal_code"]),
                "country": parse_optional_str(raw["country"]),
                "tax_id": parse_optional_str(raw["tax_id"]),
                "notes": parse_optional_str(raw["notes"]),
                "is_active": parse_bool(raw["is_active"]),
                "hourly_rate": parse_optional_decimal(raw["hourly_rate"]),
                "timesheet_frequency": parse_optional_str(
                    raw["timesheet_frequency"]
                )
                or "monthly",
                "created_at": parse_iso_utc(raw["created_at"]),
                "updated_at": parse_iso_utc(raw["updated_at"]),
            }
            response = client.execute_statement(
                resourceArn=resource_arn,
                secretArn=secret_arn,
                database=database,
                sql=INSERT_SQL,
                parameters=[to_param(k, v) for k, v in row.items()],
            )
            if response.get("numberOfRecordsUpdated", 0) > 0:
                inserted += 1
                print(f"  inserted {row['name']:<10} {row['id']}")
            else:
                skipped += 1
                print(f"  skipped  {row['name']:<10} {row['id']} — already present")
    return inserted, skipped


INSERT_INVOICE_SQL = """
INSERT INTO invoices (
    id, invoice_number, issue_date, due_date, client_id,
    status, currency, subtotal, tax_amount, total,
    notes, payment_terms, attachments_path,
    created_at, updated_at
) VALUES (
    :id, :invoice_number, :issue_date, :due_date, :client_id,
    :status, :currency, :subtotal, :tax_amount, :total,
    :notes, :payment_terms, :attachments_path,
    :created_at, :updated_at
)
ON CONFLICT (id) DO NOTHING
""".strip()


INSERT_LINE_ITEM_SQL = """
INSERT INTO invoice_line_items (
    id, invoice_id, line_order, description,
    quantity, unit_price, tax_category,
    is_taxable, tax_rate,
    line_subtotal, line_tax, line_total
) VALUES (
    :id, :invoice_id, :line_order, :description,
    :quantity, :unit_price, :tax_category,
    :is_taxable, :tax_rate,
    :line_subtotal, :line_tax, :line_total
)
ON CONFLICT (id) DO NOTHING
""".strip()


def import_invoices(
    client: Any, *, resource_arn: str, secret_arn: str, database: str
) -> tuple[int, int]:
    """Import invoices.csv. Returns (inserted, skipped) counts.

    The legacy CSV has 3 ``invoice_number`` duplicates (two pairs of
    AUD EFT-references where the same number was reused a month later, and
    one exact double-row for ``202501-001``). Since the live schema enforces
    ``UNIQUE (invoice_number)``, second-and-later occurrences are renamed
    in-place with a ``-2`` / ``-3`` suffix so the row's data is still
    preserved.
    """
    inserted = 0
    skipped = 0
    seen_numbers: dict[str, int] = {}
    with INVOICES_CSV.open(newline="") as f:
        reader = csv.DictReader(f)
        for raw in reader:
            original_number = raw["invoice_number"]
            count = seen_numbers.get(original_number, 0) + 1
            seen_numbers[original_number] = count
            if count == 1:
                invoice_number = original_number
            else:
                invoice_number = f"{original_number}-{count}"
                print(
                    f"  ! renaming duplicate {original_number} → {invoice_number}"
                )
            row = {
                "id": UUID(raw["invoice_id"]),
                "invoice_number": invoice_number,
                "issue_date": parse_optional_date(raw["issue_date"]),
                "due_date": parse_optional_date(raw["due_date"]),
                "client_id": UUID(raw["client_id"]),
                "status": raw["status"] or "draft",
                "currency": raw["currency"] or "CAD",
                "subtotal": Decimal(raw["subtotal"]),
                "tax_amount": Decimal(raw["tax_amount"] or "0"),
                "total": Decimal(raw["total"]),
                "notes": parse_optional_str(raw["notes"]),
                "payment_terms": parse_optional_str(raw["payment_terms"]),
                "attachments_path": parse_optional_str(raw["attachments_path"]),
                "created_at": parse_iso_utc(raw["created_at"]),
                "updated_at": parse_iso_utc(raw["updated_at"]),
            }
            response = client.execute_statement(
                resourceArn=resource_arn,
                secretArn=secret_arn,
                database=database,
                sql=INSERT_INVOICE_SQL,
                parameters=[to_param(k, v) for k, v in row.items()],
            )
            if response.get("numberOfRecordsUpdated", 0) > 0:
                inserted += 1
            else:
                skipped += 1
    return inserted, skipped


INSERT_PAYMENT_SQL = """
INSERT INTO payments_received (
    id, invoice_id, payment_date, amount, payment_method, reference,
    notes, deduction_amount, deduction_description,
    created_at, updated_at
) VALUES (
    :id, :invoice_id, :payment_date, :amount, :payment_method, :reference,
    :notes, :deduction_amount, :deduction_description,
    :created_at, :updated_at
)
ON CONFLICT (id) DO NOTHING
""".strip()


def import_payments_received(
    client: Any, *, resource_arn: str, secret_arn: str, database: str
) -> tuple[int, int]:
    """Import payments_received.csv. Returns (inserted, skipped) counts.

    Convention shift: the legacy CSV stored ``amount`` as the **net**
    received (after the bank/client kept any deduction). The new schema
    treats ``amount`` as the **gross** (what the invoice was billed for)
    and ``deduction_amount`` as the part kept in transit, so
    ``net = amount - deduction_amount``. Each imported row is therefore
    re-keyed: ``amount := raw.amount + raw.deduction_amount``.
    """
    inserted = 0
    skipped = 0
    with PAYMENTS_RECEIVED_CSV.open(newline="") as f:
        reader = csv.DictReader(f)
        for raw in reader:
            net = Decimal(raw["amount"])
            deduction = Decimal(raw["deduction_amount"] or "0")
            gross = net + deduction
            row = {
                "id": UUID(raw["payment_id"]),
                "invoice_id": UUID(raw["invoice_id"]),
                "payment_date": parse_optional_date(raw["payment_date"]),
                "amount": gross,
                "payment_method": parse_optional_str(raw["payment_method"]),
                "reference": parse_optional_str(raw["reference"]),
                "notes": parse_optional_str(raw["notes"]),
                "deduction_amount": deduction,
                "deduction_description": parse_optional_str(
                    raw["deduction_description"]
                ),
                "created_at": parse_iso_utc(raw["created_at"]),
                "updated_at": parse_iso_utc(raw["updated_at"]),
            }
            response = client.execute_statement(
                resourceArn=resource_arn,
                secretArn=secret_arn,
                database=database,
                sql=INSERT_PAYMENT_SQL,
                parameters=[to_param(k, v) for k, v in row.items()],
            )
            if response.get("numberOfRecordsUpdated", 0) > 0:
                inserted += 1
            else:
                skipped += 1
    return inserted, skipped


INSERT_TAX_LEDGER_SQL = """
INSERT INTO tax_ledger (
    id, tax_type, tax_period, period_start, period_end,
    tax_rate, taxable_amount, tax_amount,
    paid_status, paid_date, paid_amount,
    payment_method, payment_reference, notes,
    created_at, updated_at
) VALUES (
    :id, :tax_type, :tax_period, :period_start, :period_end,
    :tax_rate, :taxable_amount, :tax_amount,
    :paid_status, :paid_date, :paid_amount,
    :payment_method, :payment_reference, :notes,
    :created_at, :updated_at
)
ON CONFLICT (id) DO NOTHING
""".strip()


def import_tax_ledger(
    client: Any, *, resource_arn: str, secret_arn: str, database: str
) -> tuple[int, int]:
    """Import tax_ledger.csv. Returns (inserted, skipped) counts.

    Needed for the FK constraint on ``tax_payments.tax_id`` and
    ``invoice_tax_links.tax_id``. No V1 UI surfaces it yet.
    """
    inserted = 0
    skipped = 0
    with TAX_LEDGER_CSV.open(newline="") as f:
        reader = csv.DictReader(f)
        for raw in reader:
            row = {
                "id": UUID(raw["tax_id"]),
                "tax_type": raw["tax_type"],
                "tax_period": raw["tax_period"],
                "period_start": parse_optional_date(raw["period_start"]),
                "period_end": parse_optional_date(raw["period_end"]),
                "tax_rate": Decimal(raw["tax_rate"]),
                "taxable_amount": Decimal(raw["taxable_amount"]),
                "tax_amount": Decimal(raw["tax_amount"]),
                "paid_status": raw["paid_status"] or "unpaid",
                "paid_date": parse_optional_date(raw["paid_date"]),
                "paid_amount": parse_optional_decimal(raw["paid_amount"])
                or Decimal(0),
                "payment_method": parse_optional_str(raw["payment_method"]),
                "payment_reference": parse_optional_str(raw["payment_reference"]),
                "notes": parse_optional_str(raw["notes"]),
                "created_at": parse_iso_utc(raw["created_at"]),
                "updated_at": parse_iso_utc(raw["updated_at"]),
            }
            response = client.execute_statement(
                resourceArn=resource_arn,
                secretArn=secret_arn,
                database=database,
                sql=INSERT_TAX_LEDGER_SQL,
                parameters=[to_param(k, v) for k, v in row.items()],
            )
            if response.get("numberOfRecordsUpdated", 0) > 0:
                inserted += 1
            else:
                skipped += 1
    return inserted, skipped


INSERT_TAX_PAYMENT_SQL = """
INSERT INTO tax_payments (
    id, tax_id, payment_date, amount, payment_method,
    payment_reference, fiscal_year, notes,
    created_at, updated_at
) VALUES (
    :id, :tax_id, :payment_date, :amount, :payment_method,
    :payment_reference, :fiscal_year, :notes,
    :created_at, :updated_at
)
ON CONFLICT (id) DO NOTHING
""".strip()


INSERT_INVOICE_TAX_LINK_SQL = """
INSERT INTO invoice_tax_links (
    id, invoice_id, tax_payment_id, tax_id, gst_amount, created_at
) VALUES (
    :id, :invoice_id, :tax_payment_id, :tax_id, :gst_amount, :created_at
)
ON CONFLICT (id) DO NOTHING
""".strip()


def import_tax_payments(
    client: Any, *, resource_arn: str, secret_arn: str, database: str
) -> tuple[int, int]:
    """Import tax_payments.csv. Returns (inserted, skipped) counts."""
    inserted = 0
    skipped = 0
    with TAX_PAYMENTS_CSV.open(newline="") as f:
        reader = csv.DictReader(f)
        for raw in reader:
            row = {
                "id": UUID(raw["payment_id"]),
                "tax_id": UUID(raw["tax_id"]) if raw["tax_id"] else None,
                "payment_date": parse_optional_date(raw["payment_date"]),
                "amount": Decimal(raw["amount"]),
                "payment_method": parse_optional_str(raw["payment_method"]),
                "payment_reference": parse_optional_str(raw["payment_reference"]),
                "fiscal_year": parse_optional_str(raw["fiscal_year"]),
                "notes": parse_optional_str(raw["notes"]),
                "created_at": parse_iso_utc(raw["created_at"]),
                "updated_at": parse_iso_utc(raw["updated_at"]),
            }
            response = client.execute_statement(
                resourceArn=resource_arn,
                secretArn=secret_arn,
                database=database,
                sql=INSERT_TAX_PAYMENT_SQL,
                parameters=[to_param(k, v) for k, v in row.items()],
            )
            if response.get("numberOfRecordsUpdated", 0) > 0:
                inserted += 1
            else:
                skipped += 1
    return inserted, skipped


def import_invoice_tax_links(
    client: Any, *, resource_arn: str, secret_arn: str, database: str
) -> tuple[int, int]:
    """Import invoice_tax_links.csv. Returns (inserted, skipped) counts."""
    inserted = 0
    skipped = 0
    with INVOICE_TAX_LINKS_CSV.open(newline="") as f:
        reader = csv.DictReader(f)
        for raw in reader:
            row = {
                "id": UUID(raw["link_id"]),
                "invoice_id": UUID(raw["invoice_id"]),
                "tax_payment_id": UUID(raw["tax_payment_id"]),
                "tax_id": UUID(raw["tax_id"]) if raw["tax_id"] else None,
                "gst_amount": Decimal(raw["gst_amount"]),
                "created_at": parse_iso_utc(raw["created_at"]),
            }
            response = client.execute_statement(
                resourceArn=resource_arn,
                secretArn=secret_arn,
                database=database,
                sql=INSERT_INVOICE_TAX_LINK_SQL,
                parameters=[to_param(k, v) for k, v in row.items()],
            )
            if response.get("numberOfRecordsUpdated", 0) > 0:
                inserted += 1
            else:
                skipped += 1
    return inserted, skipped


INSERT_TRANSFER_SQL = """
INSERT INTO transfers (
    id, transfer_date, amount, method, purpose, category,
    estimated_tax_company, estimated_tax_personal,
    actual_tax_paid_company, actual_tax_paid_personal,
    tax_ledger_link_company, tax_ledger_link_personal,
    notes, created_at, updated_at
) VALUES (
    :id, :transfer_date, :amount, :method, :purpose, :category,
    :estimated_tax_company, :estimated_tax_personal,
    :actual_tax_paid_company, :actual_tax_paid_personal,
    :tax_ledger_link_company, :tax_ledger_link_personal,
    :notes, :created_at, :updated_at
)
ON CONFLICT (id) DO NOTHING
""".strip()


def import_transfers(
    client: Any, *, resource_arn: str, secret_arn: str, database: str
) -> tuple[int, int]:
    """Import transfers.csv. Returns (inserted, skipped) counts."""
    inserted = 0
    skipped = 0
    with TRANSFERS_CSV.open(newline="") as f:
        reader = csv.DictReader(f)
        for raw in reader:
            row = {
                "id": UUID(raw["transfer_id"]),
                "transfer_date": parse_optional_date(raw["transfer_date"]),
                "amount": Decimal(raw["amount"]),
                "method": parse_optional_str(raw["method"]),
                "purpose": parse_optional_str(raw["purpose"]),
                "category": parse_optional_str(raw["category"]),
                "estimated_tax_company": parse_optional_decimal(
                    raw["estimated_tax_company"]
                ),
                "estimated_tax_personal": parse_optional_decimal(
                    raw["estimated_tax_personal"]
                ),
                "actual_tax_paid_company": parse_optional_decimal(
                    raw["actual_tax_paid_company"]
                ),
                "actual_tax_paid_personal": parse_optional_decimal(
                    raw["actual_tax_paid_personal"]
                ),
                "tax_ledger_link_company": (
                    UUID(raw["tax_ledger_link_company"])
                    if raw["tax_ledger_link_company"]
                    else None
                ),
                "tax_ledger_link_personal": (
                    UUID(raw["tax_ledger_link_personal"])
                    if raw["tax_ledger_link_personal"]
                    else None
                ),
                "notes": parse_optional_str(raw["notes"]),
                "created_at": parse_iso_utc(raw["created_at"]),
                "updated_at": parse_iso_utc(raw["updated_at"]),
            }
            response = client.execute_statement(
                resourceArn=resource_arn,
                secretArn=secret_arn,
                database=database,
                sql=INSERT_TRANSFER_SQL,
                parameters=[to_param(k, v) for k, v in row.items()],
            )
            if response.get("numberOfRecordsUpdated", 0) > 0:
                inserted += 1
            else:
                skipped += 1
    return inserted, skipped


def import_invoice_line_items(
    client: Any, *, resource_arn: str, secret_arn: str, database: str
) -> tuple[int, int]:
    """Import invoice_line_items.csv. Returns (inserted, skipped) counts."""
    inserted = 0
    skipped = 0
    with INVOICE_LINE_ITEMS_CSV.open(newline="") as f:
        reader = csv.DictReader(f)
        for raw in reader:
            row = {
                "id": UUID(raw["line_id"]),
                "invoice_id": UUID(raw["invoice_id"]),
                "line_order": parse_int(raw["line_order"]),
                "description": raw["description"],
                "quantity": Decimal(raw["quantity"]),
                "unit_price": Decimal(raw["unit_price"]),
                "tax_category": parse_optional_str(raw["tax_category"]),
                "is_taxable": parse_bool(raw["is_taxable"]),
                "tax_rate": parse_optional_decimal(raw["tax_rate"]),
                "line_subtotal": Decimal(raw["line_subtotal"]),
                "line_tax": Decimal(raw["line_tax"] or "0"),
                "line_total": Decimal(raw["line_total"]),
            }
            response = client.execute_statement(
                resourceArn=resource_arn,
                secretArn=secret_arn,
                database=database,
                sql=INSERT_LINE_ITEM_SQL,
                parameters=[to_param(k, v) for k, v in row.items()],
            )
            if response.get("numberOfRecordsUpdated", 0) > 0:
                inserted += 1
            else:
                skipped += 1
    return inserted, skipped


def main() -> int:
    if not CLIENTS_CSV.exists():
        sys.exit(f"error: {CLIENTS_CSV} not found")

    resource_arn = require_env("HELM_DATABASE_RESOURCE_ARN")
    secret_arn = require_env("HELM_DATABASE_SECRET_ARN")
    database = os.environ.get("HELM_DATABASE_NAME", "helm")

    rds = boto3.client("rds-data")
    print(f"→ warming up Aurora")
    warm_up(rds, resource_arn=resource_arn, secret_arn=secret_arn, database=database)

    print(f"→ importing {CLIENTS_CSV.relative_to(REPO_ROOT)}")
    inserted, skipped = import_clients(
        rds, resource_arn=resource_arn, secret_arn=secret_arn, database=database
    )
    print(f"✓ clients — {inserted} inserted, {skipped} skipped")

    if INVOICES_CSV.exists():
        print(f"→ importing {INVOICES_CSV.relative_to(REPO_ROOT)}")
        inserted, skipped = import_invoices(
            rds, resource_arn=resource_arn, secret_arn=secret_arn, database=database
        )
        print(f"✓ invoices — {inserted} inserted, {skipped} skipped")

    if INVOICE_LINE_ITEMS_CSV.exists():
        print(f"→ importing {INVOICE_LINE_ITEMS_CSV.relative_to(REPO_ROOT)}")
        inserted, skipped = import_invoice_line_items(
            rds, resource_arn=resource_arn, secret_arn=secret_arn, database=database
        )
        print(f"✓ invoice_line_items — {inserted} inserted, {skipped} skipped")

    if PAYMENTS_RECEIVED_CSV.exists():
        print(f"→ importing {PAYMENTS_RECEIVED_CSV.relative_to(REPO_ROOT)}")
        inserted, skipped = import_payments_received(
            rds, resource_arn=resource_arn, secret_arn=secret_arn, database=database
        )
        print(f"✓ payments_received — {inserted} inserted, {skipped} skipped")

    if TAX_LEDGER_CSV.exists():
        print(f"→ importing {TAX_LEDGER_CSV.relative_to(REPO_ROOT)}")
        inserted, skipped = import_tax_ledger(
            rds, resource_arn=resource_arn, secret_arn=secret_arn, database=database
        )
        print(f"✓ tax_ledger — {inserted} inserted, {skipped} skipped")

    if TAX_PAYMENTS_CSV.exists():
        print(f"→ importing {TAX_PAYMENTS_CSV.relative_to(REPO_ROOT)}")
        inserted, skipped = import_tax_payments(
            rds, resource_arn=resource_arn, secret_arn=secret_arn, database=database
        )
        print(f"✓ tax_payments — {inserted} inserted, {skipped} skipped")

    if INVOICE_TAX_LINKS_CSV.exists():
        print(f"→ importing {INVOICE_TAX_LINKS_CSV.relative_to(REPO_ROOT)}")
        inserted, skipped = import_invoice_tax_links(
            rds, resource_arn=resource_arn, secret_arn=secret_arn, database=database
        )
        print(f"✓ invoice_tax_links — {inserted} inserted, {skipped} skipped")

    if TRANSFERS_CSV.exists():
        print(f"→ importing {TRANSFERS_CSV.relative_to(REPO_ROOT)}")
        inserted, skipped = import_transfers(
            rds, resource_arn=resource_arn, secret_arn=secret_arn, database=database
        )
        print(f"✓ transfers — {inserted} inserted, {skipped} skipped")

    return 0


if __name__ == "__main__":
    sys.exit(main())
