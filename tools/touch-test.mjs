// Touch controls on a phone-sized screen (Pixel 7 landscape emulation, real touch events through CDP): tap to
// select, tap to order, long-press to deploy, one-finger box, two-finger pinch zoom and two-finger tap to clear,
// tap and long-press on a sidebar cameo. Writes screenshots of the compact layout.
//   node tools/touch-test.mjs [--runtime aot] [--url http://127.0.0.1:3490/?profile=public] [--out dir]
import fs from "node:fs";
import path from "node:path";
import { chromium, devices } from "../web/node_modules/playwright-core/index.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const runtime = opt("runtime", "aot");
const url = opt("url", `http://127.0.0.1:3490/?profile=public&runtime=${runtime}`);
const out = opt("out", "shots-touch");
fs.mkdirSync(out, { recursive: true });
const exe = path.join(process.env.LOCALAPPDATA, "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe");
const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined, headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const context = await browser.newContext({ ...devices["Pixel 7 landscape"] });
const page = await context.newPage();
page.on("pageerror", (e) => console.log("pageerror", String(e)));
const cdp = await context.newCDPSession(page);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const results = {};
const check = (name, ok, detail = "") => { results[name] = ok; log(ok ? "PASS" : "FAIL", name, detail); };

const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 4, radiusY: 4, force: 1 })) });
const tap = async (x, y) => { await touch("touchStart", [[x, y]]); await page.waitForTimeout(60); await touch("touchEnd", []); await page.waitForTimeout(250); };
const longPress = async (x, y) => { await touch("touchStart", [[x, y]]); await page.waitForTimeout(700); await touch("touchEnd", []); await page.waitForTimeout(250); };
const drag = async (x0, y0, x1, y1) => {
  await touch("touchStart", [[x0, y0]]);
  for (let i = 1; i <= 8; i++) { await touch("touchMove", [[x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8]]); await page.waitForTimeout(30); }
  await touch("touchEnd", []);
  await page.waitForTimeout(300);
};
const pinch = async (cx, cy, d0, d1) => {
  await touch("touchStart", [[cx - d0, cy], [cx + d0, cy]]);
  for (let i = 1; i <= 8; i++) { const d = d0 + ((d1 - d0) * i) / 8; await touch("touchMove", [[cx - d, cy], [cx + d, cy]]); await page.waitForTimeout(30); }
  await touch("touchEnd", []);
  await page.waitForTimeout(300);
};
const state = () => page.evaluate(() => {
  const g = window.game, s = g.client.cur, st = window.store.getState();
  const own = s.actors.filter((a) => a.owner === s.header.localPlayer);
  return { selected: [...g.overlay.selected], zoom: g.cam.zoom, mode: st.ui?.mode ?? "", queues: st.ui?.queues?.map((q) => [q.type, q.items.map((i) => `${i.name}${i.paused ? "(held)" : ""}`)]) ?? [],
    own: own.map((a) => ({ id: a.id, type: g.client.str(a.type), sx: a.sx, sy: a.sy })) };
});
/** World -> CSS pixel position of an actor on screen. */
const screenOf = (a) => page.evaluate(([sx, sy]) => {
  const g = window.game, r = g.canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  return [r.left + ((sx - g.cam.x) * g.cam.zoom + g.canvas.width / 2) / dpr, r.top + ((sy - g.cam.y) * g.cam.zoom + g.canvas.height / 2) / dpr];
}, [a.sx, a.sy]);

await page.goto(url);
await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 600000 });
await page.screenshot({ path: path.join(out, "t0-setup.png") });
const scenario = fs.readFileSync(path.join("scenarios", "skirmish-public.json"), "utf8");
await page.evaluate((s) => window.game.start(s), scenario);
await page.waitForFunction(() => window.store.getState().phase === "playing" && !!window.game.client.cur && !!window.store.getState().ui, null, { timeout: 600000 });
await page.waitForTimeout(2000);
await page.screenshot({ path: path.join(out, "t1-game.png") });

let s = await state();
let mcv = s.own.find((a) => a.type.includes("mcv"));
// Centre the camera on the MCV so the test stays on screen.
await page.evaluate(([x, y]) => { window.game.lookAt(x, y); }, [mcv.sx, mcv.sy]);
await page.waitForTimeout(800);
s = await state();
mcv = s.own.find((a) => a.id === mcv.id);
const [mx, my] = await screenOf(mcv);
await tap(mx, my);
s = await state();
check("tap selects own unit", s.selected.length === 1 && s.selected[0] === mcv.id, JSON.stringify(s.selected));

// Tap the ground: the selected MCV is ordered there (it moves).
await tap(mx + 70, my + 30);
await page.waitForTimeout(2500);
s = await state();
const moved = s.own.find((a) => a.id === mcv.id);
check("tap orders the selection", moved && Math.hypot(moved.sx - mcv.sx, moved.sy - mcv.sy) > 20, `moved ${moved ? Math.round(Math.hypot(moved.sx - mcv.sx, moved.sy - mcv.sy)) : "?"}`);

// Long-press on the (selected) MCV itself: deploy, as a right-click on it would.
await page.waitForTimeout(3000);
s = await state();
const mcv2 = s.own.find((a) => a.id === mcv.id) ?? moved ?? mcv;
const [m2x, m2y] = await screenOf(mcv2);
await longPress(m2x, m2y);
const yard = await page.waitForFunction(() => {
  const g = window.game, s = g.client.cur;
  return s.actors.some((a) => a.owner === s.header.localPlayer && g.client.str(a.type).includes("cnst") || g.client.str(a.type).endsWith("yard"));
}, null, { timeout: 15000 }).then(() => true).catch(() => false);
check("long-press deploys (right-click order)", yard);

// One-finger drag: box-select the infantry.
s = await state();
const inf = s.own.filter((a) => !a.type.includes("cnst") && !a.type.includes("mcv") && !a.type.includes("yard"));
const pts = await Promise.all(inf.map(screenOf));
const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
await drag(Math.min(...xs) - 30, Math.min(...ys) - 30, Math.max(...xs) + 30, Math.max(...ys) + 30);
s = await state();
check("one-finger drag box-selects", s.selected.length >= 2, `${s.selected.length} selected of ${inf.length}`);

// Two fingers: pinch zoom, then a quick two-finger tap clears the selection.
const z0 = s.zoom;
await pinch(400, 200, 60, 140);
s = await state();
check("pinch zooms in", s.zoom > z0 * 1.3, `${z0.toFixed(2)} -> ${s.zoom.toFixed(2)}`);
await touch("touchStart", [[380, 200], [460, 200]]);
await page.waitForTimeout(80);
await touch("touchEnd", []);
await page.waitForTimeout(300);
s = await state();
check("two-finger tap clears the selection", s.selected.length === 0, JSON.stringify(s.selected));
await page.screenshot({ path: path.join(out, "t2-after-gestures.png") });

// Sidebar cameo: tap builds, long-press holds.
const cameo = await page.evaluate(() => {
  const b = document.querySelector("button.cameo[data-queue='Building']:not([data-disabled='true'])")?.getBoundingClientRect();
  const name = document.querySelector("button.cameo[data-queue='Building']:not([data-disabled='true'])")?.getAttribute("data-item");
  return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2, name } : null;
});
if (cameo) {
  await tap(cameo.x, cameo.y);
  await page.waitForTimeout(500);
  s = await state();
  const q = s.queues.find(([t]) => t === "Building")?.[1] ?? [];
  check("cameo tap starts production", q.some((n) => n.startsWith(cameo.name)), JSON.stringify(q));
  await longPress(cameo.x, cameo.y);
  await page.waitForTimeout(400);
  s = await state();
  const q2 = s.queues.find(([t]) => t === "Building")?.[1] ?? [];
  check("cameo long-press holds", q2.some((n) => n.includes("(held)")), JSON.stringify(q2));
} else check("cameo tap starts production", false, "no buildable cameo");
await page.screenshot({ path: path.join(out, "t3-production.png") });

// Portrait: the rotate hint.
await page.setViewportSize({ width: 412, height: 839 });
await page.waitForTimeout(500);
const hint = await page.getByLabel("Turn your device sideways").count();
check("portrait shows the rotate hint", hint > 0);
await page.screenshot({ path: path.join(out, "t4-portrait.png") });
await browser.close();
const failed = Object.entries(results).filter(([, ok]) => !ok).map(([k]) => k);
console.log(failed.length ? `FAILED: ${failed.join(", ")}` : "all touch checks passed");
process.exit(failed.length ? 1 : 0);
