import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  boolean,
  varchar,
  index,
} from 'drizzle-orm/pg-core';
import { invoices } from './invoices';

export const invoiceLineItems = pgTable(
  'invoice_line_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    lineOrder: integer('line_order').notNull(),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 10, scale: 2 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 15, scale: 2 }).notNull(),
    taxCategory: varchar('tax_category', { length: 20 }),
    isTaxable: boolean('is_taxable').notNull().default(true),
    taxRate: numeric('tax_rate', { precision: 6, scale: 4 }),
    lineSubtotal: numeric('line_subtotal', { precision: 15, scale: 2 }).notNull(),
    lineTax: numeric('line_tax', { precision: 15, scale: 2 }).notNull().default('0'),
    lineTotal: numeric('line_total', { precision: 15, scale: 2 }).notNull(),
  },
  (t) => [index('invoice_line_items_invoice_idx').on(t.invoiceId)],
);

export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;
export type NewInvoiceLineItem = typeof invoiceLineItems.$inferInsert;
