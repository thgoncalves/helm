# `db` — Postgres schema (source of truth)

Schema and migrations for Aurora Serverless v2 Postgres, defined in
**Drizzle ORM** (TypeScript).

## Why Drizzle

- Declarative schema in TS, in the same language as `apps/web`,
  `amplify/`, and `infra/`.
- Migrations generated from the schema and committed as SQL files.
- Works cleanly with the RDS Data API.

## Planned layout

```
db/
├── schema/             # Drizzle schema definitions (per feature)
│   ├── clients.ts
│   ├── invoices.ts
│   ├── time-entries.ts
│   ├── ...
│   └── index.ts        # re-exports
├── migrations/         # Generated SQL migration files
├── drizzle.config.ts
└── package.json
```

## Source-of-truth & FastAPI mirror

Drizzle owns the DDL. The FastAPI service in `services/api/` defines
**Pydantic models** in `services/api/app/models/` that mirror these
definitions. When the schema changes, update both.

## Migration from the legacy PyQt5 app

`old_database/*.csv` (gitignored) holds real data going back to 2022.
The one-shot import lives at `scripts/import-legacy.ts`. It preserves
UUIDs and invoice numbers verbatim and inserts in dependency order
(clients → invoices → invoice_line_items → payments_received →
time_entries → tax_ledger → tax_payments → invoice_tax_links → transfers
→ settings).

## Status

V1 schema defined in [`schema/`](./schema). See
[`../docs/data-model.md`](../docs/data-model.md) for the *why* (conventions,
delete semantics, migration plan, V2 placeholders). No migrations generated
yet — that's the next step:

```sh
pnpm install                              # workspace-wide
pnpm --filter @helm/db generate           # creates migrations/0000_initial.sql
pnpm --filter @helm/db push               # applies to $DATABASE_URL
```

The Pydantic models in `services/api/app/models/` will be hand-mirrored from
these definitions when we initialise the FastAPI service.
