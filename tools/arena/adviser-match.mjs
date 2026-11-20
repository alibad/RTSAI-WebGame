// One whole skirmish of a player who does exactly what the built-in adviser recommends (Auto: every card applied at
// once), against the engine's computer player, in the live game's sign-in-free twin page (the Arena runner serves it
// on 127.0.0.1:3464). It answers "does following the adviser win?", and if not, where the player falls behind.
//   node tools/arena/adviser-match.mjs --out <run folder> [--faction iran] [--enemy saudi] [--skill normal]
//        [--map ra2-tournament-2B] [--seed 1] [--speed 4] [--limit 2400] [--adviser <adviser js>] [--bundle <pack>]
// --adviser: a bundle of web/src/adviser.ts and adviser-tree.ts as the global __adviserPreview (esbuild --bundle
// --format=iife --global-name=__adviserPreview) takes the place of the page's own skirmish adviser.
// The adviser looks once a game second, as it does for a player at normal speed, however fast the game runs here.
// Prints one RESULT line (JSON): the outcome, every recommendation (game second, key, summary), and every 30 game
// seconds per side: earned, army value, what it owns by type (count, idle); writes the same to <out>/<name>.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SKILLS } from "./skirmish-skills.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const faction = opt("faction", "iran"), enemy = opt("enemy", "saudi"), skill = opt("skill", "normal");
if (!SKILLS[skill]) throw new Error(`skills: ${Object.keys(SKILLS).join(", ")}`);
const map = opt("map", "ra2-tournament-2B"), seed = Number(opt("seed", 1));
const speed = Number(opt("speed", 4)), limit = Number(opt("limit", 2400));
const url = opt("url", "http://127.0.0.1:3464/");
const out = path.resolve(opt("out", "."));
const adviser = opt("adviser", ""), bundle = opt("bundle", "");
const name = opt("name", `${faction}-vs-${enemy}-${skill}-s${seed}`);
fs.mkdirSync(out, { recursive: true });

const { chromium } = await import(pathToFileURL(path.join(repo, "web", "node_modules", "playwright-core", "index.mjs")).href);
const msPlaywright = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
const chrome = (fs.existsSync(msPlaywright) ? fs.readdirSync(msPlaywright) : []).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
  .map((d) => path.join(msPlaywright, d, "chrome-win64", "chrome.exe")).find((f) => fs.existsSync(f));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "--mute-audio"] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack ?? e).slice(0, 600)));
page.on("crash", () => errors.push("page crashed"));
if (bundle) await page.route(/\/public\/web-bundle\.pack$/, (r) => r.fulfill({ status: 200, contentType: "application/octet-stream", body: fs.readFileSync(bundle) }));

let result;
try {
  await page.goto(`${url}?profile=public&mode=skirmish`);
  await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 300000, polling: 500 });
  const setup = await page.evaluate(() => window.store.getState().setup);
  const options = { ...Object.fromEntries((setup.options ?? []).map((o) => [o.id, o.default])), cheats: "False", crates: "False", "rtsai-cocommander": "True" };
  const s = SKILLS[skill];
  const scenario = { map, seed, options, players: [{ slot: "Multi0", faction, color: "4F80FF" },
    { slot: "Multi1", faction: enemy, color: "FF4848", bot: s.bot, ...(s.handicap ? { handicap: s.handicap } : {}), ...(s.cash ? { cash: s.cash } : {}) }] };
  await page.evaluate(() => { const cc = window.game.cc; cc.setEnabled(true); cc.setMode("browser"); cc.setAuto(true); });
  if (adviser) {
    await page.addScriptTag({ path: path.resolve(adviser) });
    const ok = await page.evaluate(() => {
      const cc = window.game.cc, A = window.__adviserPreview;
      if (typeof cc.browserChoice !== "function" || !A?.nextAdvice) return false;
      cc.browserChoice = (observation) => A.nextAdvice({ ...observation, techTree: A.adviserTreeFor(observation) });
      return true;
    });
    if (!ok) throw new Error("--adviser: the page's adviser could not be replaced");
  }
  // Every recommendation as it changes, and one look a game second (the page looks once a wall second).
  await page.evaluate(() => {
    const cc = window.game.cc, choose = cc.browserChoice.bind(cc);
    window.__cards = []; let last = "";
    // The working tree's co-commander offers an applied card again after 20 game seconds if nothing changed
    // (web/src/cocommander.ts browserAppliedTick); the live page holds it for good. Do the same here.
    let held = "", heldAt = 0;
    cc.browserChoice = (observation) => {
      if (cc.browserSuppressed !== held) { held = cc.browserSuppressed; heldAt = observation.tick; }
      if (held && observation.tick - heldAt > 25 * 20) { cc.browserSuppressed = ""; held = ""; }
      const advice = choose(observation);
      const key = advice ? `${advice.key}|${advice.summary}` : "";
      window.__last = { key: advice?.key ?? null, summary: advice ? advice.summary || advice.text.slice(0, 90) : "", orders: advice?.commands.length ?? 0,
        seen: [observation.visibleEnemyBuildings.length, observation.rememberedEnemyBuildings?.length ?? -1], available: observation.availableProduction.length,
        queue: observation.production.map((p) => `${p.queueType}:${p.item}:${Math.round(p.progress * 100)}`) };
      if (advice && key !== last && advice.commands.length) window.__cards.push([Math.round(observation.tick / 25), advice.key, advice.summary, observation.cash]);
      last = key;
      return advice;
    };
    cc.pollEvery = function () { return 1000 / Math.max(1, Math.min(4, this.pace.speed)); };
  });
  log("start", faction, "(adviser) vs", enemy, s.label, "on", map);
  await page.evaluate((sc) => window.game.start(JSON.stringify(sc)), scenario);
  await page.waitForFunction(() => ["playing", "error"].includes(window.store.getState().phase), null, { timeout: 300000, polling: 250 });
  const phase = await page.evaluate(() => `${window.store.getState().phase} ${window.store.getState().error ?? ""}`);
  if (!phase.startsWith("playing")) throw new Error(`did not start: ${phase}`);
  await page.evaluate(() => { const g = window.game; g.sendView = function () { this.client.send({ type: "view", x0: -100000, y0: -100000, x1: 100000, y1: 100000 }); }; g.sendView(true); });
  await page.evaluate((v) => window.game.client.send({ type: "speed", speed: v }), speed);
  // The working tree's reading of the engine's observation too, when the bundle has it (fields the live page skips).
  await page.evaluate(() => {
    const A = window.__adviserPreview, client = window.game.client;
    if (A?.decodeAdviserObservation) client.adviserObserve = async function () { const o = A.decodeAdviserObservation(await this.adviserRpc("Observe")); this.lastAdviserTick = o.tick; return o; };
  });

  const census = () => page.evaluate(() => {
    const c = window.game.client, s = c.cur;
    if (!s) return null;
    const sides = {};
    s.players.forEach((p, i) => { if (p.flags & 4 && !(p.flags & 8)) sides[i] = { faction: c.str(p.faction), types: {} }; });
    for (const a of s.actors) {
      const o = sides[a.owner];
      if (!o || a.flags & 16 || a.maxHp <= 0) continue;
      const row = (o.types[c.str(a.type)] ??= [0, 0]);
      row[0]++;
      if (!(a.flags & 8) && a.flags & 4) row[1]++;
    }
    return Object.values(sides);
  });
  let stats = null, next = 0;
  const minutes = [];
  for (;;) {
    await page.waitForTimeout(1500);
    stats = await page.evaluate(() => window.game.command({ cmd: "stats" }));
    const gs = (stats.tick * stats.timestep) / 1000;
    const st = await page.evaluate(() => window.store.getState().phase);
    if (gs >= next) {
      next += 30;
      // What the adviser says now (and whether that card was already applied, so it is held back), and what is queued.
      const own = await page.evaluate(() => window.game.client.adviserObserve().then((o) => ({ cash: o.cash, power: [o.powerProvided, o.powerDrained], harvesters: o.harvesterCount, explored: Math.round(o.exploredPercent),
        advice: window.__last, held: !!window.game.cc.browserSuppressed, enemyBuildings: [o.visibleEnemyBuildings.length, o.rememberedEnemyBuildings?.length ?? 0],
        cc: (() => { const cc = window.game.cc, p = cc.pending(), s = window.store.getState(); return { pending: p ? `${p.text} (${p.state})` : null, deciding: !!cc.browserDeciding, uncertain: s.cc.uncertainProposalId || null, paused: !!s.paused, autoRetried: cc.autoRetried === p?.id }; })(),
        queue: o.production.map((p) => `${p.queueType}:${p.item}:${Math.round(p.progress * 100)}`) })).catch(() => null));
      minutes.push({ game: Math.round(gs), own, p: stats.players.map((p) => ({ earned: p.earned, army: p.army.at(-1), kills: p.killsCost, deaths: p.deathsCost })), census: await census() });
    }
    if (st !== "playing") { errors.push(`phase ${st}`); break; }
    const decided = stats.players.some((p) => p.win === "Won" || p.win === "Lost");
    if (decided || gs >= limit) break;
    if (minutes.length % 4 === 0 && gs >= next - 30 && gs < next - 28) log("game", Math.round(gs), "s army", stats.players.map((p) => p.army.at(-1)).join(" / "), "earned", stats.players.map((p) => p.earned).join(" / "));
  }
  const gs = (stats.tick * stats.timestep) / 1000;
  const cards = await page.evaluate(() => window.__cards);
  // The engine's answer to every applied card: accepted, or refused and why.
  const receipts = await page.evaluate(() => [...window.game.cc.receipts.values()].map((r) => [r.accepted ? 1 : 0, r.detail ?? ""]));
  const win = stats.players[0].win;
  const rec = await page.evaluate((m) => window.game.client.request({ type: "record", map: m }), map).catch(() => null);
  if (rec) { fs.mkdirSync(path.join(out, "replays"), { recursive: true }); fs.writeFileSync(path.join(out, "replays", `${name}.json`), JSON.stringify({ scenario, log: rec.log, tick: rec.tick })); }
  result = { name, faction, enemy, skill, map, seed, speed, adviser: adviser || null, bundle: bundle || null,
    outcome: win === "Won" ? "win" : win === "Lost" ? "loss" : "no winner", gameSeconds: Math.round(gs), wallSeconds: Math.round((Date.now() - t0) / 1000),
    players: stats.players.map(({ army, ...p }) => ({ ...p, armyPeak: Math.max(...army), army })), cards, receipts, minutes, errors, playedAt: new Date().toISOString() };
} catch (e) {
  result = { name, faction, enemy, skill, map, seed, outcome: "failed", failed: String(e.stack ?? e).slice(0, 2000), wallSeconds: Math.round((Date.now() - t0) / 1000), errors };
}
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(result));
console.log("RESULT " + JSON.stringify({ ...result, cards: result.cards?.length, minutes: result.minutes?.length, players: result.players?.map((p) => ({ faction: p.faction, win: p.win, earned: p.earned, kills: p.killsCost, deaths: p.deathsCost, armyPeak: p.armyPeak })) }));
await browser.close();
