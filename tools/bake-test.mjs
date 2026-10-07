// Prebaked sprite sheets: prepares a map cold (decode + pack, then cached), reloads the page in the same browser
// profile, prepares again (restored from IndexedDB) and starts the game; reports times, heap and whether every
// sprite drew.   node tools/bake-test.mjs [--runtime aot] [--map tournament-2A] [--scenario skirmish]
import fs from "node:fs";
import path from "node:path";
import { chromium } from "../web/node_modules/playwright-core/index.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const runtime = opt("runtime", "aot");
const map = opt("map", "tournament-2A");
const scenario = opt("scenario", "skirmish");
const extra = opt("extra", "");
const exe = path.join(process.env.LOCALAPPDATA, "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe");
const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined, headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (e) => console.log("pageerror", String(e)));
page.on("console", (m) => { if (["error", "warning"].includes(m.type()) || m.text().startsWith("sprite cache")) console.log("console", m.type(), m.text().slice(0, 400)); });
const url = `http://127.0.0.1:3490/?runtime=${runtime}${extra}`;

async function prepare(label) {
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 600000, polling: 100 });
  const ready = (Date.now() - t0) / 1000;
  const tp = Date.now();
  await page.evaluate((m) => window.game.prepare(m), map);
  await page.waitForFunction((m) => window.store.getState().preparedMap === m, map, { timeout: 600000, polling: 50 });
  await page.waitForFunction(() => { const s = window.store.getState().sheets; return s.uploaded >= s.total; }, null, { timeout: 600000, polling: 50 });
  const t = await page.evaluate(() => window.store.getState().timings);
  console.log(`${label}: setup ${ready.toFixed(1)} s, prepare ${((Date.now() - tp) / 1000).toFixed(2)} s`,
    `(map ${t["prepare.map"]?.toFixed(0)} ms, sprites ${t["prepare.sprites"]?.toFixed(0)} ms, restored ${t["sprites.restored"]}, heap ${t["heap.prepared"]} MB)`);
}

await prepare("cold");
await page.waitForTimeout(8000); // the compressed sheets are written to IndexedDB in the background
await prepare("warm");
const sj = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..", "scenarios", `${scenario}.json`), "utf8");
const ts = Date.now();
await page.evaluate((s) => window.game.start(s), sj);
await page.waitForFunction(() => ["playing", "error"].includes(window.store.getState().phase), null, { timeout: 600000, polling: 50 });
const st = await page.evaluate(() => ({ phase: window.store.getState().phase, error: window.store.getState().error }));
if (st.phase === "error") { console.log("start failed", JSON.stringify(st)); await browser.close(); process.exit(1); }
await page.waitForFunction(() => !!window.game.client.cur, null, { timeout: 60000, polling: 50 });
console.log(`start ${((Date.now() - ts) / 1000).toFixed(2)} s`);
await page.waitForTimeout(4000);
console.log("sheets", JSON.stringify(await page.evaluate(() => window.store.getState().sheets)));
console.log("frame", JSON.stringify(await page.evaluate(() => ({ ...window.game.renderer.stats, sheetMs: Math.round(window.game.client.sheetMs), heap: window.store.getState().perf.heapMB, textures: window.game.renderer.textureCount }))));
console.log("idb", JSON.stringify(await page.evaluate(async () => (await navigator.storage.estimate()))));
await browser.close();
