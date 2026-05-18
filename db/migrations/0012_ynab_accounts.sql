-- 0012: Cache YNAB accounts locally.
--
-- Until now we only stored YNAB transactions; the `account_id` column on
-- ynab_transactions was a free-form string with no first-class row to
-- join against. The new unified Accounts page needs the per-account
-- balance, name, and type from YNAB, plus a place to attach Helm-side
-- taxonomy (kind + owner) that survives a refresh.
--
-- Balances come from YNAB as signed milliunits (CAD 12.34 → 12340).
-- We store them as BIGINT in milliunits to match the rest of the YNAB
-- cache; the API converts to dollars at the boundary.
--
-- `helm_kind` and `helm_owner` are Helm-side annotations. The YNAB sync
-- never overwrites them — only the upstream-controlled columns refresh.

CREATE TABLE "ynab_accounts" (
    "id" text PRIMARY KEY NOT NULL,
    "budget_id" text NOT NULL,
    "name" text NOT NULL,
    "type" varchar(30) NOT NULL,
    "on_budget" boolean DEFAULT true NOT NULL,
    "closed" boolean DEFAULT false NOT NULL,
    "deleted" boolean DEFAULT false NOT NULL,
    "balance" bigint DEFAULT 0 NOT NULL,
    "cleared_balance" bigint DEFAULT 0 NOT NULL,
    "uncleared_balance" bigint DEFAULT 0 NOT NULL,
    "helm_kind" varchar(30),
    "helm_owner" varchar(15),
    "last_synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "ynab_accounts"
    ADD CONSTRAINT "ynab_accounts_budget_id_ynab_budgets_id_fk"
    FOREIGN KEY ("budget_id") REFERENCES "ynab_budgets"("id") ON DELETE cascade;
--> statement-breakpoint

CREATE INDEX "ynab_accounts_budget_idx" ON "ynab_accounts" ("budget_id");
