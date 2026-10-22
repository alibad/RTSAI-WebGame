// Focused probe: does Yuri's mind control take an enemy unit? Yuri is placed beside an enemy tank and a soldier,
// ordered onto the tank; screenshots and every actor's owner are recorded for 40 game seconds.
//   node tools/yuri-probe.mjs [--faction russia] [--url http://127.0.0.1:3742/]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "file:///C:/Users/Admin/Code/hq/games/RTSAI-WebGame/web/node_modules/playwright-core/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const faction = opt("faction", "russia"), url = opt("url", "http://127.0.0.1:3742/");
const out = path.join(root, "dev", "yuri-probe");
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = process.env.LOCALAPPDATA + "/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "--mute-audio"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const ev = (f, a) => page.evaluate(f, a);
const cmd = (c) => ev((c) => window.game.command(c), c);
const actors = () => ev(() => { const c = window.game.client, s = c.cur; return s.actors.map((a) => ({ id: a.id, type: c.str(a.type), owner: a.owner, hp: a.hp, x: a.sx, y: a.sy, cx: a.sx + a.bx + a.bw / 2, cy: a.sy + a.by + a.bh / 2 })); });
await page.goto(`${url}?profile=public&mode=skirmish`);
await page.waitForFunction(() => window.store?.getState().phase === "setup", null, { timeout: 300000, polling: 500 });
const options = await ev(() => Object.fromEntries((window.store.getState().setup.options ?? []).map((o) => [o.id, o.default])));
Object.assign(options, { cheats: "False", "rtsai-cocommander": "False", startingunits: "none", fog: "False", explored: "True", crates: "False", shortgame: "False" });
await ev((s) => window.game.start(JSON.stringify(s)), { map: "ra2-tournament-2B", seed: 5, players: [
  { slot: "Multi0", faction, color: "4F80FF" }, { slot: "Multi1", faction: "america", bot: "webidle", color: "FF4848" }], options });
await page.waitForFunction(() => window.store.getState().phase === "playing", null, { timeout: 300000, polling: 250 });
await ev(() => { const g = window.game; g.sendView = function () { this.client.send({ type: "view", x0: -100000, y0: -100000, x1: 100000, y1: 100000 }); }; g.sendView(true); });
const spawns = (await cmd({ cmd: "spawnpoints" })).points;
const local = await ev(() => window.game.client.cur.header.localPlayer);
const mid = { u: Math.round(spawns[0].u + (spawns[1].u - spawns[0].u) * 0.75), v: Math.round(spawns[0].v + (spawns[1].v - spawns[0].v) * 0.75) };
await cmd({ cmd: "spawn", type: "mtnk", player: 1, u: mid.u, v: mid.v });
await cmd({ cmd: "spawn", type: "e1", player: 1, u: mid.u - 2, v: mid.v + 2 });
await cmd({ cmd: "spawn", type: "yuri", player: 0, u: mid.u - 2, v: mid.v + 1 });
await sleep(800);
let all = await actors();
const tank = all.find((a) => a.type === "mtnk"), yuri = all.find((a) => a.type === "yuri" && a.owner === local);
await ev(([x, y]) => window.game.lookAt(x, y), [tank.x, tank.y]);
await ev((ids) => window.game.select(ids), [yuri.id]);
const sel = await ev(() => window.store.getState().ui?.selection?.map((s) => s.type));
await ev(([x, y]) => window.game.orderAt(x, y), [tank.cx, tank.cy]);
const trace = [];
for (let k = 0; k < 20; k++) {
  await sleep(1000);
  all = await actors();
  const t = all.find((a) => a.id === tank.id), y = all.find((a) => a.id === yuri.id), s = all.find((a) => a.type === "e1");
  trace.push({ k, tankOwner: t?.owner, tankHp: t?.hp, yuri: y ? { x: Math.round(y.x), y: Math.round(y.y), owner: y.owner } : null, soldierOwner: s?.owner });
  if (k % 5 === 0) await page.screenshot({ path: path.join(out, `t${k}.png`) });
}
console.log(JSON.stringify({ local, selection: sel, tank: tank.id, trace, errors }, null, 0));
await browser.close();
