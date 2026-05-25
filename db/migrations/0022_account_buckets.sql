-- 0022: User-defined account categories ("buckets") + manual ordering.
--
-- Adds a first-class grouping concept the user controls — distinct
-- from the YNAB "categories" naming, which is a budget concept.
-- Internally we call them buckets so every join and model is
-- unambiguous; the UI calls them Categories.
--
-- bucket_id is nullable: an account that hasn't been categorized
-- renders under "Uncategorized" in the rail. Deleting a bucket
-- moves its accounts to Uncategorized (ON DELETE SET NULL); we
-- never lose accounts as a side effect of category cleanup.
--
-- sort_index is per-bucket ordering, written on every drag. We use
-- plain ints (not fractional) — at ~50 accounts the rewrite cost on
-- reorder is negligible and avoids the float-precision pitfalls.

CREATE TABLE IF NOT EXISTS "account_buckets" (
    "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "name"       text NOT NULL,
    "color"      text,
    "sort_order" int  NOT NULL DEFAULT 0,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT account_buckets_name_unique UNIQUE (name)
);

ALTER TABLE "manual_accounts"
    ADD COLUMN IF NOT EXISTS "bucket_id"  uuid REFERENCES "account_buckets"(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS "sort_index" int  NOT NULL DEFAULT 0;

ALTER TABLE "ynab_accounts"
    ADD COLUMN IF NOT EXISTS "bucket_id"  uuid REFERENCES "account_buckets"(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS "sort_index" int  NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS ix_manual_accounts_bucket
    ON "manual_accounts" (bucket_id, sort_index);
CREATE INDEX IF NOT EXISTS ix_ynab_accounts_bucket
    ON "ynab_accounts" (bucket_id, sort_index);
