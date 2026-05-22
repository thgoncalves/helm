-- Drop the legacy Investments tables. Funds live in manual_accounts +
-- ynab_accounts (tagged investing_fund); stocks live in
-- stock_transactions (account_source ∈ {manual, ynab}).
--
-- Tables removed:
--   investment_contributions  (FK → investment_accounts)
--   investment_holdings       (FK → investment_accounts)
--   target_allocations        (no FKs)
--   investment_accounts       (parent — dropped last)
--
-- Also flips the default on stock_transactions.account_source from
-- 'investment' (no longer a valid source) to 'manual'.
DROP TABLE IF EXISTS investment_contributions;--> statement-breakpoint
DROP TABLE IF EXISTS investment_holdings;--> statement-breakpoint
DROP TABLE IF EXISTS target_allocations;--> statement-breakpoint
DROP TABLE IF EXISTS investment_accounts;--> statement-breakpoint
ALTER TABLE stock_transactions ALTER COLUMN account_source SET DEFAULT 'manual';
