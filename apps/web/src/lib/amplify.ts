/**
 * Amplify configuration.
 *
 * Call configureAmplify() once at app startup (in main.tsx) before any
 * auth calls are made. Reads all settings from VITE_* env vars so that
 * no AWS credentials or resource IDs are ever hardcoded in source.
 */
import { Amplify } from "aws-amplify";

function requireEnv(key: string): string {
  const value = import.meta.env[key] as string | undefined;
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${key}. ` +
        `Copy .env.example to .env.local and fill in the values.`,
    );
  }
  return value;
}

export function configureAmplify(): void {
  const region = requireEnv("VITE_AWS_REGION");
  const userPoolId = requireEnv("VITE_COGNITO_USER_POOL_ID");
  const userPoolClientId = requireEnv("VITE_COGNITO_USER_POOL_CLIENT_ID");

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId,
        userPoolClientId,
        signUpVerificationMethod: "code",
        loginWith: {
          email: true,
        },
      },
    },
  });

  // Suppress unused-variable warning — region is used for documentation
  // purposes and may be needed for future Storage configuration.
  void region;
}
