import {
  pgTable,
  text,
  integer,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Stocks Research V1 — curated universe of tickers the user can browse
 * to decide what to buy next. Seeded once via SQL migration; not
 * user-editable in V1.
 *
 * Prices for these tickers reuse the existing ``stock_quotes`` cache.
 * Spec: docs/specs/investments-research-v1.md.
 */

export const researchTickers = pgTable(
  'research_tickers',
  {
    ticker: text('ticker').primaryKey(),
    //   Yahoo / Twelve Data style symbol. "AAPL", "RY.TO", etc. Matches
    //   the keys used by ``stock_quotes`` so the LEFT JOIN is trivial.

    name: text('name').notNull(),

    sector: text('sector').notNull(),
    //   GICS-style sector — "Technology", "Financials", "Energy", "ETF",
    //   etc. Used by the sector filter dropdown on the Research page.

    industry: text('industry'),
    //   Finer cut under ``sector``. Currently unused in UI; kept for
    //   future grouping / fundamentals work.

    country: text('country').notNull(),
    //   "US" | "CA". Lets the UI show a small flag inline with the
    //   ticker and biases the FX conversion (most US tickers quote in
    //   USD, TSX tickers quote in CAD).

    sort_order: integer('sort_order').notNull().default(0),
    //   Smaller values sort first. Lets us put ETFs / favourite picks
    //   above the alphabetic rest if we ever want a curated default
    //   order. V1 uses sequential values from the seed.

    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('research_tickers_sector_idx').on(t.sector)],
);

export type ResearchTicker = typeof researchTickers.$inferSelect;
export type NewResearchTicker = typeof researchTickers.$inferInsert;
