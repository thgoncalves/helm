import {
  pgTable,
  uuid,
  text,
  date,
  integer,
  numeric,
  jsonb,
  timestamp,
  varchar,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Expenses — receipts and supplier invoices the user uploads (typically
 * via phone camera). Lifecycle:
 *
 *   pending     row created, file expected in S3 (upload in flight)
 *   processing  S3 event fired, Textract AnalyzeExpense running
 *   ready       OCR succeeded; user can review/edit
 *   failed      Textract errored or produced nothing usable; user can
 *               still fill in fields manually
 *
 * ``s3_key`` is the canonical pointer to the image in the helm-receipts
 * bucket — backend generates presigned PUT/GET URLs from it. ``ocr_raw``
 * keeps the full Textract response so the extraction logic can be
 * improved later without re-uploading the image.
 */
export const expenses = pgTable(
  'expenses',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    status: varchar('status', { length: 20 }).notNull().default('pending'),

    s3_key: text('s3_key').notNull(),
    content_type: varchar('content_type', { length: 60 }),
    size_bytes: integer('size_bytes'),

    expense_date: date('expense_date'),
    supplier: text('supplier'),
    category: varchar('category', { length: 50 }),
    subtotal: numeric('subtotal', { precision: 15, scale: 2 }),
    tax_amount: numeric('tax_amount', { precision: 15, scale: 2 }),
    total: numeric('total', { precision: 15, scale: 2 }),
    currency: varchar('currency', { length: 3 }).default('CAD'),
    notes: text('notes'),

    ocr_raw: jsonb('ocr_raw'),
    ocr_error: text('ocr_error'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('expenses_status_idx').on(t.status),
    index('expenses_expense_date_idx').on(t.expense_date),
  ],
);

export type Expense = typeof expenses.$inferSelect;
export type NewExpense = typeof expenses.$inferInsert;
