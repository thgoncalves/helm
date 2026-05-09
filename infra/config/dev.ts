/**
 * Configuration for the `dev` environment.
 *
 * The dev Amplify Gen 2 backend deployed on 2026-05-08; the User Pool below
 * is the one Amplify created for the `dev` branch.  If the dev backend is
 * ever destroyed and recreated, update this ID to match the new pool.
 */
import type { EnvConfig } from './main.js';

export const devConfig: EnvConfig = {
  env: 'dev',
  userPoolId: 'ca-central-1_LeWajbbXR',
};
