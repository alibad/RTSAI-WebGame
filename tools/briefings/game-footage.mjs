// Real in-engine footage of a campaign mission for its briefing film: the actual map, units, objectives and fighting,
// recorded HUD-free (a "clean plate": only the game canvas) at 1920x1080, constant 30 fps, H.264 CRF 16.
//
//   node tools/briefings/game-footage.mjs <mission> [--out D:/rtsai-campaign/footage-out] [--url http://127.0.0.1:3977/]
//        [--map-yaml content/maps/<mission>/map.yaml] [--difficulty hard] [--speed 4] [--cuts 3] [--cut-seconds 13]
//        [--only establishing,objectives,battle] [--keep-frames]
//
// The page is any build of the web game whose data contains the mission (a static build served by
// tools/static-serve.mjs, or the live site). Per mission, into <out>/<mission>/:
//   establishing.mp4   ~8 s: an eased camera glide from the battlefield (toward the farthest primary objective) to the
//                      player's base.
//   objective-<n>.mp4  ~5 s each: the camera on objective n's target(s) with a slow drift and push-in; targets spread
//                      over the map get one shot per group (objective-<n>-2.mp4, ...).
//   battle.mp4         the battle cuts joined (battle-1.mp4, battle-2.mp4, ... kept too): real play, the camera
//                      following the fighting.
//   frames/<segment>.png  the most detailed frame of each segment at full capture resolution.
//   footage.json       every file, its seconds, what it shows (objective index and text, actor names, map cells), how
//                      it was made, ffprobe checks.
//
// How: headless Chromium with GPU flags at a true 2x device scale (CSS viewport 960x540 -> 1920x1080 device pixels),
// CDP screencast JPEG frames (q95) resampled by their timestamps to constant 30 fps (tools/film-takes.mjs). The mission
// is launched through the page's own API (game.start with the mission's slot and faction, as the campaign screen does)
// with the lobby options fog off and map explored, so every objective is visible (the campaign screen plays with fog
// on). The HUD is hidden by a stylesheet the tool injects (every element but the game canvas hidden, the sidebar width
// set to 0 so the canvas fills the window): nothing in the page is changed. The camera is driven through game.lookAt
// and game.cam.zoom from a requestAnimationFrame loop in the page (eased glides, a damped follow). The player's side is
// played by the page's co-commander in Auto (the browser strategy adviser applying its own recommendations: build,
// train, defend, attack); the enemy is the mission's own scripted forces and waves. The warm-up runs at a raised game
// speed until the two sides meet (actors losing health, or own and enemy within ~10 cells, from the co-commander's
// observation), then the battle is recorded at normal speed. When nothing has met after 15 s of warm-up (at once on a
// map whose mission sends no waves), the player's combat units are sent (attack-move, one validated order per unit,
// through the same engine channel the co-commander's Attack uses) at the nearest enemy objective target or enemy, again
// every 25 s while nothing fights; footage.json lists every push. A take whose screencast stalled (under 45 fps or a gap
// over 150 ms) is recorded again. Objectives whose target is not on the map yet get a stand-in subject: escorts the
// route's entry drifting along the route, shipping lanes the strait seen from the coast by the base, survive the wave
// entry's approach to the base, build the base.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "../../web/node_modules/playwright-core/index.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);
const mission = argv.find((a, i) => !a.startsWith("--") && (i === 0 || !argv[i - 1].startsWith("--")));
if (!mission) { console.error("usage: node tools/briefings/game-footage.mjs <mission> [--out dir] [--url page]"); process.exit(2); }
const outRoot = path.resolve(opt("out", "D:/rtsai-campaign/footage-out"));
const url = opt("url", "http://127.0.0.1:3977/");
const mapYaml = opt("map-yaml", path.join(repo, "content", "maps", mission, "map.yaml"));
const difficulty = opt("difficulty", "hard");
const warmSpeed = Number(opt("speed", 4));
const cuts = Number(opt("cuts", 3));
const cutSeconds = Number(opt("cut-seconds", 13));
const only = new Set(opt("only", "establishing,objectives,battle").split(","));
const keepFrames = flag("keep-frames");
const CSS_W = 960, CSS_H = 540, DPR = 2, FPS = 30, CRF = 16;
const out = path.join(outRoot, mission);
const framesDir = path.join(out, "frames");
const tmpRoot = path.join(out, "_capture");
fs.mkdirSync(framesDir, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${mission} ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------- the map's named actors
/** Named actors of map.yaml (name -> {type, cell [x, y]}): waypoints of convoy routes and shipping lanes are not in the
 * page's objective markers, so their cells come from the map. */
function readNamedActors(file) {
  const named = {};
  if (!fs.existsSync(file)) return named;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  let inActors = false, cur = null;
  for (const line of lines) {
    if (/^\S/.test(line)) { inActors = line.startsWith("Actors:"); cur = null; continue; }
    if (!inActors) continue;
    const head = /^\t([^\t:]+):\s*(\S+)\s*$/.exec(line);
    if (head) { cur = named[head[1]] = { type: head[2], cell: null }; continue; }
    const loc = /^\t\tLocation:\s*(-?\d+)\s*,\s*(-?\d+)/.exec(line);
    if (loc && cur) cur.cell = [Number(loc[1]), Number(loc[2])];
  }
  return named;
}
const named = readNamedActors(mapYaml);

// ------------------------------------------------------------------------------------------------- the browser
const exe = path.join(process.env.LOCALAPPDATA, "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe");
const browser = await chromium.launch({ executablePath: exe, headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required",
    `--force-device-scale-factor=${DPR}`, `--window-size=${CSS_W + 22},${CSS_H + 98}`, "--hide-scrollbars"] });
const context = await browser.newContext({ viewport: null });
await context.addInitScript(() => {
  // The co-commander in the browser (strategy adviser), Auto: it applies each recommendation itself. Muted.
  try { localStorage.setItem("rtsai.cocommander", JSON.stringify({ enabled: true, mode: "browser", muted: true, auto: true, browserVersion: 1 })); } catch { /* about:blank */ }
  addEventListener("DOMContentLoaded", () => {
    const css = document.createElement("style");
    // Clean plate: every element hidden but the game canvas (visibility is inherited, so the canvas can be shown again).
    css.textContent = `html.footage-clean body * { visibility: hidden !important; } html.footage-clean canvas.stage { visibility: visible !important; }
      html.footage-clean { --sidebar-w: 0px !important; cursor: none !important; }`;
    document.head.appendChild(css);
  });
});
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => { pageErrors.push(String(e)); log("pageerror", String(e)); });
const cdp = await context.newCDPSession(page);
await page.goto("about:blank");
for (let i = 0; i < 4; i++) {
  const [w, h] = await page.evaluate(() => [innerWidth, innerHeight]);
  if (w === CSS_W && h === CSS_H) break;
  const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget");
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: bounds.width + (CSS_W - w), height: bounds.height + (CSS_H - h) } });
}
const until = async (f, arg, ms = 60000, every = 200) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await page.evaluate(f, arg); if (v) return v; await sleep(every); }
  return null;
};
const now = () => page.evaluate(() => performance.timeOrigin + performance.now());

// ------------------------------------------------------------------------------------------------- the mission
const pageUrl = new URL(url);
if (!pageUrl.searchParams.has("profile")) pageUrl.searchParams.set("profile", "public");
await page.goto(pageUrl.href);
await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 600000 });
const spec = await page.evaluate((id) => window.store.getState().setup?.missions?.find((m) => m.id === id) ?? null, mission);
if (!spec) throw new Error(`the page has no mission "${mission}" (missions: ${await page.evaluate(() => (window.store.getState().setup?.missions ?? []).map((m) => m.id).join(", "))})`);
log("viewport", JSON.stringify(await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio])), "faction", spec.faction, "slot", spec.slot);
await page.evaluate((m) => { window.game.wantFactions(null, m.faction); window.game.prepare(m.id); }, spec);
await page.waitForFunction((id) => { const s = window.store.getState(); return s.preparedMap === id && s.sheets.uploaded >= s.sheets.total; }, mission, { timeout: 600000 });
const scenario = { map: spec.id, mission: spec.id, seed: 2026, players: [{ slot: spec.slot, faction: spec.faction, color: "2A6FDB" }],
  options: { difficulty, startingcash: "10000", fog: "False", explored: "True" } };
await page.evaluate((s) => window.game.start(JSON.stringify(s)), scenario);
await page.waitForFunction(() => ["playing", "error"].includes(window.store.getState().phase), null, { timeout: 600000 });
if (await page.evaluate(() => window.store.getState().phase) !== "playing") throw new Error(`mission did not start: ${await page.evaluate(() => window.store.getState().error)}`);
await page.waitForFunction((id) => window.store.getState().ui?.mission?.id === id, mission, { timeout: 60000 });
log("playing");

// The camera rig and the clean plate, in the page.
await page.evaluate(([margin]) => {
  const g = window.game;
  const ease = (u) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, u)));
  /** The view kept inside the map (no black past its ragged edge). */
  const clamp = (x, y, zoom) => {
    const b = g.info.bounds, halfW = g.canvas.clientWidth / zoom / 2, halfH = g.canvas.clientHeight / zoom / 2;
    const x0 = b[0] + margin + halfW, x1 = b[2] - margin - halfW, y0 = b[1] + margin + halfH, y1 = b[3] - margin - halfH;
    return [x0 > x1 ? (b[0] + b[2]) / 2 : Math.min(x1, Math.max(x0, x)), y0 > y1 ? (b[1] + b[3]) / 2 : Math.min(y1, Math.max(y0, y))];
  };
  const set = (x, y, zoom) => { g.cam.zoom = zoom; const [cx, cy] = clamp(x, y, zoom); g.lookAt(cx, cy); };
  // Catmull-Rom through the keys, eased in and out over the whole glide; zoom interpolated in log space.
  const spline = (keys, s) => {
    const n = keys.length - 1, f = Math.min(n - 1e-9, s * n), i = Math.floor(f), t = f - i;
    const p0 = keys[Math.max(0, i - 1)], p1 = keys[i], p2 = keys[i + 1], p3 = keys[Math.min(n, i + 2)];
    const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
    return [cr(p0.x, p1.x, p2.x, p3.x), cr(p0.y, p1.y, p2.y, p3.y), Math.exp(cr(Math.log(p0.zoom), Math.log(p1.zoom), Math.log(p2.zoom), Math.log(p3.zoom)))];
  };
  const fx = window.__fx = {
    clamp, set,
    clean(on) { document.documentElement.classList.toggle("footage-clean", on); window.dispatchEvent(new Event("resize")); },
    stopAll() { fx.gliding = null; fx.following = null; },
    /** Keys [{x, y, zoom}], each clamped at its own zoom first; resolves when done. */
    glide(keys, ms) {
      fx.following = null;
      const k = keys.map((p) => { const [x, y] = clamp(p.x, p.y, p.zoom); return { x, y, zoom: p.zoom }; });
      set(k[0].x, k[0].y, k[0].zoom);
      return new Promise((resolve) => {
        const token = fx.gliding = {};
        const start = performance.now();
        const step = (t) => {
          if (fx.gliding !== token) return resolve(false);
          const u = (t - start) / ms;
          const [x, y, z] = spline(k, ease(u));
          set(x, y, z);
          if (u < 1) requestAnimationFrame(step); else { fx.gliding = null; resolve(true); }
        };
        requestAnimationFrame(step);
      });
    },
    /** A damped follow of a moving target point (updated by the tool); speed-limited so a new target is a pan. */
    follow(x, y, zoom) {
      fx.gliding = null;
      if (fx.following) { fx.following.tx = x; fx.following.ty = y; fx.following.tz = zoom; return; }
      const f = fx.following = { tx: x, ty: y, tz: zoom, x: g.cam.x, y: g.cam.y, z: g.cam.zoom, vx: 0, vy: 0, last: performance.now() };
      const step = (t) => {
        if (fx.following !== f) return;
        const dt = Math.min(50, t - f.last) / 1000; f.last = t;
        // Critically damped spring toward the target (omega 1.6/s), velocity capped at 260 world px/s.
        const w = 1.6, ax = w * w * (f.tx - f.x) - 2 * w * f.vx, ay = w * w * (f.ty - f.y) - 2 * w * f.vy;
        f.vx += ax * dt; f.vy += ay * dt;
        const v = Math.hypot(f.vx, f.vy), cap = 260;
        if (v > cap) { f.vx *= cap / v; f.vy *= cap / v; }
        f.x += f.vx * dt; f.y += f.vy * dt;
        f.z += (f.tz - f.z) * Math.min(1, dt * 0.8);
        set(f.x, f.y, f.z);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
  };
}, [72]);
await page.evaluate(() => window.__fx.clean(true));
await sleep(800);

// ------------------------------------------------------------------------------------------------- geometry
const info = await page.evaluate(() => { const i = window.game.info; return { bounds: i.bounds, start: i.start, cellOrigin: i.cellOrigin, tileSize: i.tileSize, gridType: i.gridType, mapSize: i.mapSize }; });
// Two cell spaces: map.yaml gives cells (CPos x, y); the co-commander's observation and its orders use map positions
// (MPos u, v: the staggered rows of the isometric grid). World pixels are the camera's space.
const iso = info.gridType !== "Rectangular";
/** A map position (MPos u, v) to world pixels. */
function mposToWorld([u, v]) {
  if (!iso) return [info.cellOrigin[0] + (u + 0.5) * info.tileSize[0], info.cellOrigin[1] + (v + 0.5) * info.tileSize[1]];
  return [info.cellOrigin[0] + (2 * u + (Math.round(v) & 1)) * info.tileSize[0] / 2, info.cellOrigin[1] + v * info.tileSize[1] / 2];
}
/** A cell (CPos) to its map position (MPos), as OpenRA's CPos.ToMPos. */
const cposToMPos = ([x, y]) => (iso ? [Math.floor((x - y) / 2), x + y] : [x, y]);
/** A map position back to its cell. */
const mposToCPos = ([u, v]) => { if (!iso) return [u, v]; const d = 2 * u + (v & 1); return [(v + d) / 2, (v - d) / 2]; };
/** A cell (CPos, as map.yaml gives it) to world pixels. */
const cellToWorld = (c) => mposToWorld(cposToMPos(c));
/** World pixels to the nearest map position (MPos). */
function worldToMPos([x, y]) {
  if (!iso) return [Math.floor((x - info.cellOrigin[0]) / info.tileSize[0]), Math.floor((y - info.cellOrigin[1]) / info.tileSize[1])];
  const v = Math.round((y - info.cellOrigin[1]) / (info.tileSize[1] / 2));
  return [Math.round(((x - info.cellOrigin[0]) / (info.tileSize[0] / 2) - (v & 1)) / 2), v];
}
/** World pixels to the nearest cell (CPos). */
const worldToCell = (p) => mposToCPos(worldToMPos(p));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const base = info.start;

/** Each objective's subjects: groups of target points (world px) with their actor names and cells. */
const missionUi = await page.evaluate(() => window.store.getState().ui.mission);
function subjectsOf(o, ui) {
  const pts = [];
  for (const m of ui?.markers ?? []) pts.push({ name: m.name, at: [m.x, m.y], cell: named[m.name]?.cell ?? worldToCell([m.x, m.y]) });
  const add = (n) => { const a = named[n]; if (a?.cell && !pts.some((p) => p.name === n)) pts.push({ name: n, at: cellToWorld(a.cell), cell: a.cell }); };
  if (o.kind === "escort" && o.entry) add(o.entry);
  if (o.kind === "shipping") {
    // The lanes' entries are open sea at the map edge and the ships only sail once the objective is active: the shot
    // is the strait itself, from the coast by the player's base out over the lane waypoint nearest to it.
    const wps = (o.lanes ?? []).flatMap((lane) => lane.slice(1, -1)).filter((n) => named[n]?.cell).map((n) => ({ name: n, at: cellToWorld(named[n].cell), cell: named[n].cell }));
    const lane = wps.sort((a, b) => dist(a.at, base) - dist(b.at, base))[0];
    if (lane) {
      const mix = (f) => [lane.at[0] + (base[0] - lane.at[0]) * f, lane.at[1] + (base[1] - lane.at[1]) * f];
      return { groups: [[lane]], toward: null, path: [mix(0.5), mix(0.15)], pathNote: `the strait from the coast by the player's base out over the shipping lane at ${lane.name}` };
    }
  }
  if (o.kind === "survive" && !pts.length) {
    // The attacks come from the mission's wave entry (Missions.Wave's naming rule) at the base: the shot looks down
    // that approach toward the base.
    const entry = Object.keys(named).find((n) => named[n].cell && (n.includes("GroundEntry") || n.includes("WaveEntry") || n === "NorthEntry" || n === "WestEntry"));
    if (entry) {
      const at = cellToWorld(named[entry].cell);
      const mix = (f) => [base[0] + (at[0] - base[0]) * f, base[1] + (at[1] - base[1]) * f];
      return { groups: [[{ name: entry, at, cell: named[entry].cell }]], toward: null, path: [mix(0.6), mix(0.3)], pathNote: `the attackers' approach from ${entry} toward the player's base` };
    }
  }
  let groups = [];
  for (const p of pts) {
    const g = groups.find((g) => dist(g[0].at, p.at) < 700);
    if (g) g.push(p); else groups.push([p]);
  }
  if (!groups.length) groups = [[{ name: "player base (start)", at: base, cell: worldToCell(base), base: true }]];
  // Escort: drift from the entry toward the first route point.
  let toward = null;
  if (o.kind === "escort" && o.route?.length && named[o.route[0]]?.cell) toward = { name: o.route[0], at: cellToWorld(named[o.route[0]].cell), cell: named[o.route[0]].cell };
  if (o.kind === "shipping" && o.lanes?.[0]?.[1] && named[o.lanes[0][1]]?.cell) toward = { name: o.lanes[0][1], at: cellToWorld(named[o.lanes[0][1]].cell), cell: named[o.lanes[0][1]].cell };
  return { groups: groups.slice(0, 3), toward };
}
const objectives = spec.objectives.map((o, i) => ({ index: i + 1, text: o.text, kind: o.kind, secondary: !!o.secondary, ...subjectsOf(o, missionUi.objectives[i]) }));

// ------------------------------------------------------------------------------------------------- recording
function recorder(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const frames = [];
  let on = false;
  const handler = async (f) => {
    if (on) {
      const name = `f${String(frames.length).padStart(6, "0")}.jpg`;
      const buf = Buffer.from(f.data, "base64");
      fs.writeFileSync(path.join(dir, name), buf);
      frames.push({ t: f.metadata.timestamp * 1000, name, bytes: buf.length });
    }
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  };
  cdp.on("Page.screencastFrame", handler);
  return {
    dir, frames,
    async start() { on = true; await cdp.send("Page.startScreencast", { format: "jpeg", quality: 95, everyNthFrame: 1 }); },
    async stop() { await cdp.send("Page.stopScreencast"); on = false; cdp.off("Page.screencastFrame", handler); },
  };
}

/** Constant-frame-rate H.264 from timestamped frames (each output frame shows the latest frame at its time). */
function encode(frames, dir, file, startMs, durationMs) {
  if (!frames.length) throw new Error(`no frames for ${file}`);
  const list = [];
  let j = 0;
  for (let k = 0; k * (1000 / FPS) < durationMs - 1; k++) {
    const t = startMs + k * (1000 / FPS);
    while (j + 1 < frames.length && frames[j + 1].t <= t) j++;
    list.push(`file '${frames[j].name}'\nduration ${(1 / FPS).toFixed(6)}`);
  }
  fs.writeFileSync(path.join(dir, "list.txt"), list.join("\n") + `\nfile '${frames[j].name}'\n`);
  // The screencast JPEGs are full-range BT.601 YCbCr; the delivery is limited-range BT.709 yuv420p.
  const vf = ["scale=trunc(iw/2)*2:trunc(ih/2)*2:in_range=full:in_color_matrix=bt601:out_range=limited:out_color_matrix=bt709", "format=yuv420p",
    "setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709"].join(",");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", "list.txt", "-r", String(FPS), "-vf", vf,
    "-frames:v", String(list.length), "-c:v", "libx264", "-preset", "slow", "-crf", String(CRF), "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", file], { cwd: dir });
}

function probe(file) {
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
    "stream=codec_name,width,height,r_frame_rate,nb_read_frames,pix_fmt:format=duration", "-of", "json", file]).toString());
  const s = j.streams[0];
  return { codec: s.codec_name, width: s.width, height: s.height, fps: s.r_frame_rate, frames: Number(s.nb_read_frames), pixFmt: s.pix_fmt, seconds: +Number(j.format.duration).toFixed(2) };
}

/** The most detailed frame (largest JPEG at a fixed quality: the most high-frequency detail) away from the ends. */
function keyFrame(rec, startMs, endMs, file) {
  const span = endMs - startMs;
  const inner = rec.frames.filter((f) => f.t >= startMs + span * 0.15 && f.t <= endMs - span * 0.1);
  const pool = inner.length ? inner : rec.frames;
  const best = pool.reduce((a, b) => (b.bytes > a.bytes ? b : a));
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", path.join(rec.dir, best.name), "-frames:v", "1", file]);
  return +((best.t - startMs) / 1000).toFixed(2);
}

const segments = [];
/**
 * Records one segment: run(), which moves the camera, between start and stop; the clip is [start, start + seconds].
 * A take where the page stalled (the screencast under 45 fps, or a gap over 150 ms between frames: the 30 fps clip would
 * stutter) is recorded again, after again(), up to three takes.
 */
async function segment(name, seconds, run, describe, again = null) {
  for (let attempt = 1; ; attempt++) {
    if (attempt > 1 && again) await again();
    const rec = recorder(path.join(tmpRoot, name));
    await rec.start();
    await sleep(150);
    const start = await now();
    await run(start);
    const left = start + seconds * 1000 - (await now());
    if (left > 0) await sleep(left + 120);
    const end = start + seconds * 1000;
    await rec.stop();
    const inWindow = rec.frames.filter((f) => f.t >= start && f.t <= end);
    const times = [start, ...inWindow.map((f) => f.t), end];
    const longestGap = Math.round(Math.max(...times.slice(1).map((t, i) => t - times[i])));
    const captureFps = +(inWindow.length / seconds).toFixed(1);
    if ((captureFps < 45 || longestGap > 150) && attempt < 3) {
      log(`${name}: take ${attempt} stuttered (screencast ${captureFps} fps, longest gap ${longestGap} ms): again`);
      fs.rmSync(rec.dir, { recursive: true, force: true });
      continue;
    }
    const file = path.join(out, `${name}.mp4`);
    encode(rec.frames, rec.dir, file, start, seconds * 1000);
    const frameAt = keyFrame(rec, start, end, path.join(framesDir, `${name}.png`));
    if (!keepFrames) fs.rmSync(rec.dir, { recursive: true, force: true });
    const p = probe(file);
    const seg = { file: `${name}.mp4`, keyFrame: `frames/${name}.png`, keyFrameAt: frameAt, ...p, captureFps, longestFrameGapMs: longestGap, takes: attempt, ...describe };
    segments.push(seg);
    log(`${name}: ${p.seconds} s, ${p.width}x${p.height} ${p.fps}, ${p.frames} frames, screencast ${captureFps} fps, longest gap ${longestGap} ms, take ${attempt}`);
    return seg;
  }
}

/** Jumps the camera (between recordings, a cut) and lets the view's actors and art stream in. */
async function cutTo(x, y, zoom, settle = 1400) {
  await page.evaluate(([x, y, zoom]) => { window.__fx.stopAll(); window.__fx.set(x, y, zoom); }, [x, y, zoom]);
  await sleep(settle);
}

const gameTime = () => page.evaluate(() => window.game.client.cur?.header.tick ?? 0);
const setSpeed = (speed) => page.evaluate((speed) => window.game.client.send({ type: "speed", speed }), speed);
const cellsOf = (pts) => pts.map((p) => ({ name: p.name, cell: p.cell }));

// The mission sends waves at the base only from an entry named as Missions.Wave looks for; without one, nothing
// attacks the player and the army is sent out at once.
const hasWaves = Object.keys(named).some((n) => n.includes("GroundEntry") || n.includes("WaveEntry") || n === "NorthEntry" || n === "WestEntry");

// ------------------------------------------------------------------------------------------------- establishing
async function shootEstablishing() {
  // From the battlefield (toward the farthest primary objective, at most 2400 px away) to the player's base.
  const primary = objectives.filter((o) => !o.secondary).flatMap((o) => o.groups.map((g) => ({ o, g, c: [g.reduce((s, p) => s + p.at[0], 0) / g.length, g.reduce((s, p) => s + p.at[1], 0) / g.length] })));
  // Prefer starting on an objective 1200-2600 px out (something to see at the start), else the farthest one.
  const away = primary.filter((p) => !p.g[0].base);
  const far = away.filter((p) => dist(p.c, base) >= 1200 && dist(p.c, base) <= 2600).sort((a, b) => dist(b.c, base) - dist(a.c, base))[0]
    ?? away.sort((a, b) => dist(b.c, base) - dist(a.c, base))[0];
  const dir = far ? [far.c[0] - base[0], far.c[1] - base[1]] : [1, -0.5];
  const len = Math.hypot(dir[0], dir[1]) || 1, reach = Math.min(2400, Math.max(1400, len));
  const from = [base[0] + dir[0] / len * reach, base[1] + dir[1] / len * reach];
  const mid = [(from[0] + base[0]) / 2 - dir[1] / len * reach * 0.08, (from[1] + base[1]) / 2 + dir[0] / len * reach * 0.08];
  const keys = [{ x: from[0], y: from[1], zoom: 0.62 }, { x: mid[0], y: mid[1], zoom: 0.7 }, { x: base[0], y: base[1], zoom: 0.84 }];
  await cutTo(keys[0].x, keys[0].y, keys[0].zoom, 2200);
  await segment("establishing", 8, async () => {
    await sleep(200);
    await page.evaluate(([keys]) => window.__fx.glide(keys, 7600), [keys]);
  }, { shows: `Camera glide from ${far ? `the battlefield toward ${far.g.map((p) => p.name).join(", ")} (objective ${far.o.index})` : "the battlefield"} to the player's base`,
    camera: { keys, easing: "cosine ease-in-out over a Catmull-Rom path, 0.2 s holds" }, from: { at: from.map(Math.round), cell: worldToCell(from) }, to: { at: base, cell: worldToCell(base), name: "player base (start)" } }, () => cutTo(keys[0].x, keys[0].y, keys[0].zoom, 2200));
}

// ------------------------------------------------------------------------------------------------- objectives
async function shootObjectives() {
  for (const o of objectives) {
    for (let k = 0; k < o.groups.length; k++) {
      const g = o.groups[k];
      const c = [g.reduce((s, p) => s + p.at[0], 0) / g.length, g.reduce((s, p) => s + p.at[1], 0) / g.length];
      // A slow drift (along the route for escorts) and a gentle push-in, centred on the subject.
      let d = [Math.cos(o.index * 2.1 + k), Math.sin(o.index * 2.1 + k) * 0.5];
      const along = !!o.toward && k === 0;
      if (along) d = [o.toward.at[0] - c[0], o.toward.at[1] - c[1]];
      const dl = Math.hypot(d[0], d[1]) || 1, drift = along ? 170 : 90;
      const a = [c[0] - d[0] / dl * drift * (along ? 0.2 : 1), c[1] - d[1] / dl * drift * (along ? 0.2 : 1)];
      const b = [c[0] + d[0] / dl * drift * (along ? 1.8 : 1), c[1] + d[1] / dl * drift * (along ? 1.8 : 1)];
      // Closer on a lone target (units are small), wider when the group is spread.
      const xs = g.map((p) => p.at[0]), ys = g.map((p) => p.at[1]);
      const fit = Math.min(CSS_W / (Math.max(...xs) - Math.min(...xs) + 700), CSS_H / (Math.max(...ys) - Math.min(...ys) + 420));
      const z1 = Math.max(0.75, Math.min(1.3, fit)), z0 = z1 * 0.9;
      const keys = o.path && k === 0 ? [{ x: o.path[0][0], y: o.path[0][1], zoom: 0.75 }, { x: o.path[1][0], y: o.path[1][1], zoom: 0.82 }] : [{ x: a[0], y: a[1], zoom: z0 }, { x: b[0], y: b[1], zoom: z1 }];
      const name = k === 0 ? `objective-${o.index}` : `objective-${o.index}-${k + 1}`;
      await cutTo(keys[0].x, keys[0].y, keys[0].zoom);
      await segment(name, 5, async () => { await page.evaluate(([keys]) => window.__fx.glide(keys, 5000), [keys]); },
        { shows: `Objective ${o.index}${o.secondary ? " (secondary)" : ""}: ${o.text} Subject: ${g.map((p) => p.name).join(", ")}${o.toward && k === 0 ? `, drifting toward ${o.toward.name}` : ""}${o.pathNote && k === 0 ? ` (${o.pathNote})` : ""}.`,
          objective: { index: o.index, text: o.text, kind: o.kind, secondary: o.secondary }, actors: cellsOf(g), toward: o.toward ? cellsOf([o.toward])[0] : undefined,
          camera: { keys, easing: "cosine ease-in-out drift and push-in" } }, () => cutTo(keys[0].x, keys[0].y, keys[0].zoom));
    }
  }
}

// ------------------------------------------------------------------------------------------------- battle
const battle = { warmup: [], pushes: [] };
async function shootBattle() {
  /**
   * The fighting, from the co-commander's observation (not fog-limited here since the fog is off): actors that lost
   * health since the last look (that is where the shots land and the explosions are), and own actors (units,
   * buildings) and enemy units within 330 world px (about ten cells) of each other. Returns the densest group's centre
   * (world px), its size and how many enemies are in it, or null.
   */
  const lastHp = new Map();
  async function action() {
    const obs = await page.evaluate(async () => { try { return await window.game.client.adviserObserve(); } catch (e) { return { error: String(e) }; } });
    if (!obs || obs.error) return { obs: null, fight: null };
    const own = [...obs.units, ...obs.buildings], enemies = [...obs.visibleEnemies, ...obs.visibleEnemyBuildings];
    const at = (a) => (a.at ??= mposToWorld([a.cellX, a.cellY]));
    const near = (a, b, r) => dist(at(a), at(b)) <= r;
    const hit = [];
    for (const a of [...own, ...enemies]) {
      const hp = a.hpPercent ?? 1, before = lastHp.get(a.actorId);
      if (before !== undefined && hp < before - 0.001) hit.push(a);
      lastHp.set(a.actorId, hp);
    }
    const engaged = new Set(hit);
    for (const e of obs.visibleEnemies) {
      const close = own.filter((a) => near(a, e, 330));
      if (close.length) { engaged.add(e); for (const a of close) engaged.add(a); }
    }
    const list = [...engaged];
    if (list.length < 2) return { obs, fight: null };
    // The densest group: the actor with the most others within 450 px (a hit counts double), then their mean.
    const weight = (a) => (hit.includes(a) ? 2 : 1);
    const centre = list.map((a) => ({ a, n: list.filter((b) => near(a, b, 450)) }))
      .sort((p, q) => q.n.reduce((s, b) => s + weight(b), 0) - p.n.reduce((s, b) => s + weight(b), 0))[0];
    const pts = centre.n.map(at);
    const c = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    const isEnemy = (a) => enemies.includes(a);
    return { obs, fight: { at: c, size: centre.n.length, hits: centre.n.filter((a) => hit.includes(a)).length,
      enemies: centre.n.filter(isEnemy).length || (centre.n.some((a) => hit.includes(a)) ? obs.visibleEnemies.filter((e) => dist(at(e), c) <= 500).length : 0),
      cell: worldToCell(c), mpos: worldToMPos(c) } };
  }
  const nonCombat = /harv|mcv|engineer|engi|truck|sapc|network|spy|dog/i;
  const fightersOf = (obs, moving = false) => (obs ? obs.units.filter((u) => u.canAttack && !nonCombat.test(u.kind) && (!moving || !u.idle)) : []);
  const centreOf = (us) => mposToWorld([us.reduce((s, u) => s + u.cellX, 0) / us.length, us.reduce((s, u) => s + u.cellY, 0) / us.length]);
  /** Where the camera goes without a fight: the army on the move, else nothing (null). */
  const movingArmy = (obs) => { const m = fightersOf(obs, true); return m.length ? centreOf(m) : null; };
  /** Without a fight after a push: the army wherever it is (it went toward the enemy). */
  const army = (obs) => { const m = fightersOf(obs); return m.length ? centreOf(m) : null; };

  /** The player's combat units attack-move at the nearest enemy objective target or enemy, through the co-commander's
   * engine channel (the same validated orders its Attack recommendation gives). */
  async function push(obs) {
    const fighters = fightersOf(obs);
    if (!fighters.length) return null;
    const armyAt = [fighters.reduce((s, u) => s + u.cellX, 0) / fighters.length, fighters.reduce((s, u) => s + u.cellY, 0) / fighters.length];
    const targets = objectives.filter((o) => ["destroy", "capture"].includes(o.kind)).flatMap((o) => o.groups.flat()).filter((p) => p.cell && !p.base).map((p) => ({ name: p.name, cell: p.cell, mpos: cposToMPos(p.cell) }));
    const enemies = obs.visibleEnemies.map((e) => ({ name: e.kind, mpos: [e.cellX, e.cellY], cell: mposToCPos([e.cellX, e.cellY]) }));
    // The nearest live enemy unit first (targets move: ships patrol), else the nearest objective target or building.
    const byDistance = (list) => list.sort((p, q) => dist(mposToWorld(p.mpos), mposToWorld(armyAt)) - dist(mposToWorld(q.mpos), mposToWorld(armyAt)));
    const live = byDistance(obs.visibleEnemies.map((e) => ({ name: e.kind, mpos: [e.cellX, e.cellY], cell: mposToCPos([e.cellX, e.cellY]) })));
    const goal = live[0] ?? byDistance([...targets, ...enemies])[0];
    if (!goal) return null;
    const commands = fighters.slice(0, 20).map((u) => ({ action: "attack_move", actor_id: u.actorId, target_x: goal.mpos[0], target_y: goal.mpos[1] }));
    // One order per unit: the engine validates each against the latest observation, and one batch can be refused whole.
    const receipts = await page.evaluate(async (cs) => {
      const out = [];
      for (const c of cs) {
        try { const r = await window.game.client.adviserExecute(`footage-push-${c.actor_id}-${Date.now()}`, [c]); out.push(r?.accepted ? "ok" : (r?.detail ?? "refused")); }
        catch (e) { out.push(String(e)); }
      }
      return out;
    }, commands);
    const accepted = receipts.filter((r) => r === "ok").length;
    const p = { tick: await gameTime(), units: commands.length, accepted, target: goal.name, cell: goal.cell, distancePx: Math.round(dist(mposToWorld(goal.mpos), mposToWorld(armyAt))), liveEnemies: obs.visibleEnemies.length, refused: receipts.filter((r) => r !== "ok").slice(0, 3) };
    battle.pushes.push(p);
    log("push", JSON.stringify(p));
    return p;
  }
  await cutTo(base[0], base[1], 0.6, 300);
  // Without waves the first clash is the army arriving: a gentler warm-up speed so it is not over before it is seen.
  const warmUp = hasWaves ? warmSpeed : Math.min(2, warmSpeed);
  await setSpeed(warmUp);
  log(`warm-up at ${warmUp}x from tick ${await gameTime()}`);
  let fight = null, lastPush = 0;
  const warmStart = Date.now();
  while (Date.now() - warmStart < 150000) {
    const r = await action();
    // A fight: three engaged, or shots landing (a hit) with an enemy in it or near (long-range fire, ships).
    if (r.fight && r.fight.enemies >= 1 && (r.fight.size >= 3 || r.fight.hits >= 1)) { fight = r.fight; break; }
    // No fighting after 15 s (a game minute at 4x; at once on a map without waves): push, and again every 25 s with the
    // units built since (at most 4).
    if (r.obs && !r.fight && Date.now() - warmStart > (hasWaves ? 15000 : 0) && Date.now() - lastPush > 25000 && battle.pushes.length < 4) {
      if (await push(r.obs)) lastPush = Date.now();
    }
    const look = r.fight?.at ?? (lastPush ? movingArmy(r.obs) : null);
    if (look) await page.evaluate(([x, y]) => window.__fx.follow(x, y, 0.6), look);
    await sleep(500);
  }
  battle.warmup.push({ seconds: +((Date.now() - warmStart) / 1000).toFixed(1), speed: warmUp, tick: await gameTime(), fight });
  await setSpeed(1);
  log("battle from tick", await gameTime(), "fight", JSON.stringify(fight));
  const files = [];
  for (let k = 1; k <= cuts; k++) {
    let r = await action();
    if (!r.fight && k > 1) {
      // Between cuts the fight may be over: catch up at speed to the next contact (at most 40 s; a push after 20 s).
      await setSpeed(warmSpeed);
      const t = Date.now();
      let pushed = false;
      while (Date.now() - t < 40000 && !(r.fight && r.fight.enemies >= 1)) {
        await sleep(500);
        r = await action();
        if (!pushed && r.obs && Date.now() - t > 20000) { pushed = !!(await push(r.obs)); }
      }
      await setSpeed(1);
      battle.warmup.push({ beforeCut: k, tick: await gameTime(), fight: r.fight });
    }
    const target = r.fight?.at ?? movingArmy(r.obs) ?? (battle.pushes.length ? army(r.obs) : null) ?? fight?.at ?? base;
    await cutTo(target[0], target[1], 0.95, 1200);
    const seen = [];
    const startTick = await gameTime();
    const seg = await segment(`battle-${k}`, cutSeconds, async (start) => {
      seen.length = 0;
      await page.evaluate(([x, y]) => window.__fx.follow(x, y, 0.95), target);
      while ((await now()) < start + cutSeconds * 1000 - 400) {
        const q = await action();
        if (q.fight) seen.push({ at: +(((await now()) - start) / 1000).toFixed(1), cell: q.fight.cell, size: q.fight.size });
        const look = q.fight?.at ?? movingArmy(q.obs) ?? (battle.pushes.length ? army(q.obs) : null);
        if (look) await page.evaluate(([x, y]) => window.__fx.follow(x, y, 0.95), look);
        await sleep(450);
      }
    }, { shows: `Battle cut ${k}: real play, the camera following the fighting (the player's side played by the co-commander in Auto${battle.pushes.length ? ", its army sent at " + battle.pushes.map((p) => p.target).join(", then ") : ""}; the enemy is the mission's own forces${hasWaves ? " and scripted waves" : ""}).`,
      camera: { follow: "critically damped spring to the densest engagement (else the army on the move), capped at 260 world px/s, zoom 0.95" }, startTick });
    seg.fight = seen.length ? { first: seen[0], last: seen.at(-1), samples: seen.length } : null;
    files.push(`battle-${k}.mp4`);
    if (k < cuts) { await page.evaluate(() => window.__fx.stopAll()); await sleep(3000); }
  }
  // battle.mp4: the cuts joined (same encoder settings: stream copy).
  fs.writeFileSync(path.join(out, "battle-list.txt"), files.map((f) => `file '${f}'`).join("\n") + "\n");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", "battle-list.txt", "-c", "copy", "-movflags", "+faststart", "battle.mp4"], { cwd: out });
  fs.unlinkSync(path.join(out, "battle-list.txt"));
  const best = segments.filter((s) => s.file.startsWith("battle-")).sort((a, b) => (b.fight?.samples ?? 0) - (a.fight?.samples ?? 0))[0];
  if (best) fs.copyFileSync(path.join(out, best.keyFrame), path.join(framesDir, "battle.png"));
  segments.push({ file: "battle.mp4", keyFrame: "frames/battle.png", ...probe(path.join(out, "battle.mp4")), shows: `The ${files.length} battle cuts joined: ${files.join(", ")}.`, cuts: files });
}

// The order of the shots: a mission that sends waves at the base is filmed establishing, objectives, battle; one
// without waves (nothing attacks the player) is filmed battle first, while its forces are still where they start, so
// the army sent out meets them.
const shots = { establishing: shootEstablishing, objectives: shootObjectives, battle: shootBattle };
for (const name of hasWaves ? ["establishing", "objectives", "battle"] : ["battle", "establishing", "objectives"]) if (only.has(name)) await shots[name]();

const ui = await page.evaluate(() => window.store.getState().ui?.mission);
await browser.close();
fs.rmSync(tmpRoot, { recursive: true, force: true });
const meta = {
  mission, title: spec.title, faction: spec.faction, slot: spec.slot, enemy: spec.enemy, page: pageUrl.href, mapYaml: fs.existsSync(mapYaml) ? path.relative(repo, mapYaml).replaceAll("\\", "/") : null,
  recordedAt: new Date().toISOString(),
  capture: { resolution: `${CSS_W * DPR}x${CSS_H * DPR}`, cssViewport: `${CSS_W}x${CSS_H}`, deviceScale: DPR, fps: FPS, codec: `H.264 (libx264 preset slow, CRF ${CRF}, yuv420p, BT.709 limited range)`,
    method: "headless Chromium (ANGLE D3D11, GPU), CDP screencast JPEG q95 frames resampled by their timestamps to constant 30 fps",
    hud: "hidden: an injected stylesheet hides every element but the game canvas and sets the sidebar width to 0 (the canvas fills the window); no pointer over the canvas (no hover brackets), nothing selected",
    fog: "the mission launched through the page's game.start with the lobby options fog False and explored True (the campaign screen launches with fog on), so every target is visible; the mission's objectives and scripts run as usual",
    difficulty, players: "the player's side: the page's co-commander (browser strategy adviser) in Auto, applying its own recommendations; the enemy: the mission's scripted forces and waves",
    keyFrames: "per segment, the most detailed frame (largest JPEG at fixed quality, away from the segment's ends), written as PNG at full resolution" },
  map: { bounds: info.bounds, start: info.start, cellOrigin: info.cellOrigin, tileSize: info.tileSize, gridType: info.gridType, mapSize: info.mapSize },
  objectives: spec.objectives.map((o, i) => ({ index: i + 1, text: o.text, kind: o.kind, secondary: !!o.secondary, statusAtEnd: ui?.objectives?.[i]?.status ?? null,
    subjects: objectives[i].groups.map((g) => cellsOf(g)) })),
  battle, segments, pageErrors,
};
fs.writeFileSync(path.join(out, "footage.json"), JSON.stringify(meta, null, 2) + "\n");
log("done", out, `${segments.length} files`);
