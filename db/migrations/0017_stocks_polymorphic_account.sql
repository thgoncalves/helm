-- 0017: Stocks V1.1 — let stock_transactions reference any of the three
-- account sources.
--
-- Before 0017, stock_transactions.account_id was a hard FK to
-- investment_accounts(id). That excluded YNAB-synced and manual cash
-- accounts that the user has tagged helm_kind='investing_stock' on the
-- unified Accounts page (e.g. "Thiago SB iTRADE-Cash (CAD) – 5294" which
-- syncs from YNAB and is the real cash account behind a Scotia iTrade
-- brokerage).
--
-- This migration:
--   * Adds an account_source discriminator ('investment' | 'manual' | 'ynab').
--   * Drops the FK so account_id can point at investment_accounts OR
--     manual_accounts OR ynab_accounts depending on account_source.
--   * Leaves existing rows alone (default 'investment' covers them).
--
-- Referential integrity is enforced application-side in the stocks
-- router by looking up the account from the matching table before
-- writing a transaction.

ALTER TABLE "stock_transactions"
    DROP CONSTRAINT IF EXISTS "stock_transactions_account_fk";
--> statement-breakpoint

ALTER TABLE "stock_transactions"
    ADD COLUMN IF NOT EXISTS "account_source" varchar(15) NOT NULL DEFAULT 'investment';
--> statement-breakpoint

-- Index for the per-(source, account_id, ticker) lookup the detail page
-- and recompute paths use.
CREATE INDEX IF NOT EXISTS "stock_transactions_account_source_idx"
    ON "stock_transactions" ("account_source", "account_id", "ticker");
