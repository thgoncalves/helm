-- 0011: Per-account contribution log.
--
-- Tracks deposits / withdrawals separately from share buys/sells.
-- For Brazilian (BRL) accounts each row stores the BRL→CAD rate on the
-- day of the deposit, locking in CAD cost basis at the time of the
-- contribution. For TFSA / RRSP, it lets the Overview compute remaining
-- contribution room against the account's contribution_limit.

CREATE TABLE "investment_contributions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "account_id" uuid NOT NULL,
    "contributed_on" date NOT NULL,
    "kind" varchar(15) DEFAULT 'deposit' NOT NULL,
    "amount" numeric(15, 2) NOT NULL,
    "currency" varchar(3) NOT NULL,
    "fx_rate_cad" numeric(15, 8) NOT NULL,
    "amount_cad" numeric(15, 2) NOT NULL,
    "notes" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "investment_contributions"
    ADD CONSTRAINT "investment_contributions_account_id_investment_accounts_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "investment_accounts"("id")
    ON DELETE cascade;
--> statement-breakpoint

CREATE INDEX "investment_contributions_account_idx"
    ON "investment_contributions" ("account_id");--> statement-breakpoint
CREATE INDEX "investment_contributions_date_idx"
    ON "investment_contributions" ("contributed_on");
