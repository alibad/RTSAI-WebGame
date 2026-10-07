// Drives the spike in Chromium (Playwright's build, real GPU via ANGLE/D3D11) and records the measurements:
// load timings, download sizes, sim tick and frame times, input latency, memory, and the SyncHash replay check.
//   node tools/measure.mjs --runtime interp --scenario battle-50 [--seconds 20] [--verify] [--probe 20]
// Requires server/serve.mjs on 127.0.0.1:3490. Writes one JSON line per run to data/measure.jsonl.
// No screenshots are taken: the scene contains private RA2 content.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../web/node_modules/playwright-core/index.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]);
  return acc;
}, []));
const runtime = args.runtime ?? "interp";
const scenario = args.scenario ?? "battle-50";
const seconds = Number(args.seconds ?? 20);
const exe = path.join(process.env.LOCALAPPDATA, "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe");

const browser = await chromium.launch({
  executablePath: fs.existsSync(exe) ? exe : undefined,
  headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--disable-background-timer-throttling"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const t0 = Date.now();
await page.goto(`http://127.0.0.1:3490/?runtime=${runtime}&scenario=${scenario}`);
const renderer = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const ext = gl?.getExtension("WEBGL_debug_renderer_info");
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
});

const hud = () => page.evaluate(() => JSON.parse(JSON.stringify(window.game.hud)));
let h;
for (;;) {
  h = await hud();
  if (h.phase === "running" || h.phase === "error") break;
  if (Date.now() - t0 > 600_000) throw new Error("timeout waiting for the world");
  await page.waitForTimeout(500);
}
if (h.phase === "error") throw new Error(h.error);
const loadSeconds = (Date.now() - t0) / 1000;

// Keep the fight on screen: battles meet mid-map; skirmish stays on the player's base.
if (scenario.startsWith("battle")) await page.evaluate(() => window.game.lookAt());

// Let the battle run; sample once a second.
const samples = [];
for (let i = 0; i < seconds; i++) {
  await page.waitForTimeout(1000);
  const s = await hud();
  samples.push({ fps: s.fps, simTickMs: s.simTickMs, engineTickMs: s.engineTickMs, buildMs: s.buildMs, tps: s.tps, draws: s.draws, frameMs: s.frameMs, heapMB: s.heapMB, units: s.units, tick: s.tick });
}
const pixels = await page.evaluate(() => window.game.probePixels());

// Input latency: n right-click move orders through the engine's order generator.
const probe = Number(args.probe ?? 20);
if (probe > 0) await page.evaluate((n) => window.game.latencyProbe(n), probe);
h = await hud();

// Pure simulation throughput (no snapshots), then the SyncHash replay check.
await page.evaluate(() => window.game.bench(250));
let bench = "";
for (let i = 0; i < 600 && !(bench = (await hud()).bench).includes("ms/tick"); i++) await page.waitForTimeout(500);

let verify = "";
if (args.verify) {
  await page.evaluate(() => window.game.requestVerify());
  for (let i = 0; i < 1200 && !/Identical|MISMATCH|Error/.test(verify = (await hud()).verify); i++) await page.waitForTimeout(500);
}

const mean = (k) => samples.reduce((a, s) => a + s[k], 0) / samples.length;
const pct = (v, q) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };
const result = {
  at: new Date().toISOString(), runtime, scenario, gpu: renderer, loadSeconds,
  bootTimings: h.timings, worldStartMs: h.startMs, downloads: h.downloads,
  fps: mean("fps"), frameMs: mean("frameMs"), simTickMs: mean("simTickMs"), engineTickMs: mean("engineTickMs"),
  snapshotMs: mean("buildMs"), tps: mean("tps"), draws: mean("draws"), heapMB: Math.max(...samples.map((s) => s.heapMB)),
  lateTicks: h.lateTicks, unitsStart: samples[0]?.units, unitsEnd: samples.at(-1)?.units,
  latency: { n: h.latency.length, p50: pct(h.latency, 0.5), p95: pct(h.latency, 0.95), max: pct(h.latency, 1) },
  latencyVisible: { n: h.latencyVisible.length, p50: pct(h.latencyVisible, 0.5), p95: pct(h.latencyVisible, 0.95) },
  missedSnapshots: await page.evaluate(() => window.game.client.missedSnapshots),
  bench, verify, pixels, errors,
};
console.log(JSON.stringify(result, null, 1));
fs.appendFileSync(path.join(repo, "data", "measure.jsonl"), JSON.stringify(result) + "\n");
await browser.close();
