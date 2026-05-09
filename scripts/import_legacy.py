# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "boto3>=1.35",
# ]
# ///
"""One-shot import of legacy CSV data into Aurora via the RDS Data API.

V1 scope: ``clients`` only. Other entities (invoices, time_entries, etc.)
are brought over with their respective feature branches because they
reference each other and need the schema-aware routers in place first.

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
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID

import boto3
from botocore.exceptions import ClientError

REPO_ROOT = Path(__file__).resolve().parent.parent
LEGACY_DIR = REPO_ROOT / "old_database"
CLIENTS_CSV = LEGACY_DIR / "clients.csv"


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


def to_param(name: str, value: Any) -> dict[str, Any]:
    """Mirror of ``app.db._to_param`` — Python value → Data API parameter."""
    if value is None:
        return {"name": name, "value": {"isNull": True}}
    if isinstance(value, bool):
        return {"name": name, "value": {"booleanValue": value}}
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
    print(f"✓ done — {inserted} inserted, {skipped} skipped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
