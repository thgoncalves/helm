# Money > Accounts: real 30-day balance line (per-account daily snapshots)

## Context

The "30-day balance" line in the account detail pane is a **hardcoded static
SVG** (`apps/web/src/routes/Accounts.tsx`, `Sparkline()` ~L1059) — the same
shape for every account. Its own comment says "Swap for real data once we wire
account snapshots."

There is **no per-account balance history stored anywhere** today
(`manual_accounts` has no ledger; `ynab_accounts` keeps only the current
balance; `net_worth_snapshots` is monthly + aggregate, not per-account).

Decision (confirmed with user): **snapshot-forward** — add a per-account daily
snapshot table, capture today's balance on every balance-change event, and
render the line from those rows. This covers *all* account types uniformly
(YNAB + manual). Consequence the user accepted: the line starts flat (one
point) and fills with real daily movement going forward; it is not backfilled.
**Flat case:** when there are 0/1 points or all values are equal, draw a real
flat line at the current balance (uniform across accounts).

Mirrors the existing snapshot machinery: `net_worth_snapshots` /
`app/money/snapshots.py::record_snapshot()` (capture pattern + call sites) and
`investing_snapshots` / migration 0021 (daily per-source table, SQL-only, no
Drizzle TS file).

## Backend

### 1. Migration `db/migrations/0023_account_balance_snapshots.sql`
```
CREATE TABLE IF NOT EXISTS "account_balance_snapshots" (
    "id"            bigserial PRIMARY KEY,
    "snapshot_date" date NOT NULL,
    "account_id"    text NOT NULL,   -- namespaced: "ynab:<id>" / "manual:<id>"
    "source"        text NOT NULL,   -- 'ynab' | 'manual'
    "currency"      text NOT NULL,
    "native_amount" numeric(18,2) NOT NULL,
    "cad_amount"    numeric(18,2),   -- NULL on FX miss
    "created_at"    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_account_balance_snapshot"
    ON "account_balance_snapshots" ("snapshot_date", "account_id");
CREATE INDEX IF NOT EXISTS "ix_account_balance_snapshot_acct_date"
    ON "account_balance_snapshots" ("account_id", "snapshot_date" DESC);
```
Check `db/migrations/meta/_journal` — append an entry only if 0021/0022 did
(the `apply_migration.py` script runs the SQL directly regardless). Apply with
`AWS_PROFILE=helm uv run python scripts/apply_migration.py 0023_account_balance_snapshots`.

### 2. Capture module `app/money/account_snapshots.py`
`record_account_snapshots()` mirroring `record_snapshot()` (swallow + log; never
raise to caller). Body: reuse the account loaders
(`from app.routers.accounts import _load_ynab_rows, _load_manual_rows`, imported
*inside* the function to avoid an import cycle), then upsert one row per account
for today via `ON CONFLICT (snapshot_date, account_id) DO UPDATE`. Latest write
of the day wins (daily granularity).

### 3. Hook capture into the existing balance-change call sites
Everywhere `record_snapshot()` is already called, add
`record_account_snapshots()` beside it:
- `app/ynab/sync.py` (refresh)
- `app/routers/accounts_manual.py` (POST / PATCH / DELETE)
- `app/routers/accounts.py::update_tags`
Plus call it once in `list_accounts()` so simply opening the Accounts page seeds
today's point (cheap idempotent upsert).

### 4. History endpoint (in `app/routers/accounts.py`)
`GET /accounts/{source}/{account_id}/balance-history?days=30` →
`list[AccountBalancePoint]` oldest-first. Rebuild the namespaced id from
`{source}:{account_id}`, `SELECT ... WHERE account_id = :id AND snapshot_date >=
today-days ORDER BY snapshot_date`, sort oldest-first in Python (so it's
testable against the fake DB, which ignores SQL `ORDER BY`).
New model `AccountBalancePoint { snapshot_date: date; native_amount: Decimal;
cad_amount: Decimal | None }` in `app/models/accounts.py`.

## Frontend

### `apps/web/src/routes/Accounts.tsx`
Replace static `Sparkline()` with `Sparkline({ account })`:
- `useQuery(["account-balance-history", account.id], () =>
  apiFetch('/accounts/{account.source}/{rawId}/balance-history?days=30'))`
  where `rawId = account.id.split(":")[1]`.
- Map points → polyline auto-scaled to `[min,max]` of the series (keep the
  current compact 380×60 SVG look). 0/1 point or all-equal → flat line at
  current balance. While loading → render the flat line at current balance (no
  layout shift).
- Pass `account` where `<Sparkline />` is used (~L946).

### `apps/web/src/types/api.ts`
Add `AccountBalancePoint { snapshot_date: string; native_amount: number|string;
cad_amount: number|string|null }`.

## Tests

### Backend `services/api/tests/`
- Extend `conftest.py` fake DB: handle the snapshot upsert INSERT and the
  history SELECT (store rows in a dict keyed by (snapshot_date, account_id)).
- `test_account_snapshots`: `record_account_snapshots()` writes one row per
  active account for today and is idempotent (second call updates, not
  duplicates).
- History endpoint test: seed two days → returns 2 points oldest-first with the
  right values; unknown account → empty list.

## Workflow
- Branch off `dev` as `feat/account-balance-snapshots`; copy this spec to
  `docs/specs/`. (Currently on `main` from the prior task — switch first.)

## Verification
1. Apply migration to dev Aurora (command above).
2. `cd services/api && uv run pytest tests/test_account_snapshots.py tests/test_accounts_router.py -q` (+ full suite).
3. `pnpm -C apps/web build`.
4. Live: backend already running on :8000. `curl` the new endpoint for a real
   account → expect today's single point now; open the Accounts page, select an
   account → flat line at current balance (real data, one point). Re-check after
   a YNAB sync / manual edit to confirm the row upserts.

## Caveat (will state to user on completion)
Forward-only: the line is flat until ≥2 days of snapshots accrue — by design.
Real movement appears as days pass / syncs run. Prod needs the migration applied
**and** the API Lambda redeployed via CDK; a git push won't do either.
