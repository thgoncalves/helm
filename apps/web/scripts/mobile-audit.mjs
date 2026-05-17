/**
 * Mobile audit: walks every protected route at iPhone and iPad portrait
 * viewports and dumps a screenshot for each. Designed to run against the
 * dev server with VITE_E2E_AUTH_BYPASS=true so we can drive the protected
 * pages without a Cognito session.
 *
 * Usage:
 *   node scripts/mobile-audit.mjs
 *
 * Output:
 *   apps/web/screenshots/mobile-audit/<viewport>/<page>.png
 */
import { chromium, devices } from "playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const API = "http://127.0.0.1:8000";
const APP = "http://localhost:5173";
const OUT = new URL("../screenshots/mobile-audit/", import.meta.url).pathname;

async function fetchJson(path) {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json();
}

async function sampleIds() {
  const clients = await fetchJson("/business/clients/");
  const invoicesPayload = await fetchJson("/business/invoices/");
  const invoices = invoicesPayload.invoices ?? [];
  const payments = await fetchJson("/business/payments/");
  const taxes = await fetchJson("/business/tax-payments/");
  const transfers = await fetchJson("/business/transfers/");
  return {
    clientId: clients[0]?.id ?? null,
    invoiceId: invoices[0]?.id ?? null,
    paymentId: payments[0]?.id ?? null,
    taxId: taxes[0]?.id ?? null,
    transferId: transfers[0]?.id ?? null,
  };
}

function pageList(ids) {
  return [
    ["clients", "/clients"],
    ["clients-new", "/clients/new"],
    ids.clientId && ["clients-detail", `/clients/${ids.clientId}`],
    ids.clientId && ["clients-edit", `/clients/${ids.clientId}/edit`],
    ["timesheets", "/timesheets"],
    ["invoices", "/invoices"],
    ids.invoiceId && ["invoices-detail", `/invoices/${ids.invoiceId}`],
    ["payments", "/payments"],
    ids.paymentId && ["payments-detail", `/payments/${ids.paymentId}`],
    ["taxes", "/taxes"],
    ids.taxId && ["taxes-detail", `/taxes/${ids.taxId}`],
    ["transfers", "/transfers"],
    ids.transferId && ["transfers-detail", `/transfers/${ids.transferId}`],
    ["settings", "/settings"],
  ].filter(Boolean);
}

async function screenshotPages(browser, label, device, ids, themeFollowups) {
  console.log(`\n=== ${label} ===`);
  const outDir = join(OUT, label);
  await mkdir(outDir, { recursive: true });

  const ctx = await browser.newContext({ ...device });
  const page = await ctx.newPage();
  // Surface errors so we know if a page broke.
  page.on("pageerror", (e) => console.error(`${label} pageerror:`, e.message));
  page.on("requestfailed", (req) => {
    if (!req.url().includes("favicon")) {
      console.warn(`${label} req failed: ${req.method()} ${req.url()} - ${req.failure()?.errorText}`);
    }
  });

  for (const [name, path] of pageList(ids)) {
    const url = `${APP}${path}`;
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
    } catch (e) {
      console.warn(`${label} ${name}: nav timeout, retrying with domcontentloaded`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    }
    // Give react-query / lazy effects a moment to settle.
    await page.waitForTimeout(700);
    const file = join(outDir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`  ${name} -> ${file}`);
  }

  // Theme sweep on the Clients list (so we see the header + table).
  if (themeFollowups) {
    for (const [themeName, htmlClass] of [
      ["catppuccin", "theme-catppuccin"],
      ["tokyo-night", "theme-tokyo-night"],
    ]) {
      await page.goto(`${APP}/clients`, { waitUntil: "networkidle" });
      await page.evaluate((cls) => {
        document.documentElement.classList.remove(
          "theme-catppuccin",
          "theme-tokyo-night",
        );
        document.documentElement.classList.add(cls);
      }, htmlClass);
      await page.waitForTimeout(200);
      const file = join(outDir, `theme-${themeName}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(`  theme-${themeName} -> ${file}`);
    }
  }

  await ctx.close();
}

const ids = await sampleIds();
console.log("Sampled ids:", ids);

const browser = await chromium.launch();
try {
  await screenshotPages(
    browser,
    "iphone",
    devices["iPhone 14 Pro"],
    ids,
    true,
  );
  await screenshotPages(
    browser,
    "ipad",
    devices["iPad (gen 7)"],
    ids,
    false,
  );
} finally {
  await browser.close();
}
console.log("\nDone.");
