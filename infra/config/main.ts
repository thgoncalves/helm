/**
 * Configuration for the `main` (production) environment.
 *
 * The User Pool ID is hardcoded here because it was created by the Amplify
 * Gen 2 stack `amplify-d3rafk9vdphq49-main-branch-3480dfaea8-auth179371D7-2ZZ7HHW9SRTS`
 * and is stable for the lifetime of that Amplify app.  If Amplify ever tears
 * down and recreates the auth stack (e.g. after a destroy + redeploy), update
 * this value and redeploy the CDK stacks.
 *
 * The User Pool Client ID is NOT hardcoded because it changes if the Amplify
 * auth stack is recreated.  Pass it at synth/deploy time:
 *
 *   cdk synth -c env=main -c userPoolClientId=<id>
 *   pnpm --filter @helm/infra deploy:main -- -c userPoolClientId=<id>
 *
 * To find the client ID:
 *   aws --profile helm cognito-idp list-user-pool-clients \
 *     --user-pool-id ca-central-1_QTDeN4z06 \
 *     --query 'UserPoolClients[].{Name:ClientName,Id:ClientId}'
 */
export interface EnvConfig {
  /** Logical environment name — matches the CDK context `env` key. */
  env: 'main' | 'dev';
  /** Cognito User Pool ID for this environment. */
  userPoolId: string;
  /**
   * Cognito User Pool Client ID.  Optional — when omitted the JWT authoriser
   * accepts tokens from any client in the pool (a hardening TODO).
   * Provided via CDK context: `-c userPoolClientId=<id>`.
   */
  userPoolClientId?: string;
}

export const mainConfig: EnvConfig = {
  env: 'main',
  // Cognito User Pool deployed by Amplify Gen 2 on the `main` branch.
  // Stack: amplify-d3rafk9vdphq49-main-branch-3480dfaea8-auth179371D7-2ZZ7HHW9SRTS
  userPoolId: 'ca-central-1_QTDeN4z06',
};
