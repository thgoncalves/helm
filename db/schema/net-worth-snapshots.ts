import {
  pgTable,
  date,
  numeric,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Monthly snapshots of total net worth + breakdown by kind / owner.
 *
 * Idempotent on ``snapshot_month`` (always the first day of the
 * month). The aggregator that fills this table is shared with
 * ``/money/health`` so a snapshot and the live KPI always agree.
 *
 * Captured after every write that changes a balance: YNAB refresh,
 * manual-account CRUD, investment-account update, and the kind/owner
 * tag PATCHes. We don't run a cron — the table is purely
 * write-triggered.
 */

export const netWorthSnapshots = pgTable('net_worth_snapshots', {
  snapshot_month: date('snapshot_month').primaryKey(),

  assets_cad: numeric('assets_cad', { precision: 15, scale: 2 }).notNull(),
  liabilities_cad: numeric('liabilities_cad', {
    precision: 15,
    scale: 2,
  }).notNull(),

  // Breakdown by Helm kind, CAD. ``investing_cad`` covers both
  // ``investing_fund`` and ``investing_stock``; ``lending_cad`` covers
  // ``credit_card`` and ``line_of_credit``.
  checking_cad: numeric('checking_cad', { precision: 15, scale: 2 })
    .notNull()
    .default('0'),
  savings_cad: numeric('savings_cad', { precision: 15, scale: 2 })
    .notNull()
    .default('0'),
  investing_cad: numeric('investing_cad', { precision: 15, scale: 2 })
    .notNull()
    .default('0'),
  lending_cad: numeric('lending_cad', { precision: 15, scale: 2 })
    .notNull()
    .default('0'),

  // Breakdown by owner, CAD. Excludes ``unassigned`` (those still
  // contribute to assets_cad / liabilities_cad).
  personal_cad: numeric('personal_cad', { precision: 15, scale: 2 })
    .notNull()
    .default('0'),
  business_cad: numeric('business_cad', { precision: 15, scale: 2 })
    .notNull()
    .default('0'),

  taken_at: timestamp('taken_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type NetWorthSnapshot = typeof netWorthSnapshots.$inferSelect;
export type NewNetWorthSnapshot = typeof netWorthSnapshots.$inferInsert;
