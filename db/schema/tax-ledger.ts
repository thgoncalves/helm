import {
  pgTable,
  uuid,
  text,
  date,
  numeric,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

export const taxLedger = pgTable('tax_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  taxType: varchar('tax_type', { length: 20 }).notNull(),
  taxPeriod: text('tax_period').notNull(),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  taxRate: numeric('tax_rate', { precision: 6, scale: 4 }).notNull(),
  taxableAmount: numeric('taxable_amount', { precision: 15, scale: 2 }).notNull(),
  taxAmount: numeric('tax_amount', { precision: 15, scale: 2 }).notNull(),
  paidStatus: varchar('paid_status', { length: 20 }).notNull().default('unpaid'),
  paidDate: date('paid_date'),
  paidAmount: numeric('paid_amount', { precision: 15, scale: 2 }).default('0'),
  paymentMethod: text('payment_method'),
  paymentReference: text('payment_reference'),
  notes: text('notes'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type TaxLedgerEntry = typeof taxLedger.$inferSelect;
export type NewTaxLedgerEntry = typeof taxLedger.$inferInsert;
