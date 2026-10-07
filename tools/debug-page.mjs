// Opens the game in headless Chromium (real GPU), waits for a phase, waits --wait seconds, then evaluates each
// --eval expression in the page and prints the JSON result. For debugging without screenshots.
//   node tools/debug-page.mjs [--runtime aot] [--scenario skirmish] [--phase playing] [--wait 5] --eval "store.getState().ui"
import fs from "node:fs";
import path from "node:path";
import { chromium } from "../web/node_modules/playwright-core/index.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const evals = argv.flatMap((a, i) => (a === "--eval" ? [argv[i + 1]] : []));
const exe = path.join(process.env.LOCALAPPDATA, "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe");
const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined, headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: Number(opt("w", "1600")), height: Number(opt("h", "900")) } });
page.on("pageerror", (e) => console.log("pageerror", String(e)));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(`console.${m.type()}`, m.text().slice(0, 400)); });
const scenario = opt("scenario", "");
const url = `http://127.0.0.1:3490/?runtime=${opt("runtime", "aot")}${scenario ? `&scenario=${scenario}` : ""}${opt("extra", "")}`;
const t0 = Date.now();
await page.goto(url);
const want = opt("phase", scenario ? "playing" : "setup");
await page.waitForFunction((w) => { const p = window.store?.getState().phase; return p === w || p === "error"; }, want, { timeout: 600000, polling: 250 });
console.log(`phase ${await page.evaluate(() => window.store.getState().phase)} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const err = await page.evaluate(() => window.store.getState().error);
if (err) console.log("error:", err.slice(0, 3000));
await page.waitForTimeout(1000 * Number(opt("wait", "3")));
for (const e of evals) {
  try { console.log(e.slice(0, 120), "=>", JSON.stringify(await page.evaluate(`(async () => (${e}))()`))); }
  catch (er) { console.log(e.slice(0, 120), "=> ERROR", String(er).slice(0, 500)); }
}
const shot = opt("shot", "");
if (shot) { await page.screenshot({ path: shot }); console.log("wrote", shot); }
await browser.close();
