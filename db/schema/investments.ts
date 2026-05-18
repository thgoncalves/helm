import {
  pgTable,
  uuid,
  text,
  boolean,
  numeric,
  date,
  timestamp,
  varchar,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';

/**
 * Investments module — portfolio tracker (V1).
 *
 * Positions only (one row per (account, ticker)) per the user's choice.
 * Lot-by-lot cost basis is deferred until tax-aware features ship.
 *
 * Five account kinds covered:
 *   itrade    Scotia iTrade or any taxable brokerage account in CAD
 *   rrsp      Registered retirement account (CAD, tax-sheltered)
 *   tfsa      Tax-free savings account (CAD)
 *   brazil    Holdings denominated in BRL — converted to CAD via the
 *             `fx_rates` cache for total-portfolio views
 *   corp      Holdings owned by the operating corporation
 *
 * All monetary precision is conservative: 8 decimals for share counts
 * (fractional shares are now table stakes on most brokers); 4 decimals
 * for prices (Brazilian penny-stocks can have prices like 12.3456 BRL);
 * 2 decimals for cash totals and contribution limits.
 */

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export const investmentAccounts = pgTable(
  'investment_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    name: text('name').notNull(),
    kind: varchar('kind', { length: 20 }).notNull(),
    //   "itrade" | "rrsp" | "tfsa" | "brazil" | "corp"

    currency: varchar('currency', { length: 3 }).notNull().default('CAD'),
    //   ISO 4217. BRL for brazil; CAD for everything else (today).

    owner_label: text('owner_label'),
    //   Informational only — "Joint with spouse", "Held in trust", etc.

    contribution_limit: numeric('contribution_limit', {
      precision: 15,
      scale: 2,
    }),
    //   TFSA / RRSP only. Surfaces on the Accounts list so the user
    //   can see remaining room at a glance.

    notes: text('notes'),

    is_active: boolean('is_active').notNull().default(true),

    // ---- Accounts-page taxonomy (cross-source) ----

    /** ``"personal" | "business"``. NULL until the user tags the row
     *  on the Accounts page. Orthogonal to ``kind`` (which is the
     *  regulatory bucket). */
    owner: varchar('owner', { length: 15 }),

    /** ``"investing_fund" | "investing_stock"``. NULL = unassigned.
     *  Funds get a single editable balance on the Accounts page; stocks
     *  use the existing holdings UI under Investments + the
     *  ``cash_balance`` field below. */
    helm_kind: varchar('helm_kind', { length: 30 }),

    /** Issuing institution. Free-form. e.g. "Scotia iTrade", "Itaú
     *  Investimentos". Distinct from ``name`` which is the user-facing
     *  display label. */
    bank: text('bank'),

    /** Uninvested cash on the brokerage account. Stocks-type accounts
     *  show this alongside their holdings; funds-type accounts use it
     *  as the single editable balance. */
    cash_balance: numeric('cash_balance', { precision: 15, scale: 2 })
      .notNull()
      .default('0'),

    /** Cash currency. Falls back to ``currency`` at the API boundary
     *  when NULL — most accounts hold cash in the same currency as
     *  their holdings. */
    cash_currency: varchar('cash_currency', { length: 3 }),

    /** When ``cash_balance`` was last touched. Surfaces as "as of …"
     *  on the Accounts page. */
    balance_as_of: date('balance_as_of'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('investment_accounts_is_active_idx').on(t.is_active),
    index('investment_accounts_kind_idx').on(t.kind),
  ],
);

export type InvestmentAccount = typeof investmentAccounts.$inferSelect;
export type NewInvestmentAccount = typeof investmentAccounts.$inferInsert;

// ---------------------------------------------------------------------------
// Holdings — one row per (account, ticker)
// ---------------------------------------------------------------------------

export const investmentHoldings = pgTable(
  'investment_holdings',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    account_id: uuid('account_id')
      .notNull()
      .references(() => investmentAccounts.id, { onDelete: 'cascade' }),

    ticker: text('ticker').notNull(),
    //   Free-form. Toronto: "VEQT.TO". NY: "AAPL". B3: "PETR4.SA" or just
    //   "PETR4" — we don't validate suffix, just match what the user
    //   sees on their broker statement.

    asset_class: varchar('asset_class', { length: 30 }).notNull(),
    //   See AssetClass enum in services/api/app/models/investments.py.

    shares: numeric('shares', { precision: 20, scale: 8 }).notNull(),
    //   Fractional shares supported (Wealthsimple / iTrade allow them).

    avg_cost: numeric('avg_cost', { precision: 15, scale: 4 }).notNull(),
    //   Per-share, in account currency. User-maintained — manual entry.

    current_price: numeric('current_price', { precision: 15, scale: 4 }).notNull(),
    //   Per-share, in account currency. Manually updated by the user
    //   (no live price feed in V1).

    currency: varchar('currency', { length: 3 }).notNull(),
    //   Stored on the row even though it shadows the account's currency,
    //   so reports don't have to JOIN to figure out the holding's units.

    as_of: date('as_of').notNull(),
    //   When `current_price` was last set. Used in the UI to show
    //   "Prices stale for >X days" hints.

    notes: text('notes'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('investment_holdings_account_idx').on(t.account_id),
    index('investment_holdings_asset_class_idx').on(t.asset_class),
    uniqueIndex('investment_holdings_account_ticker_idx').on(
      t.account_id,
      t.ticker,
    ),
  ],
);

export type InvestmentHolding = typeof investmentHoldings.$inferSelect;
export type NewInvestmentHolding = typeof investmentHoldings.$inferInsert;

// ---------------------------------------------------------------------------
// Target allocation — by asset class, must sum to 100.
// ---------------------------------------------------------------------------

export const targetAllocations = pgTable('target_allocations', {
  asset_class: varchar('asset_class', { length: 30 }).primaryKey(),
  target_pct: numeric('target_pct', { precision: 5, scale: 2 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TargetAllocation = typeof targetAllocations.$inferSelect;
export type NewTargetAllocation = typeof targetAllocations.$inferInsert;

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

// ---------------------------------------------------------------------------
// Contributions — per-deposit / per-withdrawal log on each account.
// ---------------------------------------------------------------------------
//
// Tracks money flowing IN/OUT of the account, separate from buying or
// selling shares. Used for two things:
//
//  1. Brazilian (BRL) accounts — the CAD cost basis of the whole sub-
//     portfolio is the SUM of deposits converted at the FX rate on the
//     day of each deposit, not at today's rate. Each row stores the
//     `fx_rate_cad` snapshot at `contributed_on`, plus a denormalised
//     `amount_cad` so reports don't have to recompute.
//  2. TFSA / RRSP — combined with the account's `contribution_limit`,
//     this drives the "remaining room" widget on the Overview.

export const investmentContributions = pgTable(
  'investment_contributions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    account_id: uuid('account_id')
      .notNull()
      .references(() => investmentAccounts.id, { onDelete: 'cascade' }),

    contributed_on: date('contributed_on').notNull(),

    kind: varchar('kind', { length: 15 }).notNull().default('deposit'),
    //   "deposit" | "withdrawal"

    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    //   Always positive — sign comes from `kind`.

    currency: varchar('currency', { length: 3 }).notNull(),

    fx_rate_cad: numeric('fx_rate_cad', { precision: 15, scale: 8 }).notNull(),
    //   Units of CAD per 1 unit of `currency` on the day of the
    //   contribution. 1.0 when currency == CAD. Snapshot at write time
    //   so today's rate doesn't retroactively rewrite cost basis.

    amount_cad: numeric('amount_cad', { precision: 15, scale: 2 }).notNull(),
    //   `amount * fx_rate_cad`, signed by `kind`. Denormalised on
    //   insert/update so report queries don't have to join + multiply.

    notes: text('notes'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('investment_contributions_account_idx').on(t.account_id),
    index('investment_contributions_date_idx').on(t.contributed_on),
  ],
);

export type InvestmentContribution =
  typeof investmentContributions.$inferSelect;
export type NewInvestmentContribution =
  typeof investmentContributions.$inferInsert;
