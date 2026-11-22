// Short clips of real fights for the owner's Review inbox (RTSAI-Web docs/review-inbox.md).
// Each clip is one row of a coverage grid (evals/battle-review/grid.json): two countries, their units, one way of
// fighting. The fight is set up through the Battle simulator's own link (?mode=sandbox&s=..., web/src/sandbox.ts):
// side A is the player's, with each unit's opening order; side B is the engine's AI. Nothing is approximated: it is
// the game's page, runtime and data, filmed while it plays.
//
//   node tools/static-serve.mjs --dir <a built page> --port 3475      (the page to film: see docs/BATTLE-CLIPS.md)
//   node tools/battle-clips.mjs --grid evals/battle-review/grid.json --out <folder> [--url http://127.0.0.1:3475/]
//        [--only id,id] [--seconds 30] [--play https://rtsai.net/play/]
//   node tools/battle-clips.mjs --probe <map> --unit <actor> [--faction america]     where a unit can be placed
//
//   --pack <web-bundle.pack>   answer the page's data bundle from this file: a copy of the live bundle with a rules
//                              change under test, so a proposed fix is filmed on the live build before any data build
//   --runtime <_framework dir>  answer the page's runtime (public/aot/_framework/*) from a local publish of
//                              sim/OpenRA.WebSim.Browser, so a simulation or drawing change is filmed on the live page
//                              and data before any runtime release
//   --runtime-mode interp       film a local Studio build (it ships only the interpreter runtime); default aot
//   --bars selected|damaged|all   whose health bars show (default damaged: every unit that has been hit; a grid row
//                              can say "bars" for itself)
//
// Writes <out>/<id>.mp4 (1920x1080, 30 fps), <id>.jpg, flags/ and icons/ (each unit's build icon as the game draws
// it), clips.json (what `node tools/review.mjs add <out>` in RTSAI-Web takes) and report.json (per clip: who fired,
// who died, what looks wrong). The film is drawn afterwards from the simulator's recording of the fight, one frame at
// a time at game time, so it never stutters, however busy the PC is.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { browserExecutable } from "./browser-launch.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(pathToFileURL(process.env.RTSAI_PLAYWRIGHT_MODULE ?? path.join(repo, "web/node_modules/playwright-core/index.mjs")).href);
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const url = opt("url", "http://127.0.0.1:3475/");
const play = opt("play", "https://rtsai.net/play/");
const CSS_W = 1280, CSS_H = 720, DPR = 1.5, FPS = 30;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ------------------------------------------------------------------------------------------------- the formations
// Each side stands in lines across the approach, the first group in front. Cells are the map's (u, v): one u is a
// cell across (60 px), one v half a cell down (15 px).
const SPACING = { infantry: [1, 2], vehicle: [2, 4], aircraft: [3, 6], ship: [4, 8], defense: [4, 8], building: [5, 10] };
function formation(side, groups, kinds, centre, gap) {
  const dir = side === 0 ? -1 : 1, out = [];
  let depth = 0;
  for (const g of groups) {
    const [du, dv] = SPACING[kinds[g.id] ?? "vehicle"], rows = Math.min(g.count, g.rows ?? 6), cols = Math.ceil(g.count / rows);
    for (let i = 0; i < g.count; i++) {
      const col = Math.floor(i / rows), row = i % rows, inCol = Math.min(rows, g.count - col * rows);
      out.push({ id: g.id, side, u: Math.round(centre[0] + dir * (gap / 2 + depth + col * du) + (g.du ?? 0) * dir), v: Math.round(centre[1] + (row - (inCol - 1) / 2) * dv + (g.dv ?? 0)),
        facing: side === 0 ? 768 : 256, order: g.order ?? "engage", ...(g.deploy ? { deploy: true } : {}), ...(g.level ? { level: g.level } : {}) });
    }
    depth += cols * du + 1;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- the browser
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required", "--mute-audio",
    `--force-device-scale-factor=${DPR}`, `--window-size=${CSS_W + 22},${CSS_H + 98}`, "--hide-scrollbars", "--disable-background-timer-throttling"] });
const context = await browser.newContext({ viewport: null });
await context.addInitScript(() => {
  addEventListener("DOMContentLoaded", () => {
    // Footage: the battlefield alone. The simulator's panels stay in the page (hidden), so the fight is the game's own.
    const css = document.createElement("style");
    css.textContent = `html.footage-clean body * { visibility: hidden !important; } html.footage-clean canvas.stage { visibility: visible !important; }
      html.footage-clean { --sidebar-w: 0px !important; cursor: none !important; }`;
    document.head.appendChild(css);
  });
});
const page = await context.newPage();
// Filming must not write production analytics or accounts: the page reads its own host and the game's CDN only.
await page.route("**/*", (route) => {
  const u = new URL(route.request().url());
  return ["127.0.0.1", "localhost"].includes(u.hostname) || ["blob:", "data:"].includes(u.protocol) || (u.hostname.endsWith("rtsai-play-cdn.pages.dev") && ["GET", "HEAD"].includes(route.request().method()))
    ? route.continue() : route.abort();
});
// --pack: the rules under test (as tools/film-parade.mjs). The page fetches public/web-bundle.pack from the CDN.
const packFile = opt("pack", "");
if (packFile) {
  const body = fs.readFileSync(path.resolve(packFile));
  await page.route(/\/public\/web-bundle\.pack(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: "application/octet-stream",
    headers: { "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" }, body }));
  log(`data bundle answered from ${packFile} (a rules change under test, not the live data)`);
}
// --runtime: a simulation change under test. The worker loads dotnet.js and the assemblies from the runtime root.
const runtimeDir = opt("runtime", "");
if (runtimeDir) {
  const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };
  await page.route(/\/public\/aot\/_framework\/[^?]+(\?.*)?$/, (route) => {
    const file = path.join(path.resolve(runtimeDir), decodeURIComponent(new URL(route.request().url()).pathname.split("/_framework/")[1]));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: types[path.extname(file)] ?? "application/octet-stream",
      headers: { "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" }, body: fs.readFileSync(file) });
  });
  log(`runtime answered from ${runtimeDir} (a simulation change under test, not the live runtime)`);
}
let errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack ?? e).slice(0, 400)));
page.on("console", (m) => { if (m.type() === "error" && !/net::ERR_FAILED|Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 400)); });
const cdp = await context.newCDPSession(page);
await page.goto("about:blank");
for (let i = 0; i < 4; i++) {
  const [w, h] = await page.evaluate(() => [innerWidth, innerHeight]);
  if (w === CSS_W && h === CSS_H) break;
  const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget");
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: bounds.width + (CSS_W - w), height: bounds.height + (CSS_H - h) } });
}

/** Opens a simulator link and waits for its editing world: the placements standing, paused. */
async function openSimulator(cfg) {
  // --runtime-mode interp films a local Studio build, which ships only the interpreter runtime (wasm-interp).
  await page.goto(`${url}?profile=public&private=0&runtime=${opt("runtime-mode", "aot")}&mode=sandbox&s=${b64url(cfg)}`);
  await page.waitForFunction(() => { const s = window.store?.getState(); return s?.phase === "error" || (s?.phase === "playing" && s.sandbox?.mode === "edit" && s.sandbox.units.length > 0 && !!window.game.client.cur); }, null, { timeout: 300000, polling: 250 });
  const state = await page.evaluate(() => ({ phase: window.store.getState().phase, error: window.store.getState().error }));
  if (state.phase === "error") throw new Error(`the page failed: ${state.error}`);
}

// ------------------------------------------------------------------------------------------------- --probe
if (opt("probe")) {
  // Where can this unit stand on this map? A coarse picture of the map in cells: # placed, . refused.
  const map = opt("probe"), unit = opt("unit", "dest"), faction = opt("faction", "america");
  await openSimulator({ fa: faction, fb: "russia", map, placements: [], autorun: false });
  const picture = await page.evaluate(async ({ unit }) => {
    const g = window.game, info = window.store.getState().info, [x0, y0, x1, y1] = info.bounds, rows = [];
    for (let y = y0 + 60; y < y1; y += 120) {
      let row = "";
      for (let x = x0 + 60; x < x1; x += 120) {
        const r = await g.command({ cmd: "spawn", type: unit, player: 0, x: Math.round(x), y: Math.round(y), count: 1, level: 0 });
        row += r.created ? "#" : ".";
      }
      const c = await g.command({ cmd: "cellat", x: Math.round(x0 + 60), y: Math.round(y) });
      rows.push(`${String(c.v).padStart(4)} ${row}`);
    }
    const first = await g.command({ cmd: "cellat", x: Math.round(x0 + 60), y: Math.round(y0 + 60) }), last = await g.command({ cmd: "cellat", x: Math.round(x1 - 60), y: Math.round(y0 + 60) });
    return { rows, u: [first.u, last.u], step: "one mark = 2 cells across, 8 rows (v) down" };
  }, { unit });
  console.log(`${unit} on ${map}: u from ${picture.u[0]} to ${picture.u[1]} (${picture.step}); left number = v`);
  console.log(picture.rows.join("\n"));
  await browser.close();
  process.exit(0);
}

// ------------------------------------------------------------------------------------------------- the grid
const grid = JSON.parse(fs.readFileSync(path.resolve(opt("grid") ?? (console.error("usage: node tools/battle-clips.mjs --grid <grid.json> --out <folder>"), process.exit(1))), "utf8"));
const out = path.resolve(opt("out") ?? (console.error("--out <folder>"), process.exit(1)));
const only = opt("only")?.split(",");
fs.mkdirSync(path.join(out, "icons"), { recursive: true });
fs.mkdirSync(path.join(out, "flags"), { recursive: true });
const manifestFile = path.join(out, "clips.json"), reportFile = path.join(out, "report.json");
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : { front: "battles", by: grid.by, build: grid.build, clips: [] };
const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, "utf8")) : { build: grid.build, clips: {} };
Object.assign(manifest, { by: grid.by, build: grid.build });
const KIND_CLASS = { infantry: "infantry", vehicle: "vehicle", aircraft: "aircraft", ship: "ship", defense: "defence", building: "building" };
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

let kinds = null, labels = null, factionNames = null;
for (const clip of grid.clips) {
  if (only && !only.includes(clip.id)) continue;
  errors = [];
  log(clip.id);
  // The catalog (what a unit is called, what kind it is) comes from the game itself, on the first load.
  if (!kinds) {
    await openSimulator({ fa: clip.a.faction, fb: clip.b.faction, map: "web-arena", placements: [], autorun: false });
    const c = await page.evaluate(() => { const s = window.store.getState(); return { units: s.sandbox.units, factions: s.setup.factions }; });
    kinds = Object.fromEntries(c.units.map((u) => [u.name, u.kind])); labels = Object.fromEntries(c.units.map((u) => [u.name, u.label]));
    factionNames = Object.fromEntries(c.factions.map((f) => [f.id, f.name]));
    report.combat = Object.fromEntries(c.units.map((u) => [u.name, !!u.combat]));
  }
  const centre = clip.centre ?? [64, 70], gap = clip.gap ?? 12;
  const placements = [...formation(0, clip.a.units, kinds, clip.a.at ?? centre, clip.a.at ? 0 : gap), ...formation(1, clip.b.units, kinds, clip.b.at ?? centre, clip.b.at ? 0 : gap)];
  const cfg = { fa: clip.a.faction, fb: clip.b.faction, map: clip.map ?? "web-arena", skill: clip.skill ?? "normal", money: 0, fog: false, level: 0, health: 100, placements };
  await openSimulator({ ...cfg, autorun: false });

  // What actually stands on the field (a unit the map refuses is simply not there).
  const placed = await page.evaluate(() => window.game.command({ cmd: "placements" }));
  const stand = (side, id) => (placed.spawns ?? []).filter((s) => s.player === side && s.type === id).length;
  const missing = [];
  for (const [side, s] of [[0, clip.a], [1, clip.b]]) for (const g of s.units) if (stand(side, g.id) < g.count) missing.push(`${g.count - stand(side, g.id)} of ${g.count} ${labels[g.id] ?? g.id} could not be placed`);

  // Each unit's build icon, as the game draws it.
  const sides = [];
  for (const [side, s] of [[0, clip.a], [1, clip.b]]) {
    const ids = s.units.map((g) => g.id);
    const icons = await page.evaluate(async ({ ids, faction }) => {
      const g = window.game, key = (n) => `${faction}:${n}`;
      g.requestIcons(ids, faction);
      for (let i = 0; i < 60 && ids.some((n) => window.store.getState().icons[key(n)] === undefined); i++) await new Promise((r) => setTimeout(r, 100));
      const result = {};
      for (const n of ids) {
        const src = window.store.getState().icons[key(n)];
        if (!src) continue;
        const bytes = new Uint8Array(await (await fetch(src)).arrayBuffer());
        result[n] = btoa(String.fromCharCode(...bytes));
      }
      return result;
    }, { ids, faction: s.faction });
    for (const [n, b64] of Object.entries(icons)) fs.writeFileSync(path.join(out, "icons", `${s.faction}-${n}.png`), Buffer.from(b64, "base64"));
    const flag = path.join(path.resolve(opt("flags", path.join(repo, "web/public/flags"))), `${s.faction}.svg`);
    if (fs.existsSync(flag)) fs.copyFileSync(flag, path.join(out, "flags", `${s.faction}.svg`));
    sides.push({ faction: s.faction, name: factionNames[s.faction] ?? s.faction, ...(fs.existsSync(flag) ? { flag: `flags/${s.faction}.svg` } : {}),
      units: s.units.map((g) => ({ id: g.id, name: labels[g.id] ?? g.id, count: stand(side, g.id), cls: KIND_CLASS[kinds[g.id]] ?? "vehicle", ...(icons[g.id] ? { icon: `icons/${s.faction}-${g.id}.png` } : {}) })) });
  }

  // ---- film it
  // The fight runs live first, unfilmed. The simulator keeps a snapshot of the WHOLE battlefield for every game tick
  // (web/src/sandbox.ts, the replay), so the film is then drawn from that recording: each frame at its exact game
  // time (30 a second, between two ticks as the live game draws them), grabbed from the canvas, encoded in order.
  // A busy PC can no longer drop or repeat a frame, and a game that ran slow still films at its true speed. (Until
  // 20 Nov 2026 the clips were a screencast of the live run: 16 of the first 17 stuttered, with up to 24% of their
  // frames held and then jumping; the owner took it for the game.)
  const file = path.join(out, `${clip.id}.mp4`);
  const bars = { selected: 0, damaged: 1, all: 2 }[clip.bars ?? opt("bars", "damaged")] ?? 1;
  await page.evaluate(() => {
    const g = window.game;
    document.documentElement.classList.add("footage-clean");
    // Snapshots carry only actors in view: ask for the whole map (the recording keeps everything).
    g.sendView = function () { this.client.send({ type: "view", x0: -100000, y0: -100000, x1: 100000, y1: 100000 }); };
    g.sendView(true);
  });

  // Run it as the simulator's own button does, held on its first tick, then let it go.
  await page.evaluate(() => {
    const g = window.game;
    window.__held = false;
    const off = window.store.subscribe((s) => {
      if (window.__held || s.phase !== "playing" || s.sandbox?.mode !== "run" || !((g.client.cur?.header.tick ?? 0) >= 1)) return;
      window.__held = true; off(); g.sandbox.setPaused(true);
    });
    g.sandbox.run();
  });
  await page.waitForFunction(() => window.__held === true, null, { timeout: 120000, polling: 50 });
  await sleep(400);
  const runAt = 1.2; // the film opens on both armies standing, this long
  await page.evaluate(() => window.game.sandbox.setPaused(false));
  const started = Date.now();
  // Game time counts from here: a row's scripted orders come during the fight, not before it.
  const tick0 = { tick: await page.evaluate(() => window.game.client.cur.header.tick), at: started };

  // The player's own orders, given the way a player gives them: select, then a right-click on the target.
  for (const step of clip.script ?? []) {
    // At its second of game time (on a busy PC the game runs slower than the clock).
    await page.waitForFunction((tick) => window.game.client.cur.header.tick >= tick, tick0.tick + Math.round(step.at * 25), { timeout: 120000, polling: 20 });
    if (step.do === "attack") {
      // The order goes in as a right-click at the target's place on the map (the message the page sends for a
      // real right-click), so it lands even when the camera is not showing the target.
      const ordered = await page.evaluate(async ({ type, units }) => {
        const g = window.game, s = g.client.cur, me = s.header.localPlayer, name = (a) => g.client.strings[a.type];
        const own = s.actors.filter((a) => a.owner === me && (a.flags & 1) && !(a.flags & 8) && !(a.flags & 16) && (!units || units.includes(name(a))));
        const target = s.actors.filter((a) => a.owner !== me && !(a.flags & 16) && a.maxHp > 0 && (!type || name(a) === type)).sort((a, b) => b.maxHp - a.maxHp)[0];
        if (!own.length || !target) return false;
        await g.select(own.map((a) => a.id));
        g.click(target.sx, target.sy, 2, 0);
        return true;
      }, { type: step.target, units: step.units });
      if (!ordered) errors.push(`script: no target for the attack order (${step.target ?? "any"})`);
    } else if (step.do === "stance") await page.evaluate(async ({ stance }) => { const g = window.game, s = g.client.cur; await g.select(s.actors.filter((a) => a.owner === s.header.localPlayer && (a.flags & 1)).map((a) => a.id)); await g.command({ cmd: "stance", stance }); }, { stance: step.stance });
    else if (step.do === "deselect") await page.evaluate(() => window.game.select([]));
  }

  // Watch it: who is alive, who has fired, until the time is up or one side is gone. Game time, from the ticks: on a
  // busy PC the game runs slower than real time, and the film is drawn at game time anyway.
  const seconds = Number(opt("seconds", clip.seconds ?? 28)), timeline = [];
  let ended = null, stats = null, built0 = null, builtNow = null, tickNow = null, poses = null;
  for (;;) {
    await sleep(500);
    const seen = await page.evaluate(() => {
      const g = window.game, s = g.client.cur;
      const sides = s.players.map((p, i) => ((p.flags & 4) && !(p.flags & 8) ? i : -1)).filter((i) => i >= 0).slice(0, 2);
      // Buildings and defences per side: how many stand, and their health.
      const built = sides.map((owner) => { const b = s.actors.filter((a) => a.owner === owner && (a.flags & 8) && a.maxHp > 0 && !(a.flags & 16)); return { alive: b.length, hp: b.reduce((n, a) => n + a.hp, 0) }; });
      // Each unit type's body poses (deployed or not, prone or standing), for the units still alive.
      const poses = sides.map((owner) => { const out = {}; for (const a of s.actors) { if (a.owner !== owner || (a.flags & 16) || (a.flags & 8) || !(a.maxHp > 0)) continue; const t = g.client.strings[a.type], q = g.client.str(a.sequence) || "deployed"; /* an empty pose: deployed, its sandbag body drawn instead (sandbox.ts) */ (out[t] ??= {})[q] = ((out[t] ??= {})[q] ?? 0) + 1; } return out; });
      return { stats: window.store.getState().ui?.sandbox ?? null, built, tick: s.header.tick, poses };
    });
    tickNow = { tick: seen.tick, at: Date.now() };
    const t = (seen.tick - tick0.tick) / 25;
    if (t >= seconds || (Date.now() - started) / 1000 > seconds * 4 + 30) break;
    stats = seen.stats;
    if (!stats) continue;
    if (!built0) built0 = seen.built;
    builtNow = seen.built;
    // Poses once the opening orders have played out (a deploy takes a moment) and before the fighting thins the ranks.
    if (!poses && t >= 3) poses = seen.poses;
    timeline.push({ t: +t.toFixed(1), alive: stats.sides.map((s) => s.alive), shots: stats.sides.map((s) => s.shots), hp: stats.sides.map((s) => s.hp), built: seen.built });
    // Over when a side has nothing left standing: no unit, and no building either.
    if (ended === null && stats.sides.some((s, i) => s.total + built0[i].alive > 0 && s.alive + seen.built[i].alive === 0)) ended = t;
    if (ended !== null && t - ended > 3.5 && t > 10) break;
  }
  // How fast the game really ran (25 ticks a second is real time). The film is right either way; a slow game only
  // takes longer to film.
  const tps = tickNow.at > tick0.at ? +(((tickNow.tick - tick0.tick) * 1000) / (tickNow.at - tick0.at)).toFixed(1) : null;
  await page.evaluate(() => window.game.sandbox.setPaused(true));

  // Draw the film from the recording. The camera: both armies in frame while they stand and approach, then close in
  // on where units are being hit (and whoever stands near them), so the fight itself fills the picture. "camera":
  // "all" keeps everyone in frame; "launch" opens on the player's own units until something is hit (long-range
  // fights: first the launch close up, then the landing). It glides as the live director did, in game time.
  const frames = await page.evaluate(({ zoomMin, zoomMax, fightMin, all, launch, bars, fps, hold }) => {
    const g = window.game, rec = g.sandbox.recording, TICK = 40;
    g.overlay.statusBars = bars; // the game's own health bars (","): the owner judges by them whether hits land
    const hp = new Map(), hit = new Map();
    let seen = -1, first = true;
    const glide = 1 - Math.pow(1 - 0.028, 60 / fps); // the live director's 0.028 per 60 Hz frame
    const sidesOf = (s) => s.players.map((p, i) => ((p.flags & 4) && !(p.flags & 8) ? i : -1)).filter((i) => i >= 0).slice(0, 2);
    window.__filmFrame = (k) => {
      // Film time: a held opening, then the recording at 25 ticks a second, drawn between ticks.
      const t = Math.max(0, k / fps - hold), pos = Math.min(rec.length - 1, t * 25), i = Math.min(rec.length - 1, Math.floor(pos)), j = Math.min(rec.length - 1, i + 1);
      const cur = rec[j], prev = rec[i], frac = j === i ? 1 : pos - i, now = cur.header.tick * TICK;
      for (let n = seen + 1; n <= j; n++) {
        const s = rec[n], sides = sidesOf(s);
        for (const a of s.actors) { if (!sides.includes(a.owner) || (a.flags & 16) || !(a.maxHp > 0)) continue; const was = hp.get(a.id); if (was !== undefined && a.hp < was) hit.set(a.id, s.header.tick * TICK); hp.set(a.id, a.hp); }
      }
      seen = Math.max(seen, j);
      const sides = sidesOf(cur), live = cur.actors.filter((a) => sides.includes(a.owner) && !(a.flags & 16) && a.maxHp > 0);
      const hot = all ? [] : live.filter((a) => now - (hit.get(a.id) ?? -1e9) < 2600);
      let shown = live, fight = false;
      if (launch && !hot.length && !hit.size && t > 0) { shown = live.filter((a) => a.owner === sides[0]); fight = true; }
      if (hot.length) {
        const hx = hot.map((a) => a.sx), hy = hot.map((a) => a.sy);
        const [a0, a1, b0, b1] = [Math.min(...hx) - 380, Math.max(...hx) + 380, Math.min(...hy) - 260, Math.max(...hy) + 260];
        shown = live.filter((a) => a.sx >= a0 && a.sx <= a1 && a.sy >= b0 && a.sy <= b1);
        fight = true;
      }
      if (shown.length) {
        const xs = shown.map((a) => a.sx), ys = shown.map((a) => a.sy);
        const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        const fit = Math.min(g.canvas.clientWidth / (x1 - x0 + 240), g.canvas.clientHeight / (y1 - y0 + 180));
        const zoom = Math.max(fight ? fightMin : zoomMin, Math.min(zoomMax, fit));
        // Snap during the held opening, then glide.
        const kk = first || t === 0 ? 1 : glide;
        // Stay on the map where it is larger than the picture: the black beyond its edge is not part of the game.
        const bounds = window.store.getState().info?.bounds, halfW = g.canvas.clientWidth / zoom / 2, halfH = g.canvas.clientHeight / zoom / 2;
        const within = (v, lo, hi, half) => (hi - lo > half * 2 ? Math.min(hi - half, Math.max(lo + half, v)) : v);
        const tx = bounds ? within((x0 + x1) / 2, bounds[0], bounds[2], halfW) : (x0 + x1) / 2, ty = bounds ? within((y0 + y1) / 2, bounds[1], bounds[3], halfH) : (y0 + y1) / 2;
        g.cam.x += (tx - g.cam.x) * kk; g.cam.y += (ty - g.cam.y) * kk; g.cam.zoom += (zoom - g.cam.zoom) * kk;
        first = false;
      }
      g.renderer.runModels(cur);
      g.renderer.render(cur, prev === cur ? null : prev, g.cam, g.overlay, cur.receivedAt + TICK * frac);
      const copy = document.createElement("canvas");
      copy.width = g.canvas.width; copy.height = g.canvas.height;
      copy.getContext("2d").drawImage(g.canvas, 0, 0);
      return copy.toDataURL("image/jpeg", 0.92).slice("data:image/jpeg;base64,".length);
    };
    return Math.round(((rec.length - 1) / 25 + hold) * fps) + 1;
  }, { zoomMin: clip.zoomMin ?? 0.55, zoomMax: clip.zoomMax ?? 2.2, fightMin: clip.fightMin ?? 1.15, all: clip.camera === "all", launch: clip.camera === "launch", bars, fps: FPS, hold: runAt });
  const vf = ["scale=1920:1080:flags=lanczos:in_range=full:in_color_matrix=bt601:out_range=limited:out_color_matrix=bt709", "format=yuv420p", "setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709"].join(",");
  const ff = spawn("ffmpeg", ["-y", "-v", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-", "-vf", vf, "-c:v", "libx264", "-preset", "medium", "-crf", String(clip.crf ?? 24), "-pix_fmt", "yuv420p", "-r", String(FPS), "-movflags", "+faststart", file], { stdio: ["pipe", "inherit", "inherit"] });
  const closed = new Promise((r) => ff.on("close", r));
  for (let k = 0; k < frames; k++) {
    const jpeg = Buffer.from(await page.evaluate((k) => window.__filmFrame(k), k), "base64");
    if (!ff.stdin.write(jpeg)) await new Promise((r) => ff.stdin.once("drain", r));
  }
  ff.stdin.end();
  await closed;
  const length = frames / FPS - runAt;
  log(`  filmed ${frames} frames from ${tickNow.tick - tick0.tick} ticks (the game ran at ${tps} ticks a second)`);
  await page.evaluate(() => { delete window.__filmFrame; document.documentElement.classList.remove("footage-clean"); });

  // ---- what looks wrong, from the numbers (the clip is still watched by eye before it is sent)
  const suspects = [], at = (t) => +(Math.min(length, Math.max(0, t)) + runAt).toFixed(1);
  for (const m of missing) suspects.push({ t: 0, text: `${m}.` });
  if (stats) {
    for (const ty of stats.types) {
      if (!report.combat[ty.type] || ty.shots > 0 || ty.total === 0) continue;
      const side = [clip.a, clip.b][ty.side];
      suspects.push({ t: at(length * 0.6), text: `${factionNames[side.faction]}'s ${labels[ty.type] ?? ty.type} (${ty.total}) recorded no shot in ${Math.round(length)} seconds.` });
    }
    // What each side did to the other: to its units (the simulator's count) and to its buildings (their health).
    const builtLost = built0 ? built0.map((b, i) => b.hp - builtNow[i].hp) : [0, 0];
    const standing = (i) => (built0 ? built0[i].alive : 0);
    if (stats.sides.every((s) => s.kills === 0) && (!built0 || built0.every((b, i) => b.alive === builtNow[i].alive))) suspects.push({ t: at(length - 2), text: `Nothing was destroyed in ${Math.round(length)} seconds.` });
    stats.sides.forEach((s, i) => { if (s.damageDealt === 0 && builtLost[1 - i] === 0 && s.total + standing(i) > 0) suspects.push({ t: at(length * 0.5), text: `${factionNames[[clip.a, clip.b][i].faction]} did no damage at all.` }); });
  } else suspects.push({ t: 0, text: "The simulator reported no results for this fight." });
  // A unit ordered to deploy that still stands in an undeployed pose.
  for (const [i, side] of [clip.a, clip.b].entries())
    for (const u of side.units.filter((x) => x.deploy)) {
      const seen = poses?.[i]?.[u.id];
      if (!seen) continue;
      const standing = Object.entries(seen).filter(([q]) => q !== "deployed").reduce((n, [, c]) => n + c, 0);
      if (standing) suspects.push({ t: at(3), text: `${standing} of ${Object.values(seen).reduce((n, c) => n + c, 0)} ${labels[u.id] ?? u.id} ordered to deploy are not deployed (${Object.keys(seen).join(", ")}).` });
    }
  for (const e of [...new Set(errors)].slice(0, 3)) suspects.push({ t: 0, text: `The page reported an error: ${e.slice(0, 160)}` });

  // The poster: the fight at its first kill (or a third of the way in).
  const posterAt = Math.max(1, Math.min(length - 1, (stats?.firstKill ?? length / 3) + runAt + 0.4));
  await new Promise((r) => spawn("ffmpeg", ["-y", "-v", "error", "-ss", posterAt.toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", path.join(out, `${clip.id}.jpg`)], { stdio: "inherit" }).on("close", r));

  const total = frames / FPS;
  const entry = {
    id: clip.id, title: clip.title, why: clip.why, file: `${clip.id}.mp4`, poster: `${clip.id}.jpg`, seconds: +total.toFixed(1), mode: clip.mode, sides,
    chips: [{ label: "Map", value: cfg.map }, { label: "AI", value: cfg.skill }],
    repro: { link: `${play}?mode=sandbox&s=${b64url({ ...cfg, autorun: true })}`, map: cfg.map },
    suspects,
  };
  manifest.clips = [...manifest.clips.filter((c) => c.id !== clip.id), entry];
  // The grid's order is the inbox's order.
  manifest.clips.sort((a, b) => grid.clips.findIndex((c) => c.id === a.id) - grid.clips.findIndex((c) => c.id === b.id));
  report.clips[clip.id] = { classes: clip.classes, mode: clip.mode.id, factions: [clip.a.faction, clip.b.faction], seconds: +total.toFixed(1), runAt: +runAt.toFixed(2), ticksPerSecond: tps, ended, stats, built: built0 && { start: built0, end: builtNow }, poses, pack: packFile ? path.basename(packFile) : undefined, timeline, missing, errors: [...new Set(errors)], suspects };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 1));
  const line = stats ? stats.sides.map((s, i) => `${[clip.a, clip.b][i].faction} ${s.alive}/${s.total} alive, ${s.shots} shots, ${s.kills} kills${built0 && built0[i].alive ? `, buildings ${builtNow[i].alive}/${built0[i].alive}` : ""}`).join(" | ") : "no stats";
  if (tps !== null && tps < 23) log(`  the game ran slow (${tps} ticks a second; 25 is real time): the film is drawn at game time, so it plays at true speed`);
  log(`  ${clock(total)}  ${tps ?? "?"} ticks/s  ${line}${suspects.length ? `\n      suspects: ${suspects.map((s) => s.text).join(" / ")}` : ""}`);
}
await browser.close();
log("done:", manifestFile);
