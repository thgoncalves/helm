import {
  pgTable,
  uuid,
  text,
  date,
  numeric,
  timestamp,
  varchar,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { personalAccounts } from './accounts';
import { personalImports } from './personal-imports';

/**
 * One row per transaction on a Personal account. Sourced from CSV
 * imports for now; manual entry comes later.
 *
 * ``amount`` is signed — positive = credit (deposit, interest, refund);
 * negative = debit (purchase, withdrawal, fee). Keeps reporting math
 * trivial: ``SUM(amount)`` is a real running net.
 *
 * Dedup invariant: unique on (account_id, posted_date, amount,
 * description). Canadian banks rarely emit stable transaction IDs in
 * their CSV exports, so we use this composite key to skip duplicates
 * when the user re-imports an overlapping statement.
 */
export const personalTransactions = pgTable(
  'personal_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    account_id: uuid('account_id')
      .notNull()
      .references(() => personalAccounts.id),
    import_id: uuid('import_id').references(() => personalImports.id, {
      onDelete: 'set null',
    }),

    posted_date: date('posted_date').notNull(),
    description: text('description').notNull(),
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    balance: numeric('balance', { precision: 15, scale: 2 }),
    category: varchar('category', { length: 50 }),
    external_id: text('external_id'),  // bank's txn ID when present

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('personal_transactions_account_idx').on(t.account_id),
    index('personal_transactions_posted_date_idx').on(t.posted_date),
    uniqueIndex('personal_transactions_dedup_idx').on(
      t.account_id,
      t.posted_date,
      t.amount,
      t.description,
    ),
  ],
);

export type PersonalTransaction = typeof personalTransactions.$inferSelect;
export type NewPersonalTransaction = typeof personalTransactions.$inferInsert;
