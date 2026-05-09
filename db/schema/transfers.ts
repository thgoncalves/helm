import {
  pgTable,
  uuid,
  text,
  date,
  numeric,
  timestamp,
  varchar,
  index,
} from 'drizzle-orm/pg-core';
import { taxLedger } from './tax-ledger';

export const transfers = pgTable(
  'transfers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transferDate: date('transfer_date').notNull(),
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    method: varchar('method', { length: 50 }),
    purpose: text('purpose'),
    category: varchar('category', { length: 50 }),

    estimatedTaxCompany: numeric('estimated_tax_company', { precision: 15, scale: 2 }),
    estimatedTaxPersonal: numeric('estimated_tax_personal', { precision: 15, scale: 2 }),
    actualTaxPaidCompany: numeric('actual_tax_paid_company', { precision: 15, scale: 2 }),
    actualTaxPaidPersonal: numeric('actual_tax_paid_personal', { precision: 15, scale: 2 }),

    taxLedgerLinkCompany: uuid('tax_ledger_link_company').references(() => taxLedger.id),
    taxLedgerLinkPersonal: uuid('tax_ledger_link_personal').references(() => taxLedger.id),

    notes: text('notes'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('transfers_transfer_date_idx').on(t.transferDate)],
);

export type Transfer = typeof transfers.$inferSelect;
export type NewTransfer = typeof transfers.$inferInsert;
