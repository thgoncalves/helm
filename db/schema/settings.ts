import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Application settings as a key/value table.
// Known V1 keys (carried from legacy): `gst_rate`, `default_currency`.
// Values are stored as TEXT and parsed at the application layer.
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;
