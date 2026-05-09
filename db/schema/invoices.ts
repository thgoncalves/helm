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
import { clients } from './clients';

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceNumber: text('invoice_number').notNull().unique(),
    issueDate: date('issue_date').notNull(),
    dueDate: date('due_date'),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    status: varchar('status', { length: 20 }).notNull().default('draft'),
    currency: varchar('currency', { length: 3 }).notNull().default('CAD'),

    subtotal: numeric('subtotal', { precision: 15, scale: 2 }).notNull(),
    taxAmount: numeric('tax_amount', { precision: 15, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 15, scale: 2 }).notNull(),

    notes: text('notes'),
    paymentTerms: text('payment_terms'),
    attachmentsPath: text('attachments_path'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('invoices_client_idx').on(t.clientId),
    index('invoices_status_idx').on(t.status),
    index('invoices_issue_date_idx').on(t.issueDate),
  ],
);

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
