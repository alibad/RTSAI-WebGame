// One skirmish with the engine's AI in both seats, each at its own difficulty, in the live game's sign-in-free twin
// page (the Arena runner serves it on 127.0.0.1:3464). It answers "what does the computer player do?": what it
// builds, how much of its army sits idle, when it reaches the enemy base, how much money it leaves unspent, and
// whether the game ends.
//   node tools/arena/skirmish-match.mjs --a iran --a-skill normal --b saudi --b-skill hard --out <run folder>
//        [--map ra2-tournament-2B] [--seed 1] [--speed 8] [--limit 2400] [--url http://127.0.0.1:3464/] [--bundle <pack>]
// Prints one RESULT line (JSON) in the faction showdown's format (evals/faction-showdown-20261022/tools/match.mjs),
// so its film.mjs films the replay unchanged, plus:
//   samples: every ~2 s, per side [combat units, idle ones, ones near the enemy base, buildings]
//   census:  every 60 game seconds, per side what it owns by type, and how many of each are idle
// The replay (the game's recorded orders) goes to <out>/replays/<a>-vs-<b>-s<seed>.json. Bots use unsynced
// randomness: the replay reproduces the game, the seed does not.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SKILLS } from "./skirmish-skills.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const A = opt("a", "iran"), B = opt("b", "saudi");
const aSkill = opt("a-skill", "normal"), bSkill = opt("b-skill", "normal");
if (!SKILLS[aSkill] || !SKILLS[bSkill]) throw new Error(`skills: ${Object.keys(SKILLS).join(", ")}`);
const map = opt("map", "ra2-tournament-2B");
const seed = Number(opt("seed", 1));
const speed = Number(opt("speed", 8));
const limit = Number(opt("limit", 2400)); // game seconds
const url = opt("url", "http://127.0.0.1:3464/");
const out = path.resolve(opt("out", "."));
const bundle = opt("bundle", "");
const censusEvery = 60;

const { chromium } = await import(pathToFileURL(path.join(repo, "web", "node_modules", "playwright-core", "index.mjs")).href);
const msPlaywright = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
const chrome = (fs.existsSync(msPlaywright) ? fs.readdirSync(msPlaywright) : []).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
  .map((d) => path.join(msPlaywright, d, "chrome-win64", "chrome.exe")).find((f) => fs.existsSync(f));

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "--mute-audio"] });
// Nobody watches these games: a small window, since the GPU is shared.
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on("pageerror", (e) => errors.push({ at: Date.now() - t0, kind: "pageerror", text: String(e.stack ?? e).slice(0, 800) }));
page.on("crash", () => errors.push({ at: Date.now() - t0, kind: "crash", text: "page crashed" }));
if (bundle) await page.route(/\/public\/web-bundle\.pack$/, (r) => r.fulfill({ status: 200, contentType: "application/octet-stream", body: fs.readFileSync(bundle) }));

const seat = (slot, faction, skill, color) => ({ slot, faction, color, bot: SKILLS[skill].bot, ...(SKILLS[skill].handicap ? { handicap: SKILLS[skill].handicap } : {}), ...(SKILLS[skill].cash ? { cash: SKILLS[skill].cash } : {}) });
let result;
try {
  await page.goto(`${url}?profile=public&mode=skirmish`);
  await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 300000, polling: 500 });
  const setup = await page.evaluate(() => window.store.getState().setup);
  // The skirmish screen's own defaults, without crates (they hand out units no side built) or the adviser.
  const options = { ...Object.fromEntries((setup.options ?? []).map((o) => [o.id, o.default])), cheats: "False", crates: "False", "rtsai-cocommander": "False" };
  const scenario = { map, seed, options, players: [seat("Multi0", A, aSkill, "4F80FF"), seat("Multi1", B, bSkill, "FF4848")] };
  log("start", A, aSkill, "vs", B, bSkill, "on", map);
  await page.evaluate((s) => window.game.start(JSON.stringify(s)), scenario);
  await page.waitForFunction(() => ["playing", "error"].includes(window.store.getState().phase), null, { timeout: 300000, polling: 250 });
  const phase = await page.evaluate(() => `${window.store.getState().phase} ${window.store.getState().error ?? ""}`);
  if (!phase.startsWith("playing")) throw new Error(`did not start: ${phase}`);
  // Snapshots carry only the actors in view: keep the whole map in view.
  await page.evaluate(() => { const g = window.game; g.sendView = function () { this.client.send({ type: "view", x0: -100000, y0: -100000, x1: 100000, y1: 100000 }); }; g.sendView(true); });
  // What everything costs and which queue makes it, for reading the census afterwards.
  const catalogFile = path.join(out, "catalog.json");
  if (!fs.existsSync(catalogFile)) {
    // units: name, label, queue, kind, cost; rosters: faction -> what its player can build.
    const catalog = await page.evaluate(() => window.game.catalog()).catch(() => null);
    fs.mkdirSync(out, { recursive: true });
    if (catalog?.units) fs.writeFileSync(catalogFile, JSON.stringify({ units: catalog.units.map((u) => ({ name: u.name, label: u.label, queue: u.queue, kind: u.kind, cost: u.cost, combat: u.combat, modern: u.modern })), rosters: catalog.rosters, factions: setup.factions, bots: setup.bots }));
  }
  await page.evaluate((v) => window.game.client.send({ type: "speed", speed: v }), speed);

  // Each side's start (its first buildings or units), read once; "near the enemy base" is measured from it.
  const read = (homes) => page.evaluate((homes) => {
    const c = window.game.client, s = c.cur;
    if (!s) return null;
    const b = window.game.info.bounds, reach = Math.hypot(b[2] - b[0], b[3] - b[1]) * 0.2;
    const sides = {};
    s.players.forEach((p, i) => { if (p.flags & 4 && !(p.flags & 8)) sides[i] = { faction: c.str(p.faction), units: 0, idle: 0, forward: 0, buildings: 0, types: {}, sum: [0, 0, 0], bsum: [0, 0, 0] }; });
    const order = Object.keys(sides).map(Number);
    for (const a of s.actors) {
      const o = sides[a.owner];
      if (!o || a.flags & 16 || a.maxHp <= 0) continue;
      const t = c.str(a.type), row = (o.types[t] ??= [0, 0]);
      row[0]++;
      if (a.flags & 8) { o.buildings++; o.bsum[0] += a.sx; o.bsum[1] += a.sy; o.bsum[2]++; continue; }
      if (a.flags & 4) row[1]++;
      o.sum[0] += a.sx; o.sum[1] += a.sy; o.sum[2]++;
      // Harvesters and construction vehicles are counted with the units here; the census tells them apart by type.
      o.units++;
      if (a.flags & 4) o.idle++;
      const enemy = homes?.[order.find((k) => k !== a.owner)];
      if (enemy && Math.hypot(a.sx - enemy[0], a.sy - enemy[1]) < reach) o.forward++;
    }
    return { tick: s.header.tick, order, sides };
  }, homes);

  let stats = null, nextCensus = 0, homes = null;
  const timeline = [], samples = [], census = [];
  for (;;) {
    await page.waitForTimeout(2000);
    stats = await page.evaluate(() => window.game.command({ cmd: "stats" }));
    if (!stats?.players) throw new Error("stats: " + JSON.stringify(stats).slice(0, 300));
    const gs = (stats.tick * stats.timestep) / 1000;
    const st = await page.evaluate(() => { const s = window.store.getState(); return { phase: s.phase, error: s.error }; });
    timeline.push({ tick: stats.tick, wall: Math.round((Date.now() - t0) / 1000), p: stats.players.map((p) => [p.army.at(-1), p.killsCost, p.deathsCost, p.unitsDead, p.buildingsDead, p.earned]) });
    const now = await read(homes);
    if (now) {
      if (!homes) {
        homes = {};
        for (const k of now.order) { const o = now.sides[k]; homes[k] = o.bsum[2] ? [o.bsum[0] / o.bsum[2], o.bsum[1] / o.bsum[2]] : o.sum[2] ? [o.sum[0] / o.sum[2], o.sum[1] / o.sum[2]] : null; }
        if (now.order.some((k) => !homes[k])) homes = null;
      }
      samples.push({ tick: now.tick, s: now.order.map((k) => { const o = now.sides[k]; return [o.units, o.idle, o.forward, o.buildings]; }) });
      if (gs >= nextCensus) { nextCensus += censusEvery; census.push({ game: Math.round(gs), sides: Object.fromEntries(now.order.map((k) => [now.sides[k].faction, now.sides[k].types])) }); }
    }
    if (st.phase !== "playing") { log("phase changed", st.phase, st.error); errors.push({ at: Date.now() - t0, kind: "phase", text: `${st.phase}: ${st.error}` }); break; }
    const decided = stats.players.some((p) => p.win === "Won") || stats.players.filter((p) => p.win === "Lost").length >= stats.players.length - 1;
    if (decided) { log("decided at", gs.toFixed(0), "s", stats.players.map((p) => `${p.faction}:${p.win}`).join(" ")); break; }
    if (gs >= limit) { log("time limit"); break; }
    if (timeline.length % 30 === 0) log("game", gs.toFixed(0), "s army", stats.players.map((p) => `${p.faction}=${p.army.at(-1)}`).join(" "), "kills$", stats.players.map((p) => p.killsCost).join("/"));
  }
  const rec = await page.evaluate((m) => window.game.client.request({ type: "record", map: m }), map);
  const replayFile = path.join(out, "replays", `${A}-vs-${B}-s${seed}.json`);
  fs.mkdirSync(path.dirname(replayFile), { recursive: true });
  fs.writeFileSync(replayFile, JSON.stringify({ scenario, log: rec.log, tick: rec.tick }));
  const gs = (stats.tick * stats.timestep) / 1000;
  result = { a: A, b: B, aSkill, bSkill, map, bot: scenario.players[0].bot, seed, speed, units: options.startingunits, cash: options.startingcash, bundle: bundle || null,
    winner: stats.players.find((p) => p.win === "Won")?.faction ?? null, winnerSeat: stats.players.findIndex((p) => p.win === "Won"), gameSeconds: Math.round(gs), wallSeconds: Math.round((Date.now() - t0) / 1000), replay: replayFile,
    players: stats.players.map(({ army, ...p }) => ({ ...p, armyPeak: Math.max(...army), armyEnd: army.at(-1), army })), timeline, samples, census, errors, playedAt: new Date().toISOString() };
} catch (e) {
  result = { a: A, b: B, aSkill, bSkill, map, seed, speed, winner: null, failed: String(e.stack ?? e).slice(0, 2000), wallSeconds: Math.round((Date.now() - t0) / 1000), errors };
}
console.log("RESULT " + JSON.stringify(result));
await browser.close();
