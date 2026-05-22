-- Migrate any investment_accounts rows tagged ``helm_kind='investing_fund'``
-- into ``manual_accounts`` BEFORE 0018 drops the legacy table. On dev this
-- is a no-op (investment_accounts is already gone); on main it preserves
-- the XP + Santander balances the user is actively tracking.
--
-- Idempotent: the IF EXISTS guard skips dev's already-dropped table, and
-- ON CONFLICT (id) DO NOTHING avoids dupes on a re-run.
--
-- iTrade Personal-style rows (helm_kind IS NULL, cash_balance=0) are
-- intentionally excluded — they're empty placeholders and the user has
-- already replaced them with a YNAB-synced brokerage account.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'investment_accounts'
  ) THEN
    INSERT INTO manual_accounts (
      id, name, bank, currency, balance, balance_as_of,
      kind, owner, notes, is_active, created_at, updated_at
    )
    SELECT
      id,
      name,
      bank,
      currency,
      cash_balance,
      COALESCE(balance_as_of, CURRENT_DATE),
      'investing_fund',
      COALESCE(owner, 'personal'),
      notes,
      is_active,
      created_at,
      updated_at
    FROM investment_accounts
    WHERE is_active = TRUE
      AND helm_kind = 'investing_fund'
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;
