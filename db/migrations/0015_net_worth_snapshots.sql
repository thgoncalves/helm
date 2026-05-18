-- 0015: Monthly net-worth snapshots for the dashboard trend chart.
--
-- One row per calendar month, keyed on the first day of the month so
-- repeated writes within a month upsert in place (idempotent). The
-- snapshot is recomputed after every write that changes a balance:
-- YNAB refresh, manual-account CRUD, investment-account update, and
-- the kind/owner tag PATCHes.
--
-- All amounts in CAD. The aggregator that fills this table is shared
-- with /money/health so the snapshot and the live KPI always agree.

CREATE TABLE "net_worth_snapshots" (
    "snapshot_month" date PRIMARY KEY NOT NULL,
    "assets_cad"     numeric(15, 2) NOT NULL,
    "liabilities_cad" numeric(15, 2) NOT NULL,
    -- By kind (CAD).
    "checking_cad"   numeric(15, 2) NOT NULL DEFAULT 0,
    "savings_cad"    numeric(15, 2) NOT NULL DEFAULT 0,
    "investing_cad"  numeric(15, 2) NOT NULL DEFAULT 0,
    "lending_cad"    numeric(15, 2) NOT NULL DEFAULT 0,
    -- By owner (CAD).
    "personal_cad"   numeric(15, 2) NOT NULL DEFAULT 0,
    "business_cad"   numeric(15, 2) NOT NULL DEFAULT 0,
    "taken_at"       timestamp with time zone NOT NULL DEFAULT now()
);
