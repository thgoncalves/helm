-- 0014: Extend investment_accounts with cross-source taxonomy fields.
--
-- The Accounts page tags every row in every source with two orthogonal
-- labels — `owner` (personal/business) and `helm_kind` (investing_fund
-- vs investing_stock for this table). The existing `kind` column stays
-- — it's the regulatory bucket (itrade/rrsp/tfsa/brazil/corp) used for
-- contribution-room math — but the Accounts page reads `helm_kind`.
--
-- `cash_balance` / `cash_currency` give brokerages a place to record
-- uninvested cash. We store it as a dedicated column rather than as a
-- synthetic "CASH" holding so balance queries stay simple and the FX
-- handling matches how a brokerage statement displays it.
--
-- `bank` is the issuing institution (e.g. "Scotia iTrade"). `name`
-- continues to be the user-facing display name.

ALTER TABLE "investment_accounts"
    ADD COLUMN "owner" varchar(15);--> statement-breakpoint
ALTER TABLE "investment_accounts"
    ADD COLUMN "helm_kind" varchar(30);--> statement-breakpoint
ALTER TABLE "investment_accounts"
    ADD COLUMN "bank" text;--> statement-breakpoint
ALTER TABLE "investment_accounts"
    ADD COLUMN "cash_balance" numeric(15, 2) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "investment_accounts"
    ADD COLUMN "cash_currency" varchar(3);--> statement-breakpoint
ALTER TABLE "investment_accounts"
    ADD COLUMN "balance_as_of" date;
