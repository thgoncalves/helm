import {
  pgTable,
  uuid,
  text,
  numeric,
  date,
  timestamp,
  varchar,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';

/**
 * Stocks V1 — self-managed equity tracking.
 *
 * Per-lot transactions feed a per-(account, ticker) ACB that lives on
 * the existing ``investment_holdings`` row. Yahoo Finance is the price
 * source; quotes and 1Y of daily closes are cached locally so the
 * detail page can render without an upstream round-trip on every view.
 */

// ---------------------------------------------------------------------------
// Transactions — the lots that drive ACB.
// ---------------------------------------------------------------------------

export const stockTransactions = pgTable(
  'stock_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Which table ``account_id`` points at. Polymorphic so a buy can
     *  be recorded against a brokerage cash account that lives in
     *  either of the two account sources Helm aggregates on the
     *  Accounts page (manual_accounts | ynab_accounts). */
    account_source: varchar('account_source', { length: 15 })
      .notNull()
      .default('manual'),

    account_id: uuid('account_id').notNull(),
    //   No FK — the referenced row lives in the table named by
    //   account_source. Integrity is enforced application-side.

    ticker: text('ticker').notNull(),
    //   Yahoo-style symbol. "AAPL", "RY.TO", "PETR4.SA". Free-form —
    //   matched verbatim against what the user types and what Yahoo
    //   accepts.

    transaction_type: varchar('transaction_type', { length: 10 }).notNull(),
    //   "buy" in V1. Reserved values: "sell" | "split" | "dividend".

    transaction_date: date('transaction_date').notNull(),

    quantity: numeric('quantity', { precision: 20, scale: 8 }).notNull(),
    //   Fractional supported.

    unit_price: numeric('unit_price', { precision: 15, scale: 4 }).notNull(),
    //   Per-share, in ``currency``.

    fees: numeric('fees', { precision: 15, scale: 2 }).notNull().default('0'),
    //   Commission on this lot. Included in ACB.

    currency: varchar('currency', { length: 3 }).notNull(),
    //   Trade currency. USD for AAPL; CAD for RY.TO; BRL for PETR4.SA.

    notes: text('notes'),

    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('stock_transactions_account_ticker_idx').on(
      t.account_id,
      t.ticker,
      t.transaction_date,
    ),
    index('stock_transactions_account_source_idx').on(
      t.account_source,
      t.account_id,
      t.ticker,
    ),
  ],
);

export type StockTransaction = typeof stockTransactions.$inferSelect;
export type NewStockTransaction = typeof stockTransactions.$inferInsert;

// ---------------------------------------------------------------------------
// Quote cache — single row per ticker, 15-minute TTL.
// ---------------------------------------------------------------------------

export const stockQuotes = pgTable('stock_quotes', {
  ticker: text('ticker').primaryKey(),
  currency: varchar('currency', { length: 3 }).notNull(),
  last_price: numeric('last_price', { precision: 15, scale: 4 }).notNull(),
  previous_close: numeric('previous_close', { precision: 15, scale: 4 }),
  name: text('name'),
  exchange: text('exchange'),
  fetched_at: timestamp('fetched_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type StockQuote = typeof stockQuotes.$inferSelect;

// ---------------------------------------------------------------------------
// Daily close history — feeds the 1Y chart on the ticker page.
// ---------------------------------------------------------------------------

export const stockPriceHistory = pgTable(
  'stock_price_history',
  {
    ticker: text('ticker').notNull(),
    date: date('date').notNull(),
    close: numeric('close', { precision: 15, scale: 4 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    fetched_at: timestamp('fetched_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ticker, t.date] })],
);

export type StockPriceHistoryRow = typeof stockPriceHistory.$inferSelect;
