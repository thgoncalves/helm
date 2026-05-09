#!/usr/bin/env node
/**
 * CDK application entry point.
 *
 * Reads the `env` context key (default: `'dev'`) and loads the matching
 * environment config.  Instantiates DbStack and ApiStack pinned to the
 * Helm AWS account and region.
 *
 * Usage:
 *   npx tsx bin/app.ts                       # dev (default)
 *   cdk synth -c env=main                    # main / prod
 *   cdk synth -c env=main -c userPoolClientId=<id>
 */

import * as cdk from 'aws-cdk-lib';
import { DbStack } from '../lib/db-stack.js';
import { ApiStack } from '../lib/api-stack.js';
import { mainConfig } from '../config/main.js';
import { devConfig } from '../config/dev.js';
import type { EnvConfig } from '../config/main.js';

const app = new cdk.App();

// ---------------------------------------------------------------------------
// Resolve environment config
// ---------------------------------------------------------------------------
const envName = (app.node.tryGetContext('env') as string | undefined) ?? 'dev';

if (envName !== 'main' && envName !== 'dev') {
  throw new Error(
    `Unknown env "${envName}". Valid values: main | dev.\n` +
      `Pass via: cdk synth -c env=main`,
  );
}

const baseConfig: EnvConfig = envName === 'main' ? mainConfig : devConfig;

// Merge in the userPoolClientId from CDK context (optional)
const userPoolClientId =
  (app.node.tryGetContext('userPoolClientId') as string | undefined) ??
  undefined;

const config: EnvConfig = { ...baseConfig, userPoolClientId };

// ---------------------------------------------------------------------------
// Guard: refuse to instantiate stacks when the User Pool ID is missing.
// For dev, synth is allowed to produce a stub (we use a placeholder).
// For main, userPoolId is always hardcoded so this never triggers.
// ---------------------------------------------------------------------------
const awsEnv: cdk.Environment = {
  account: '326543321262',
  region: 'ca-central-1',
};

if (!config.userPoolId) {
  if (envName === 'main') {
    // Should never happen — userPoolId is hardcoded in config/main.ts
    throw new Error('BUG: main userPoolId is empty. Check config/main.ts.');
  }

  // dev: synthesise a stub ApiStack with a placeholder pool ID so `cdk synth`
  // succeeds and developers can inspect the template without a real pool.
  console.warn(
    '\n[helm/infra] WARNING: dev Cognito User Pool not yet configured.\n' +
      'ApiStack will be synthesised with placeholder pool ID "[NotYetSet]".\n' +
      'Do NOT deploy dev until amplify-d3rafk9vdphq49-dev-branch has been\n' +
      'deployed and config/dev.ts is updated with the real userPoolId.\n',
  );

  config.userPoolId = '[NotYetSet]';
}

// ---------------------------------------------------------------------------
// Stacks
// ---------------------------------------------------------------------------
const dbStack = new DbStack(app, `helm-db-${envName}`, {
  stackName: `helm-db-${envName}`,
  config,
  env: awsEnv,
});

new ApiStack(app, `helm-api-${envName}`, {
  stackName: `helm-api-${envName}`,
  config,
  cluster: dbStack.cluster,
  secret: dbStack.secret,
  databaseName: dbStack.databaseName,
  env: awsEnv,
});
