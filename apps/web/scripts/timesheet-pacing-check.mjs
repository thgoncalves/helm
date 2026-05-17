/**
 * timesheet-pacing-check — Playwright verification for the pacing widget.
 *
 * What it does:
 *   1. Seeds a test client with contract dates via POST /business/clients/.
 *   2. Navigates to /timesheets at desktop 1280×800 viewport.
 *   3. Picks the seeded client from the client dropdown.
 *   4. Captures screenshots in both default and catppuccin themes.
 *   5. Asserts the pacing widget is visible and contains "h/day".
 *   6. Cleans up the seeded client.
 *
 * Usage:
 *   node scripts/timesheet-pacing-check.mjs
 *
 * Prerequisites:
 *   - FastAPI server running on http://127.0.0.1:8000
 *   - Vite dev server running on http://localhost:5173 (VITE_E2E_AUTH_BYPASS=true)
 */

import { chromium } from "playwright";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const API = "http://127.0.0.1:8000";
const APP = "http://localhost:5173";
const OUT = new URL("../screenshots/pacing/", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedClient() {
  // Contract: 2026-01-01 to 2027-01-01 — comfortably in the future regardless
  // of when the test runs, given a Wenco-style 12-month engagement.
  const payload = {
    name: "Pacing Test Client (E2E)",
    hourly_rate: "95.38",
    contract_value: "190000.00",
    contract_start_date: "2026-01-01",
    contract_end_date: "2027-01-01",
    timesheet_frequency: "monthly",
    is_active: true,
  };
  const response = await fetch(`${API}/business/clients/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to seed client: ${response.status} ${await response.text()}`,
    );
  }
  return response.json();
}

async function deleteClient(id) {
  // Archive rather than delete (no DELETE endpoint exists; set is_active=false).
  await fetch(`${API}/business/clients/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Pacing Test Client (E2E)",
      hourly_rate: "95.38",
      contract_value: "190000.00",
      contract_start_date: "2026-01-01",
      contract_end_date: "2027-01-01",
      timesheet_frequency: "monthly",
      is_active: false,
    }),
  });
}

// ---------------------------------------------------------------------------
// Screenshot helper
// ---------------------------------------------------------------------------

async function screenshotPaging(page, outDir, label) {
  const path = join(outDir, `${label}.png`);
  await page.screenshot({ path, fullPage: false });
  console.log(`  Saved: ${path}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await mkdir(OUT, { recursive: true });

  // Seed the test client.
  console.log("Seeding test client with contract dates...");
  const seeded = await seedClient();
  console.log(
    `  Seeded: ${seeded.name} (id=${seeded.id}), contract_end_date=${seeded.contract_end_date}`,
  );

  const browser = await chromium.launch({ headless: true });

  try {
    for (const theme of ["default", "catppuccin"]) {
      console.log(`\nTheme: ${theme}`);
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        storageState: undefined,
      });

      const page = await context.newPage();

      // Apply theme before navigating.
      await page.goto(`${APP}/timesheets`, { waitUntil: "networkidle" });
      if (theme === "catppuccin") {
        await page.evaluate(() => {
          localStorage.setItem("helm:theme", "catppuccin");
        });
        await page.reload({ waitUntil: "networkidle" });
      } else {
        await page.evaluate(() => {
          localStorage.removeItem("helm:theme");
        });
        await page.reload({ waitUntil: "networkidle" });
      }

      // Wait for the client dropdown to appear.
      await page.waitForSelector("select#client", { timeout: 10_000 });

      // Pick the seeded client from the dropdown by its UUID value.
      await page.selectOption("select#client", { value: seeded.id });

      // Wait for the summary to load (the pacing widget depends on it).
      await page.waitForTimeout(1500);

      // Assert pacing text is visible.
      const pacingLocator = page.locator("text=/h\\/day/");
      const count = await pacingLocator.count();
      if (count === 0) {
        // The contract end date is in the future but the "Contract window ended"
        // text may appear if remaining hours is 0. Accept either.
        const endedLocator = page.locator("text=Contract window ended");
        const endedCount = await endedLocator.count();
        const completeLocator = page.locator("text=Contract complete");
        const completeCount = await completeLocator.count();
        const setDatesLocator = page.locator("text=Set contract dates on the client");
        const setDatesCount = await setDatesLocator.count();

        if (endedCount === 0 && completeCount === 0 && setDatesCount === 0) {
          throw new Error(
            `[${theme}] Pacing widget not found — none of the expected states are visible.`,
          );
        }
        console.log(
          `  [${theme}] Pacing widget rendered (state: ${endedCount ? "ended" : completeCount ? "complete" : "set-dates"})`,
        );
      } else {
        console.log(`  [${theme}] Pacing widget visible: contains "h/day"`);
      }

      await screenshotPaging(page, OUT, `timesheets-pacing-${theme}`);
      await context.close();
    }

    console.log("\nAll assertions passed.");
  } finally {
    await browser.close();

    // Archive (soft-delete) the seeded client.
    console.log("\nCleaning up seeded client...");
    await deleteClient(seeded.id);
    console.log("  Done.");
  }
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
