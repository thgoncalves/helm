import {
  pgTable,
  uuid,
  text,
  date,
  numeric,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { invoices } from './invoices';

export const paymentsReceived = pgTable(
  'payments_received',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    paymentDate: date('payment_date').notNull(),
    amount: numeric('amount', { precision: 15, scale: 2 }).notNull(),
    paymentMethod: text('payment_method'),
    reference: text('reference'),
    notes: text('notes'),
    deductionAmount: numeric('deduction_amount', { precision: 15, scale: 2 })
      .notNull()
      .default('0'),
    deductionDescription: text('deduction_description'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payments_received_invoice_idx').on(t.invoiceId),
    index('payments_received_payment_date_idx').on(t.paymentDate),
  ],
);

export type PaymentReceived = typeof paymentsReceived.$inferSelect;
export type NewPaymentReceived = typeof paymentsReceived.$inferInsert;
