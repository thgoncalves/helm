import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  numeric,
  timestamp,
  varchar,
  index,
} from 'drizzle-orm/pg-core';

export const clients = pgTable(
  'clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),

    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    country: text('country'),

    taxId: text('tax_id'),
    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    hourlyRate: numeric('hourly_rate', { precision: 10, scale: 2 }),
    timesheetFrequency: varchar('timesheet_frequency', { length: 20 }).default('monthly'),

    // Total contract value in `contractCurrency` (V1: one active contract per
    // client). Used to compute "remaining $ / hours" on the timesheet page.
    contractValue: numeric('contract_value', { precision: 15, scale: 2 }),
    contractCurrency: varchar('contract_currency', { length: 3 }).default('CAD'),
    // Default line-item description that shows up on every populated row of
    // the exported PDF timesheet (e.g. "Consulting services in ETL, ML and AI").
    defaultTaskDescription: text('default_task_description'),

    // Invoicing defaults — applied when an invoice is auto-created from a
    // submitted timesheet. The user can still override per-line on the
    // invoice form.
    defaultTaxable: boolean('default_taxable').notNull().default(true),
    defaultTaxRate: numeric('default_tax_rate', { precision: 6, scale: 4 }),
    // Net-N payment terms in days (Sulpetro/CP = 30, Wenco = 15).
    defaultPaymentTermsDays: integer('default_payment_terms_days')
      .notNull()
      .default(30),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('clients_is_active_idx').on(t.isActive)],
);

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
