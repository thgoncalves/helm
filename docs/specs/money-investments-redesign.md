# Helm: Personal → Money + Investments redesign

## Context

The Business side of Helm (Dashboard, Clients, Timesheets, Invoices, Payments, Expenses, Taxes, Transfers, Settings) is working and stays untouched. The Personal side today is only V1 stubs — `personal_accounts`, `personal_imports`, `personal_transactions` driven by a CSV upload → S3 → Lambda processor pipeline. None of it carries data you want to keep, and the original V2 vision (budgeting + investments) was never built.

This plan wipes the Personal side cleanly and replaces it with **three peer modules** at the top of Helm:

- **Business** — unchanged
- **Money** — YNAB-driven macro expense dashboard + bill-over-budget alerts (V1 ship target)
- **Investments** — scaffolded route + nav only; full feature build is a follow-up phase

YNAB is the source of truth for personal cash flow. Helm reads it on demand via the YNAB API using a Personal Access Token stored in AWS Secrets Manager, caches recent state in Postgres, and never writes back. Investments will eventually cover Scotia iTrade, RRSP/TFSA, Brazil holdings in BRL with FX→CAD, and business holdings, with LLM-assisted research via the Claude API — but only the module shell ships in this phase.

Decisions locked with the user:
- 3 peer prefixes: `/business/*`, `/money/*`, `/investments/*`. Business stays at flat URLs; `/business` redirect already exists.
- YNAB API, on-demand only (no cron), single budget, no picker UI.
- Bill-over-budget = YNAB category where `activity > assigned` for the current month.
- PAT in AWS Secrets Manager, fetched at runtime by the FastAPI Lambda.
- Old Personal data is expendable — hard drop, no export.
- Investments: scaffold route + nav, no schema yet.
- Single user — no `user_id` columns needed.
- Types stay hand-written in `apps/web/src/types/api.ts` for this phase; generated-types tooling is a separate follow-up.

## Recommended approach

### 0. Spec + branch kickoff (run first, before any code edits)

1. Copy this plan into the repo as a versioned spec: `docs/specs/money-investments-redesign.md`. The `.claude/plans/` copy stays as the working scratchpad; the in-repo copy is the spec other contributors (and future me) can find.
2. Create and check out a feature branch off `dev`: `feat/money-investments-redesign`.
3. From here, work proceeds with file edits allowed. The user wants to spot-check progress in a running dev sandbox (frontend dev server + local API) before merge, and wants UI fidelity verified via a UX/UI review agent and Playwright after each visible screen lands.

### 1. Top-level shell

Generalize the current Personal/Business URL switcher in `apps/web/src/components/AppHeader.tsx` (`sideForPath` at ~line 105, `SideSwitcher` at ~line 209) from 2 sides to 3 modules. Add `MONEY_NAV` and `INVESTMENTS_NAV` arrays alongside the existing `BUSINESS_NAV` / `PERSONAL_NAV`. Widen the pill switcher to 3 segments.

Convert `apps/web/src/routes/AccountType.tsx` from a 2-position toggle into a 3-tile chooser ("Business / Money / Investments"). On submit, write the choice to `localStorage["helm:lastModule"]`. On mount, if a stored value exists, redirect immediately to that module's home. The header switcher writes the same key so deep-linked navigation stays sticky.

### 2. YNAB integration

**Settings UI** — add a `ynab` section to `apps/web/src/routes/Settings.tsx` (follows the documented sidebar+scroll-spy pattern in `docs/settings-page-pattern.md`): password-masked PAT input, "Test connection" button, last-synced line, "Refresh now" button. This section talks to new endpoints under `/money/integrations/ynab/*` — NOT through the existing business settings PUT. The PAT never lands in the `settings` table.

**Secret + IaC** — in `infra/lib/api-stack.ts`, create `new secretsmanager.Secret(this, 'YnabPat', { secretName: 'helm/{env}/ynab/personal-access-token' })`. Grant `secretsmanager:GetSecretValue` and `PutSecretValue` to the API Lambda role only (not processor Lambdas). Pass `HELM_YNAB_SECRET_ARN` as a Lambda env var.

**FastAPI plumbing**
- `services/api/app/ynab/client.py` — thin httpx client, bearer auth, base URL `https://api.ynab.com/v1`, exponential backoff on 429 respecting `X-Rate-Limit` headers.
- `services/api/app/deps.py` — add `get_ynab_client()` dependency. Token loaded once per warm Lambda container via module-level cache; invalidated when `PUT /money/integrations/ynab/token` runs.
- Error mapping: YNAB 401 → `HTTPException(502, {"code":"YNAB_AUTH"})`; 429 → `HTTPException(503, {"code":"YNAB_RATE_LIMIT", retry_after})`. Frontend surfaces both as banners on the dashboard.

**Caching in Postgres.** Each dashboard load must not hit YNAB (200 req/hr cap). Refresh-on-demand fills these tables:

- `ynab_budgets` — id (YNAB UUID PK), name, last_modified_on, is_active boolean (exactly one row true)
- `ynab_categories` — budget_id, category_id (PK), group_name, name, hidden, last_synced_at
- `ynab_month_categories` — (budget_id, month, category_id) composite PK; assigned, activity, balance, last_synced_at
- `ynab_transactions` — id (YNAB UUID PK), budget_id, account_id, date, amount, payee_name, category_id, memo, cleared, approved, last_synced_at. Pulls a rolling N days on refresh.

**Endpoints (all `/money/*`)**
- `GET  /money/integrations/ynab/status` — token present? last sync? active budget name?
- `PUT  /money/integrations/ynab/token` — writes Secret, then runs a first-time sync (single budget auto-selected, marked is_active=true).
- `POST /money/ynab/refresh` — upserts categories + current month + recent transactions; returns counters.
- `GET  /money/dashboard` — single-shot mirroring `apps/web/src/routes/Dashboard.tsx`'s payload shape. Pure DB read against the cache tables.

### 3. Money dashboard

Top bar: "Last synced … · Refresh" calling `POST /money/ynab/refresh` then invalidating `["money-dashboard"]` React Query key.

KPI cards (reuse the layout from `apps/web/src/routes/Dashboard.tsx` ~lines 281–305): **Spent this month**, **Income this month**, **Net**, **Categories over budget (count)**.

Charts using Recharts + existing theme tokens:
- Spending by category group — horizontal bar, top 8
- Daily cumulative spend vs daily-budget line — area + line, shows pacing
- Trailing-3-month spend by group — grouped bars

**Bill-over-budget widget.** A card listing YNAB categories where `activity > assigned` for the current month, sorted by overage DESC. Per row: category name, assigned, activity, overage (red), % over. Empty state: "All categories on budget." Pulls from `ynab_month_categories` JOIN `ynab_categories`.

### 4. Destructive migration sequence

Order matters — drop dead UI first so removed backend endpoints can't 404 a live page.

1. Remove Personal frontend routes + components from `apps/web/src/App.tsx`; delete the route files.
2. Drop FastAPI routers and remove their `include_router` calls in `services/api/app/main.py`.
3. Delete S3 CSV processor: in `infra/lib/api-stack.ts` remove `csvProcessorFn`, its log group, and the `imports/`-prefix S3 notification (keep the `expenses/` Textract pipeline — that's Business). Delete `services/api/app/handlers/process_csv.py`.
4. Delete Pydantic models for Personal.
5. New Drizzle migration `db/migrations/0008_drop_personal_and_add_money.sql`: `DROP TABLE personal_transactions; DROP TABLE personal_imports; DROP TABLE personal_accounts;` then `CREATE TABLE ynab_budgets / ynab_categories / ynab_month_categories / ynab_transactions`. Also delete the Drizzle source files for the dropped tables and add `db/schema/ynab.ts`.
6. After deploy, the orphaned `imports/` keys in `helm-receipts-{env}` need a manual S3 sweep — CDK only removes the notification, not the objects. Note this in the PR.
7. `cdk deploy` — remember `-c userPoolClientId=<id>` (per memory: forgetting it 401s every authenticated route).

### 5. Investments scaffold

- New route `apps/web/src/routes/InvestmentsHome.tsx` — placeholder page listing the eventual scope (Scotia iTrade, RRSP/TFSA, Brazil/BRL with FX, Business holdings, LLM-assisted research, rebalance suggestions). No data, no charts.
- New `services/api/app/routers/investments.py` — stub router declaring the `/investments` prefix, single endpoint returning 501.
- Header switcher includes the Investments segment; `INVESTMENTS_NAV` has one item ("Overview") pointing at the placeholder.
- **No DB tables, no Pydantic models** in this phase.

## Critical files

**Add**
- `apps/web/src/routes/MoneyDashboard.tsx`
- `apps/web/src/routes/InvestmentsHome.tsx`
- `apps/web/src/components/ModuleChooser.tsx` (replaces `AccountTypeToggle.tsx`)
- `services/api/app/routers/money_dashboard.py`
- `services/api/app/routers/money_ynab.py`
- `services/api/app/routers/investments.py`
- `services/api/app/ynab/__init__.py`, `services/api/app/ynab/client.py`, `services/api/app/ynab/sync.py`
- `services/api/app/models/ynab.py`
- `db/schema/ynab.ts`
- `db/migrations/0008_drop_personal_and_add_money.sql`
- `docs/ynab-integration.md` (token rotation runbook, rate-limit notes)

**Change**
- `apps/web/src/App.tsx` — remove personal routes; add `/money/dashboard`, `/investments`; legacy `/personal/*` redirects to `/money/dashboard`; `/account-type` renders `ModuleChooser`.
- `apps/web/src/components/AppHeader.tsx` — generalize `Side`→`Module`, widen switcher to 3 segments, add `MONEY_NAV` + `INVESTMENTS_NAV`, update `sideForPath` and `HOME` map.
- `apps/web/src/routes/Settings.tsx` — add `ynab` section wired to `/money/integrations/ynab/*`.
- `apps/web/src/routes/AccountType.tsx` — convert to 3-tile chooser with `localStorage` fast-path.
- `apps/web/src/types/api.ts` — append `YnabStatus`, `MoneyDashboardResponse`, `MoneyCategoryOverage`.
- `services/api/app/main.py` — drop 3 personal `include_router` calls; add `money_dashboard`, `money_ynab`, `investments`.
- `infra/lib/api-stack.ts` — add `YnabPat` Secret + grants + Lambda env var; delete CSV processor Lambda + log group + S3 `imports/` notification.
- `db/schema/index.ts` — remove personal exports, add `./ynab`.

**Delete**
- `apps/web/src/routes/Personal.tsx`, `PersonalAccounts.tsx`, `PersonalImports.tsx`, `PersonalTransactions.tsx`
- `apps/web/src/components/AccountTypeToggle.tsx`
- `services/api/app/routers/personal_accounts.py`, `personal_imports.py`, `personal_transactions.py`
- `services/api/app/models/personal_accounts.py`, `personal_imports.py`, `personal_transactions.py`
- `services/api/app/handlers/process_csv.py`
- `db/schema/accounts.ts`, `personal-imports.ts`, `personal-transactions.ts`

## Existing patterns to reuse

- **Settings sidebar+scroll-spy**: `apps/web/src/routes/Settings.tsx` (`SECTIONS` array drives both nav and search; per-section dirty flags + Save).
- **Dashboard layout**: `apps/web/src/routes/Dashboard.tsx` — single GET returns full payload; KPI grid + Recharts + tooltip helpers.
- **Module/side switching in header**: `AppHeader.tsx` `sideForPath`, `SideSwitcher`, `SideButton`.
- **Pacing math** (for the daily-budget line in the spending pacing chart): `packages/pacing/` shared module (per recent commits `f29c997` / `ee7c583`).
- **Secrets Manager + Lambda env wiring**: existing pattern in `infra/lib/api-stack.ts` for the DB cluster secret.

## Verification

0. **Sandbox for live review** — `pnpm --filter @helm/web dev` for the frontend; `cd services/api && uv run uvicorn app.main:app --reload` (or the project's standard local-API command) for the backend. Share the local URL with the user for each visible milestone (ModuleChooser, Settings YNAB section, Money dashboard, Investments placeholder).
0a. **UI review** — after each visible screen lands, launch a UX/UI review agent against the running sandbox to flag styling/IA issues against `docs/settings-page-pattern.md` and the existing Business Dashboard look-and-feel.
0b. **Playwright** — add Playwright smoke tests in `apps/web/e2e/` (or wherever the project keeps e2e) for the critical journeys: signin → ModuleChooser → Money dashboard renders with cache data; Settings YNAB section accepts a token and reflects "Connected"; Investments placeholder loads.

1. **Local typecheck + lint** — `pnpm -w typecheck && pnpm -w lint` after frontend edits; `uv run ruff check` (or current Python linter) in `services/api`.
2. **DB migration dry-run** — apply `0008` against a scratch DB; verify the three personal tables are gone, four `ynab_*` tables exist, and Drizzle introspection matches `db/schema/ynab.ts`.
3. **Backend unit** — pytest hits `GET /money/dashboard` with seeded YNAB cache rows; assert KPI math and over-budget sorting. Mock the YNAB client at `services/api/app/ynab/client.py` for refresh tests.
4. **CDK synth** — `cd infra && pnpm cdk synth` to confirm `YnabPat` secret + grants are present and CSV-processor resources are removed. Don't deploy yet.
5. **Dev deploy** — `pnpm cdk deploy -c userPoolClientId=<dev id>` (memory: missing this flag → silent 401s).
6. **End-to-end smoke in dev Amplify URL**:
   - Sign in → `ModuleChooser` shows three tiles (first run).
   - Settings → YNAB section: paste PAT → "Test connection" returns 200 → backend pulls budget + categories.
   - Money → Dashboard renders KPI cards and bill-over-budget widget. Trigger an over-budget category in YNAB; click Refresh in Helm; verify it appears in red.
   - Investments → placeholder page renders; switcher pill highlights correctly.
   - Old `/personal/accounts` URL → redirects to `/money/dashboard`.
7. **Network sanity** — DevTools confirms no 4xx on YNAB endpoints; the dashboard GET is fast (DB-only, no YNAB call); Refresh is the only call that hits YNAB.
8. **Secret rotation** — paste a wrong PAT → UI shows the "token rejected — re-enter" banner from the mapped 502.
