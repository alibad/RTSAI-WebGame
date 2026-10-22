// One AI-vs-AI match in the live web game's ungated twin: both seats are bots, the page spectates.
//   node tools/match.mjs --a america --b russia [--map ra2-tournament-2B] [--bot normal] [--speed 8]
//        [--limit 2400] [--seed 1] [--units none|light|medium|heavy] [--cash 2500|5000|10000|20000]
//        [--shots <dir>] [--replays <dir>] [--url http://127.0.0.1:3741/] [--headed]
// Prints one RESULT line (JSON): winner, game seconds, per-side stats, a stats timeline (for the film overlay), what
// each side owned every 120 game seconds, page errors, wall time. Saves the match's recorded orders (the game's own
// replay record) to <replays>/<a>-vs-<b>-s<seed>.json: OpenRA bots use unsynced randomness, so a seed alone does not
// reproduce a bot match, but its recorded orders do.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "file:///C:/Users/Admin/Code/hq/games/RTSAI-WebGame/web/node_modules/playwright-core/index.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);
const A = opt("a", "america"), B = opt("b", "russia");
const map = opt("map", "ra2-tournament-2B");
const bot = opt("bot", "normal");
const speed = Number(opt("speed", 8));
const limit = Number(opt("limit", 2400)); // game seconds
const seed = Number(opt("seed", 1));
const shots = opt("shots", "");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const replays = opt("replays", path.join(root, "replays"));
// Lobby settings that differ from the skirmish defaults (starting units, starting cash).
const units = opt("units", ""), cash = opt("cash", "");
const censusEvery = Number(opt("census-every", 120)); // game seconds
const url = opt("url", "http://127.0.0.1:3741/");
const exe = process.env.LOCALAPPDATA + "/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
if (shots) fs.mkdirSync(shots, { recursive: true });

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const browser = await chromium.launch({ executablePath: exe, headless: !flag("headed"),
  args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (e) => errors.push({ at: Date.now() - t0, kind: "pageerror", text: String(e.stack ?? e).slice(0, 1500) }));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push({ at: Date.now() - t0, kind: m.type(), text: m.text().slice(0, 1500) }); });
page.on("crash", () => errors.push({ at: Date.now() - t0, kind: "crash", text: "page crashed" }));
// --bundle: a patched web-bundle.pack (tools/bundle_rules.py) served in place of the live one, to test a rules fix.
const bundle = opt("bundle", "");
if (bundle) await page.route(/\/public\/web-bundle\.pack$/, (r) => r.fulfill({ status: 200, contentType: "application/octet-stream", body: fs.readFileSync(bundle) }));

let result;
const scenarioOf = (options) => ({ map, seed, players: [
  { slot: "Multi0", faction: A, bot, color: "4F80FF" },
  { slot: "Multi1", faction: B, bot, color: "FF4848" },
], options });
try {
  await page.goto(`${url}?profile=public&mode=skirmish`);
  await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 300000, polling: 500 });
  const setup = await page.evaluate(() => window.store.getState().setup);
  const options = Object.fromEntries((setup.options ?? []).map((o) => [o.id, o.default]));
  Object.assign(options, { cheats: "False", "rtsai-cocommander": "False" }, units ? { startingunits: units } : {}, cash ? { startingcash: cash } : {});
  const scenario = scenarioOf(options);
  log("start", A, "vs", B, "on", map);
  await page.evaluate((s) => window.game.start(JSON.stringify(s)), scenario);
  await page.waitForFunction(() => ["playing", "error"].includes(window.store.getState().phase), null, { timeout: 300000, polling: 250 });
  const phase = await page.evaluate(() => window.store.getState().phase + " " + (window.store.getState().error ?? ""));
  if (!phase.startsWith("playing")) throw new Error("did not start: " + phase);
  // Snapshots carry only the actors in view: keep the whole map in view (for the census).
  await page.evaluate(() => {
    const g = window.game;
    g.sendView = function () { this.client.send({ type: "view", x0: -100000, y0: -100000, x1: 100000, y1: 100000 }); };
    g.sendView(true);
  });
  await page.evaluate((v) => window.game.client.send({ type: "speed", speed: v }), speed);

  let lastShot = -1e9, stats = null, nextCensus = 0;
  const timeline = [], census = [];
  for (;;) {
    await page.waitForTimeout(2000);
    stats = await page.evaluate(() => window.game.command({ cmd: "stats" }));
    if (!stats?.players) throw new Error("stats: " + JSON.stringify(stats).slice(0, 300));
    const gs = (stats.tick * stats.timestep) / 1000;
    const st = await page.evaluate(() => { const s = window.store.getState(); return { phase: s.phase, error: s.error }; });
    timeline.push({ tick: stats.tick, wall: Math.round((Date.now() - t0) / 1000), p: stats.players.map((p) => [p.army.at(-1), p.killsCost, p.deathsCost, p.unitsDead, p.buildingsDead, p.earned]) });
    if (gs >= nextCensus) {
      // What each side owns, read from a paused, fully refreshed whole-map snapshot.
      nextCensus += censusEvery;
      await page.evaluate(() => window.game.client.send({ type: "pause", paused: true }));
      await page.waitForTimeout(600);
      census.push({ game: Math.round(gs), sides: await page.evaluate(() => {
        const c = window.game.client, s = c.cur; if (!s) return {};
        const out = {};
        s.players.forEach((p, i) => { if (p.flags & 4 && !(p.flags & 8)) out[i] = { faction: c.str(p.faction), types: {} }; });
        for (const a of s.actors) if (out[a.owner]) { const t = c.str(a.type); out[a.owner].types[t] = (out[a.owner].types[t] ?? 0) + 1; }
        return Object.fromEntries(Object.values(out).map((o) => [o.faction, o.types]));
      }) });
      await page.evaluate(() => window.game.client.send({ type: "pause", paused: false }));
    }
    if (shots && gs - lastShot >= 120) {
      lastShot = gs;
      await page.screenshot({ path: path.join(shots, `t${String(Math.round(gs)).padStart(5, "0")}.png`) });
    }
    if (st.phase !== "playing") { log("phase changed", st.phase, st.error); errors.push({ at: Date.now() - t0, kind: "phase", text: `${st.phase}: ${st.error}` }); break; }
    const decided = stats.players.some((p) => p.win === "Won") || stats.players.filter((p) => p.win === "Lost").length >= stats.players.length - 1;
    if (decided) { log("decided at", gs.toFixed(0), "s", stats.players.map((p) => `${p.faction}:${p.win}`).join(" ")); break; }
    if (gs >= limit) { log("time limit"); break; }
    if (timeline.length % 15 === 0) log("game", gs.toFixed(0), "s army", stats.players.map((p) => `${p.faction}=${p.army.at(-1)}`).join(" "), "kills$", stats.players.map((p) => p.killsCost).join("/"));
  }
  // The match's recorded orders (the game's own save/replay record).
  let replayFile = null;
  if (replays) {
    const rec = await page.evaluate((m) => window.game.client.request({ type: "record", map: m }), map);
    replayFile = path.join(replays, `${A}-vs-${B}-s${seed}.json`);
    fs.mkdirSync(replays, { recursive: true });
    fs.writeFileSync(replayFile, JSON.stringify({ scenario, log: rec.log, tick: rec.tick }));
  }
  const gs = (stats.tick * stats.timestep) / 1000;
  const winner = stats.players.find((p) => p.win === "Won")?.faction ?? null;
  result = { a: A, b: B, map, bot, seed, speed, units: options.startingunits, cash: options.startingcash, bundle: bundle || null, winner, gameSeconds: Math.round(gs), wallSeconds: Math.round((Date.now() - t0) / 1000), replay: replayFile,
    players: stats.players.map(({ army, ...p }) => ({ ...p, armyPeak: Math.max(...army), armyEnd: army.at(-1), army })), timeline, census, errors };
} catch (e) {
  result = { a: A, b: B, map, bot, seed, speed, units, cash, winner: null, failed: String(e.stack ?? e).slice(0, 2000), wallSeconds: Math.round((Date.now() - t0) / 1000), errors };
}
console.log("RESULT " + JSON.stringify(result));
await browser.close();
