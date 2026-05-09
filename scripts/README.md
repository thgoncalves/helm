# `scripts`

One-shot operational scripts.

| Script | Purpose |
|---|---|
| `gen-api-types.sh` | Run `openapi-typescript` against `services/api`'s exported OpenAPI to regenerate `packages/shared/api-types`. Run on every API change. |
| `import-legacy.ts` | One-shot import of the PyQt5 CSV data in `old_database/` into Postgres. Preserves UUIDs and invoice numbers. Runs first against dev Aurora, then prod after dev verifies clean. |

## Status

Folder reserved.
