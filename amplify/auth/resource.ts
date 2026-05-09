import { defineAuth } from '@aws-amplify/backend';

/**
 * Cognito User Pool for Helm.
 *
 * Sign-in: email + password only. No federation in V1.
 *
 * Self-signup is disabled — users must be created by an administrator via the
 * Cognito console or AWS CLI. Apply the override in backend.ts after calling
 * defineBackend() using the CDK escape hatch on
 * `backend.auth.resources.cfnResources.cfnUserPool`.
 *
 * Password policy (stronger than the Amplify default of 8 chars):
 *   - minimum 12 characters
 *   - requires lowercase, uppercase, number, and symbol
 *
 * Account recovery: EMAIL_ONLY — password reset emails only (no phone fallback).
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  accountRecovery: 'EMAIL_ONLY',
});
