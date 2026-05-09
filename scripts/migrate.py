# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "boto3>=1.35",
# ]
# ///
"""Apply Drizzle SQL migrations to Aurora via the RDS Data API.

Reads ``db/migrations/*.sql`` in lexicographic order, splits each file on
Drizzle's ``--> statement-breakpoint`` markers, and applies pending
migrations in a transaction. Applied filenames are tracked in a
``_migrations`` table created on first run.

Required env vars:
    HELM_DATABASE_RESOURCE_ARN  ARN of the Aurora cluster
    HELM_DATABASE_SECRET_ARN    ARN of the credentials secret
    HELM_DATABASE_NAME          Database name (default: helm)

Run with:
    AWS_PROFILE=helm uv run scripts/migrate.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import boto3

REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
STATEMENT_DELIMITER = "--> statement-breakpoint"

CREATE_MIGRATIONS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
""".strip()


def require_env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        sys.exit(f"error: env var {name} is required")
    return val


def split_statements(sql: str) -> list[str]:
    """Split a Drizzle migration file into individual SQL statements."""
    return [s.strip() for s in sql.split(STATEMENT_DELIMITER) if s.strip()]


def get_applied_migrations(
    client: Any, *, resource_arn: str, secret_arn: str, database: str
) -> set[str]:
    result = client.execute_statement(
        resourceArn=resource_arn,
        secretArn=secret_arn,
        database=database,
        sql="SELECT name FROM _migrations",
    )
    return {row[0]["stringValue"] for row in result.get("records", [])}


def apply_migration(
    client: Any,
    *,
    resource_arn: str,
    secret_arn: str,
    database: str,
    name: str,
    statements: list[str],
) -> None:
    """Apply all statements of one migration inside a single transaction."""
    txn = client.begin_transaction(
        resourceArn=resource_arn,
        secretArn=secret_arn,
        database=database,
    )
    txn_id = txn["transactionId"]
    try:
        for stmt in statements:
            client.execute_statement(
                resourceArn=resource_arn,
                secretArn=secret_arn,
                database=database,
                transactionId=txn_id,
                sql=stmt,
            )
        client.execute_statement(
            resourceArn=resource_arn,
            secretArn=secret_arn,
            database=database,
            transactionId=txn_id,
            sql="INSERT INTO _migrations (name) VALUES (:name)",
            parameters=[{"name": "name", "value": {"stringValue": name}}],
        )
        client.commit_transaction(
            resourceArn=resource_arn,
            secretArn=secret_arn,
            transactionId=txn_id,
        )
    except Exception:
        client.rollback_transaction(
            resourceArn=resource_arn,
            secretArn=secret_arn,
            transactionId=txn_id,
        )
        raise


def main() -> int:
    resource_arn = require_env("HELM_DATABASE_RESOURCE_ARN")
    secret_arn = require_env("HELM_DATABASE_SECRET_ARN")
    database = os.environ.get("HELM_DATABASE_NAME", "helm")

    client = boto3.client("rds-data")

    print("→ ensuring _migrations table exists")
    client.execute_statement(
        resourceArn=resource_arn,
        secretArn=secret_arn,
        database=database,
        sql=CREATE_MIGRATIONS_TABLE_SQL,
    )

    applied = get_applied_migrations(
        client,
        resource_arn=resource_arn,
        secret_arn=secret_arn,
        database=database,
    )
    print(f"→ {len(applied)} migration(s) already applied")

    pending_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    if not pending_files:
        sys.exit(f"error: no migrations found in {MIGRATIONS_DIR}")

    applied_count = 0
    for path in pending_files:
        if path.name in applied:
            print(f"  skip  {path.name}")
            continue

        statements = split_statements(path.read_text())
        print(f"  apply {path.name} ({len(statements)} statement(s))")
        apply_migration(
            client,
            resource_arn=resource_arn,
            secret_arn=secret_arn,
            database=database,
            name=path.name,
            statements=statements,
        )
        applied_count += 1

    print(f"✓ done — {applied_count} new migration(s) applied")
    return 0


if __name__ == "__main__":
    sys.exit(main())
