-- 0023: Per-account daily balance snapshots.
--
-- Powers the "30-day balance" line in the Accounts detail pane. One row
-- per (snapshot_date, account_id), where account_id is the namespaced
-- unified id used everywhere on the Accounts page:
--   * "ynab:<ynab_accounts.id>"
--   * "manual:<manual_accounts.id>"
--
-- Captured forward-only: a row for today is upserted on every balance
-- change event (YNAB refresh, manual account create/edit/delete, kind/
-- owner retag) and whenever the Accounts list loads. The latest write of
-- the day wins, so the series is effectively daily. There is no backfill
-- — the line grows real history as days pass.
--
-- Mirrors the daily-snapshot shape of investing_snapshots (migration
-- 0021): SQL-only, no Drizzle schema file.

CREATE TABLE IF NOT EXISTS "account_balance_snapshots" (
    "id"            bigserial PRIMARY KEY,
    "snapshot_date" date NOT NULL,
    "account_id"    text NOT NULL,   -- "ynab:<id>" / "manual:<id>"
    "source"        text NOT NULL,   -- 'ynab' | 'manual'
    "currency"      text NOT NULL,
    "native_amount" numeric(18, 2) NOT NULL,
    "cad_amount"    numeric(18, 2),  -- NULL when FX conversion missed
    "created_at"    timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- One row per (date, account) — same-day re-snapshot UPSERTs in place.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_account_balance_snapshot"
    ON "account_balance_snapshots" ("snapshot_date", "account_id");
--> statement-breakpoint
-- Hot path: fetch the last N days for one account, newest first.
CREATE INDEX IF NOT EXISTS "ix_account_balance_snapshot_acct_date"
    ON "account_balance_snapshots" ("account_id", "snapshot_date" DESC);
