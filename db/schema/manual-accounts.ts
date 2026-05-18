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
} from 'drizzle-orm/pg-core';

/**
 * Non-YNAB, non-investment cash accounts.
 *
 * The Accounts page unions these with ``ynab_accounts`` (read-only,
 * synced from YNAB) and ``investment_accounts`` (portfolio rows). Use
 * this table for things like a Brazilian checking account at Itaú that
 * the user wants to see alongside their Canadian accounts but isn't
 * going to wire into YNAB.
 *
 * Balances are point-in-time: the user enters a number and we stamp
 * ``balance_as_of``. There is intentionally no transaction ledger — if
 * the user wants one, they should track that account in YNAB instead.
 */

export const manualAccounts = pgTable(
  'manual_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Display name. e.g. "Itaú checking". */
    name: text('name').notNull(),

    /** Issuing bank. Free-form. e.g. "Itaú", "Bradesco". */
    bank: text('bank'),

    /** ISO 4217. Defaults to BRL — most manual accounts will be Brazil. */
    currency: varchar('currency', { length: 3 }).notNull().default('BRL'),

    /** Native-currency balance the user last entered. */
    balance: numeric('balance', { precision: 15, scale: 2 })
      .notNull()
      .default('0'),

    /** When ``balance`` was last touched. Bumped on every PATCH that
     *  includes a balance field. The Accounts page shows "as of …". */
    balance_as_of: date('balance_as_of').notNull().defaultNow(),

    /** Helm taxonomy: ``"checking" | "savings" | "line_of_credit"``. */
    kind: varchar('kind', { length: 30 }).notNull(),

    /** ``"personal" | "business"``. */
    owner: varchar('owner', { length: 15 }).notNull(),

    notes: text('notes'),

    is_active: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('manual_accounts_owner_idx').on(t.owner),
    index('manual_accounts_kind_idx').on(t.kind),
  ],
);

export type ManualAccount = typeof manualAccounts.$inferSelect;
export type NewManualAccount = typeof manualAccounts.$inferInsert;
