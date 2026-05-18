-- 0008: Wipe the Personal V1 stubs and stand up the YNAB cache tables
-- that back the new Money module.
--
-- Drop order: personal_transactions has FKs to personal_imports and
-- personal_accounts, so it goes first; then personal_imports (FK to
-- personal_accounts); finally personal_accounts. The YNAB tables that
-- replace them all live below.
--
-- Money amounts on the YNAB side come as milliunits (CAD 12.34 → 12340).
-- We store them as BIGINT in milliunits to avoid losing precision; the
-- API layer converts to dollars when serialising for the frontend.

DROP TABLE IF EXISTS "personal_transactions";--> statement-breakpoint
DROP TABLE IF EXISTS "personal_imports";--> statement-breakpoint
DROP TABLE IF EXISTS "personal_accounts";--> statement-breakpoint

CREATE TABLE "ynab_budgets" (
    "id" text PRIMARY KEY NOT NULL,
    "name" text NOT NULL,
    "last_modified_on" timestamp with time zone,
    "currency_code" varchar(3) DEFAULT 'CAD' NOT NULL,
    "is_active" boolean DEFAULT false NOT NULL,
    "last_synced_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "ynab_categories" (
    "category_id" text PRIMARY KEY NOT NULL,
    "budget_id" text NOT NULL,
    "group_name" text NOT NULL,
    "name" text NOT NULL,
    "hidden" boolean DEFAULT false NOT NULL,
    "last_synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "ynab_categories"
    ADD CONSTRAINT "ynab_categories_budget_id_ynab_budgets_id_fk"
    FOREIGN KEY ("budget_id") REFERENCES "ynab_budgets"("id") ON DELETE cascade;
--> statement-breakpoint

CREATE INDEX "ynab_categories_budget_idx" ON "ynab_categories" ("budget_id");
--> statement-breakpoint

CREATE TABLE "ynab_month_categories" (
    "budget_id" text NOT NULL,
    "month" date NOT NULL,
    "category_id" text NOT NULL,
    "assigned" bigint DEFAULT 0 NOT NULL,
    "activity" bigint DEFAULT 0 NOT NULL,
    "balance" bigint DEFAULT 0 NOT NULL,
    "last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "ynab_month_categories_budget_id_month_category_id_pk"
        PRIMARY KEY ("budget_id", "month", "category_id")
);
--> statement-breakpoint

ALTER TABLE "ynab_month_categories"
    ADD CONSTRAINT "ynab_month_categories_budget_id_ynab_budgets_id_fk"
    FOREIGN KEY ("budget_id") REFERENCES "ynab_budgets"("id") ON DELETE cascade;
--> statement-breakpoint

ALTER TABLE "ynab_month_categories"
    ADD CONSTRAINT "ynab_month_categories_category_id_ynab_categories_category_id_fk"
    FOREIGN KEY ("category_id") REFERENCES "ynab_categories"("category_id") ON DELETE cascade;
--> statement-breakpoint

CREATE INDEX "ynab_month_categories_month_idx" ON "ynab_month_categories" ("month");
--> statement-breakpoint

CREATE TABLE "ynab_transactions" (
    "id" text PRIMARY KEY NOT NULL,
    "budget_id" text NOT NULL,
    "account_id" text NOT NULL,
    "posted_date" date NOT NULL,
    "amount" bigint NOT NULL,
    "payee_name" text,
    "memo" text,
    "category_id" text,
    "cleared" varchar(12) NOT NULL,
    "approved" boolean DEFAULT true NOT NULL,
    "last_synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "ynab_transactions"
    ADD CONSTRAINT "ynab_transactions_budget_id_ynab_budgets_id_fk"
    FOREIGN KEY ("budget_id") REFERENCES "ynab_budgets"("id") ON DELETE cascade;
--> statement-breakpoint

CREATE INDEX "ynab_transactions_budget_idx" ON "ynab_transactions" ("budget_id");--> statement-breakpoint
CREATE INDEX "ynab_transactions_posted_date_idx" ON "ynab_transactions" ("posted_date");--> statement-breakpoint
CREATE INDEX "ynab_transactions_category_idx" ON "ynab_transactions" ("category_id");
