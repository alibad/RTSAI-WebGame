// What a player actually sees of deaths and impacts in a real AI game on the live page twin:
//   node dev/effects-probe.mjs --a america --b russia [--units heavy] [--speed 1] [--minutes 5] [--bundle dev/live-bundle-b1ab.pack]
// Every snapshot: effect draws (explosions, death animations, projectiles) and how many the renderer had to skip because
// their sheet was not loaded yet; every unit that leaves the world: was anything drawn where it died?
import fs from "node:fs";
import path from "node:path";
import { chromium } from "file:///C:/Users/Admin/Code/hq/games/RTSAI-WebGame/web/node_modules/playwright-core/index.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const A = opt("a", "america"), B = opt("b", "russia"), units = opt("units", "heavy"), speed = Number(opt("speed", 1));
const minutes = Number(opt("minutes", 5)), url = opt("url", "http://127.0.0.1:3743/"), bundle = opt("bundle", "dev/live-bundle-b1ab.pack");
const out = opt("out", `dev/effects-probe-${A}-${B}.json`);
const rosters = JSON.parse(fs.readFileSync("dev/rosters.json", "utf8"));
const kind = Object.fromEntries(rosters.units.map((u) => [u.name, u.kind]));

const exe = process.env.LOCALAPPDATA + "/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "--mute-audio"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 400)));
if (bundle) await page.route(/\/public\/web-bundle\.pack$/, (r) => r.fulfill({ status: 200, contentType: "application/octet-stream", body: fs.readFileSync(bundle) }));
const t0 = Date.now();
await page.goto(`${url}?profile=public&mode=skirmish`);
await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 300000, polling: 500 });
const setup = await page.evaluate(() => window.store.getState().setup);
const options = Object.fromEntries((setup.options ?? []).map((o) => [o.id, o.default]));
Object.assign(options, { cheats: "False", "rtsai-cocommander": "False", startingunits: units, startingcash: "10000" });
await page.evaluate((s) => window.game.start(JSON.stringify(s)), { map: "ra2-tournament-2B", players: [
  { slot: "Multi0", faction: A, bot: "normal", color: "4F80FF" }, { slot: "Multi1", faction: B, bot: "normal", color: "FF4848" }], options });
await page.waitForFunction(() => ["playing", "error"].includes(window.store.getState().phase), null, { timeout: 300000, polling: 250 });
const startedAt = (Date.now() - t0) / 1000;
await page.evaluate(({ kind }) => {
  const g = window.game, c = g.client, r = g.renderer;
  g.sendView = function () { this.client.send({ type: "view", x0: -100000, y0: -100000, x1: 100000, y1: 100000 }); };
  g.sendView(true);
  const P = (window.probe = { snaps: 0, eff: 0, effSkipped: 0, actorSkipped: 0, deaths: [], pending: [], prev: new Map(), fxTimeline: [] });
  const old = c.onSnapshot;
  c.onSnapshot = (s) => {
    old?.(s);
    P.snaps++;
    const sprites = r.sprites, has = (id) => r.textures.has(id);
    const effNear = [];
    for (let i = 0; i < s.header.drawCount; i++) {
      const o = i * 48, key = s.draws.getUint32(o, true), sp = sprites[s.draws.getInt32(o + 4, true)];
      const missing = !sp || !has(sp.tex) || (sp.tex2 >= 0 && !has(sp.tex2));
      if (key >= 0x80000000) { P.eff++; if (missing) P.effSkipped++; else effNear.push([s.draws.getFloat32(o + 8, true), s.draws.getFloat32(o + 12, true)]); }
      else if (key !== 0 && missing) P.actorSkipped++;
    }
    const now = new Map();
    for (const a of s.actors) now.set(a.id, a);
    for (const [id, a] of P.prev) {
      if (now.has(id)) continue;
      const t = c.str(a.type), k = kind[t];
      if (!k || k === "building") continue;
      P.pending.push({ type: t, kind: k, x: a.sx, y: a.sy, tick: s.header.tick, left: 25, seen: false, husk: false });
    }
    for (const d of P.pending) {
      if (!d.seen && effNear.some(([x, y]) => Math.hypot(x - d.x, y - d.y) < 120)) d.seen = true;
      if (!d.husk) for (const a of s.actors) if (!P.prev.has(a.id) && /husk|wreck|dead/i.test(c.str(a.type)) && Math.hypot(a.sx - d.x, a.sy - d.y) < 120) d.husk = true;
      d.left--;
    }
    for (const d of P.pending.filter((d) => d.left <= 0)) P.deaths.push({ type: d.type, kind: d.kind, tick: d.tick, visible: d.seen || d.husk, husk: d.husk });
    P.pending = P.pending.filter((d) => d.left > 0);
    P.prev = now;
  };
  window.fxState = () => { const fx = c.sheetList.filter((s) => s.group === "fx"); return [fx.filter((s) => has2(s.id)).length, fx.length]; };
  const has2 = (id) => r.textures.has(id);
}, { kind });
await page.evaluate((v) => window.game.client.send({ type: "speed", speed: v }), speed);
const samples = [];
const end = Date.now() + minutes * 60000;
while (Date.now() < end) {
  await new Promise((res) => setTimeout(res, 5000));
  const s = await page.evaluate(() => { const p = window.probe; return { snaps: p.snaps, eff: p.eff, effSkipped: p.effSkipped, actorSkipped: p.actorSkipped, deaths: p.deaths.length, vanished: p.deaths.filter((d) => !d.visible).length, fx: window.fxState(), tick: window.game.client.cur?.header.tick ?? -1, phase: window.store.getState().phase, sheets: window.game.client.sheetList?.length ?? -1, err: window.store.getState().error ?? null }; });
  samples.push({ wall: Math.round((Date.now() - t0) / 1000), ...s });
  console.log(JSON.stringify(samples.at(-1)));
}
const deaths = await page.evaluate(() => window.probe.deaths);
const byType = {};
for (const d of deaths) { const b = (byType[d.type] ??= { kind: d.kind, n: 0, vanished: 0, husk: 0 }); b.n++; if (!d.visible) b.vanished++; if (d.husk) b.husk++; }
fs.writeFileSync(out, JSON.stringify({ A, B, units, speed, startedAt, samples, byType, errors }, null, 1));
console.log("byType", JSON.stringify(byType));
console.log("errors", errors.length);
await browser.close();
