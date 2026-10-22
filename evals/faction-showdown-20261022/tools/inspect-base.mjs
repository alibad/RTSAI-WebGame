// Watches one side's base in an AI-vs-AI match: every --every game seconds, the camera on that side's construction
// yard, a screenshot, and every actor it owns (type, hp) from a whole-map snapshot.
//   node tools/inspect-base.mjs --a england --b cuba --side england [--until 600] [--every 100] --out shots/england
import fs from "node:fs";
import path from "node:path";
import { chromium } from "file:///C:/Users/Admin/Code/hq/games/RTSAI-WebGame/web/node_modules/playwright-core/index.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const A = opt("a", "england"), B = opt("b", "cuba"), side = opt("side", A);
const map = opt("map", "ra2-tournament-2B");
const until = Number(opt("until", 600)), every = Number(opt("every", 100));
const out = opt("out", `shots/base-${side}`);
const speed = Number(opt("speed", 4));
fs.mkdirSync(out, { recursive: true });
const exe = process.env.LOCALAPPDATA + "/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "--mute-audio"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("http://127.0.0.1:3741/?profile=public&mode=skirmish");
await page.waitForFunction(() => window.store?.getState().phase === "setup", null, { timeout: 300000, polling: 500 });
const options = await page.evaluate(() => Object.fromEntries((window.store.getState().setup.options ?? []).map((o) => [o.id, o.default])));
Object.assign(options, { cheats: "False", "rtsai-cocommander": "False" });
await page.evaluate((s) => window.game.start(JSON.stringify(s)), { map, seed: 7, players: [
  { slot: "Multi0", faction: A, bot: "normal", color: "4F80FF" }, { slot: "Multi1", faction: B, bot: "normal", color: "FF4848" }], options });
await page.waitForFunction(() => window.store.getState().phase === "playing", null, { timeout: 300000, polling: 250 });
await page.evaluate(() => {
  const g = window.game;
  g.sendView = function () { this.client.send({ type: "view", x0: -100000, y0: -100000, x1: 100000, y1: 100000 }); };
  g.sendView(true);
});
await page.evaluate((v) => window.game.client.send({ type: "speed", speed: v }), speed);
let next = 0;
const report = [];
for (;;) {
  await page.waitForTimeout(500);
  const gs = await page.evaluate(() => { const s = window.game.client.cur; return s ? s.header.tick * 0.04 : 0; });
  if (gs < next) continue;
  next += every;
  await page.evaluate(() => window.game.client.send({ type: "pause", paused: true }));
  await page.waitForTimeout(300);
  const own = await page.evaluate((side) => {
    const c = window.game.client, s = c.cur;
    const idx = s.players.findIndex((p) => c.str(p.faction) === side);
    const list = s.actors.filter((a) => a.owner === idx).map((a) => ({ id: a.id, type: c.str(a.type), hp: a.hp, maxHp: a.maxHp, x: Math.round(a.sx), y: Math.round(a.sy) }));
    const yard = list.find((a) => /cnst/.test(a.type)) ?? list[0];
    if (yard) window.game.lookAt(yard.x, yard.y);
    window.game.sendView(true);
    return list;
  }, side);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(out, `t${String(Math.round(gs)).padStart(4, "0")}.png`) });
  const types = {};
  for (const a of own) types[a.type] = (types[a.type] ?? 0) + 1;
  report.push({ game: Math.round(gs), types });
  console.log(Math.round(gs), JSON.stringify(types));
  await page.evaluate(() => window.game.client.send({ type: "pause", paused: false }));
  if (gs >= until) break;
}
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify({ report, errors }, null, 1));
console.log("errors", errors);
await browser.close();
