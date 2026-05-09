# `scripts`

One-shot operational scripts.

| Script | Purpose |
|---|---|
| `gen-api-types.sh` | Run `openapi-typescript` against `services/api`'s exported OpenAPI to regenerate `packages/shared/api-types`. Run on every API change. |
| `migrate.py` | Apply Drizzle SQL migrations from `db/migrations/` to Aurora via the RDS Data API. Idempotent — tracks applied files in a `_migrations` table. Run with `AWS_PROFILE=helm uv run scripts/migrate.py` after exporting `HELM_DATABASE_RESOURCE_ARN`, `HELM_DATABASE_SECRET_ARN`, and (optionally) `HELM_DATABASE_NAME`. |
| `import_legacy.py` | One-shot import of the PyQt5 CSV data in `old_database/` into Aurora via the RDS Data API. Preserves UUIDs and invoice numbers. Runs first against dev, then prod after dev verifies clean. |
