// Same as csv-upload-probe.mjs but runs against WebKit (Safari engine)
// and lets you point at a real file on disk so we can reproduce
// Safari-specific upload failures.
//
// usage: node scripts/csv-upload-probe-webkit.mjs '<presigned-url>' [path/to/file.csv]
import { webkit } from "playwright";
import { readFile } from "node:fs/promises";

const URL = process.argv[2];
const FILE = process.argv[3];
if (!URL) {
  console.error("usage: node scripts/csv-upload-probe-webkit.mjs <url> [file]");
  process.exit(1);
}

const bytes = FILE
  ? await readFile(FILE)
  : Buffer.from(
      "Date,Description,Withdrawals,Deposits,Balance\n03/01/2024,T,1.00,,100.00\n",
    );
console.log(`uploading ${bytes.length} bytes from ${FILE ?? "inline"}`);

const browser = await webkit.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

page.on("console", (m) => console.log(`console.${m.type()}:`, m.text()));
page.on("requestfailed", (r) =>
  console.log(
    "requestfailed:",
    r.method(),
    r.url().slice(0, 110),
    "—",
    r.failure()?.errorText,
  ),
);
page.on("response", (resp) => {
  if (resp.url().includes("helm-receipts")) {
    console.log("response:", resp.status(), resp.request().method());
  }
});

await page.goto("https://dev.d3rafk9vdphq49.amplifyapp.com/", {
  waitUntil: "domcontentloaded",
});

// Inject the bytes as a base64 string so it can be reconstructed in-page.
const b64 = bytes.toString("base64");
const result = await page.evaluate(
  async ({ u, b64 }) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const blob = new Blob([arr], { type: "text/csv" });
    try {
      const r = await fetch(u, { method: "PUT", body: blob });
      return { ok: r.ok, status: r.status, statusText: r.statusText };
    } catch (e) {
      return { error: String(e), name: e.name, message: e.message };
    }
  },
  { u: URL, b64 },
);

console.log("result:", JSON.stringify(result, null, 2));
await browser.close();
