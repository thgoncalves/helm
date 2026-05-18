# Helm: Accounts management — unified page (V1)

## Context

Today, Helm has three different things that could be called "an account" and they live in three different places:

- **YNAB accounts** — referenced as `account_id` strings on `ynab_transactions`, but never cached as first-class rows. We don't pull `/accounts` from YNAB at all yet. They're the source of truth for Canadian cash flow (checking, savings, credit cards).
- **Investment accounts** (`investment_accounts`) — the portfolio-tracker rows added in migration 0010. Today they cover Scotia iTrade, RRSP, TFSA, Brazil holdings (BRL), and corp-owned holdings. They have holdings, contribution limits, FX.
- **Brazil (and any non-YNAB, non-investment) cash accounts** — currently have no home. The user has at least one Brazilian checking account that isn't in YNAB and isn't a brokerage; right now there's nowhere to record it.

Beyond surfacing the right data, the user wants a single page where they can:

1. See every account in one list.
2. Hit **Sync** on YNAB-sourced rows to pull fresh balances from YNAB.
3. **Edit** non-YNAB accounts: name, bank, current balance, currency, notes.
4. Tag each account with two orthogonal labels: a **kind** (checking / savings / line of credit / investing-fund / investing-stock) and an **owner** (personal / business).
5. For investment-stock accounts specifically, the page should make the **cash position** visible alongside the equity holdings (the stocks themselves keep their existing Holdings UI under Investments — this spec doesn't redesign that).

## Decisions locked

- **Three sources, one page.** Don't collapse YNAB and investments into a single shared table — their data shapes are too different (YNAB = balance + transactions, investments = balance + holdings + FX + contribution limits). Instead, add the one missing piece (`ynab_accounts` cache + `manual_accounts` for the Brazil-style rows) and union them at the API boundary.
- **Orthogonal taxonomy.** Two columns, `kind` and `owner`, on every account source — not eight pre-baked enum combos. Lets us filter independently ("all business accounts", "all checking") and add a third axis later without combinatorial explosion.
- **Cash on stock brokerages = dedicated column.** Add `cash_balance` + `cash_currency` to `investment_accounts` rather than modelling cash as a synthetic holding. Simpler queries, no "what does ticker=CASH mean for FX?" edge case, and matches how brokerage statements display it.
- **YNAB is read-only on this page.** Sync pulls; the user never edits YNAB balances in Helm. Editing a YNAB balance happens in YNAB itself.
- **Manual balances are point-in-time.** The user enters a current balance whenever they want it updated; we store `balance_as_of` so the UI can show "last updated 12 days ago". No transaction ledger for manual accounts in V1 — if the user wants ledger-style tracking, they should put it in YNAB.
- **Currency is per-account.** YNAB accounts use the budget currency (CAD); Brazil accounts default to BRL; investments keep their existing per-account currency. The Accounts page shows native amount + a CAD-equivalent column using the existing `fx_rates` cache.
- **No `user_id`.** Single-user app — same as the rest of Helm.
- **Spec + feature-branch + sandbox + UX/Playwright workflow applies** (per memory `[[feedback_specs_and_branches]]`): work on `feat/accounts-management`, branched off `dev`; verify each visible milestone in the sandbox and add Playwright coverage for the page's golden path.

## Recommended approach

### 0. Spec + branch kickoff

1. This file lives at `docs/specs/accounts-management-v1.md` and is the canonical spec.
2. Feature branch: `feat/accounts-management`, branched off `dev`.

### 1. Schema

**Migration 0012 — `ynab_accounts` cache table**

```sql
CREATE TABLE ynab_accounts (
    id            text PRIMARY KEY,           -- YNAB account UUID
    budget_id     text NOT NULL REFERENCES ynab_budgets(id) ON DELETE CASCADE,
    name          text NOT NULL,
    type          varchar(30) NOT NULL,       -- YNAB's type: checking, savings, creditCard, lineOfCredit, otherAsset, otherLiability, …
    on_budget     boolean NOT NULL DEFAULT TRUE,
    closed        boolean NOT NULL DEFAULT FALSE,
    deleted       boolean NOT NULL DEFAULT FALSE,
    balance       bigint  NOT NULL DEFAULT 0, -- milliunits (YNAB convention)
    cleared_balance     bigint NOT NULL DEFAULT 0,
    uncleared_balance   bigint NOT NULL DEFAULT 0,
    -- Helm-side taxonomy. NULL until the user assigns it; once set,
    -- survives YNAB refreshes (we never overwrite these from upstream).
    helm_kind     varchar(30),    -- 'checking' | 'savings' | 'line_of_credit' | NULL
    helm_owner    varchar(15),    -- 'personal' | 'business' | NULL
    last_synced_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX ynab_accounts_budget_idx ON ynab_accounts (budget_id);
```

**Migration 0013 — `manual_accounts` table** (non-YNAB, non-investment cash accounts)

```sql
CREATE TABLE manual_accounts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name          text NOT NULL,             -- "Itaú checking"
    bank          text,                      -- "Itaú"
    currency      varchar(3) NOT NULL DEFAULT 'BRL',
    balance       numeric(15, 2) NOT NULL DEFAULT 0,
    balance_as_of date NOT NULL DEFAULT CURRENT_DATE,
    kind          varchar(30) NOT NULL,      -- 'checking' | 'savings' | 'line_of_credit'
    owner         varchar(15) NOT NULL,      -- 'personal' | 'business'
    notes         text,
    is_active     boolean NOT NULL DEFAULT TRUE,
    created_at    timestamp with time zone NOT NULL DEFAULT now(),
    updated_at    timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX manual_accounts_owner_idx ON manual_accounts (owner);
CREATE INDEX manual_accounts_kind_idx  ON manual_accounts (kind);
```

**Migration 0014 — extend `investment_accounts`**

```sql
ALTER TABLE investment_accounts
    ADD COLUMN owner            varchar(15),         -- 'personal' | 'business' | NULL until tagged
    ADD COLUMN helm_kind        varchar(30),         -- 'investing_fund' | 'investing_stock' | NULL
    ADD COLUMN bank             text,                -- "Scotia iTrade", "Itaú Investimentos"
    ADD COLUMN cash_balance     numeric(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN cash_currency    varchar(3),          -- defaults to account currency in router
    ADD COLUMN balance_as_of    date;                -- when cash_balance was last touched
```

The existing `kind` column (`itrade` | `rrsp` | `tfsa` | `brazil` | `corp`) stays — it's the "regulatory bucket" used for contribution-room math. `helm_kind` is the orthogonal Accounts-page taxonomy.

### 2. Backend — YNAB client + sync

- Add `YnabClient.get_accounts(budget_id)` → `GET /budgets/{id}/accounts` → `data.accounts[]`.
- Extend `app/ynab/sync.py::refresh()` with a step (between the budget upsert and categories): pull `/accounts`, upsert each row into `ynab_accounts`, leaving `helm_kind` / `helm_owner` untouched on conflict (only the upstream-controlled fields update). Tombstone closed/deleted accounts via the existing `closed` / `deleted` columns.
- Bump `SyncResult` to include `accounts_upserted` count.

### 3. Backend — new routers

**`/accounts` — unified aggregator (read)**

`GET /accounts` returns:

```jsonc
{
  "accounts": [
    {
      "source": "ynab",                  // 'ynab' | 'manual' | 'investment'
      "id": "ynab:uuid",                 // namespaced so the union stays unique
      "name": "TD Checking",
      "bank": null,                      // YNAB doesn't expose bank name
      "currency": "CAD",
      "balance": 4321.99,                // converted from milliunits at the boundary
      "balance_as_of": null,             // YNAB rows: always last_synced_at; manual: balance_as_of
      "last_synced_at": "2026-05-18T…",
      "kind": "checking",                // helm_kind (NULL → 'unassigned')
      "owner": "personal",               // helm_owner (NULL → 'unassigned')
      "is_editable": false,              // YNAB rows are read-only except for kind/owner
      "is_active": true,
      "extra": {                          // source-specific fields
        "ynab_type": "checking",
        "on_budget": true
      }
    },
    {
      "source": "manual",
      "id": "manual:uuid",
      "name": "Itaú checking",
      "bank": "Itaú",
      "currency": "BRL",
      "balance": 12345.67,
      "balance_as_of": "2026-04-30",
      "kind": "checking",
      "owner": "personal",
      "is_editable": true,
      "extra": {}
    },
    {
      "source": "investment",
      "id": "investment:uuid",
      "name": "Scotia iTrade",
      "bank": "Scotia iTrade",
      "currency": "CAD",
      "balance": 87432.11,               // for stock accounts: sum(holdings @ last price) + cash_balance
      "balance_as_of": null,
      "kind": "investing_stock",
      "owner": "personal",
      "is_editable": true,
      "extra": {
        "regulatory_kind": "itrade",     // existing kind column
        "cash_balance": 1234.00,
        "cash_currency": "CAD",
        "holdings_count": 7,
        "contribution_limit": null
      }
    }
  ],
  "totals_cad": {
    "personal": { "checking": …, "savings": …, "line_of_credit": …, "investing_fund": …, "investing_stock": … },
    "business": { … },
    "unassigned": { … }
  }
}
```

FX conversion to CAD uses the existing `fx_rates` cache (per `services/api/app/investments/fx.py`). For YNAB CAD budgets the rate is 1.0.

**`PATCH /accounts/{source}/{id}/tags`** — assign `kind` and/or `owner` on any source. For YNAB rows it writes `helm_kind` / `helm_owner` (the only mutable fields on a YNAB row from Helm's side). For manual + investment rows it writes the same.

**`/accounts/manual` — full CRUD**

- `POST   /accounts/manual` — create.
- `PATCH  /accounts/manual/{id}` — update name, bank, currency, balance (sets `balance_as_of = today`), kind, owner, notes, is_active.
- `DELETE /accounts/manual/{id}` — soft delete via `is_active = FALSE`.

**`/accounts/investment/{id}`** — small superset on top of existing investments router

- `PATCH /accounts/investment/{id}` — update `bank`, `helm_kind`, `owner`, `cash_balance` (sets `balance_as_of = today`), `cash_currency`. Existing `/investments/accounts/{id}` endpoints already handle name / contribution_limit / notes — reuse them. The accounts page calls whichever endpoint owns the field.

**`POST /accounts/ynab/sync`** — thin alias for `POST /money/ynab/refresh` so the Accounts page's Sync button has a route that matches its mental model. Internally the same handler. Returns `accounts_upserted` plus the existing counters.

### 4. Frontend

**New route** `apps/web/src/routes/Accounts.tsx` mounted at `/accounts`. Visible from all three modules (the user thinks of it as a cross-cutting concern), but logically grouped under **Money** in the nav.

Layout (mirroring the existing Money Dashboard look-and-feel — same KPI grid + card chrome from `apps/web/src/routes/Dashboard.tsx`):

- **Top bar** — "Last YNAB sync … · Sync YNAB" button → `POST /accounts/ynab/sync`, invalidates `["accounts"]`.
- **Totals strip** — KPI cards for each owner × kind cell with non-zero balances. CAD totals. Click a card → filters the list below.
- **Account list** — grouped by **Owner** (Personal / Business / Unassigned), each group split by **Kind**. Each row:
  - Name, bank, source badge (YNAB / Manual / Investment), balance (native + CAD), last-updated.
  - Trailing actions:
    - **YNAB row** → kind/owner picker (inline `<select>` calling `PATCH /accounts/.../tags`); the "Sync" button is global, not per-row.
    - **Manual row** → Edit (modal: name, bank, currency, balance, kind, owner, notes), Archive.
    - **Investment row** → Edit (modal: name, bank, cash_balance, cash_currency, helm_kind, owner); a "View holdings" link if `helm_kind === investing_stock`.
- **Add manual account** — primary button top-right; modal with the same form as Edit.

**ModuleChooser / AppHeader** — append "Accounts" to the Money nav array; no new top-level module.

**Types** — append to `apps/web/src/types/api.ts`:
- `AccountSource = "ynab" | "manual" | "investment"`
- `AccountKind = "checking" | "savings" | "line_of_credit" | "investing_fund" | "investing_stock" | "unassigned"`
- `AccountOwner = "personal" | "business" | "unassigned"`
- `Account`, `AccountListResponse`, `ManualAccountInput`, `AccountTagsInput`.

### 5. Verification

0. **Sandbox** — same pattern as `[[feedback_specs_and_branches]]`. `pnpm --filter @helm/web dev` + local API.
0a. **UX review** — after the Accounts page lands, run the UI review agent against the running sandbox to check IA + Settings-pattern conformance.
0b. **Playwright** — `apps/web/e2e/accounts.spec.ts`:
   - Page loads with empty state when nothing is configured.
   - Add a manual account → it appears in the right group.
   - Tag a YNAB account as Checking/Personal → tag survives a Sync.
   - Edit an investment account's cash_balance → balance updates without touching its holdings.

1. **Typecheck + lint** — `pnpm -w typecheck && pnpm -w lint`; `uv run ruff check` in `services/api`.
2. **DB migration dry-run** — apply 0012/0013/0014 against a scratch DB; verify schemas + indexes; verify Drizzle introspection matches `db/schema/`.
3. **Backend unit** — pytest:
   - Aggregator returns correctly-shaped rows from each source.
   - Tags-patch on a YNAB row updates `helm_kind` / `helm_owner` only.
   - Manual CRUD round-trip.
   - YNAB sync upserts accounts without clobbering `helm_kind` / `helm_owner`.
4. **Dev deploy** — `pnpm cdk deploy -c userPoolClientId=<dev id>` (per memory `[[project_cdk_userpoolclientid]]`).
5. **End-to-end smoke in dev** — sign in → /accounts → Sync YNAB pulls account rows; tag two of them; add an Itaú manual account; edit a Scotia iTrade cash balance; refresh page; confirm everything persists.
6. **Network sanity** — DevTools confirms the page is one `/accounts` GET on first load; Sync is the only call that hits YNAB upstream.

## Critical files

**Add**
- `apps/web/src/routes/Accounts.tsx`
- `apps/web/src/components/AccountEditDialog.tsx` (shared edit modal — manual + investment)
- `services/api/app/routers/accounts.py` (aggregator + tags)
- `services/api/app/routers/accounts_manual.py` (manual CRUD)
- `services/api/app/models/accounts.py` (Pydantic shapes for the aggregator + manual rows)
- `services/api/app/models/manual_accounts.py`
- `db/schema/manual-accounts.ts`
- `db/migrations/0012_ynab_accounts.sql`
- `db/migrations/0013_manual_accounts.sql`
- `db/migrations/0014_account_taxonomy.sql`
- `apps/web/e2e/accounts.spec.ts`

**Change**
- `apps/web/src/App.tsx` — add `/accounts` route.
- `apps/web/src/components/AppHeader.tsx` — append "Accounts" to `MONEY_NAV`.
- `apps/web/src/types/api.ts` — add the Account types.
- `db/schema/ynab.ts` — append the `ynab_accounts` Drizzle table.
- `db/schema/investments.ts` — add the new columns on `investmentAccounts`.
- `db/schema/index.ts` — export `manual-accounts`.
- `services/api/app/ynab/client.py` — add `get_accounts`.
- `services/api/app/ynab/sync.py` — call `get_accounts` and upsert; bump `SyncResult`.
- `services/api/app/main.py` — include the two new routers.
- `services/api/app/models/ynab.py` — add `accounts_upserted` to `YnabRefreshResponse`.
- `services/api/app/routers/investments_accounts.py` — accept the new columns (`bank`, `helm_kind`, `owner`, `cash_balance`, `cash_currency`) on its existing update path, OR — preferred — the new `/accounts/investment/{id}` PATCH owns those fields and the legacy router stays narrow.

## Existing patterns to reuse

- **YNAB caching pattern** — `services/api/app/ynab/sync.py` already shows the "upsert-on-refresh, never overwrite Helm-side columns" idiom; the new accounts step follows the same shape.
- **Settings sidebar+scroll-spy** — not directly used here (Accounts is a list, not a settings page), but the **card chrome + KPI strip** from the Money / Business dashboards is the visual language to match.
- **Drizzle migration + meta-snapshot workflow** — `db/migrations/0011_investment_contributions.sql` shows the SQL-with-statement-breakpoints shape; a paired snapshot under `db/migrations/meta/` is generated by the Drizzle introspect command — don't hand-edit.
- **FX cache** — `services/api/app/investments/fx.py` already turns BRL/USD into CAD via cached rates; the aggregator's `totals_cad` reuses it.
- **Per-section dirty flag + Save** (Settings pattern) — for the manual/investment edit modal: same UX, smaller scope (one card).
