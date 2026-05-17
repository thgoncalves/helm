/**
 * personal-nav-check — verifies the Personal/Business header design at
 * iPhone and iPad viewports across the default and Catppuccin themes.
 *
 * What it covers:
 *   - /dashboard at iPhone 14 Pro (393×852) and iPad (820×1180): captures
 *     just the header so we can eyeball the Business nav + Side switcher.
 *   - /personal/accounts, /personal/imports, /personal/transactions:
 *     full-page screenshots at iPhone in both default and Catppuccin.
 *
 * Theme toggling is done via `localStorage.setItem('helm:theme',
 * 'catppuccin')` + reload, which matches the boot path in main.tsx.
 *
 * Usage:
 *   node scripts/personal-nav-check.mjs
 *
 * Output:
 *   apps/web/screenshots/personal-nav/<file>.png
 */
import { chromium, devices } from "playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const APP = "http://localhost:5173";
const OUT = new URL("../screenshots/personal-nav/", import.meta.url).pathname;

const PERSONAL_ROUTES = [
  ["personal-accounts", "/personal/accounts"],
  ["personal-imports", "/personal/imports"],
  ["personal-transactions", "/personal/transactions"],
];

async function setTheme(page, theme) {
  // Theme is read on boot from localStorage by main.tsx. Set it, then
  // reload so the class is applied before first paint.
  await page.evaluate((t) => {
    if (t === "default") {
      window.localStorage.removeItem("helm:theme");
    } else {
      window.localStorage.setItem("helm:theme", t);
    }
  }, theme);
  await page.reload({ waitUntil: "networkidle" });
}

async function snapHeader(page, file) {
  const header = await page.locator("header").first();
  await header.screenshot({ path: file });
}

async function run() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();

  try {
    // --- iPhone 14 Pro header crops on /dashboard (Business side) ---
    const iphoneCtx = await browser.newContext({
      ...devices["iPhone 14 Pro"],
    });
    const ipage = await iphoneCtx.newPage();
    ipage.on("pageerror", (e) => console.error("iphone pageerror:", e.message));

    await ipage.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
    await snapHeader(ipage, join(OUT, "iphone-business-header.png"));
    console.log("iphone /dashboard header -> iphone-business-header.png");

    await ipage.goto(`${APP}/personal/accounts`, { waitUntil: "networkidle" });
    await snapHeader(ipage, join(OUT, "iphone-personal-header.png"));
    console.log(
      "iphone /personal/accounts header -> iphone-personal-header.png",
    );

    // Personal pages: full-page in both themes at iPhone.
    for (const [name, path] of PERSONAL_ROUTES) {
      // default theme
      await setTheme(ipage, "default");
      await ipage.goto(`${APP}${path}`, { waitUntil: "networkidle" });
      await ipage.waitForTimeout(200);
      await ipage.screenshot({
        path: join(OUT, `iphone-${name}-default.png`),
        fullPage: true,
      });
      console.log(`iphone ${path} default -> iphone-${name}-default.png`);

      // catppuccin theme
      await ipage.goto(`${APP}${path}`, { waitUntil: "networkidle" });
      await setTheme(ipage, "catppuccin");
      await ipage.waitForTimeout(200);
      await ipage.screenshot({
        path: join(OUT, `iphone-${name}-catppuccin.png`),
        fullPage: true,
      });
      console.log(`iphone ${path} catppuccin -> iphone-${name}-catppuccin.png`);

      // reset to default for next iteration
      await setTheme(ipage, "default");
    }
    await iphoneCtx.close();

    // --- iPad header crops on /dashboard and /personal/accounts ---
    const ipadCtx = await browser.newContext({
      viewport: { width: 820, height: 1180 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const tpage = await ipadCtx.newPage();
    tpage.on("pageerror", (e) => console.error("ipad pageerror:", e.message));

    await tpage.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
    await snapHeader(tpage, join(OUT, "ipad-business-header.png"));
    console.log("ipad /dashboard header -> ipad-business-header.png");

    await tpage.goto(`${APP}/personal/accounts`, { waitUntil: "networkidle" });
    await snapHeader(tpage, join(OUT, "ipad-personal-header.png"));
    console.log(
      "ipad /personal/accounts header -> ipad-personal-header.png",
    );

    // iPad full-page screenshots of all three Personal routes in default theme.
    for (const [name, path] of PERSONAL_ROUTES) {
      await tpage.goto(`${APP}${path}`, { waitUntil: "networkidle" });
      await tpage.waitForTimeout(200);
      await tpage.screenshot({
        path: join(OUT, `ipad-${name}-default.png`),
        fullPage: true,
      });
      console.log(`ipad ${path} default -> ipad-${name}-default.png`);
    }
    await ipadCtx.close();
  } finally {
    await browser.close();
  }
  console.log("\nDone.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
