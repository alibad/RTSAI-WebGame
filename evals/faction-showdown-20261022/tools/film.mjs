// A broadcast-style recording of one AI-vs-AI match in the live web game's ungated twin, from the match's replay
// (the recorded orders tools/match.mjs saved): the game's own read-only replay, so the film is exactly the match
// that was scored. The game's HUD is hidden and an overlay of our own shows the sides, army value, clock, losses and
// the winner card (values from the match's stats timeline, by tick). A director moves the camera to the fighting
// (actors losing health) and time-lapses the quiet stretches.
//   node tools/film.mjs --replay <run>/replays/america-vs-russia-s1.json --result <run>/results.jsonl --out <run>/videos
//        [--label "Match 1 of 120"] [--mode highlights|full] [--battle-speed 4] [--quiet-speed 8] [--crf 27]
//        [--window 50] [--windows 4] [--opening 5]
// highlights (default): the opening, the biggest fights (windows of --window game seconds where the scored match
// destroyed the most value), the final assault and the result, about two minutes. full: the whole match, quiet
// stretches skipped.
// Writes <out>/<a>-vs-<b>-s<seed>.mp4 (1920x1080, 30 fps, H.264) and a .json beside it.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "file:///C:/Users/Admin/Code/hq/games/RTSAI-WebGame/web/node_modules/playwright-core/index.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const replay = JSON.parse(fs.readFileSync(opt("replay"), "utf8"));
const scenario = replay.scenario;
const A = scenario.players[0].faction, B = scenario.players[1].faction;
const map = scenario.map, seed = scenario.seed, bot = scenario.players[0].bot;
// The scored match: its stats timeline and final numbers.
const results = fs.readFileSync(opt("result"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); // a line may be mid-append
const scored = results.filter((r) => r.a === A && r.b === B && r.seed === seed && r.map === map && r.timeline).at(-1);
if (!scored) throw new Error(`no scored result for ${A} vs ${B} seed ${seed}`);
const outDir = path.resolve(opt("out"));
const label = opt("label", "AI vs AI");
const sub = opt("sub", ""); // the tag's second line (default: the map's name)
const battleSpeed = Number(opt("battle-speed", opt("mode", "highlights") === "full" ? 4 : 3));
const quietRecord = Number(opt("quiet-record", 4)); // seconds of time-lapse kept from each quiet stretch
const quietSpeed = Number(opt("quiet-speed", 8));
const limit = Number(opt("limit", 2400));
const crf = opt("crf", "28");
const url = opt("url", "http://127.0.0.1:3741/");
const CSS_W = 960, CSS_H = 540, DPR = 2, FPS = 30;
const name = opt("name", `${A}-vs-${B}-s${seed}`);
fs.mkdirSync(outDir, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const exe = process.env.LOCALAPPDATA + "/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
const browser = await chromium.launch({ executablePath: exe, headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required", "--mute-audio",
    `--force-device-scale-factor=${DPR}`, `--window-size=${CSS_W + 22},${CSS_H + 98}`, "--hide-scrollbars"] });
const context = await browser.newContext({ viewport: null });
await context.addInitScript(() => {
  addEventListener("DOMContentLoaded", () => {
    const css = document.createElement("style");
    css.textContent = `html.footage-clean body * { visibility: hidden !important; } html.footage-clean canvas.stage { visibility: visible !important; }
      html.footage-clean { --sidebar-w: 0px !important; cursor: none !important; }
      html.footage-clean #evo, html.footage-clean #evo * { visibility: visible !important; }`;
    document.head.appendChild(css);
  });
});
const page = await context.newPage();
// --bundle: the patched web-bundle.pack the replayed games were played with (tools/bundle_rules.py).
if (opt("bundle")) await page.route(/\/public\/web-bundle\.pack$/, (r) => r.fulfill({ status: 200, contentType: "application/octet-stream", body: fs.readFileSync(opt("bundle")) }));
const errors = [];
page.on("pageerror", (e) => errors.push({ at: Date.now() - t0, kind: "pageerror", text: String(e.stack ?? e).slice(0, 1500) }));
page.on("console", (m) => { if (m.type() === "error") errors.push({ at: Date.now() - t0, kind: "error", text: m.text().slice(0, 1500) }); });
const cdp = await context.newCDPSession(page);
await page.goto("about:blank");
for (let i = 0; i < 4; i++) {
  const [w, h] = await page.evaluate(() => [innerWidth, innerHeight]);
  if (w === CSS_W && h === CSS_H) break;
  const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget");
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: bounds.width + (CSS_W - w), height: bounds.height + (CSS_H - h) } });
}

// ------------------------------------------------------------------------------------------------- streaming encoder
// Screencast frames arrive when the page repaints, timestamped; each 1/30 s of output shows the latest frame then.
const file = path.join(outDir, `${name}.mp4`);
const vf = ["scale=trunc(iw/2)*2:trunc(ih/2)*2:in_range=full:in_color_matrix=bt601:out_range=limited:out_color_matrix=bt709", "format=yuv420p",
  "setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709"].join(",");
const ff = spawn("ffmpeg", ["-y", "-v", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
  "-vf", vf, "-c:v", "libx264", "-preset", "medium", "-crf", crf, "-pix_fmt", "yuv420p", "-movflags", "+faststart", file], { stdio: ["pipe", "inherit", "inherit"] });
let last = null, clock = null, written = 0, recording = false, longestGap = 0, lastT = null;
const write = (buf) => new Promise((r) => { written++; if (ff.stdin.write(buf)) r(); else ff.stdin.once("drain", r); });
cdp.on("Page.screencastFrame", async (f) => {
  if (recording) {
    const t = f.metadata.timestamp * 1000, buf = Buffer.from(f.data, "base64");
    if (clock === null) { last = null; lastT = null; }
    if (lastT !== null) longestGap = Math.max(longestGap, t - lastT);
    lastT = t;
    if (clock === null) clock = t;
    while (last && clock + 1000 / FPS <= t) { await write(last); clock += 1000 / FPS; }
    last = buf;
  }
  await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
});

// ------------------------------------------------------------------------------------------------- the match
await page.goto(`${url}?profile=public&mode=skirmish`);
await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 300000, polling: 500 });
const setup = await page.evaluate(() => window.store.getState().setup);
const factionName = (id) => setup.factions.find((f) => f.id === id)?.name ?? id;
const mapTitle = setup.maps.find((m) => m.id === map)?.title ?? map;
// The read-only replay, as the Saves & replays screen starts one (MatchLibrary startRecord): paused at its start.
await page.evaluate(({ scenario, log, end }) => window.game.start(JSON.stringify({ ...scenario, webReplay: { log, tick: 0, readonly: true, end } }), true),
  { scenario, log: replay.log, end: replay.tick });
await page.waitForFunction(() => ["playing", "error"].includes(window.store.getState().phase), null, { timeout: 300000, polling: 250 });
if ((await page.evaluate(() => window.store.getState().phase)) !== "playing") throw new Error("did not start: " + await page.evaluate(() => window.store.getState().error));
log("replay ready", A, "vs", B, "end tick", replay.tick);

// The director and the overlay live in the page (smooth camera on requestAnimationFrame).
await page.evaluate(({ A, B, nameA, nameB, mapTitle, label, sub }) => {
  const g = window.game;
  document.documentElement.classList.add("footage-clean");
  // Snapshots carry only actors in view: keep the whole map in view (the camera still shows its own part).
  g.sendView = function () { this.client.send({ type: "view", x0: -100000, y0: -100000, x1: 100000, y1: 100000 }); };
  g.sendView(true);
  g.cam.zoom = 0.85;

  // ---- overlay
  const flag = (id) => id === "hezbollah"
    ? `<span class="evo-mono" style="--c:#7fae3a">HZB</span>` // never the Hezbollah flag in a video (owner rule)
    : `<img class="evo-flag" src="flags/${id}.svg" alt="">`;
  const root = document.createElement("div");
  root.id = "evo";
  root.innerHTML = `<style>
    #evo { position: fixed; inset: 0; pointer-events: none; z-index: 99999; font-family: "Segoe UI", system-ui, sans-serif; color: #eeeadd; }
    #evo .evo-board { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); width: 440px;
      background: linear-gradient(#141912f2, #0d100df2); border: 1px solid #f1d28b40; border-radius: 6px; box-shadow: 0 6px 24px #0009; overflow: hidden; }
    #evo .evo-row { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding: 7px 12px 5px; gap: 10px; }
    #evo .evo-side { display: flex; align-items: center; gap: 8px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; font-size: 15px; }
    #evo .evo-side.b { justify-content: flex-end; }
    #evo .evo-flag { width: 30px; height: 20px; object-fit: cover; border-radius: 2px; box-shadow: 0 0 0 1px #0008; }
    #evo .evo-mono { display: inline-grid; place-items: center; width: 30px; height: 20px; border-radius: 2px; background: var(--c); color: #0d100d; font-size: 9px; font-weight: 800; letter-spacing: .04em; }
    #evo .evo-clock { font: 600 18px/1 Consolas, ui-monospace, monospace; color: #f1d28b; text-align: center; min-width: 74px; }
    #evo .evo-clock small { display: block; font: 600 8px/1.4 "Segoe UI", sans-serif; letter-spacing: .18em; color: #a8924f; }
    #evo .evo-bar { position: relative; height: 6px; background: #ff4848; }
    #evo .evo-bar i { position: absolute; inset: 0 auto 0 0; background: #4f80ff; transition: width .6s; }
    #evo .evo-nums { display: grid; grid-template-columns: 1fr auto 1fr; padding: 4px 12px 6px; font: 600 11px/1.2 Consolas, monospace; color: #a2a695; }
    #evo .evo-nums .b { text-align: right; } #evo .evo-nums .m { letter-spacing: .14em; font: 600 8px/1.6 "Segoe UI", sans-serif; color: #7d8572; }
    #evo .evo-tag { position: absolute; top: 12px; left: 12px; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: #a8924f;
      background: #0d100dd9; border: 1px solid #f1d28b30; border-radius: 4px; padding: 5px 8px; line-height: 1.5; }
    #evo .evo-tag b { color: #f1d28b; font-weight: 700; display: block; letter-spacing: .1em; }
    #evo .evo-speed { position: absolute; right: 12px; bottom: 12px; font: 700 12px/1 Consolas, monospace; padding: 6px 9px; border-radius: 4px;
      background: #0d100dd9; border: 1px solid #f1d28b30; color: #f1d28b; letter-spacing: .08em; }
    #evo .evo-speed.fight { color: #fff; background: #b8341fe6; border-color: #ef5b3f; }
    #evo .evo-feed { position: absolute; left: 12px; bottom: 12px; display: flex; flex-direction: column; gap: 4px; }
    #evo .evo-feed div { font-size: 11px; background: #0d100dd9; border-left: 3px solid var(--c); padding: 4px 8px; border-radius: 2px; animation: evoIn .3s ease-out; }
    @keyframes evoIn { from { opacity: 0; transform: translateX(-8px); } }
    #evo .evo-end { position: absolute; inset: 0; display: none; place-items: center; background: radial-gradient(#0000 30%, #000c 100%); }
    #evo .evo-end.on { display: grid; animation: evoFade .8s ease-out; }
    @keyframes evoFade { from { opacity: 0; } }
    #evo .evo-card { text-align: center; background: #0d100deb; border: 1px solid #f1d28b66; border-radius: 8px; padding: 22px 40px 18px; box-shadow: 0 10px 40px #000; }
    #evo .evo-card .evo-flag, #evo .evo-card .evo-mono { display: block; margin: 0 auto; width: 96px; height: 64px; font-size: 22px; line-height: 64px; text-align: center; }
    #evo .evo-skip { position: absolute; right: 12px; top: 12px; font: 700 13px/1 Consolas, monospace; padding: 6px 9px; border-radius: 4px; background: #0d100dd9; border: 1px solid #f1d28b66; color: #f1d28b; opacity: 0; transition: opacity .3s; }
    #evo .evo-skip.on { opacity: 1; }
    #evo .evo-fade { position: absolute; inset: 0; background: #000; opacity: 0; transition: opacity .35s; }
    #evo .evo-fade.on { opacity: 1; transition: none; }
    #evo.ended .evo-speed, #evo.ended .evo-skip { display: none; }
    #evo .evo-card h1 { margin: 12px 0 4px; font-size: 30px; letter-spacing: .12em; text-transform: uppercase; color: #f1d28b; }
    #evo .evo-card p { margin: 0; font-size: 12px; color: #a2a695; letter-spacing: .04em; }
  </style>
  <div class="evo-tag"><b>${label}</b>${sub || mapTitle}</div>
  <div class="evo-board">
    <div class="evo-row"><div class="evo-side a">${flag(A)}<span>${nameA}</span></div><div class="evo-clock" id="evo-clock">0:00<small>GAME TIME</small></div><div class="evo-side b"><span>${nameB}</span>${flag(B)}</div></div>
    <div class="evo-bar"><i id="evo-share" style="width:50%"></i></div>
    <div class="evo-nums"><span id="evo-a">army 0 · lost 0</span><span class="m">ARMY VALUE</span><span class="b" id="evo-b">army 0 · lost 0</span></div>
  </div>
  <div class="evo-feed" id="evo-feed"></div>
  <div class="evo-speed" id="evo-speed">▶▶ ${8}×</div>
  <div class="evo-skip" id="evo-skip"></div>
  <div class="evo-fade" id="evo-fade"></div>
  <div class="evo-end" id="evo-end"></div>`;
  document.body.appendChild(root);
  const fmt = (n) => n >= 10000 ? (n / 1000).toFixed(1) + "k" : n.toLocaleString("en-US");
  const prev = {};
  window.__evo = {
    update(stats, speed, fight) {
      const gs = Math.floor(stats.tick * stats.timestep / 1000);
      document.getElementById("evo-clock").innerHTML = `${Math.floor(gs / 60)}:${String(gs % 60).padStart(2, "0")}<small>GAME TIME</small>`;
      const [pa, pb] = stats.players;
      const va = pa.army.at(-1), vb = pb.army.at(-1);
      document.getElementById("evo-share").style.width = `${va + vb ? (100 * va / (va + vb)) : 50}%`;
      document.getElementById("evo-a").textContent = `army ${fmt(va)} · lost ${fmt(pa.deathsCost)}`;
      document.getElementById("evo-b").textContent = `lost ${fmt(pb.deathsCost)} · army ${fmt(vb)}`;
      const sp = document.getElementById("evo-speed");
      sp.className = "evo-speed" + (fight ? " fight" : "");
      sp.textContent = fight ? `BATTLE · ${speed}×` : `▶▶ ${speed}×`;
      // Feed: buildings lost since the last update.
      for (const [i, p] of stats.players.entries()) {
        const before = prev[i] ?? 0;
        if (p.buildingsDead > before) {
          const other = stats.players[1 - i];
          const n = p.buildingsDead - before;
          const el = document.createElement("div");
          el.style.setProperty("--c", i === 0 ? "#ff4848" : "#4f80ff");
          el.textContent = `${i === 0 ? nameA : nameB} loses ${n === 1 ? "a building" : n + " buildings"}`;
          const feed = document.getElementById("evo-feed");
          feed.appendChild(el);
          while (feed.children.length > 3) feed.firstChild.remove();
          setTimeout(() => el.remove(), 9000);
        }
        prev[i] = p.buildingsDead;
      }
    },
    /** Back from a skipped stretch: a short fade from black and the time jumped. */
    resume(skipped) {
      const fade = document.getElementById("evo-fade"), skip = document.getElementById("evo-skip");
      fade.classList.add("on"); requestAnimationFrame(() => requestAnimationFrame(() => fade.classList.remove("on")));
      skip.textContent = `▶▶ +${Math.floor(skipped / 60)}:${String(skipped % 60).padStart(2, "0")}`;
      skip.classList.add("on"); clearTimeout(this.skipTimer); this.skipTimer = setTimeout(() => skip.classList.remove("on"), 2600);
    },
    end(stats) {
      const w = stats.players.findIndex((p) => p.win === "Won");
      const gs = Math.floor(stats.tick * stats.timestep / 1000);
      const time = `${Math.floor(gs / 60)}:${String(gs % 60).padStart(2, "0")}`;
      const el = document.getElementById("evo-end");
      if (w < 0) el.innerHTML = `<div class="evo-card"><h1>Draw</h1><p>No side broke through in ${time}</p></div>`;
      else {
        const p = stats.players[w], o = stats.players[1 - w];
        el.innerHTML = `<div class="evo-card">${flag(w === 0 ? A : B)}<h1>${w === 0 ? nameA : nameB} wins</h1>
          <p>in ${time} of game time · destroyed ${fmt(p.killsCost)} · lost ${fmt(o.killsCost)}</p></div>`;
      }
      el.classList.add("on");
      root.classList.add("ended");
    },
  };

  // ---- director: the camera glides to where actors lose health; elsewhere to a target the Node side picks.
  const hp = new Map();
  let heat = []; // {x, y, t}
  let goal = null, fallback = null, lastFight = -1e9;
  const vel = { x: 0, y: 0 };
  function look() {
    const s = g.client.cur; if (!s) return;
    const now = performance.now();
    for (const a of s.actors) {
      if (a.owner === 0 || a.maxHp <= 0) continue;
      const before = hp.get(a.id);
      if (before !== undefined && a.hp < before) heat.push({ x: a.sx, y: a.sy, t: now });
      hp.set(a.id, a.hp);
    }
    heat = heat.filter((h) => now - h.t < 3500);
    if (heat.length >= 4) {
      // The densest hit spot.
      let best = null, bestN = 0;
      for (const h of heat) { const n = heat.filter((o) => Math.hypot(o.x - h.x, o.y - h.y) < 420).length; if (n > bestN) { bestN = n; best = h; } }
      const near = heat.filter((o) => Math.hypot(o.x - best.x, o.y - best.y) < 420);
      goal = { x: near.reduce((t, o) => t + o.x, 0) / near.length, y: near.reduce((t, o) => t + o.y, 0) / near.length, n: bestN };
      if (bestN >= 4) lastFight = now;
    } else if (now - lastFight > 4000) goal = null;
  }
  setInterval(look, 200);
  let lastFrame = performance.now();
  function frame() {
    const now = performance.now(), dt = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
    const target = goal ?? fallback;
    if (target) {
      const dx = target.x - g.cam.x, dy = target.y - g.cam.y, d = Math.hypot(dx, dy);
      if (d > 1400) { g.cam.x = target.x; g.cam.y = target.y; vel.x = vel.y = 0; } // a cut, not a long pan
      else { // critically damped spring
        const k = 7;
        vel.x += (dx * k * k - 2 * k * vel.x) * dt; vel.y += (dy * k * k - 2 * k * vel.y) * dt;
        g.cam.x += vel.x * dt * 0.35; g.cam.y += vel.y * dt * 0.35;
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  window.__dir = {
    state: () => ({ fight: performance.now() - lastFight < 4000, heat: heat.length }),
    reset: () => { hp.clear(); heat = []; goal = null; lastFight = -1e9; },
    setFallback: (p) => { fallback = p; },
    // Where the armies are: per side, the centre of its moving combat units, and its base (buildings' centre).
    sides() {
      const s = g.client.cur; if (!s) return [];
      const out = {};
      for (const a of s.actors) {
        if (a.owner === 0 || a.maxHp <= 0) continue;
        const o = (out[a.owner] ??= { units: [], buildings: [] });
        (a.bw > 60 && a.bh > 40 ? o.buildings : o.units).push(a);
      }
      const c = (l) => l.length ? { x: l.reduce((t, a) => t + a.sx, 0) / l.length, y: l.reduce((t, a) => t + a.sy, 0) / l.length, n: l.length } : null;
      return Object.values(out).map((o) => ({ army: c(o.units), base: c(o.buildings) }));
    },
  };
}, { A, B, nameA: factionName(A), nameB: factionName(B), mapTitle, label, sub });

// The overlay's numbers at a tick, from the scored match's timeline (sampled every ~10 game seconds): army value and
// money interpolated, losses stepped.
const tl = scored.timeline;
function statsAt(tick) {
  const i = Math.max(0, tl.findLastIndex((e) => e.tick <= tick));
  const e0 = tl[i], e1 = tl[Math.min(tl.length - 1, i + 1)];
  const f = e1.tick > e0.tick ? Math.min(1, Math.max(0, (tick - e0.tick) / (e1.tick - e0.tick))) : 0;
  return { tick, timestep: 40, players: [0, 1].map((k) => {
    const a = e0.p[k], b = e1.p[k], lerp = (j) => Math.round(a[j] + (b[j] - a[j]) * f);
    return { army: [lerp(0)], killsCost: lerp(1), deathsCost: a[2], unitsDead: a[3], buildingsDead: a[4], earned: lerp(5) };
  }) };
}
const setSpeed = (v) => page.evaluate((v) => window.game.client.send({ type: "speed", speed: v }), v);
const tickNow = () => page.evaluate(() => window.game.client.cur?.header.tick ?? 0);
const timeline = [];
let speed = quietSpeed, stats = null, fightOn = false, lastPick = 0, pick = 0;
// Recording pauses while the film skips ahead; it comes back with a fade and the time jumped.
let quietSince = Date.now(), skipping = false, skipFrom = 0;
const pauseRecording = (gs) => { skipping = true; recording = false; skipFrom = gs; };
async function resumeRecording(gs) {
  await sleep(300); // the camera has cut to its subject
  clock = null; recording = true; skipping = false;
  await page.evaluate((s) => window.__evo.resume(s), Math.round(gs - skipFrom));
  timeline.push({ wall: (Date.now() - t0) / 1000, game: Math.round(gs), event: "resume", skipped: Math.round(gs - skipFrom) });
}
/** No fight on screen: every 6 s of real time the camera visits the bigger army on the move, else alternates the bases. */
async function idleCamera() {
  if (fightOn || Date.now() - lastPick <= 6000) return;
  lastPick = Date.now();
  const sides = await page.evaluate(() => window.__dir.sides());
  const armies = sides.filter((s) => s.army && s.army.n >= 3).sort((p, q) => q.army.n - p.army.n);
  const spot = pick++ % 3 === 2 && armies.length ? armies[0].army : sides[pick % Math.max(1, sides.length)]?.base ?? armies[0]?.army;
  if (spot) await page.evaluate((p) => window.__dir.setFallback(p), spot);
}
/** The overlay at the current tick; returns the tick, the page phase and whether a fight is on screen. */
async function step() {
  const tick = await tickNow();
  stats = statsAt(tick);
  const st = await page.evaluate(() => ({ phase: window.store.getState().phase, dir: window.__dir.state() }));
  await page.evaluate(({ stats, speed, fight }) => window.__evo.update(stats, speed, fight), { stats, speed, fight: st.dir.fight });
  if (st.phase !== "playing") errors.push({ kind: "phase", text: st.phase });
  return { tick, gs: tick * 0.04, phase: st.phase, fight: st.dir.fight };
}
async function endCard() {
  log("end of replay; scored winner", scored.winner);
  await setSpeed(1);
  await page.evaluate((stats) => window.__evo.end(stats), { tick: replay.tick, timestep: 40, players: scored.players });
  await sleep(5000);
}

/** The whole match: battles at the battle speed, quiet stretches time-lapsed briefly, then skipped. */
async function filmFull() {
  await setSpeed(speed);
  await page.evaluate(() => window.game.setPaused(false));
  await sleep(800);
  recording = true;
  for (;;) {
    await sleep(500);
    const s = await step();
    if (s.fight !== fightOn) {
      fightOn = s.fight;
      speed = fightOn ? battleSpeed : quietSpeed;
      await setSpeed(speed);
      timeline.push({ wall: (Date.now() - t0) / 1000, game: Math.round(s.gs), event: fightOn ? "battle" : "quiet" });
      if (fightOn && skipping) await resumeRecording(s.gs);
      if (!fightOn) quietSince = Date.now();
    }
    if (!fightOn && !skipping && Date.now() - quietSince > quietRecord * 1000) { pauseRecording(s.gs); timeline.push({ wall: (Date.now() - t0) / 1000, game: Math.round(s.gs), event: "skip" }); }
    if (skipping && s.gs - skipFrom > 240) { await resumeRecording(s.gs); quietSince = Date.now(); }
    await idleCamera();
    if (s.phase !== "playing") { log("phase", s.phase); break; }
    if (s.tick >= replay.tick - 1) { if (skipping) await resumeRecording(s.gs); await endCard(); break; }
  }
}

/**
 * Highlights: the opening, then the match's biggest fights (the windows of the scored match where the most value was
 * destroyed, from its stats timeline), then the final assault and the result. Between them the replay restarts at the
 * next window (the game's own replay seek, which rebuilds the world without drawing it) and the film shows the time
 * jumped.
 */
async function filmHighlights() {
  const W = Math.round(Number(opt("window", 50)) * 25); // ticks per window
  const lead = 5 * 25; // the fight is found and framed this long before the window
  const maxWindows = Number(opt("windows", 4));
  const end = replay.tick;
  const destroyed = tl.map((e, i) => (i === 0 ? 0 : e.p[0][2] + e.p[1][2] - tl[i - 1].p[0][2] - tl[i - 1].p[1][2]));
  const valueOf = (from) => tl.reduce((v, e, i) => (e.tick > from && e.tick <= from + W ? v + destroyed[i] : v), 0);
  const finalFrom = Math.max(0, end - W);
  // The best fight in each stretch of the match before the final assault (the story, not only its biggest late fights).
  const picks = [];
  const span = Math.max(0, finalFrom - W * 1.5 - lead);
  for (let k = 0; k < maxWindows; k++) {
    const lo = lead + (span * k) / maxWindows, hi = lead + (span * (k + 1)) / maxWindows;
    let best = null, bestV = 0;
    for (const e of tl) {
      const t = e.tick;
      if (t < lo || t >= hi || picks.some((p) => Math.abs(p - t) < W * 1.2)) continue;
      const v = valueOf(t);
      if (v > bestV) { bestV = v; best = t; }
    }
    if (best !== null && bestV >= 1000) picks.push(best); // under $1,000 destroyed is a skirmish, not a highlight
  }
  const windows = [...picks.sort((a, b) => a - b).map((t) => ({ from: t, to: t + W })), { from: finalFrom, to: end, final: true }];
  timeline.push({ event: "plan", windows: windows.map((w) => ({ from: Math.round(w.from * 0.04), to: Math.round(w.to * 0.04), value: w.final ? null : valueOf(w.from) })) });
  log("windows", windows.map((w) => `${Math.round(w.from * 0.04)}-${Math.round(w.to * 0.04)}s`).join(" "));

  // The opening: the bases deploy, time-lapsed.
  speed = quietSpeed;
  await setSpeed(speed);
  await page.evaluate(() => window.game.setPaused(false));
  await sleep(600);
  recording = true;
  const openingUntil = Date.now() + Number(opt("opening", 5)) * 1000;
  while (Date.now() < openingUntil) { await sleep(400); await idleCamera(); await step(); }
  pauseRecording((await tickNow()) * 0.04);

  for (const w of windows) {
    const start = Math.max(0, w.from - lead);
    const now = await tickNow();
    if (start > now && start - now < 25 * 60) {
      // Close by: fast-forward unrecorded.
      await setSpeed(8);
      while ((await tickNow()) < start) await sleep(100);
    } else if (start > now || start < now - 25 * 5) {
      // Far: restart the replay there (rebuilt without drawing), as the replay's own seek does.
      await page.evaluate(({ scenario, log, end, tick }) => window.game.start(JSON.stringify({ ...scenario, webReplay: { log, tick, readonly: true, end } }), true),
        { scenario, log: replay.log, end, tick: start });
      await page.waitForFunction((t) => window.store.getState().phase === "playing" && (window.game.client.cur?.header.tick ?? 0) >= t - 1, start, { timeout: 900000, polling: 250 });
      await page.evaluate(() => window.__dir.reset());
    }
    // Frame the fight during the lead, then record the window.
    speed = battleSpeed;
    await setSpeed(speed);
    await page.evaluate(() => window.game.setPaused(false));
    while ((await tickNow()) < w.from - 25) { await sleep(150); await step(); }
    const s0 = await step();
    await resumeRecording(s0.gs);
    for (;;) {
      await sleep(400);
      const s = await step();
      fightOn = s.fight;
      await idleCamera();
      if (s.phase !== "playing") { log("phase", s.phase); return; }
      if (s.tick >= Math.min(w.to, end - 1)) break;
    }
    if (w.final) { await endCard(); return; }
    pauseRecording((await tickNow()) * 0.04);
  }
}

/** One fight for a reel: --at <game seconds> for --window game seconds, framed during a short lead, no cards. */
async function filmClip() {
  const from = Math.round(Number(opt("at")) * 25), to = Math.min(replay.tick - 1, from + Math.round(Number(opt("window", 30)) * 25));
  const start = Math.max(0, from - 6 * 25);
  if (start > 0) {
    log("clip: rebuilding the replay at tick", start);
    await page.evaluate(({ scenario, log, end, tick }) => window.game.start(JSON.stringify({ ...scenario, webReplay: { log, tick, readonly: true, end } }), true),
      { scenario, log: replay.log, end: replay.tick, tick: start });
    await page.waitForFunction((t) => window.store.getState().phase === "playing" && (window.game.client.cur?.header.tick ?? 0) >= t - 1, start, { timeout: 900000, polling: 250 });
    await page.evaluate(() => window.__dir.reset());
    log("clip: rebuilt at tick", await tickNow());
  }
  speed = battleSpeed;
  await setSpeed(speed);
  await page.evaluate(() => window.game.setPaused(false));
  // The replay advances from here; a stall (paused or ended) must not hang the film.
  let lastTick = await tickNow(), stalledSince = Date.now();
  while ((await tickNow()) < from - 25) {
    await sleep(150); await step();
    const t = await tickNow();
    if (t !== lastTick) { lastTick = t; stalledSince = Date.now(); }
    else if (Date.now() - stalledSince > 20000) throw new Error(`clip: the replay stopped advancing at tick ${t} (phase ${await page.evaluate(() => window.store.getState().phase)}, paused ${await page.evaluate(() => window.store.getState().paused)})`);
  }
  log("clip: recording from tick", await tickNow());
  clock = null; recording = true;
  for (;;) {
    await sleep(300);
    const s = await step();
    fightOn = s.fight;
    await idleCamera();
    if (s.phase !== "playing" || s.tick >= to) break;
  }
}

await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, everyNthFrame: 1 });
const mode = opt("mode", "highlights");
if (mode === "full") await filmFull(); else if (mode === "clip") await filmClip(); else await filmHighlights();
await cdp.send("Page.stopScreencast");
recording = false;
if (last) await write(last);
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
const result = { a: A, b: B, map, seed, bot, winner: scored.winner, gameSeconds: scored.gameSeconds,
  wallSeconds: Math.round((Date.now() - t0) / 1000), video: file, videoSeconds: +(written / FPS).toFixed(1), longestFrameGapMs: Math.round(longestGap),
  timeline, errors };
fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(result, null, 1));
console.log("RESULT " + JSON.stringify({ ...result, timeline: timeline.length }));
await browser.close();
