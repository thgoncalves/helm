import {
  pgTable,
  uuid,
  text,
  boolean,
  numeric,
  timestamp,
  varchar,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Personal-side accounts: checking, savings, credit cards, etc.
 *
 * V1 covers cash-flow accounts (where a CSV statement → transactions
 * makes sense). Investment / brokerage accounts get their own table in
 * V2 because holdings + positions don't fit the `transactions` shape.
 *
 * Archival via ``is_active`` toggle — we never hard-delete because
 * past transactions reference the account.
 */
export const personalAccounts = pgTable(
  'personal_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    name: text('name').notNull(),
    institution: varchar('institution', { length: 30 }).notNull(),
    //   "RBC" | "TD" | "Scotia" | "Other"  (V1 set of CSV parsers)
    account_type: varchar('account_type', { length: 20 }).notNull(),
    //   "checking" | "savings" | "credit_card" | "cash"
    currency: varchar('currency', { length: 3 }).notNull().default('CAD'),

    opening_balance: numeric('opening_balance', {
      precision: 15,
      scale: 2,
    }).default('0'),

    is_active: boolean('is_active').notNull().default(true),
    notes: text('notes'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('personal_accounts_is_active_idx').on(t.is_active)],
);

export type PersonalAccount = typeof personalAccounts.$inferSelect;
export type NewPersonalAccount = typeof personalAccounts.$inferInsert;
