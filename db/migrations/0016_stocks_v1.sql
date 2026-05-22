-- 0016: Stocks V1 — self-managed equity tracking.
--
-- Three new tables:
--   stock_transactions   per-purchase lot (transaction_type='buy' in V1;
--                        'sell' / 'split' / 'dividend' reserved).
--                        Quantity + unit_price drive the per-(account, ticker)
--                        ACB; recomputed in the router into investment_holdings.
--   stock_quotes         single-row-per-ticker cache for the latest live quote
--                        (Yahoo Finance), 15-min TTL.
--   stock_price_history  daily close per (ticker, date) for the 1Y chart.
--
-- No destructive change to investment_holdings — it stays as the
-- aggregate position cache. For helm_kind='investing_stock' rows it is
-- auto-maintained by the stocks router; for 'investing_fund' rows it
-- remains user-maintained as before.

CREATE TABLE "stock_transactions" (
    "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "account_id"       uuid NOT NULL,
    "ticker"           text NOT NULL,
    "transaction_type" varchar(10) NOT NULL,
    --   "buy" in V1; reserved values "sell" | "split" | "dividend".
    "transaction_date" date NOT NULL,
    "quantity"         numeric(20, 8) NOT NULL,
    "unit_price"       numeric(15, 4) NOT NULL,
    "fees"             numeric(15, 2) NOT NULL DEFAULT 0,
    "currency"         varchar(3) NOT NULL,
    "notes"            text,
    "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at"       timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE "stock_transactions"
    ADD CONSTRAINT "stock_transactions_account_fk"
    FOREIGN KEY ("account_id") REFERENCES "investment_accounts"("id")
    ON DELETE CASCADE;
--> statement-breakpoint

CREATE INDEX "stock_transactions_account_ticker_idx"
    ON "stock_transactions" ("account_id", "ticker", "transaction_date");
--> statement-breakpoint

CREATE TABLE "stock_quotes" (
    "ticker"          text PRIMARY KEY NOT NULL,
    "currency"        varchar(3) NOT NULL,
    "last_price"      numeric(15, 4) NOT NULL,
    "previous_close"  numeric(15, 4),
    "name"            text,
    "exchange"        text,
    "fetched_at"      timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE "stock_price_history" (
    "ticker"     text NOT NULL,
    "date"       date NOT NULL,
    "close"      numeric(15, 4) NOT NULL,
    "currency"   varchar(3) NOT NULL,
    "fetched_at" timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY ("ticker", "date")
);
