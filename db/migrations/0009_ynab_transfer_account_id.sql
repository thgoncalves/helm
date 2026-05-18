-- 0009: Add transfer_account_id to ynab_transactions so the Money
-- dashboard can filter cross-account transfers out of income and spend
-- pacing. Without this, moving money between accounts double-counts
-- as both inflow and outflow.

ALTER TABLE "ynab_transactions"
    ADD COLUMN "transfer_account_id" text;
--> statement-breakpoint

CREATE INDEX "ynab_transactions_transfer_idx"
    ON "ynab_transactions" ("transfer_account_id");
