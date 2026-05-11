// Probes the Personal/Imports PUT failure by attempting the same
// presigned-URL PUT from a browser context. Logs network + console.
//
// usage: node scripts/csv-upload-probe.mjs '<presigned-url>'
import { chromium } from "playwright";

const URL = process.argv[2];
if (!URL) {
  console.error("usage: node csv-upload-probe.mjs <presigned-url>");
  process.exit(1);
}

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

page.on("console", (m) => console.log(`console.${m.type()}:`, m.text()));
page.on("requestfailed", (r) =>
  console.log(
    "requestfailed:",
    r.method(),
    r.url().slice(0, 120),
    "—",
    r.failure()?.errorText,
  ),
);
page.on("response", async (resp) => {
  if (resp.url().includes("helm-receipts-dev")) {
    console.log(
      "response:",
      resp.status(),
      resp.request().method(),
      resp.url().slice(0, 120),
    );
    console.log("  resp headers:", JSON.stringify(resp.headers(), null, 2));
    try {
      const body = await resp.text();
      if (body) console.log("  body:", body.slice(0, 500));
    } catch {}
  }
});

await page.goto("https://dev.d3rafk9vdphq49.amplifyapp.com/", {
  waitUntil: "domcontentloaded",
});

const result = await page.evaluate(async (u) => {
  const csv = new Blob(
    [
      "Date,Description,Withdrawals,Deposits,Balance\n03/01/2024,TEST,1.00,,100.00\n",
    ],
    { type: "text/csv" },
  );
  try {
    const r = await fetch(u, { method: "PUT", body: csv });
    return { ok: r.ok, status: r.status, statusText: r.statusText };
  } catch (e) {
    return { error: String(e), name: e.name, message: e.message };
  }
}, URL);

console.log("\nresult:", JSON.stringify(result, null, 2));
await browser.close();
