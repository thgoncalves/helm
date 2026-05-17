import {
  pgTable,
  uuid,
  date,
  numeric,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { clients } from './clients';
import { invoices } from './invoices';

// Note: legacy CSV had a `description` column. Dropped per V1 spec
// (the user does not record what was done per entry).
export const timeEntries = pgTable(
  'time_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    workDate: date('work_date').notNull(),
    hours: numeric('hours', { precision: 5, scale: 2 }).notNull(),
    invoiceId: uuid('invoice_id').references(() => invoices.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('time_entries_client_idx').on(t.clientId),
    index('time_entries_work_date_idx').on(t.workDate),
    index('time_entries_invoice_idx').on(t.invoiceId),
    // V1 timesheet model: exactly one entry per (client, day). Lets us
    // INSERT ... ON CONFLICT for the bulk upsert path.
    uniqueIndex('time_entries_client_work_date_unique').on(
      t.clientId,
      t.workDate,
    ),
  ],
);

export type TimeEntry = typeof timeEntries.$inferSelect;
export type NewTimeEntry = typeof timeEntries.$inferInsert;
