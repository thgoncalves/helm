# Helm

Personal & business financial hub. Replaces a long-running PyQt5 desktop
app; brings invoicing, timesheets, taxes, transfers, and (V2) personal
budgeting into one hosted, multi-device app on AWS.

- [`docs/vision.md`](./docs/vision.md) — what Helm is and the feature list
- [`docs/architecture.md`](./docs/architecture.md) — V1 architecture and the rationale
- [`docs/decisions/`](./docs/decisions/) — ADRs for later changes

## Layout

| Path | What's there |
|---|---|
| `apps/web/` | Vite + React + TypeScript frontend (PWA), deployed via Amplify Hosting |
| `services/api/` | FastAPI backend, deployed to Lambda via Mangum |
| `packages/shared/` | TypeScript types generated from the FastAPI OpenAPI |
| `db/` | Drizzle schema + migrations (source of truth for Postgres) |
| `amplify/` | Amplify Gen 2 backend (Cognito, S3, Hosting) |
| `infra/` | CDK stacks (API Gateway, Lambda, Aurora Serverless v2) |
| `scripts/` | One-shot scripts (legacy CSV import, OpenAPI → TS codegen) |
| `docs/` | Vision, architecture, ADRs |
| `old_database/` | Legacy PyQt5 CSV data — **gitignored, local-only** |

## Branches

- `main` → prod environment
- `dev` → dev environment

Both deploy automatically via Amplify branch deploys.

## Status

In progress. Architecture approved (2026-05-08); folders scaffolded; V1
Postgres schema defined in Drizzle; FastAPI service skeleton with Pydantic
mirror (32/32 passing); Amplify Gen 2 backend deployed to `main` and `dev`
in `326543321262 / ca-central-1` (Cognito + receipts/documents S3); `infra/`
CDK stacks deployed to `main` (Aurora Serverless v2 + API Gateway HTTP API
+ FastAPI Lambda); `apps/web` initialised (Vite + React + TS + Tailwind v4
+ shadcn-equivalent components + aws-amplify v6 sign-in + protected
`/clients` route, 15/15 tests passing). Next: generate the first Drizzle
migration and apply it via the Data API; write the FastAPI `app/db.py` so
`/business/clients` returns real data; write `scripts/import-legacy.ts`
and run against `main` Aurora; deploy `infra/` to `dev`.

## Tooling expectations (when we start coding)

- Node ≥ 20, pnpm ≥ 9
- Python ≥ 3.12, [`uv`](https://github.com/astral-sh/uv) for `services/api/`
- AWS CLI configured for the deploy account
- Docker (for the FastAPI Lambda container image)
