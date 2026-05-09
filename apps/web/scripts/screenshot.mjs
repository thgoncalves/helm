/**
 * Screenshot helper. Loads a URL, optionally clicks elements, captures a PNG.
 *
 * Usage:
 *   node scripts/screenshot.mjs <url> <out> [--viewport=WxH] [--click=text]
 */
import { chromium } from "playwright";

const args = process.argv.slice(2);
const url = args[0] ?? "http://localhost:5173/";
const out = args[1] ?? "/tmp/helm-shot.png";

const flags = Object.fromEntries(
  args
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, ...v] = a.replace(/^--/, "").split("=");
      return [k, v.join("=")];
    }),
);

const [width, height] = (flags.viewport ?? "1280x800")
  .split("x")
  .map((n) => Number(n));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width, height } });
const page = await context.newPage();
await page.goto(url, { waitUntil: "networkidle" });

if (flags.click) {
  await page.getByText(flags.click, { exact: true }).first().click();
  await page.waitForTimeout(150);
}

await page.screenshot({ path: out, fullPage: false });
await browser.close();
console.log(`Saved ${out} (${width}x${height})`);
