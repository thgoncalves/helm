import {
  pgTable,
  text,
  boolean,
  bigint,
  date,
  timestamp,
  varchar,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';

/**
 * Local cache of YNAB data — refresh-on-demand only (no cron).
 *
 * The Money dashboard reads from these tables, never directly from the
 * YNAB API. Each ``POST /money/ynab/refresh`` upserts:
 *
 *   - the active budget's metadata into ``ynab_budgets``
 *   - the budget's categories into ``ynab_categories``
 *   - the current month's category amounts into ``ynab_month_categories``
 *   - the last N days of transactions into ``ynab_transactions``
 *
 * Money amounts come from YNAB in milliunits (e.g. CAD 12.34 = 12340).
 * We store them as ``bigint`` in milliunits to preserve YNAB's precision
 * and convert at the API boundary when serialising for the frontend.
 */

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export const ynabBudgets = pgTable('ynab_budgets', {
  id: text('id').primaryKey(),
  //   YNAB's budget UUID (string form). Stored as TEXT because YNAB
  //   sometimes returns "last-used" as a sentinel and we want to allow
  //   it in dev / tests.

  name: text('name').notNull(),
  /** ISO 8601 — when YNAB last saw the budget change. */
  last_modified_on: timestamp('last_modified_on', { withTimezone: true }),

  /** ISO 4217 currency code (e.g. ``"CAD"``). Cached so the dashboard
   *  doesn't have to re-derive it from category amounts. */
  currency_code: varchar('currency_code', { length: 3 }).notNull().default('CAD'),

  /**
   * Exactly one row should be active at a time — the budget the user
   * picked as the source of truth for the Money dashboard. Enforced at
   * the application layer (PUT /money/ynab/active-budget toggles it).
   */
  is_active: boolean('is_active').notNull().default(false),

  last_synced_at: timestamp('last_synced_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type YnabBudget = typeof ynabBudgets.$inferSelect;
export type NewYnabBudget = typeof ynabBudgets.$inferInsert;

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const ynabCategories = pgTable(
  'ynab_categories',
  {
    /** YNAB category UUID. */
    category_id: text('category_id').primaryKey(),

    budget_id: text('budget_id')
      .notNull()
      .references(() => ynabBudgets.id, { onDelete: 'cascade' }),

    /** YNAB category-group name (e.g. "Monthly Bills", "Just for Fun"). */
    group_name: text('group_name').notNull(),

    /** Category name (e.g. "Internet", "Groceries"). */
    name: text('name').notNull(),

    /** Hidden categories live in YNAB's "Hidden Categories" group; the
     *  dashboard skips them by default to match what the user sees in
     *  YNAB itself. */
    hidden: boolean('hidden').notNull().default(false),

    last_synced_at: timestamp('last_synced_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('ynab_categories_budget_idx').on(t.budget_id)],
);

export type YnabCategory = typeof ynabCategories.$inferSelect;
export type NewYnabCategory = typeof ynabCategories.$inferInsert;

// ---------------------------------------------------------------------------
// Month categories — assigned / activity / balance per (budget, month, category)
// ---------------------------------------------------------------------------

export const ynabMonthCategories = pgTable(
  'ynab_month_categories',
  {
    budget_id: text('budget_id')
      .notNull()
      .references(() => ynabBudgets.id, { onDelete: 'cascade' }),

    /** First day of the YNAB month (e.g. 2026-05-01). */
    month: date('month').notNull(),

    category_id: text('category_id')
      .notNull()
      .references(() => ynabCategories.category_id, { onDelete: 'cascade' }),

    /** Milliunits. Positive = budgeted amount. */
    assigned: bigint('assigned', { mode: 'number' }).notNull().default(0),

    /** Milliunits. NEGATIVE for outflows (matches YNAB's convention),
     *  POSITIVE for inflows. The bill-over-budget widget compares
     *  -activity against assigned. */
    activity: bigint('activity', { mode: 'number' }).notNull().default(0),

    /** Milliunits. assigned + activity (carry-over included). */
    balance: bigint('balance', { mode: 'number' }).notNull().default(0),

    last_synced_at: timestamp('last_synced_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.budget_id, t.month, t.category_id] }),
    index('ynab_month_categories_month_idx').on(t.month),
  ],
);

export type YnabMonthCategory = typeof ynabMonthCategories.$inferSelect;
export type NewYnabMonthCategory = typeof ynabMonthCategories.$inferInsert;

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export const ynabTransactions = pgTable(
  'ynab_transactions',
  {
    /** YNAB transaction UUID. */
    id: text('id').primaryKey(),

    budget_id: text('budget_id')
      .notNull()
      .references(() => ynabBudgets.id, { onDelete: 'cascade' }),

    /** YNAB account UUID. Stored for filtering but no FK — we don't
     *  cache the YNAB accounts list in V1. */
    account_id: text('account_id').notNull(),

    posted_date: date('posted_date').notNull(),

    /** Milliunits, signed (negative = outflow). */
    amount: bigint('amount', { mode: 'number' }).notNull(),

    payee_name: text('payee_name'),
    memo: text('memo'),

    /** Nullable — YNAB allows uncategorised transactions. References the
     *  cached category cache row when present; soft FK (no DB constraint)
     *  so an unknown category from a stale sync doesn't error the insert. */
    category_id: text('category_id'),

    /**
     * YNAB account UUID of the other side of a transfer, when present.
     * NULL on regular income / outflow transactions. Used by the Money
     * dashboard to filter transfers out of "income" and "pacing spend"
     * — otherwise moving money between accounts shows up as both.
     */
    transfer_account_id: text('transfer_account_id'),

    cleared: varchar('cleared', { length: 12 }).notNull(),
    //   "cleared" | "uncleared" | "reconciled"
    approved: boolean('approved').notNull().default(true),

    last_synced_at: timestamp('last_synced_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('ynab_transactions_budget_idx').on(t.budget_id),
    index('ynab_transactions_posted_date_idx').on(t.posted_date),
    index('ynab_transactions_category_idx').on(t.category_id),
    index('ynab_transactions_transfer_idx').on(t.transfer_account_id),
  ],
);

export type YnabTransaction = typeof ynabTransactions.$inferSelect;
export type NewYnabTransaction = typeof ynabTransactions.$inferInsert;
