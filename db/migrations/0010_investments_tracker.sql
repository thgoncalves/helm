-- 0010: Investments module — portfolio tracker (V1).
--
-- Five-table set covering accounts, holdings, target allocations, and
-- an FX-rates cache for the Brazilian-account → CAD conversion.

CREATE TABLE "investment_accounts" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "name" text NOT NULL,
    "kind" varchar(20) NOT NULL,
    "currency" varchar(3) DEFAULT 'CAD' NOT NULL,
    "owner_label" text,
    "contribution_limit" numeric(15, 2),
    "notes" text,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX "investment_accounts_is_active_idx" ON "investment_accounts" ("is_active");--> statement-breakpoint
CREATE INDEX "investment_accounts_kind_idx" ON "investment_accounts" ("kind");
--> statement-breakpoint

CREATE TABLE "investment_holdings" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "account_id" uuid NOT NULL,
    "ticker" text NOT NULL,
    "asset_class" varchar(30) NOT NULL,
    "shares" numeric(20, 8) NOT NULL,
    "avg_cost" numeric(15, 4) NOT NULL,
    "current_price" numeric(15, 4) NOT NULL,
    "currency" varchar(3) NOT NULL,
    "as_of" date NOT NULL,
    "notes" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "investment_holdings"
    ADD CONSTRAINT "investment_holdings_account_id_investment_accounts_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "investment_accounts"("id") ON DELETE cascade;
--> statement-breakpoint

CREATE INDEX "investment_holdings_account_idx" ON "investment_holdings" ("account_id");--> statement-breakpoint
CREATE INDEX "investment_holdings_asset_class_idx" ON "investment_holdings" ("asset_class");--> statement-breakpoint
CREATE UNIQUE INDEX "investment_holdings_account_ticker_idx"
    ON "investment_holdings" ("account_id", "ticker");
--> statement-breakpoint

CREATE TABLE "target_allocations" (
    "asset_class" varchar(30) PRIMARY KEY NOT NULL,
    "target_pct" numeric(5, 2) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "fx_rates" (
    "from_currency" varchar(3) NOT NULL,
    "to_currency" varchar(3) NOT NULL,
    "rate_date" date NOT NULL,
    "rate" numeric(15, 8) NOT NULL,
    "source" text DEFAULT 'BoC' NOT NULL,
    "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("from_currency", "to_currency", "rate_date")
);
--> statement-breakpoint

CREATE INDEX "fx_rates_recent_idx" ON "fx_rates" ("from_currency", "to_currency", "rate_date");
