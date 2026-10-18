// Smoke test of a built page with its runtime and data: loads it per game mode, plays short matches back to back (the
// isometric skirmish with a bot, the original-art battle, the skirmish twice more, the Classic skirmish) and checks
// that each one starts, ticks and draws, and that the page throws nothing. A scenario played right after itself must
// leave no more GPU textures after quitting and take no more WASM memory than the play before: the sprite-sheet leak of
// 13 October and the per-match heap growth fixed on 14 October would both fail it. (Comparing across other maps would
// not work: sheets another match fetched stay with the cached sprite packing, and a bigger battle raises the memory
// high-water mark, which WebAssembly never gives back.)
// tools/release-play.mjs runs it before every release; it also works against any static build (tools/static-serve.mjs).
//   node tools/release-smoke.mjs <url> [--runs public:skirmish-public,public:battle-originals,public:skirmish-public,public:skirmish-public,public-classic:skirmish-classic]
//     [--seconds 8] [--shots <dir>] [--asset-origin https://trusted-game-cdn.example]
// Prints one line "RESULT <json>" and exits 1 if a check failed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { browserArgs, browserExecutable } from "./browser-launch.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(pathToFileURL(process.env.RTSAI_PLAYWRIGHT_MODULE ?? path.join(repo, "web/node_modules/playwright-core/index.mjs")).href);
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const url = argv[0];
if (!url || url.startsWith("--")) throw new Error("usage: node tools/release-smoke.mjs <url> [--runs profile:scenario,...] [--seconds 8] [--shots <dir>]");
const runs = opt("runs", "public:skirmish-public,public:battle-originals,public:skirmish-public,public:skirmish-public,public-classic:skirmish-classic").split(",").map((r) => r.split(":"));
const seconds = Number(opt("seconds", 8));
const timeout = Number(opt("timeout-ms", 300000));
const shots = opt("shots");
const assetOrigins = new Set(argv.flatMap((a, i) => a === "--asset-origin" ? [new URL(argv[i + 1]).origin] : []));
if (shots) fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true, args: [...browserArgs(), "--disable-background-timer-throttling"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
if (["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
  // Local QA must not emit production analytics. Release tests may explicitly read their game's asset CDN;
  // unrelated hosts and outbound writes stay blocked.
  await page.route("**/*", route => {
    const target = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(target.hostname) || ["blob:", "data:"].includes(target.protocol)
      || (assetOrigins.has(target.origin) && ["GET", "HEAD"].includes(route.request().method()))
      ? route.continue() : route.abort();
  });
}
const pageErrors = [], consoleErrors = [], failures = [], matches = [];
const requests = [], recentLogs = [];
let waitingFor = "boot";
page.on("request", r => { requests.push({ url: r.url(), range: r.headers().range }); if (requests.length > 30) requests.shift(); });
page.on("response", r => { const entry = requests.findLast(x => x.url === r.url()); if (entry) { entry.status = r.status(); entry.type = r.headers()["content-type"]; } });
page.on("console", m => { recentLogs.push(m.text().slice(0, 1000)); if (recentLogs.length > 12) recentLogs.shift(); });
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
const state = () => page.evaluate(() => ({ phase: window.store.getState().phase, error: window.store.getState().error?.slice(0, 300) }));

try {
  let profile = null, played = 0;
  for (const [runProfile, name] of runs) {
    if (runProfile !== profile) {
      profile = runProfile;
      played = 0;
      await page.goto(`${url}${url.includes("?") ? "&" : "?"}profile=${profile}&runtime=aot&private=0`);
      waitingFor = `${profile} boot`;
      await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout, polling: 250 });
      const s = await state();
      if (s.phase === "error") throw new Error(`${profile}: the page failed to boot: ${s.error}`);
      if (!(await page.evaluate(() => crossOriginIsolated))) failures.push(`${profile}: the page is not cross-origin isolated`);
      await page.evaluate(() => { window.__stats = null; window.game.client.on("stats", (m) => { try { window.__stats = { wasmMB: m.heapBytes / 1048576, ...JSON.parse(m.json) }; } catch { /* stats from an older worker */ } }); });
    }

    const scenario = JSON.parse(fs.readFileSync(path.join(repo, "scenarios", `${name}.json`), "utf8"));
    const t0 = Date.now();
    waitingFor = `${runProfile} prepare ${scenario.map}`;
    await page.evaluate((map) => window.game.prepare(map), scenario.map);
    await page.waitForFunction((map) => window.store.getState().preparedMap === map || window.store.getState().phase === "error", scenario.map, { timeout, polling: 100 });
    waitingFor = `${runProfile} start ${scenario.map}`;
    await page.evaluate((json) => window.game.start(json), JSON.stringify(scenario));
    await page.waitForFunction(() => window.store.getState().phase === "error" || (window.store.getState().phase === "playing" && !!window.game.client.cur), null, { timeout, polling: 100 });
    const startMs = Date.now() - t0;
    // Look at the player's own units, as a player would (a scripted battle starts with the camera elsewhere).
    await page.evaluate(() => {
      const own = window.store.getState().ui?.coach?.actors ?? [];
      if (own.length) window.game.lookAt(own.reduce((s, a) => s + a.x, 0) / own.length, own.reduce((s, a) => s + a.y, 0) / own.length);
    });
    const firstTick = await page.evaluate(() => window.game.client.cur?.header.tick ?? 0);
    // The garbage made while playing: the worker's allocation counter (once a second), past the first second.
    await page.waitForTimeout(1500);
    const alloc0 = await page.evaluate(() => [performance.now(), window.__stats?.totalAllocatedMB]);
    await page.waitForTimeout(Math.max(1000, seconds * 1000 - 1500));
    const alloc1 = await page.evaluate(() => [performance.now(), window.__stats?.totalAllocatedMB]);
    const m = await page.evaluate(() => ({
      phase: window.store.getState().phase, error: window.store.getState().error?.slice(0, 300), tick: window.game.client.cur?.header.tick ?? 0,
      actors: window.game.client.cur?.actors.length ?? 0, textures: window.game.renderer.textures.size,
      wasmMB: Math.round(window.__stats?.wasmMB ?? 0), managedMB: Math.round(window.__stats?.managedMB ?? 0) }));
    if (shots) await page.screenshot({ path: path.join(shots, `${matches.length + 1}-${profile}-${name}.png`) });
    await page.evaluate(() => window.game.quit());
    await page.waitForTimeout(2000);
    const after = await page.evaluate(() => window.game.renderer.textures.size);
    const allocMBps = alloc0[1] != null && alloc1[1] != null ? Math.round((alloc1[1] - alloc0[1]) / ((alloc1[0] - alloc0[0]) / 1000) * 10) / 10 : null;
    const result = { profile, scenario: name, startMs, ticks: m.tick - firstTick, actors: m.actors, wasmMB: m.wasmMB, managedMB: m.managedMB, allocMBps, textures: m.textures, texturesAfterQuit: after, sinceLoad: played++ };
    const prev = matches.at(-1);
    matches.push(result);
    const label = `${profile} ${name}`;
    if (m.phase !== "playing") failures.push(`${label}: phase ${m.phase}${m.error ? ` (${m.error})` : ""}`);
    // 25 ticks a second when healthy; a headless browser may run slower, but a stalled world is a failure.
    if (result.ticks < seconds * 5) failures.push(`${label}: only ${result.ticks} ticks in ${seconds} s`);
    if (!m.actors) failures.push(`${label}: nothing drawn (no actors in the snapshot)`);
    // The first match after a page load starts from a cold heap: the second one always ends higher (the 397 MB plateau).
    if (prev?.profile === profile && prev.scenario === name && prev.sinceLoad > 0) {
      if (after > prev.texturesAfterQuit + 2) failures.push(`${label}: ${after - prev.texturesAfterQuit} more GPU textures left after quitting than the play before`);
      if (m.wasmMB > prev.wasmMB + 16) failures.push(`${label}: WASM memory grew from ${prev.wasmMB} to ${m.wasmMB} MB over the same map's previous play`);
    }
  }
} catch (e) {
  failures.push(`${waitingFor}: ${String(e).slice(0, 400)}`);
} finally {
  await browser.close();
}
if (pageErrors.length) failures.push(`uncaught page errors: ${pageErrors.slice(0, 3).join(" | ")}`);
const result = { url, passed: failures.length === 0, failures, matches, consoleErrors: consoleErrors.slice(0, 10), ...(failures.length ? { requests, recentLogs } : {}) };
console.log(`RESULT ${JSON.stringify(result)}`);
process.exitCode = result.passed ? 0 : 1;
