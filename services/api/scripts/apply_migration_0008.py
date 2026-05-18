"""One-shot: apply migration 0008 to dev Aurora via the RDS Data API.

Reads the SQL file at db/migrations/0008_drop_personal_and_add_ynab.sql,
splits on Drizzle's ``--> statement-breakpoint`` marker, and executes
each statement against the cluster configured by HELM_DATABASE_*.

Usage:
    cd services/api
    AWS_PROFILE=helm uv run python scripts/apply_migration_0008.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure ``app`` is importable when run directly from services/api/.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import db  # noqa: E402
from app.config import settings  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]
MIGRATION = (
    REPO_ROOT
    / "db"
    / "migrations"
    / "0008_drop_personal_and_add_ynab.sql"
)


def main() -> int:
    if not settings.database_resource_arn or not settings.database_secret_arn:
        print(
            "HELM_DATABASE_RESOURCE_ARN / HELM_DATABASE_SECRET_ARN must be set.",
            file=sys.stderr,
        )
        return 2

    if not MIGRATION.exists():
        print(f"Migration not found at {MIGRATION}", file=sys.stderr)
        return 2

    sql = MIGRATION.read_text(encoding="utf-8")
    # Drizzle's `--> statement-breakpoint` is a one-line marker between
    # individually-executable statements.
    parts = [
        p.strip()
        for p in sql.split("--> statement-breakpoint")
        if p.strip()
    ]
    print(f"Applying {len(parts)} statements from {MIGRATION.name}…")

    for i, stmt in enumerate(parts, 1):
        head = stmt.splitlines()[0][:80]
        print(f"  [{i}/{len(parts)}] {head}…")
        try:
            db.execute(stmt)
        except Exception as e:  # noqa: BLE001 — surface the error verbatim
            print(f"    FAILED: {e}", file=sys.stderr)
            return 1

    print("Migration 0008 applied.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
