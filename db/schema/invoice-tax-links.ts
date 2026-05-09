import {
  pgTable,
  uuid,
  numeric,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { invoices } from './invoices';
import { taxPayments } from './tax-payments';
import { taxLedger } from './tax-ledger';

export const invoiceTaxLinks = pgTable(
  'invoice_tax_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    taxPaymentId: uuid('tax_payment_id')
      .notNull()
      .references(() => taxPayments.id, { onDelete: 'cascade' }),
    taxId: uuid('tax_id').references(() => taxLedger.id),
    gstAmount: numeric('gst_amount', { precision: 15, scale: 2 }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('invoice_tax_links_unique').on(t.invoiceId, t.taxPaymentId),
    index('invoice_tax_links_tax_payment_idx').on(t.taxPaymentId),
  ],
);

export type InvoiceTaxLink = typeof invoiceTaxLinks.$inferSelect;
export type NewInvoiceTaxLink = typeof invoiceTaxLinks.$inferInsert;
