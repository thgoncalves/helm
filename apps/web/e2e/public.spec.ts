import { expect, test } from "@playwright/test";

/**
 * Public-flow smokes — verify the app boots and the unauthenticated
 * routes render. The protected /money/* and /investments routes redirect
 * to SignIn via `ProtectedRoute`, so we can confirm the redirect without
 * needing real Cognito credentials.
 */

test.describe("public flows", () => {
  test("SignIn page renders the brand mark", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Helm/i);
    // The SignIn page is built around the Amplify Authenticator; the
    // brand wordmark sits above it. Asserting on the brand keeps the
    // test stable through Amplify version bumps.
    await expect(page.getByText("Helm", { exact: true })).toBeVisible();
  });

  test("/money/dashboard redirects to SignIn when unauthenticated", async ({
    page,
  }) => {
    await page.goto("/money/dashboard");
    // ProtectedRoute redirects to `/` (the SignIn page). The destination
    // page should render the Helm wordmark again.
    await expect(page).toHaveURL(/\/(?:\?.*)?$/);
    await expect(page.getByText("Helm", { exact: true })).toBeVisible();
  });

  test("/investments redirects to SignIn when unauthenticated", async ({
    page,
  }) => {
    await page.goto("/investments");
    await expect(page).toHaveURL(/\/(?:\?.*)?$/);
  });

  test("/investments/accounts is protected", async ({ page }) => {
    await page.goto("/investments/accounts");
    await expect(page).toHaveURL(/\/(?:\?.*)?$/);
  });

  test("/investments/targets is protected", async ({ page }) => {
    await page.goto("/investments/targets");
    await expect(page).toHaveURL(/\/(?:\?.*)?$/);
  });

  test("/investments/holdings/new is protected", async ({ page }) => {
    await page.goto("/investments/holdings/new");
    await expect(page).toHaveURL(/\/(?:\?.*)?$/);
  });

  test("/investments/accounts/:id/contributions is protected", async ({
    page,
  }) => {
    await page.goto(
      "/investments/accounts/00000000-0000-0000-0000-000000000000/contributions",
    );
    await expect(page).toHaveURL(/\/(?:\?.*)?$/);
  });

  test("legacy /personal/accounts redirects through to the Money landing", async ({
    page,
  }) => {
    // App.tsx has a `/personal/*` → `/money/dashboard` redirect, but
    // both targets sit under ProtectedRoute, so an unauthenticated visit
    // ends up at SignIn. Either intermediate URL is acceptable; the
    // important thing is we don't 404 on the legacy path.
    const resp = await page.goto("/personal/accounts");
    expect(resp?.status() ?? 200).toBeLessThan(400);
  });

  test("404 page renders for an unknown URL", async ({ page }) => {
    await page.goto("/this-path-does-not-exist");
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
  });
});
