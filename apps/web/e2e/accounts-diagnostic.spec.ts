/**
 * One-shot diagnostic for the /accounts page.
 *
 * Captures every console error and every failing network response while
 * the page boots so we can see exactly what the browser sees. Not a
 * regression test — produces a structured report on stderr/stdout.
 *
 * Run with:
 *   pnpm exec playwright test e2e/accounts-diagnostic.spec.ts --reporter=list
 */
import { test } from "@playwright/test";

interface NetIssue {
  url: string;
  status: number;
  method: string;
  body: string;
}

test("diagnostic: /accounts page network + console", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const netIssues: NetIssue[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("response", async (resp) => {
    if (resp.status() >= 400) {
      let body = "";
      try {
        body = (await resp.text()).slice(0, 400);
      } catch {
        body = "<body unavailable>";
      }
      netIssues.push({
        url: resp.url(),
        status: resp.status(),
        method: resp.request().method(),
        body,
      });
    }
  });

  // ProtectedRoute will redirect us to / since we aren't signed in, but
  // the JS bundle for /accounts still loads (App.tsx imports it) — so
  // any syntax / runtime errors in Accounts.tsx surface here too.
  await page.goto("/accounts", { waitUntil: "networkidle" });

  // Settle a moment in case any tail-end requests are still landing.
  await page.waitForTimeout(500);

  // eslint-disable-next-line no-console
  console.log(
    "\n=== /accounts diagnostic ===\n" +
      JSON.stringify(
        {
          finalUrl: page.url(),
          consoleErrors,
          pageErrors,
          networkFailures: netIssues,
        },
        null,
        2,
      ),
  );
});
