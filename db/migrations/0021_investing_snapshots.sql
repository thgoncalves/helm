-- 0021: Investing dashboard position snapshots.
--
-- Per-source, per-date frozen positions for the Investing > Dashboard
-- chart. One row per (date, source_kind, source_id):
--   * source_kind='manual_fund', source_id=manual_accounts.id (uuid as text) —
--     one row per manually-tracked investing fund (XP, Santander, …).
--   * source_kind='ynab_fund',   source_id=ynab_accounts.id (string id) —
--     one row per YNAB-linked investing account (RSPs, TFSAs, RESPs …)
--     using YNAB's last synced cleared_balance.
--   * source_kind='stocks',      source_id=NULL —
--     single aggregate row summing all live stock holdings × cached
--     quote.
--
-- source_id is text so it can hold either a uuid (manual) or a YNAB
-- string id without a polymorphic FK.
--
-- Same-day re-snapshot UPSERTs via the partial unique indexes below.

CREATE TABLE IF NOT EXISTS "investing_snapshots" (
    "id"              bigserial PRIMARY KEY,
    "snapshot_date"   date NOT NULL,
    "source_kind"     text NOT NULL,
    "source_id"       text,
    "label"           text NOT NULL,
    "native_currency" text NOT NULL,
    "native_amount"   numeric(18, 2) NOT NULL,
    "cad_amount"      numeric(18, 2) NOT NULL,
    "fx_rate"         numeric(18, 8) NOT NULL,
    "created_at"      timestamp with time zone NOT NULL DEFAULT now()
);

-- One manual-fund row per (date, fund).
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_investing_snapshot_manual"
    ON "investing_snapshots" ("snapshot_date", "source_id")
    WHERE source_kind = 'manual_fund';

-- One YNAB-fund row per (date, ynab_account).
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_investing_snapshot_ynab"
    ON "investing_snapshots" ("snapshot_date", "source_id")
    WHERE source_kind = 'ynab_fund';

-- One stocks-aggregate row per date.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_investing_snapshot_stocks"
    ON "investing_snapshots" ("snapshot_date")
    WHERE source_kind = 'stocks';

CREATE INDEX IF NOT EXISTS "ix_investing_snapshot_date"
    ON "investing_snapshots" ("snapshot_date" DESC);
