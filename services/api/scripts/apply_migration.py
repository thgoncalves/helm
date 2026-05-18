"""Apply one or more Drizzle migration files to dev Aurora via the RDS Data API.

Generalised from the original ``apply_migration_0008.py``. Splits each
file on Drizzle's ``--> statement-breakpoint`` marker and executes the
statements against the cluster configured by ``HELM_DATABASE_*``.

Usage:
    cd services/api
    AWS_PROFILE=helm uv run python scripts/apply_migration.py 0012_ynab_accounts 0013_manual_accounts 0014_account_taxonomy

Pass either the migration tag (e.g. ``0012_ynab_accounts``) or the
full filename (``0012_ynab_accounts.sql``). They resolve to the same
file under ``db/migrations/``.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure ``app`` is importable when run directly from services/api/.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import db  # noqa: E402
from app.config import settings  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"


def resolve(tag: str) -> Path:
    """Return the migration file path for ``tag``.

    Accepts ``0012_ynab_accounts``, ``0012_ynab_accounts.sql``, or a
    full path. Errors loudly if the file is missing.
    """
    p = Path(tag)
    if p.is_file():
        return p
    if not tag.endswith(".sql"):
        tag = f"{tag}.sql"
    candidate = MIGRATIONS_DIR / tag
    if not candidate.exists():
        raise FileNotFoundError(f"Migration not found at {candidate}")
    return candidate


def apply_one(path: Path) -> None:
    sql = path.read_text(encoding="utf-8")
    parts = [
        p.strip()
        for p in sql.split("--> statement-breakpoint")
        if p.strip()
    ]
    print(f"\n=== {path.name}: {len(parts)} statement(s) ===")
    for i, stmt in enumerate(parts, 1):
        head = stmt.splitlines()[0][:80]
        print(f"  [{i}/{len(parts)}] {head}…")
        db.execute(stmt)


def main(argv: list[str]) -> int:
    if not argv:
        print(
            "Usage: apply_migration.py <tag-or-filename> [<tag-or-filename> …]",
            file=sys.stderr,
        )
        return 2

    if not settings.database_resource_arn or not settings.database_secret_arn:
        print(
            "HELM_DATABASE_RESOURCE_ARN / HELM_DATABASE_SECRET_ARN must be set.",
            file=sys.stderr,
        )
        return 2

    paths = [resolve(a) for a in argv]

    for path in paths:
        try:
            apply_one(path)
        except Exception as e:  # noqa: BLE001 — surface the error verbatim
            print(f"\nFAILED in {path.name}: {e}", file=sys.stderr)
            return 1

    print("\nAll migrations applied.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
