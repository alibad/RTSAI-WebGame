// Review screenshots with project art only (?shot=1: no terrain, map previews or EA cameos), safe to share:
// setup screen, skirmish HUD with production running, sandbox setup, sandbox fight with results.
//   node tools/shots.mjs [--runtime aot] --out <dir>
import fs from "node:fs";
import path from "node:path";
import { chromium } from "../web/node_modules/playwright-core/index.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const runtime = opt("runtime", "aot");
const out = opt("out", "shots");
fs.mkdirSync(out, { recursive: true });
const exe = path.join(process.env.LOCALAPPDATA, "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe");
const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined, headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const base = `http://127.0.0.1:3490/?runtime=${runtime}&shot=1`;
const W = 1600, H = 900;

async function page(url) {
  const p = await browser.newPage({ viewport: { width: W, height: H } });
  p.on("pageerror", (e) => console.log("pageerror", String(e)));
  await p.goto(url);
  return p;
}
const phase = (p, w) => p.waitForFunction((x) => [x, "error"].includes(window.store?.getState().phase), w, { timeout: 600000, polling: 200 });
const until = async (p, f, arg, ms = 120000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await p.evaluate(f, arg); if (v) return v; await p.waitForTimeout(300); }
  return null;
};
const shot = async (p, name) => { const f = path.join(out, name); await p.screenshot({ path: f }); console.log("wrote", f); };

// 1. Setup screen.
{
  const p = await page(base);
  await phase(p, "setup");
  await p.waitForTimeout(1500);
  await shot(p, "1-setup.png");
  await p.close();
}

// 2. Skirmish: deploy, power plant, barracks, infantry in production, a modern squad selected.
{
  const p = await page(`${base}&scenario=skirmish`);
  await phase(p, "playing");
  await until(p, () => !!window.game.client.cur && !!window.store.getState().ui);
  const g = "window.game";
  await p.evaluate(async () => {
    const game = window.game, s = game.client.cur;
    const mcv = s.actors.find((a) => game.client.str(a.type).includes("mcv"));
    await game.select([mcv.id]);
    await game.command({ cmd: "deploy" });
  });
  await until(p, () => window.store.getState().catalog.find((c) => c.type === "Building")?.items.some((i) => i.buildable));
  const build = async (item) => {
    await p.evaluate((i) => window.game.command({ cmd: "produce", queue: "Building", item: i }), item);
    await until(p, (i) => window.store.getState().ui.queues.find((q) => q.type === "Building")?.items.find((x) => x.name === i && x.done), item, 150000);
    await p.evaluate((i) => window.game.command({ cmd: "produce", queue: "Building", item: i }), item);
    const yard = await until(p, () => { const s = window.game.client.cur; const a = s.actors.find((x) => x.owner === s.header.localPlayer && (x.flags & 8)); return a ? [a.sx, a.sy] : null; });
    for (const [dx, dy] of [[150, 60], [-150, 60], [150, -60], [0, 150], [-220, 0], [220, 0], [0, -150], [300, 90]]) {
      await p.evaluate(([x, y]) => window.game["click"](x, y, 1, 0), [yard[0] + dx, yard[1] + dy]);
      await p.waitForTimeout(400);
      if (await p.evaluate((i) => window.game.client.cur.actors.some((a) => window.game.client.str(a.type) === i), item)) return true;
      if (!(await p.evaluate(() => window.store.getState().ui.mode))) await p.evaluate((i) => window.game.command({ cmd: "produce", queue: "Building", item: i }), item);
    }
    return false;
  };
  await build("gapowr");
  await build("gapile");
  const inf = await until(p, () => window.store.getState().catalog.find((c) => c.type === "Infantry")?.items.filter((i) => i.buildable && i.name.startsWith("r2")).map((i) => i.name), null, 20000);
  if (inf?.length) {
    await p.evaluate((i) => window.game.command({ cmd: "produce", queue: "Infantry", item: i, count: 5 }), inf[0]);
    if (inf[1]) await p.evaluate((i) => window.game.command({ cmd: "produce", queue: "Infantry", item: i, count: 2 }), inf[1]);
    await p.evaluate(() => window.store.getState().set({ tab: "Infantry" }));
  }
  await p.waitForTimeout(6000);
  await p.evaluate(async () => {
    const game = window.game, s = game.client.cur;
    const squad = s.actors.filter((a) => a.owner === s.header.localPlayer && game.client.str(a.type).startsWith("r2") && !(a.flags & 8));
    await game.select(squad.map((a) => a.id));
    await game.group(0, "create");
    const c = squad.reduce((acc, a) => [acc[0] + a.sx / squad.length, acc[1] + a.sy / squad.length], [0, 0]);
    game.lookAt(c[0] + 150, c[1]);
    game.cam.zoom = 1.6;
  });
  await p.waitForTimeout(1200);
  await shot(p, "2-skirmish-hud.png");
  await p.close();
}

// 3 and 4. Sandbox setup, then the fight with results.
{
  const p = await page(`${base}&mode=sandbox&a=r2m1a2s:6,r2sang:4&b=r2karrar:6,r2basij:4&fa=saudi&fb=iran&level=1`);
  await phase(p, "playing");
  await until(p, () => window.store.getState().sandbox?.units.length > 0 && Object.keys(window.store.getState().icons).length > 20);
  await p.waitForTimeout(1500); // the sandbox frames its placements itself
  await shot(p, "3-sandbox-setup.png");
  await p.evaluate(() => window.game.sandbox.run());
  await until(p, () => window.store.getState().sandbox.mode === "run" && window.game.sandbox.recording.length > 400, null, 120000);
  await p.evaluate(() => {
    const g = window.game, s = g.client.cur;
    const units = s.actors.filter((a) => s.players[a.owner]?.flags & 4 && a.maxHp > 0);
    if (units.length) {
      const c = units.reduce((acc, a) => [acc[0] + a.sx / units.length, acc[1] + a.sy / units.length], [0, 0]);
      g.cam.zoom = 0.9;
      g.lookAt(c[0], c[1]);
    }
  });
  await p.waitForTimeout(1200);
  await shot(p, "4-sandbox-fight.png");
  await p.close();
}
await browser.close();
