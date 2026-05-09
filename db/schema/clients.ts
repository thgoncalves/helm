import {
  pgTable,
  uuid,
  text,
  boolean,
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

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('clients_is_active_idx').on(t.isActive)],
);

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
