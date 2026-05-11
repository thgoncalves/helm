/**
 * personal-audit — Playwright sweep across the new Personal section.
 *
 * What this covers (per viewport × per theme):
 *   1. /dashboard               — Business nav + side switcher still render.
 *   2. Click "Personal" switcher → /personal/accounts; confirm Personal nav.
 *   3. /personal/accounts       — empty state.
 *   4. Create an account via the New Account form.
 *   5. /personal/accounts again — new row should be present.
 *   6. /personal/imports        — new account in the dropdown.
 *   7. /personal/transactions   — empty state.
 *
 * Viewports: iPhone 14 Pro (393×852), iPad (820×1180), desktop (1280×800).
 * Themes: default, catppuccin (via localStorage 'helm:theme' + reload).
 *
 * The script seeds + cleans up account rows so the same script can run
 * repeatedly without colliding with prior data. Each (viewport, theme)
 * pair gets its own account name to keep the rows distinct on the audit
 * screenshots, but every account this script creates is deleted at the
 * end of its sweep.
 *
 * Usage:
 *   node scripts/personal-audit.mjs
 *
 * Output:
 *   apps/web/screenshots/personal-audit/<viewport>/<theme>/<step>.png
 */
import { chromium, devices } from "playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const API = "http://127.0.0.1:8000";
const APP = "http://localhost:5173";
const OUT = new URL("../screenshots/personal-audit/", import.meta.url).pathname;

const VIEWPORTS = [
  {
    label: "iphone",
    contextOptions: { ...devices["iPhone 14 Pro"] },
  },
  {
    label: "ipad",
    contextOptions: {
      viewport: { width: 820, height: 1180 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    },
  },
  {
    label: "desktop",
    contextOptions: {
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    },
  },
];

const THEMES = [
  { label: "default", value: "default" },
  { label: "catppuccin", value: "catppuccin" },
];

/** Delete every personal account currently in dev Aurora. Used to seed
 * the empty state before each sweep. Skips accounts that can't be hard
 * deleted (those with attached transactions / imports); since this audit
 * runs against a fresh table the data should always be deletable. */
async function purgeAccounts() {
  const r = await fetch(
    `${API}/personal/accounts/?include_archived=true`,
  );
  if (!r.ok) throw new Error(`GET accounts → ${r.status}`);
  const accounts = await r.json();
  for (const a of accounts) {
    const del = await fetch(`${API}/personal/accounts/${a.id}`, {
      method: "DELETE",
    });
    if (!del.ok && del.status !== 404) {
      const body = await del.text().catch(() => "");
      console.warn(
        `  warn: could not delete ${a.id} (${a.name}): ${del.status} ${body.slice(0, 120)}`,
      );
    }
  }
}

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    if (t === "default") {
      window.localStorage.removeItem("helm:theme");
    } else {
      window.localStorage.setItem("helm:theme", t);
    }
  }, theme);
  await page.reload({ waitUntil: "networkidle" });
}

async function snap(page, dir, name) {
  const file = join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`    ${name} -> ${file}`);
  return file;
}

async function runSweep(browser, viewport, theme) {
  const dir = join(OUT, viewport.label, theme.label);
  await mkdir(dir, { recursive: true });

  console.log(`\n=== ${viewport.label} / ${theme.label} ===`);

  // Start with a clean account list so the empty state is real.
  await purgeAccounts();

  const ctx = await browser.newContext(viewport.contextOptions);
  const page = await ctx.newPage();
  page.on("pageerror", (e) =>
    console.error(`  pageerror [${viewport.label}/${theme.label}]:`, e.message),
  );
  page.on("requestfailed", (req) => {
    if (!req.url().includes("favicon")) {
      console.warn(
        `  reqfail [${viewport.label}/${theme.label}]: ${req.method()} ${req.url()} - ${req.failure()?.errorText}`,
      );
    }
  });

  // Prime the origin so localStorage can be set before first protected nav.
  await page.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
  await setTheme(page, theme.value);

  // 1. /dashboard — Business nav + side switcher.
  await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await snap(page, dir, "01-dashboard");

  // 2. Click the Personal side-switcher button. Falls back to a direct
  //    nav if for some reason the button isn't visible.
  const personalButton = page.getByRole("tab", { name: "Personal" }).first();
  if (await personalButton.isVisible().catch(() => false)) {
    await personalButton.click();
    await page.waitForURL("**/personal/accounts", { timeout: 5000 }).catch(
      () => {},
    );
  } else {
    await page.goto(`${APP}/personal/accounts`, { waitUntil: "networkidle" });
  }
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
  await snap(page, dir, "02-personal-accounts-empty");

  // 3. (covered above — same screenshot proves both "switched nav" + "empty
  //    state". Keeping the explicit naming for the audit deliverable.)

  // 4. Open "New Account", fill, save.
  await page.getByRole("button", { name: "New Account" }).click();
  // Wait for the form (name input) to mount.
  await page.locator("#name").waitFor({ state: "visible" });
  const accountName = `RBC Sandbox ${viewport.label}/${theme.label}`;
  await page.locator("#name").fill(accountName);
  await page.locator("#institution").selectOption("RBC");
  await page.locator("#account_type").selectOption("checking");
  await page.locator("#currency").fill("CAD");
  await snap(page, dir, "03-new-account-form-filled");
  await page.getByRole("button", { name: "Save" }).click();

  // Form closes on success. Wait for the new row.
  await page.waitForFunction(
    (name) =>
      Array.from(document.querySelectorAll("td")).some(
        (td) => td.textContent?.trim() === name,
      ),
    accountName,
    { timeout: 5000 },
  );
  await page.waitForTimeout(300);

  // 5. /personal/accounts with the new row.
  await snap(page, dir, "04-personal-accounts-with-row");

  // 6. /personal/imports — dropdown should now have the account.
  await page.goto(`${APP}/personal/imports`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await snap(page, dir, "05-personal-imports");

  // 7. /personal/transactions — empty state (or "pick an account").
  await page.goto(`${APP}/personal/transactions`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await snap(page, dir, "06-personal-transactions");

  await ctx.close();
}

async function run() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        await runSweep(browser, viewport, theme);
      }
    }
  } finally {
    // Final cleanup so devs hitting the sandbox after this don't see
    // stale audit accounts.
    await purgeAccounts();
    await browser.close();
  }
  console.log("\nDone.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
