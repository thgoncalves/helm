import {
  pgTable,
  varchar,
  date,
  timestamp,
  text,
  numeric,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Investments module — FX cache only.
 *
 * The legacy ``investment_accounts``, ``investment_holdings``,
 * ``target_allocations`` and ``investment_contributions`` tables were
 * dropped in migration ``0018_drop_investment_legacy``. Funds live in
 * ``manual_accounts`` and ``ynab_accounts`` (tagged ``investing_fund``);
 * stocks live in ``stock_transactions``.
 */

// ---------------------------------------------------------------------------
// FX rates cache — Bank of Canada Valet API.
// ---------------------------------------------------------------------------

export const fxRates = pgTable(
  'fx_rates',
  {
    from_currency: varchar('from_currency', { length: 3 }).notNull(),
    to_currency: varchar('to_currency', { length: 3 }).notNull(),
    rate_date: date('rate_date').notNull(),

    rate: numeric('rate', { precision: 15, scale: 8 }).notNull(),
    //   Units of `to_currency` per 1 unit of `from_currency`.
    //   e.g. BRL→CAD ~= 0.27 means 1 BRL = 0.27 CAD.

    source: text('source').notNull().default('BoC'),

    fetched_at: timestamp('fetched_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.from_currency, t.to_currency, t.rate_date] }),
    index('fx_rates_recent_idx').on(t.from_currency, t.to_currency, t.rate_date),
  ],
);

export type FxRate = typeof fxRates.$inferSelect;
export type NewFxRate = typeof fxRates.$inferInsert;
