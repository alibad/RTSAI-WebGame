// Drives the game in Chromium (Playwright's build, real GPU via ANGLE/D3D11) the way a player does: boot to the
// setup screen, let it prepare the map, press Start; then records load timings, frame and tick times, input
// latency, memory, lazy private reads, and the SyncHash replay check.
//   node tools/measure.mjs [--runtime aot] [--scenario skirmish] [--seconds 20] [--probe 20] [--verify]
// Requires server/serve.mjs on 127.0.0.1:3490. Appends one JSON line per run to data/measure.jsonl.
// No screenshots: the scene contains the player's own RA2 files.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../web/node_modules/playwright-core/index.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]);
  return acc;
}, []));
const runtime = args.runtime ?? "aot";
const scenarioName = args.scenario ?? "skirmish";
const seconds = Number(args.seconds ?? 20);
const exe = path.join(process.env.LOCALAPPDATA, "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe");

const browser = await chromium.launch({
  executablePath: fs.existsSync(exe) ? exe : undefined,
  headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-background-timer-throttling"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const t0 = Date.now();
await page.goto(`http://127.0.0.1:3490/?runtime=${runtime}`);
const gpu = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const ext = gl?.getExtension("WEBGL_debug_renderer_info");
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
});
const phase = (w) => page.waitForFunction((x) => [x, "error"].includes(window.store?.getState().phase), w, { timeout: 600000, polling: 100 });
await phase("setup");
const setupSeconds = (Date.now() - t0) / 1000;

const scenario = JSON.parse(fs.readFileSync(path.join(repo, "scenarios", `${scenarioName}.json`), "utf8"));
// What the setup screen does while the player chooses: prepare the map.
const tp = Date.now();
await page.evaluate((m) => window.game.prepare(m), scenario.map);
await page.waitForFunction((m) => window.store.getState().preparedMap === m, scenario.map, { timeout: 600000, polling: 100 });
const prepareSeconds = (Date.now() - tp) / 1000;

const ts = Date.now();
await page.evaluate((s) => window.game.start(s), JSON.stringify(scenario));
await phase("playing");
await page.waitForFunction(() => !!window.game.client.cur, null, { timeout: 60000, polling: 50 });
const startSeconds = (Date.now() - ts) / 1000;
if (scenarioName.startsWith("battle")) await page.evaluate(() => { const b = window.store.getState().info.bounds; window.game.lookAt((b[0] + b[2]) / 2, (b[1] + b[3]) / 2); });

const samples = [];
for (let i = 0; i < seconds; i++) {
  await page.waitForTimeout(1000);
  samples.push(await page.evaluate(() => ({ ...window.store.getState().perf, latency: [] })));
}
const pixels = await page.evaluate(() => window.game.probePixels());

const probe = Number(args.probe ?? 20);
if (probe > 0) await page.evaluate((n) => window.game.latencyProbe(n), probe);
await page.waitForTimeout(500);
const final = await page.evaluate(() => { const s = window.store.getState(); return { perf: s.perf, lazy: s.lazy, timings: s.timings, startMs: s.startMs, downloads: s.downloads }; });

let verify = "";
if (args.verify) {
  await page.evaluate(() => window.game.requestVerify());
  for (let i = 0; i < 1200 && !/Identical|MISMATCH|Error/.test(verify); i++) {
    await page.waitForTimeout(500);
    verify = await page.evaluate(() => window.store.getState().verify);
  }
}

const mean = (k) => samples.reduce((a, s) => a + s[k], 0) / samples.length;
const pct = (v, q) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };
const lat = final.perf.latency;
const result = {
  at: new Date().toISOString(), runtime, scenario: scenarioName, gpu,
  setupSeconds, prepareSeconds, startSeconds, worldStartMs: final.startMs, timings: final.timings, downloads: final.downloads,
  fps: mean("fps"), frameMs: mean("frameMs"), simTickMs: mean("simTickMs"), engineTickMs: mean("engineTickMs"),
  snapshotMs: mean("buildMs"), tps: mean("tps"), draws: mean("draws"), heapMB: Math.max(...samples.map((s) => s.heapMB)),
  managedMB: Math.max(...samples.map((s) => s.managedMB)), lateTicks: final.perf.lateTicks, missed: final.perf.missed,
  lazy: final.lazy, latency: { n: lat.length, p50: pct(lat, 0.5), p95: pct(lat, 0.95), max: pct(lat, 1) },
  verify, pixels, errors,
};
console.log(JSON.stringify(result, null, 1));
fs.appendFileSync(path.join(repo, "data", "measure.jsonl"), JSON.stringify(result) + "\n");
await browser.close();
