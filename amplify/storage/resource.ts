import { defineStorage } from '@aws-amplify/backend';

/**
 * S3 bucket for receipt images.
 *
 * Each Cognito identity gets a private prefix: `receipts/{entity_id}/*`
 * The `{entity_id}` token is replaced at runtime by the Cognito Identity Pool
 * identity ID of the signed-in user, scoping read/write/delete to that user's
 * objects only.
 *
 * Marked `isDefault: true` because this is the primary storage resource (only
 * one bucket may carry this flag per backend).
 */
export const receipts = defineStorage({
  name: 'receipts',
  isDefault: true,
  access: (allow) => ({
    'receipts/{entity_id}/*': [
      allow.entity('identity').to(['read', 'write', 'delete']),
    ],
  }),
});

/**
 * S3 bucket for generated documents (PDF timesheets, PDF invoices) and staged
 * CSV imports.
 *
 * Each Cognito identity gets a private prefix: `documents/{entity_id}/*`
 * The `{entity_id}` token is replaced at runtime by the Cognito Identity Pool
 * identity ID, scoping access to that user's documents only.
 */
export const documents = defineStorage({
  name: 'documents',
  access: (allow) => ({
    'documents/{entity_id}/*': [
      allow.entity('identity').to(['read', 'write', 'delete']),
    ],
  }),
});
