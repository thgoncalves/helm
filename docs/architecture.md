# Helm — Architecture Proposal

> Status: **approved 2026-05-08**. See "Decisions locked" near the bottom.
> Scope: V1 deployable architecture. Future-only concerns are flagged.

## TL;DR

| Layer | Choice |
|---|---|
| **Frontend** | Vite + React + TypeScript, PWA-enabled, hosted by Amplify Hosting |
| **Auth** | Cognito User Pool (email/password to start) |
| **API** | API Gateway HTTP API → Lambda (Python, FastAPI via Mangum) — Cognito JWT authoriser |
| **Database** | Aurora Serverless v2 PostgreSQL with **RDS Data API** (no VPC needed from Lambda) |
| **ORM / migrations** | Drizzle |
| **Storage** | S3 buckets (receipts, generated documents) |
| **IaC** | Amplify Gen 2 backend (TypeScript, CDK underneath) + CDK escape hatches |
| **Branches** | `main` → prod env, `dev` → dev env (Amplify Gen 2 branch deploys) |
| **Domain** | Route 53 + ACM cert wired to Amplify Hosting (deferred) |

## Goals & constraints

- TypeScript everywhere it's a sensible choice.
- Amplify for deployment ergonomics; CDK for control where needed.
- Cognito for auth.
- S3 for media.
- `main`/`dev` branch-based environments.
- Custom domain (later).
- Open at the start of the project: API layer, frontend framework, database.

This document closes those open questions with rationale and alternatives.

## Component decisions

### Frontend — Vite + React + TypeScript, PWA-enabled

**Choice:** Single-page React app built with Vite, deployed via Amplify
Hosting. PWA manifest + service worker so it installs on iPhone home screen.
Camera capture for receipts uses
`<input type="file" accept="image/*" capture="environment">` — supported in
iOS Safari for V1.

**Stack:**

- **Vite** — dev server + bundler.
- **TypeScript** — strict mode.
- **Tailwind CSS** + **shadcn/ui** — visual layer.
- **TanStack Query** — server state.
- **React Hook Form + Zod** — forms with shared validation schemas.
- **TanStack Router** or **React Router** — routing (TBD; minor).
- **Recharts** — dashboards.
- **Amplify JS (`@aws-amplify/auth`, `@aws-amplify/storage`)** — auth + S3 uploads.

**Why not React Native / Expo from day 1?** The only native-feeling
requirement is camera access, which iOS Safari already supports for V1. RN
adds a meaningful build/maintenance burden for one feature. If/when we need
background sync, deep camera control, or push notifications, we wrap the same
React app in **Capacitor** — one codebase, native shell.

**Why not Vue?** No technical blocker, but the React/AWS/shadcn ecosystem is
denser, and you've signalled openness to React. Defaulting there.

### Auth — Cognito User Pool

**Choice:** Cognito User Pool, email + password sign-in, defined in Amplify
Gen 2's `amplify/auth`.

- Frontend uses Amplify JS for sign-in/up flows.
- API Gateway HTTP API uses a **Cognito JWT authoriser** — no token
  validation code in our Lambdas; user identity comes from JWT claims.
- Federation (Google, Apple) can be added later by extending the user pool.

### API — API Gateway HTTP API + FastAPI on Lambda

**Choice:** REST over HTTP API with a Python Lambda running **FastAPI** via
**Mangum**. Cognito JWT authoriser sits in front; FastAPI reads identity
from validated JWT claims.

**Trade-off chosen:** FastAPI familiarity + Pydantic + auto-generated
OpenAPI > end-to-end types in a single language. The Hono/TS alternative was
the recommendation for type unification; we accepted the costs below in
exchange for a faster start in a known stack.

**Implications of choosing FastAPI:**

- **Two languages** in the repo. TS for `apps/web`, `db` (Drizzle), and
  `amplify/`; Python for `services/api/`. Cross-boundary refactors cost
  more.
- **Type sharing requires codegen.** `services/api/` exports `openapi.json`;
  `scripts/gen-api-types.sh` runs `openapi-typescript` to produce TS types
  in `packages/shared/api-types/`. Generated output is committed.
  Discipline: regenerate on every API change.
- **Schema duplication.** Drizzle (TS) is the source of truth for DDL;
  Pydantic models in `services/api/app/models/` mirror it. Drift is the
  main maintenance risk.
- **Cold starts ~600-1000 ms** with Python + Mangum. Mitigate with
  provisioned concurrency on prod once usage justifies it.
- **Lambda packaging:** container image (Dockerfile in `services/api/`) is
  cleaner than zip for FastAPI's deps. Built and pushed to ECR by CI.

**Why not Amplify Data (AppSync GraphQL)?** Amplify Data is built around
DynamoDB. Because we're choosing Postgres, we'd be writing custom Lambda
resolvers anyway — AppSync would add a layer (GraphQL schema, resolver
wiring) without adding value. Going straight to API Gateway + FastAPI is
simpler.

**Endpoints organised by router:**

```
/personal/budgets
/personal/transactions
/personal/investments
/business/timesheets
/business/invoices
/business/payments
/business/taxes
/business/transfers
/business/clients
/business/receipts
/settings
```

Each feature is a FastAPI router under `services/api/app/routers/`. Single
Lambda for V1; split later only if cold-start or IAM blast radius demands
it.

### Database — Aurora Serverless v2 Postgres + Data API

**Choice:** Aurora Serverless v2 with the **RDS Data API** enabled. Two
clusters: `helm-prod` and `helm-dev`. ORM and migrations via **Drizzle**.

**Why Postgres? (now decided, not open)** The legacy PyQt5 app's CSV
"database" in `old_database/` is already a textbook relational schema:

- `invoices` ← `invoice_line_items` (1:N)
- `invoices` ↔ `tax_payments` via `invoice_tax_links` (M:N join table)
- `time_entries` → `clients`, with optional `invoice_id` linking back once
  invoiced
- `transfers` references both `tax_ledger_link_company` and
  `tax_ledger_link_personal` — cross-domain FKs
- Aggregations everywhere: "GST owed by period", "hours per client per
  month", "AR aging", "cashflow by category"

Re-implementing this on DynamoDB would mean denormalising everything and
maintaining handwritten materialised views. SQL is the only sensible fit.

**Why Aurora Serverless v2 specifically?**

- **Data API** = HTTP-based access. Lambda needs no VPC, no NAT, no
  connection pool. This historically was the painful part of Lambda + RDS.
- **Scale-to-zero** (released 2024-Nov) — when idle, ACU drops to 0; you pay
  only for storage. Critical for a single-user app that's idle most of the
  day.

**Schema lives in `db/schema/*.ts` (Drizzle).** Migrations generated from
the schema and committed to the repo. Apply on deploy via a Lambda or CodeBuild
step.

**Hybrid alternative considered & rejected:** Postgres for ledger-shaped data
+ DynamoDB for low-relational data (clients, settings). Adds two mental
models for marginal cost savings. One DB is simpler.

### Storage — S3

Two buckets per environment, defined in Amplify Gen 2 storage:

- `helm-receipts-{env}` — receipt images, private per user (path:
  `private/{cognito-sub}/...`).
- `helm-documents-{env}` — generated PDFs (timesheets, invoices),
  CSV imports staged for processing.

Frontend uploads directly to S3 using Cognito-issued credentials (Amplify
Storage). We do not round-trip image bytes through Lambda.

### IaC — Amplify Gen 2 backend + CDK escape hatches

**Choice:** Amplify Gen 2 (`@aws-amplify/backend`). The whole backend is
defined in TypeScript:

```ts
// amplify/backend.ts
import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { storage } from './storage/resource';
import { api } from './api/resource';   // custom CDK construct

defineBackend({ auth, storage, api });
```

Amplify Gen 2 is CDK underneath, so:

- Auth + Storage + Hosting are first-class Amplify resources.
- API Gateway, Lambda, Aurora cluster, RDS Data API, IAM are added via the
  **CDK escape hatch** — same stack, same deploy.

This satisfies "Amplify for ease" + "CDK for control" without operating two
separate stacks.

### Branching & environments

Amplify Gen 2 deploys per branch automatically:

- `main` branch → `helm-prod` stack.
- `dev` branch → `helm-dev` stack.

Each environment gets its own Cognito pool, S3 buckets, Aurora cluster, and
API Gateway.

**Local development** uses `npx ampx sandbox` — provisions a personal AWS
sandbox tied to your IAM identity, hot-reloads on backend changes.

### Domain (deferred)

Later: Route 53 hosted zone + ACM cert (us-east-1 for CloudFront-fronted
Amplify Hosting). Suggested:

- `helm.<your-domain>` → prod (`main`)
- `dev.helm.<your-domain>` → dev (`dev`)

## Repo layout

Monorepo, **pnpm workspaces**:

```
helm/
├── apps/
│   └── web/                    # Vite + React + TS frontend (PWA)
├── services/
│   └── api/                    # FastAPI backend (Python)
│       ├── app/
│       │   ├── routers/        #   Per-feature FastAPI routers
│       │   ├── models/         #   Pydantic models (mirror Drizzle)
│       │   ├── db.py           #   asyncpg / RDS Data API client
│       │   ├── deps.py         #   Auth + db dependencies
│       │   └── main.py         #   FastAPI app + Mangum handler
│       ├── tests/
│       ├── pyproject.toml      #   Managed with uv
│       └── Dockerfile          #   Lambda container image
├── packages/
│   └── shared/
│       └── api-types/          # GENERATED from openapi.json (committed)
├── amplify/                    # Amplify Gen 2 (auth, storage, hosting)
│   ├── auth/                   #   Cognito User Pool
│   ├── storage/                #   S3 buckets
│   └── backend.ts
├── infra/                      # CDK: API Gateway + Lambda(FastAPI) + Aurora
│   ├── bin/
│   ├── lib/
│   │   ├── api-stack.ts
│   │   ├── db-stack.ts
│   │   └── shared-stack.ts
│   └── cdk.json
├── db/                         # Drizzle schema + migrations (TS, source of truth)
│   ├── schema/
│   └── migrations/
├── scripts/
│   ├── gen-api-types.sh        # openapi.json → packages/shared/api-types
│   └── import-legacy.ts        # CSV → Postgres one-shot migration
├── docs/
│   ├── vision.md
│   ├── architecture.md
│   └── decisions/              # ADRs as decisions accumulate
├── old_database/               # Legacy CSV data (gitignored)
├── .github/workflows/          # CI: lint, typecheck, test, deploy
├── package.json                # pnpm workspace root
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## Cross-cutting concerns

| Concern | Approach |
|---|---|
| **PDF generation** | `@react-pdf/renderer` in a Lambda. Declarative, TS-friendly. |
| **CSV import** | Upload to S3 → S3 trigger Lambda → PapaParse → insert into Postgres. |
| **Receipt OCR (V2)** | AWS Textract `AnalyzeExpense` for structured extraction. Alternative: Claude Vision API for richer extraction. V1 = image + manual fields. |
| **Validation** | Pydantic models in `services/api/app/models/` (server). React Hook Form + lightweight TS validators (or Zod) in `apps/web` (client). Generated TS types in `packages/shared/api-types/` keep request/response shapes aligned. |
| **Logging / observability** | Lambda → CloudWatch Logs. AWS Lambda Powertools (TS). Alarms come later. |
| **Secrets** | AWS Secrets Manager (Aurora credentials) + SSM Parameter Store (config). |
| **CI/CD** | Amplify Hosting auto-deploys on push to `main` / `dev`. GitHub Actions for lint/typecheck/test pre-merge. |

## Cost estimate (single-user idle workload)

| Service | Estimated monthly |
|---|---|
| Amplify Hosting (2 branches) | ~$1 |
| Cognito | $0 (well under 50k MAU free tier) |
| API Gateway HTTP API | ~$0 (free tier) |
| Lambda | ~$0 (free tier) |
| Aurora Serverless v2, idle most of the day, scale-to-zero | ~$5–15 per env |
| S3 + Data API requests | a few cents |
| Route 53 (when domain added) | $0.50 / hosted zone |
| **Total (both envs)** | **~$15–35 / month** |

If Aurora cost becomes a concern with two always-on clusters, options
include consolidating into a single cluster with `helm_dev` + `helm_prod`
databases, or pausing the dev cluster outside work hours.

## Data migration from the legacy PyQt5 app

`old_database/` contains the V1 source-of-truth: 9 CSV tables with real data
back to 2022. Migration plan:

1. Stand up the Postgres schema in **dev** first (Drizzle migrations).
2. Write a one-shot Node/TS importer (`scripts/import-legacy.ts`) that:
   - Reads each CSV via PapaParse.
   - Inserts in dependency order: `clients` → `invoices` → `invoice_line_items`
     → `payments_received` → `time_entries` → `tax_ledger` → `tax_payments`
     → `invoice_tax_links` → `transfers` → `settings`.
   - **Preserves UUIDs and invoice numbers verbatim** — these are foreign
     keys in `invoice_tax_links`, `transfers`, etc.
   - Validates row counts and FK integrity post-import.
3. Run on dev. Sanity-check dashboards. Iterate.
4. Run on prod once dev verifies clean.

Schema deltas from the legacy CSVs to V1:

- **`time_entries.description`** — drop. You don't need it.
- **`tax_ledger`** historical rows reference Australian GST (10%, "ATO").
  Schema is rate-agnostic, so they import as-is.
- **New tables for V2:** `users` (Cognito sub mapping), `categories`,
  `transactions` (Personal bank-imported), `budgets`, `holdings`,
  `holding_transactions`, `receipts`, `csv_imports` (audit).
- **Account discriminator** — every business/personal-scoped table gets an
  `account_kind` column (`'business' | 'personal'`) or we use Postgres
  schemas. TBD during data-model design.

A separate `docs/data-model.md` will document the full V1 schema once
architecture is approved.

## Decisions locked (2026-05-08)

| Decision | Choice | Notes |
|---|---|---|
| Database | Aurora Serverless v2 Postgres + RDS Data API | Driven by the legacy schema's relational shape. |
| API style | REST via API Gateway HTTP API | Not GraphQL. |
| Backend language | Python (FastAPI on Lambda via Mangum) | Trade-off: familiarity + Pydantic + free OpenAPI > end-to-end TS types. |
| Frontend | Vite + React + TS, PWA-enabled | Capacitor wrapper later if needed. |
| IaC | Amplify Gen 2 (auth/storage/hosting) + CDK (api/db) | Both deploy to the same accounts. |
| Branches | `main` → prod, `dev` → dev | Amplify Gen 2 branch deploys. |
| Legacy data | `old_database/` gitignored, kept locally | Source for the one-shot import. |

## Next steps

1. Scaffold the monorepo (folders + minimal config). **← this turn**
2. Initialise `apps/web/` with Vite + React + TS + Tailwind + shadcn/ui.
3. Initialise `services/api/` with FastAPI + uv + Mangum. *(done 2026-05-08)*
4. Define the V1 Postgres schema in Drizzle, generate first migration.
5. Stand up `amplify/` (auth + storage + hosting wiring).
6. Stand up `infra/` (API Gateway + Lambda + Aurora).
7. Wire `scripts/gen-api-types.sh` to regenerate `packages/shared/api-types`.
8. Write `scripts/import-legacy.ts` and run against dev Aurora.
9. Verify dashboards against historical data on dev.
10. Cut prod environment from `main`.

Once these are locked, the next step is to scaffold the monorepo (folders,
`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, README files
inside each major folder) — no app code yet, just the structure.
