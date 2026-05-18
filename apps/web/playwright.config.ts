import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright smoke tests for the Money + Investments redesign.
 *
 * Scope: public flows (the SignIn page renders) and the ProtectedRoute
 * redirect guard. Cognito-authenticated journeys are not covered here
 * because they require real credentials; those land in a separate
 * `e2e-auth` config when test credentials exist.
 *
 * Usage: `pnpm exec playwright test` (assumes `pnpm dev` is running, or
 * the `webServer` block below spins one up).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
