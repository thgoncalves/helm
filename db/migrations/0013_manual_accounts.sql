-- 0013: Non-YNAB, non-investment cash accounts.
--
-- The user has cash accounts outside YNAB (e.g. Brazilian checking)
-- that aren't brokerages either. They live here. The Accounts page
-- unions this table with ynab_accounts and investment_accounts.
--
-- Balances are stored in the account's native currency at numeric(15, 2)
-- — same precision as invoices / payments — and stamped with
-- balance_as_of so the UI can show "last updated N days ago" without
-- exposing the user to a transaction ledger they didn't ask for. If
-- they want ledger-style tracking, they should put it in YNAB.

CREATE TABLE "manual_accounts" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "name" text NOT NULL,
    "bank" text,
    "currency" varchar(3) DEFAULT 'BRL' NOT NULL,
    "balance" numeric(15, 2) DEFAULT 0 NOT NULL,
    "balance_as_of" date DEFAULT CURRENT_DATE NOT NULL,
    "kind" varchar(30) NOT NULL,
    "owner" varchar(15) NOT NULL,
    "notes" text,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX "manual_accounts_owner_idx" ON "manual_accounts" ("owner");--> statement-breakpoint
CREATE INDEX "manual_accounts_kind_idx" ON "manual_accounts" ("kind");
