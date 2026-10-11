import {browserExecutable, browserArgs} from './browser-launch.mjs';
// Scripted playtest in headless Chromium through the same page API the HUD uses: deploy the MCV, build and place
// a power plant and a barracks, train infantry, use a control group, sell/repair modes, and report what the engine
// says after each step. No screenshots (the scene contains the player's own RA2 files).
//   node tools/playtest.mjs [--runtime aot] [--shots <dir>]   (shots: project-art-only views)
import fs from "node:fs";
import path from "node:path";
import { chromium } from "../web/node_modules/playwright-core/index.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const runtime = opt("runtime", "aot");
const exe = browserExecutable();
const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined, headless: true,
  args: browserArgs() });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
const t0 = Date.now();
await page.goto(`${process.env.RTSAI_TEST_URL || "http://127.0.0.1:3490/"}?runtime=${runtime}&profile=public&scenario=skirmish`);
await page.waitForFunction(() => ["playing", "error"].includes(window.store?.getState().phase), null, { timeout: 600000, polling: 250 });
const log = (step, v) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${step}:`, typeof v === "string" ? v : JSON.stringify(v));
log("phase", await page.evaluate(() => window.store.getState().phase + " " + window.store.getState().error.slice(0, 400)));

const ev = (f, arg) => page.evaluate(f, arg);
const until = async (f, arg, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await ev(f, arg); if (v) return v; await page.waitForTimeout(250); }
  return null;
};

// Helpers in the page.
await ev(() => {
  const g = window.game;
  window.t = {
    own: (type) => { const s = g.client.cur; return s.actors.filter((a) => a.owner === s.header.localPlayer && (!type || g.client.str(a.type) === type)); },
    types: () => { const s = g.client.cur; return [...new Set(s.actors.filter((a) => a.owner === s.header.localPlayer).map((a) => g.client.str(a.type)))]; },
    ui: () => window.store.getState().ui,
    catalog: (q) => window.store.getState().catalog.find((c) => c.type === q),
    queued: (q) => window.store.getState().ui.queues.find((c) => c.type === q),
  };
});

await until(() => !!window.game.client.cur && !!window.store.getState().ui);
log("own types", await ev(() => window.t.types()));
const mcv = await ev(() => { const a = window.t.own().find((x) => window.game.client.str(x.type).includes("mcv")); return a && { id: a.id, x: a.sx, y: a.sy }; });
log("mcv", mcv);
await ev((id) => window.game.select([id]), mcv.id);
await page.waitForTimeout(200);
log("selection", await ev(() => window.t.ui().selection.map((a) => a.type)));
await ev(() => window.game.command({ cmd: "deploy" }));
const yard = await until(() => window.store.getState().catalog.find((c) => c.type === "Building")?.items.some((i) => i.buildable), null, 30000);
log("deployed; building catalog", await ev(() => window.t.catalog("Building").items.map((i) => `${i.name}${i.buildable ? "" : "(x)"}:$${i.cost}`)));
log("icons", await ev(() => { const i = window.store.getState().icons; return { total: Object.keys(i).length, withArt: Object.values(i).filter(Boolean).length }; }));

// Build a power plant (first buildable building whose name suggests power), place it next to the yard.
const power = await ev(() => window.t.catalog("Building").items.find((i) => i.buildable && /pow|plnt|power|pp/i.test(i.name))?.name ?? window.t.catalog("Building").items.find((i) => i.buildable).name);
log("producing", power);
await ev((item) => window.game.command({ cmd: "produce", queue: "Building", item }), power);
const done = await until((item) => window.t.queued("Building")?.items.find((i) => i.name === item && i.done), power, 120000);
log("ready", done ? "yes" : "no");
await ev((item) => window.game.command({ cmd: "produce", queue: "Building", item }), power);
await page.waitForTimeout(150);
log("mode", await ev(() => window.t.ui().mode));
const yardActor = await ev(() => { const a = window.t.own().find((x) => x.flags & 8); return a && { x: a.sx, y: a.sy, type: window.game.client.str(a.type) }; });
log("yard", yardActor);
let placed = false;
for (const [dx, dy] of [[150, 60], [-150, 60], [150, -60], [-150, -60], [0, 140], [0, -140], [220, 0], [-220, 0]]) {
  await ev(([x, y]) => window.game["click"](x, y, 1, 0), [yardActor.x + dx, yardActor.y + dy]);
  await page.waitForTimeout(400);
  const types = await ev(() => window.t.types());
  if (types.includes(power)) { placed = true; log("placed at offset", [dx, dy]); break; }
  if (!(await ev(() => window.t.ui().mode))) await ev((item) => window.game.command({ cmd: "produce", queue: "Building", item }), power);
}
log("placed", placed);
await page.waitForTimeout(1500);
log("power", await ev(() => window.t.ui().power));
log("cash", await ev(() => window.t.ui().cash));

// Barracks, then infantry.
const barracks = await ev(() => window.t.catalog("Building").items.find((i) => i.buildable && /pile|barr|tent|brk|hand/i.test(i.name))?.name);
log("barracks item", barracks);
if (barracks) {
  await ev((item) => window.game.command({ cmd: "produce", queue: "Building", item }), barracks);
  await until((item) => window.t.queued("Building")?.items.find((i) => i.name === item && i.done), barracks, 120000);
  await ev((item) => window.game.command({ cmd: "produce", queue: "Building", item }), barracks);
  for (const [dx, dy] of [[-150, 60], [150, 120], [-220, 0], [0, 200], [300, 0], [-300, 60], [0, -200]]) {
    await ev(([x, y]) => window.game["click"](x, y, 1, 0), [yardActor.x + dx, yardActor.y + dy]);
    await page.waitForTimeout(400);
    if ((await ev(() => window.t.types())).includes(barracks)) { log("barracks placed", [dx, dy]); break; }
    if (!(await ev(() => window.t.ui().mode))) await ev((item) => window.game.command({ cmd: "produce", queue: "Building", item }), barracks);
  }
  const inf = await until(() => window.t.catalog("Infantry")?.items.find((i) => i.buildable)?.name, null, 10000);
  log("infantry item", inf);
  if (inf) {
    await ev((item) => window.game.command({ cmd: "produce", queue: "Infantry", item, count: 5 }), inf);
    await page.waitForTimeout(1500);
    log("infantry queue", await ev(() => window.t.queued("Infantry")?.items.map((i) => `${i.name} ${(i.progress * 100).toFixed(0)}%${i.paused ? " held" : ""}`)));
    await ev((item) => window.game.command({ cmd: "hold", queue: "Infantry", item }), inf);
    await page.waitForTimeout(300);
    log("after hold", await ev(() => window.t.queued("Infantry")?.items.map((i) => `${i.name}${i.paused ? " held" : ""}`)));
    await ev((item) => window.game.command({ cmd: "produce", queue: "Infantry", item }), inf);
    const trained = await until((item) => window.t.own(item).length >= 2, inf, 120000);
    log("trained", await ev((item) => window.t.own(item).length, inf));
    // Control group 1 with the infantry; select something else, then recall the group.
    await ev((item) => window.game.select(window.t.own(item).map((a) => a.id)), inf);
    await page.waitForTimeout(200);
    await ev(() => window.game.group(0, "create"));
    await ev(() => window.game.select([]));
    await page.waitForTimeout(200);
    await ev(() => window.game.group(0, "select"));
    await page.waitForTimeout(300);
    log("group 1", await ev(() => ({ groups: window.t.ui().groups, selected: window.t.ui().selection.length })));
    if (trained) log("veterancy fields", await ev(() => window.t.ui().selection.slice(0, 2)));
  }
}

// Modes
for (const mode of ["sell", "repair", "attackmove", "guard"]) {
  await ev((m) => window.game.setMode(m), mode);
  await page.waitForTimeout(200);
  log(`mode ${mode}`, await ev(() => window.t.ui().mode));
  await ev(() => window.game.command({ cmd: "mode", mode: "none" }));
  await page.waitForTimeout(150);
}
log("cursor sample", await ev(() => window.store.getState().cursor));
log("radar", await ev(() => window.t.ui().radar));
log("perf", await ev(() => { const p = window.store.getState().perf; return { fps: p.fps.toFixed(0), tps: p.tps.toFixed(1), tickMs: p.simTickMs.toFixed(2), heapMB: p.heapMB.toFixed(0), missed: p.missed }; }));
log("errors", errors);

const shots = opt("shots", "");
if (shots) {
  fs.mkdirSync(shots, { recursive: true });
  // HUD only, battlefield hidden: the sidebar shows engine cameos (project art for modern factions).
  await ev(() => { window.game.renderer.actorFilter = (t) => window.game.client.str(t).startsWith("r2"); });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, "hud.png") });
  log("shot", path.join(shots, "hud.png"));
}
await browser.close();
