import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { receipts, documents } from './storage/resource';

/**
 * Helm Amplify Gen 2 backend.
 *
 * Resources defined here:
 *   - auth      — Cognito User Pool (email/password, no self-signup)
 *   - receipts  — S3 bucket for receipt images (private per identity)
 *   - documents — S3 bucket for generated PDFs and CSV imports (private per identity)
 *
 * The block below applies password policy and self-signup settings via the
 * CDK escape hatch on the L1 CfnUserPool, because `defineAuth` does not expose
 * these as first-class props. We disable self-signup (admin-only account
 * creation) and explicitly set a 12-character minimum with lowercase,
 * uppercase, number, and symbol all required.
 */
const backend = defineBackend({ auth, receipts, documents });

// ── CDK escape hatch: disable self-signup ────────────────────────────────────
// The Amplify defineAuth abstraction does not expose selfSignUpEnabled, so we
// reach down to the L1 CfnUserPool resource.
const { cfnUserPool } = backend.auth.resources.cfnResources;
cfnUserPool.adminCreateUserConfig = {
  allowAdminCreateUserOnly: true,
};

// ── CDK escape hatch: stronger password policy ────────────────────────────────
cfnUserPool.policies = {
  passwordPolicy: {
    minimumLength: 12,
    requireLowercase: true,
    requireUppercase: true,
    requireNumbers: true,
    requireSymbols: true,
  },
};
