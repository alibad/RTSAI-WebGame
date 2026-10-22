// Coverage check for one faction in the live web game's ungated twin: can every unit in its roster be built, and does
// every combat unit actually fire? Plus page errors. (Whether the AI ever builds a unit comes from the AI-vs-AI runs.)
//   node tools/coverage.mjs --faction russia [--url http://127.0.0.1:3742/] [--out dev/coverage] [--bundle <pack>]
// 1. Buildable: a skirmish as the faction (the page's own player) against an idle AI; every building in the faction's
//    roster is placed (so every prerequisite is met), then the production catalog says what each unit still lacks.
// 2. Fires: each combat unit is placed six cells from enemy targets (a tank, a soldier, a building), ordered to attack
//    them one at a time, and counts as firing when an enemy target loses health. Ships need water and are only checked
//    for being buildable.
// --bundle serves a patched web-bundle.pack in place of the live one (tools/bundle_rules.py), to test a rules fix.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "file:///C:/Users/Admin/Code/hq/games/RTSAI-WebGame/web/node_modules/playwright-core/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const faction = opt("faction", "russia");
const url = opt("url", "http://127.0.0.1:3742/");
const outDir = path.resolve(root, opt("out", "dev/coverage"));
const bundle = opt("bundle", "");
fs.mkdirSync(outDir, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${faction}:`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ALLIES = ["america", "germany", "england", "france", "korea", "china", "turkey", "saudi", "israel"];
const enemy = ALLIES.includes(faction) ? "russia" : "america";

const exe = process.env.LOCALAPPDATA + "/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "--mute-audio"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack ?? e).slice(0, 800)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 800)); });
if (bundle) await page.route(/\/public\/web-bundle\.pack$/, (r) => r.fulfill({ status: 200, contentType: "application/octet-stream", body: fs.readFileSync(bundle) }));

const ev = (f, a) => page.evaluate(f, a);
const cmd = (c) => ev((c) => window.game.command(c), c);
const actors = () => ev(() => { const c = window.game.client, s = c.cur; return s ? s.actors.map((a) => ({ id: a.id, type: c.str(a.type), owner: a.owner, hp: a.hp, maxHp: a.maxHp, x: a.sx, y: a.sy })) : []; });

await page.goto(`${url}?profile=public&mode=skirmish`);
await page.waitForFunction(() => window.store?.getState().phase === "setup", null, { timeout: 300000, polling: 500 });
const setup = await ev(() => window.store.getState().setup);
const options = Object.fromEntries((setup.options ?? []).map((o) => [o.id, o.default]));
Object.assign(options, { cheats: "False", "rtsai-cocommander": "False", startingunits: "none", startingcash: "10000", fog: "False", explored: "True", crates: "False", shortgame: "False" });
await ev((s) => window.game.start(JSON.stringify(s)), { map: "ra2-tournament-2B", seed: 5, players: [
  { slot: "Multi0", faction, color: "4F80FF" }, { slot: "Multi1", faction: enemy, bot: "webidle", color: "FF4848" }], options });
await page.waitForFunction(() => window.store.getState().phase === "playing", null, { timeout: 300000, polling: 250 });
// Snapshots carry only actors in view: keep the whole map in view.
await ev(() => { const g = window.game; g.sendView = function () { this.client.send({ type: "view", x0: -100000, y0: -100000, x1: 100000, y1: 100000 }); }; g.sendView(true); });
await sleep(1500);

// The faction's roster (what its production lists hold) and the unit catalog's queue for each name.
const cat = await ev(() => window.game.catalog());
const roster = cat.rosters[faction];
const info = Object.fromEntries(cat.units.map((u) => [u.name, u]));
const spawns = (await cmd({ cmd: "spawnpoints" })).points;
const local = await ev(() => window.game.client.cur.header.localPlayer);
const home = spawns[0];

// 1. Every building of the roster, laid out on a grid around the start (each completes a prerequisite).
// Defences and superweapons stay out (they would shoot the firing range) unless a unit needs one.
const buildings = roster.filter((n) => info[n]?.kind === "building" && !/wall/.test(n));
const placed = [];
async function place(b) {
  const i = placed.length, col = i % 6, row = Math.floor(i / 6);
  const r = await cmd({ cmd: "spawn", type: b, player: 0, u: home.u - 12 + col * 5, v: home.v - 16 + row * 7 });
  placed.push({ b, ok: !r.error, error: r.error });
}
for (const b of buildings) await place(b);
await sleep(2500);
{
  const cat0 = await ev(() => window.store.getState().catalog);
  const missing = new Set(cat0.flatMap((q) => q.items).filter((it) => !it.buildable).flatMap((it) => it.requires ?? []));
  const extra = roster.filter((n) => missing.has(n) && !buildings.includes(n));
  for (const b of extra) await place(b);
  if (extra.length) { log("also placed (required by units):", extra.join(", ")); await sleep(2500); }
}
const owned = new Set((await actors()).filter((a) => a.owner === local).map((a) => a.type));
const catalog = await ev(() => window.store.getState().catalog);
const items = Object.fromEntries(catalog.flatMap((q) => q.items.map((it) => [it.name, { ...it, queue: q.type }])));
const units = roster.filter((n) => ["Infantry", "Vehicle", "Aircraft", "Ship"].includes(info[n]?.queue));
const buildable = Object.fromEntries(units.map((n) => [n, items[n] ? { buildable: items[n].buildable, requires: items[n].requires ?? [] } : { buildable: false, requires: ["not in any production list"] }]));
log("buildings placed", placed.filter((p) => p.ok).length, "of", buildings.length, "; units buildable", Object.values(buildable).filter((b) => b.buildable).length, "of", units.length);

// 2. The firing range: fresh enemy targets for every unit (nothing left over from the last test: an infesting drone or
// a ticking bomb would keep hurting them), three quarters of the way to the enemy start, out of reach of home.
const mid = { u: Math.round(spawns[0].u + (spawns[1].u - spawns[0].u) * 0.75), v: Math.round(spawns[0].v + (spawns[1].v - spawns[0].v) * 0.75) };
// The air target is a Kirov airship for every enemy (anti-aircraft-only units have nothing else to shoot).
const TARGETS = enemy === "russia" ? { vehicle: "htnk", infantry: "e2", building: "napowr", air: "zep" } : { vehicle: "mtnk", infantry: "e1", building: "gapowr", air: "zep" };
const SPOT = { vehicle: [0, 0], infantry: [-2, 2], building: [3, 0], air: [1, -3] };
await ev((v) => window.game.client.send({ type: "speed", speed: v }), 4);
// Clicks land on the middle of an actor's on-screen box (bounds are stored relative to its position; the centre point
// can miss a small soldier).
const boxes = () => ev(() => { const c = window.game.client, s = c.cur; return s ? s.actors.map((a) => ({ id: a.id, type: c.str(a.type), owner: a.owner, hp: a.hp, maxHp: a.maxHp, cx: a.sx + a.bx + a.bw / 2, cy: a.sy + a.by + a.bh / 2 })) : []; });
const homeTypes = new Set(placed.map((p) => p.b));
async function clearRange() {
  // Everything but the home buildings and the enemy's own start: both sides' units and the old targets.
  const startIds = new Set(enemyStart);
  for (const a of await actors()) {
    if (a.owner === 0 || startIds.has(a.id)) continue;
    if (a.owner === local && homeTypes.has(a.type)) continue;
    await cmd({ cmd: "remove", id: a.id });
  }
  await sleep(300);
}
async function freshTargets() {
  await clearRange();
  const want = {};
  for (const [role, type] of Object.entries(TARGETS)) {
    const before = new Set((await actors()).map((a) => a.id));
    await cmd({ cmd: "spawn", type, player: 1, u: mid.u + SPOT[role][0], v: mid.v + SPOT[role][1] });
    await sleep(300);
    want[role] = (await boxes()).find((a) => !before.has(a.id) && a.type === type);
  }
  return want;
}
const enemyStart = (await actors()).filter((a) => a.owner !== local && a.owner !== 0).map((a) => a.id);

const NONCOMBAT = /^(harv|cmin|amcv|smcv|engineer|spy|sapc|lcrf|shad)$|mcv|harv|miner|engineer|transport/i;
const fires = {};
// --only a,b: test just these units (a re-check of the ones that did not fire).
const only = opt("only", "") ? new Set(opt("only").split(",")) : null;
for (const n of units) {
  if (only && !only.has(n)) continue;
  if (info[n]?.queue === "Ship") { fires[n] = { tested: false, why: "ship (needs water)" }; continue; }
  if (NONCOMBAT.test(n)) { fires[n] = { tested: false, why: "not a combat unit" }; continue; }
  let result = { tested: true, fired: false, why: "no enemy target lost health" };
  // Each target kind gets its own fresh range and a fresh unit, so one target's leftovers never count for another.
  for (const role of ["vehicle", "infantry", "building", "air"]) {
    const tg = await freshTargets();
    const t = tg[role];
    if (!t) continue;
    const before = new Set((await actors()).map((a) => a.id));
    const r = await cmd({ cmd: "spawn", type: n, player: 0, u: mid.u - 6, v: mid.v + 6 });
    if (r.error) { result = { tested: true, fired: false, why: `could not be placed: ${r.error}` }; break; }
    await sleep(400);
    const mine = (await actors()).filter((a) => a.owner === local && a.type === n && !before.has(a.id));
    if (!mine.length) { result = { tested: true, fired: false, why: "not on the map after placing" }; break; }
    const ids = Object.values(tg).filter(Boolean).map((a) => a.id);
    const roleOf = Object.fromEntries(Object.entries(tg).filter(([, a]) => a).map(([r, a]) => [a.id, r]));
    // Health and owner of each target (a mind-controlled target changes owner instead of losing health).
    const hpOf = async () => Object.fromEntries((await actors()).filter((a) => ids.includes(a.id)).map((a) => [a.id, a.owner === local ? -1 : a.hp]));
    const hp0 = await hpOf();
    await ev((ids) => window.game.select(ids), mine.map((m) => m.id));
    await ev(([x, y]) => window.game.orderAt(x, y), [t.cx, t.cy]);
    let hit = null;
    for (let k = 0; k < 24 && !hit; k++) {
      await sleep(500);
      const now = await hpOf();
      const lost = ids.filter((id) => now[id] !== undefined && now[id] >= 0 && now[id] < hp0[id]);
      const taken = ids.filter((id) => now[id] === -1);
      const gone = ids.filter((id) => now[id] === undefined);
      if (lost.length || gone.length || taken.length) hit = { ordered: role, hit: [...new Set([...lost, ...gone, ...taken].map((id) => roleOf[id]))], damage: lost.reduce((s, id) => s + hp0[id] - now[id], 0), killed: gone.length, controlled: taken.length };
    }
    if (hit) { result = { tested: true, fired: true, ...hit }; break; }
  }
  fires[n] = result;
  log(n, result.fired ? `fires (hit ${result.hit.join(", ")}${result.controlled ? ", mind control" : ""})` : `DOES NOT FIRE: ${result.why}`);
}
await clearRange();
const report = { faction, enemy, bundle: bundle || null, placed, buildable, fires, errors, seconds: Math.round((Date.now() - t0) / 1000) };
// A re-check merges into the faction's earlier report.
const file = path.join(outDir, `${faction}.json`);
if (only && fs.existsSync(file)) { const prev = JSON.parse(fs.readFileSync(file, "utf8")); report.fires = { ...prev.fires, ...fires }; report.errors = [...prev.errors, ...errors]; }
fs.writeFileSync(file, JSON.stringify(report, null, 1));
const notBuildable = Object.entries(buildable).filter(([, b]) => !b.buildable);
const noFire = Object.entries(fires).filter(([, f]) => f.tested && !f.fired);
log(`done: ${units.length - notBuildable.length}/${units.length} buildable; ${Object.values(fires).filter((f) => f.fired).length} fire, ${noFire.length} do not; ${errors.length} page errors`);
if (notBuildable.length) log("not buildable:", notBuildable.map(([n, b]) => `${n} (needs ${b.requires.join(", ")})`).join("; "));
await browser.close();
