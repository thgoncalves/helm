import {
  pgTable,
  uuid,
  text,
  date,
  numeric,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { taxLedger } from './tax-ledger';

export const taxPayments = pgTable(
  'tax_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taxId: uuid('tax_id').references(() => taxLedger.id),
    paymentDate: date('payment_date').notNull(),
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    paymentMethod: text('payment_method'),
    paymentReference: text('payment_reference'),
    fiscalYear: text('fiscal_year'),
    notes: text('notes'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tax_payments_tax_idx').on(t.taxId),
    index('tax_payments_payment_date_idx').on(t.paymentDate),
  ],
);

export type TaxPayment = typeof taxPayments.$inferSelect;
export type NewTaxPayment = typeof taxPayments.$inferInsert;
