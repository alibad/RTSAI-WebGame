// First-visit numbers for the static public build on emulated networks: starts tools/static-serve.mjs with each
// network profile (shared downlink + latency, applied at the server so the worker's requests and lazy range reads
// count too), opens the game in a fresh browser profile (empty cache) and times what a player waits for:
// the setup screen, the map ready (prepared on the setup screen), the world started, plus the bytes transferred.
// Then it reloads in the same profile (a returning visit, cache warm).
//   node tools/firstvisit.mjs [--profiles 4g,cable] [--viewport 1600x900] [--mobile]
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "../web/node_modules/playwright-core/index.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
// WebPageTest's connection profiles (downlink kbit/s, round-trip ms).
const PROFILES = { "4g": [9000, 170], cable: [5000, 28], lte: [12000, 70], fiber: [20000, 4], none: [0, 0] };
const profiles = opt("profiles", "4g,cable").split(",");
const mobile = argv.includes("--mobile");
// --h2: HTTPS + HTTP/2 like a CDN (the default HTTP/1.1 caps a page at six connections, so many small requests queue).
const h2 = argv.includes("--h2");
if (h2) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // the test server's self-signed certificate (stats only)
const scheme = h2 ? "https" : "http";
const exe = path.join(process.env.LOCALAPPDATA, "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe");
const results = [];

for (const name of profiles) {
  const [kbps, rtt] = PROFILES[name];
  const port = 3492;
  const server = spawn(process.execPath, ["tools/static-serve.mjs", "--port", String(port), "--throttle", `${kbps},${rtt}`, ...(h2 ? ["--h2"] : [])], { cwd: repo });
  await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("static public build") && resolve()));
  // A real (on-disk) browser profile: an incognito context's small in-memory cache cannot hold the game, which would
  // make every return visit look like a first one.
  const profileDir = path.join(process.env.LOCALAPPDATA, "RTSAI-WebGame", "scratch", `pw-firstvisit-${name}`);
  fs.rmSync(profileDir, { recursive: true, force: true });
  const browser = await chromium.launchPersistentContext(profileDir, { executablePath: fs.existsSync(exe) ? exe : undefined, headless: true,
    args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"], ignoreHTTPSErrors: h2, ...(mobile ? devices["Pixel 7"] : { viewport: { width: 1600, height: 900 } }) });
  const page = browser.pages()[0] ?? await browser.newPage();
  page.on("pageerror", (e) => console.log("pageerror", String(e)));
  const stats = async () => (await fetch(`${scheme}://127.0.0.1:${port}/__stats`)).json();
  for (const visit of ["first", "return"]) {
    await stats();
    const t0 = Date.now();
    await page.goto(`${scheme}://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 900000, polling: 100 });
    const setup = (Date.now() - t0) / 1000;
    const phase = await page.evaluate(() => window.store.getState().phase);
    if (phase === "error") { console.log("error", await page.evaluate(() => window.store.getState().error)); break; }
    // The setup screen prepares the selected map by itself (Twin Fords by default).
    // ... and streams its prebaked sprite sheets to the GPU (the world waits for them).
    await page.waitForFunction(() => { const s = window.store.getState(); return !!s.preparedMap && s.sheets.uploaded >= s.sheets.total; }, null, { timeout: 900000, polling: 100 });
    const prepared = (Date.now() - t0) / 1000;
    const ts = Date.now();
    await page.evaluate(async () => {
      const s = window.store.getState();
      const sc = { map: s.preparedMap, seed: 1, players: [{ slot: "Multi0", faction: "saudi", color: "2A6FDB" }, { slot: "Multi1", faction: "iran", bot: "normal", color: "D83A2E" }],
        options: { startingunits: "medium", explored: "False", fog: "True", crates: "False" } };
      window.game.start(JSON.stringify(sc));
    });
    await page.waitForFunction(() => window.store.getState().phase === "playing" && !!window.game.client.cur, null, { timeout: 900000, polling: 100 });
    const started = (Date.now() - t0) / 1000;
    const startOnly = (Date.now() - ts) / 1000;
    await page.waitForTimeout(3000);
    const m = await page.evaluate(() => {
      const s = window.store.getState();
      const res = performance.getEntriesByType("resource");
      return { downloads: s.downloads, lazy: s.lazy, heap: s.perf.heapMB, fps: s.perf.fps, draws: s.perf.draws, pageBytes: res.reduce((n, e) => n + (e.transferSize || 0), 0) };
    });
    const mb = (n) => +(n / 1048576).toFixed(1);
    const wire = await stats();
    const row = { network: name, kbps, rtt, visit, mobile, http: h2 ? 2 : 1, setupS: +setup.toFixed(1), mapReadyS: +prepared.toFixed(1), worldStartedS: +started.toFixed(1), startClickToPlayS: +startOnly.toFixed(2),
      transferredMB: mb(wire.sent), requests: wire.requests, byRoot: Object.fromEntries(Object.entries(wire.byRoot ?? {}).map(([k, v]) => [k, mb(v)])), lazyReadsMB: mb(m.lazy?.fetchedBytes ?? 0), heapMB: Math.round(m.heap), fps: Math.round(m.fps) };
    console.log(JSON.stringify(row));
    results.push(row);
    await page.evaluate(() => window.game.quit());
  }
  await browser.close();
  fs.rmSync(profileDir, { recursive: true, force: true });
  server.kill();
}
fs.appendFileSync(path.join(repo, "data", "firstvisit.jsonl"), results.map((r) => JSON.stringify({ at: new Date().toISOString(), ...r })).join("\n") + "\n");
