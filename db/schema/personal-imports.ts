import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  varchar,
  index,
} from 'drizzle-orm/pg-core';
import { personalAccounts } from './accounts';

/**
 * One row per CSV statement upload. Tracks the S3 object, parser
 * choice, and per-import counts so the user can see what happened on
 * the Imports page.
 *
 * Lifecycle:
 *   pending     row created, file uploaded to S3 (PUT in flight)
 *   processing  S3 event fired, CSV parser running
 *   ready       parse succeeded — see `imported_count` / `skipped_count`
 *   failed      parse errored — see `error`
 */
export const personalImports = pgTable(
  'personal_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    account_id: uuid('account_id')
      .notNull()
      .references(() => personalAccounts.id),
    institution: varchar('institution', { length: 30 }).notNull(),
    //   Drives parser dispatch. Stored on the import row so a future
    //   reparse uses the same parser the user picked at upload time.

    status: varchar('status', { length: 20 }).notNull().default('pending'),

    s3_key: text('s3_key').notNull(),
    filename: text('filename'),
    size_bytes: integer('size_bytes'),

    row_count: integer('row_count'),         // total rows in the file
    imported_count: integer('imported_count'), // newly inserted
    skipped_count: integer('skipped_count'), // duplicates skipped

    error: text('error'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('personal_imports_account_idx').on(t.account_id),
    index('personal_imports_status_idx').on(t.status),
  ],
);

export type PersonalImport = typeof personalImports.$inferSelect;
export type NewPersonalImport = typeof personalImports.$inferInsert;
