// Films a finished Arena game from its replay, for the experiment notebook and the owner's talks. The live game's own
// replay viewer plays the recorded orders; captions show what the brain decided as it happened (its decision log).
// Two passes over the same replay, since a snapshot only carries the actors in view:
//   1. "map": the whole battlefield as a timelapse. It also notes where the fighting is, second by second;
//   2. "fight": a closer camera that follows that track.
//   node tools/arena/film.mjs <game id> [--dir <arena data>] [--shots map,fight] [--speed 8] [--to <game s>] [--runner <url>]
// Films go to <arena data>/films/<game id>-<shot>.mp4, with a .jpg poster and <game id>-track.json. Needs the Arena
// runner (it serves the live game's twin page) and ffmpeg.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scenarioFor } from "./match.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const dir = opt("dir", path.join(process.env.LOCALAPPDATA ?? os.homedir(), "RTSAI-WebGame", "arena"));
const id = argv[0];
const shots = opt("shots", "map,fight").split(",");
const speed = Number(opt("speed", 8));
const to = opt("to") ? Number(opt("to")) : null;
// The runner whose twin page plays the replay: the main one, or a second runner beside it (RTSAI_ARENA_PORT).
const runner = opt("runner", "http://127.0.0.1:3463");
const TPS = 25;

const games = fs.readFileSync(path.join(dir, "games.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const game = games.find((g) => g.id === id);
if (!game) throw new Error(`no game ${id}`);
const replay = JSON.parse(fs.readFileSync(path.join(dir, "replays", `${id}.json`), "utf8"));
const decisions = JSON.parse(fs.readFileSync(path.join(dir, "decisions", `${id}.json`), "utf8"));
// Replays before 24 Oct kept the Arena's spec under "scenario"; newer ones keep the game's scenario and the spec.
const spec = replay.spec ?? replay.scenario;
const endTick = Math.min(replay.tick, to !== null ? to * TPS : Infinity);

const status = await fetch(`${runner}/status`).then((r) => r.json()).catch(() => null);
if (!status?.ready) throw new Error("Start the Arena runner first (node tools/arena/server.mjs): it serves the live game's twin page.");
if (game.page?.release && status.page?.release && game.page.release !== status.page.release)
  console.warn(`warning: the game was played on release ${game.page.release}; the runner serves ${status.page.release}. The replay may drift.`);

/** What the brain did, as captions: builds and trainings, army choices, and what each army turn saw. */
const ARMY = { attack: "Army attacks the enemy base", defend: "Army defends the base", scout: "Sends a scout", sweep: "Army sweeps toward the enemy side" };
const events = [], seen = [];
for (const d of decisions) {
  for (const q of d.questions ?? []) {
    if (!q.choice || q.choice === "wait" || q.choice === "hold") continue;
    const label = q.options?.find((o) => o.value === q.choice)?.label ?? q.choice;
    const text = q.name === "army" ? ARMY[q.choice] ?? q.choice : `${q.name === "build" || q.name === "defense" ? "Builds" : "Trains"} ${label}`;
    if (events.at(-1)?.text === text && d.tick - events.at(-1).tick < 25 * 20) continue;
    events.push({ tick: d.tick, text, kind: q.name === "army" ? q.choice : "make" });
  }
  if (d.seen) seen.push({ tick: d.tick, text: d.seen });
}
const brainLabel = game.brain === "decision" ? `Decision brain · ${game.provider}${game.version ? ` · ${game.version}` : ""}` : game.brain;
const title = `${brainLabel} — ${game.ours} vs ${game.opponent} AI (${game.theirs}) · seed ${game.seed}`;
const resultText = `${game.result === "win" ? "Win" : game.result === "loss" ? "Loss" : game.result === "draw" ? "Draw" : game.result} at ${Math.floor(game.gameSeconds / 60)}:${String(game.gameSeconds % 60).padStart(2, "0")}`;

const { chromium } = await import(pathToFileURL(path.join(repo, "web", "node_modules", "playwright-core", "index.mjs")).href);
const msPlaywright = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
const chrome = (fs.existsSync(msPlaywright) ? fs.readdirSync(msPlaywright) : []).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
  .map((d) => path.join(msPlaywright, d, "chrome-win64", "chrome.exe")).find((f) => fs.existsSync(f));
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "--mute-audio"] });
const out = path.join(dir, "films");
fs.mkdirSync(out, { recursive: true });
const trackFile = path.join(out, `${id}-track.json`);
const SIZES = { map: { width: 1600, height: 900 }, fight: { width: 1280, height: 720 } };

async function film(shot, track) {
  const size = SIZES[shot];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arena-film-"));
  const context = await browser.newContext({ viewport: size, recordVideo: { dir: tmp, size } });
  const page = await context.newPage();
  const t0 = Date.now();
  await page.goto(`${status.pageUrl}?profile=public&mode=skirmish`);
  await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 300000, polling: 500 });
  const defaults = await page.evaluate(() => Object.fromEntries((window.store.getState().setup.options ?? []).map((o) => [o.id, o.default])));
  // The explored map lifts the black shroud for the camera. Fog stays, so what each side can see (and shoot) is as it
  // was, and the replay plays out the same.
  const scenario = { ...(replay.spec ? replay.scenario : scenarioFor(spec, defaults)) };
  scenario.options = { ...scenario.options, explored: "True" };
  await page.evaluate(([s, log, end]) => window.game.start(JSON.stringify({ ...s, webReplay: { log, tick: 0, readonly: true, end } }), true), [scenario, replay.log, replay.tick]);
  await page.waitForFunction(() => ["playing", "error"].includes(window.store.getState().phase), null, { timeout: 300000, polling: 250 });
  // The director: keeps the camera on its shot, notes the fighting (map shot) and draws the captions.
  await page.evaluate(([shot, film]) => {
    const g = window.game, info = g.info, b = info.bounds;
    const center = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    const W = innerWidth, H = innerHeight;
    const mapZoom = Math.min(W / (b[2] - b[0]), H / (b[3] - b[1])) * 1.02;
    const track = film.track ?? {};
    let snap = null, last = new Map(), us = -1;
    const orig = g.client.onSnapshot;
    g.client.onSnapshot = (s) => {
      snap = s; window.__tick = s.header.tick; orig(s);
      if (us < 0) { let best = 1e9; s.players.forEach((p, i) => { const c = (p.color >>> 0) & 0xffffff, d = Math.abs(((c >> 16) & 255) - 0x4f) + Math.abs(((c >> 8) & 255) - 0x80) + Math.abs((c & 255) - 0xff); if (d < best) { best = d; us = i; } }); }
      if (us >= 0 && s.players[us]) window.__ending = s.players[us].winState;
      if (shot !== "map") return;
      const sec = Math.floor(s.header.tick / film.tps), row = (track[sec] ??= { hot: [0, 0, 0], ours: [0, 0, 0], theirs: [0, 0, 0] });
      const now = new Map();
      for (const a of s.actors) {
        if (a.flags & 16) continue;
        now.set(a.id, a.hp);
        const was = last.get(a.id);
        if (was !== undefined && a.hp < was) { row.hot[0] += a.sx; row.hot[1] += a.sy; row.hot[2]++; }
        if (!(a.flags & 8) && a.maxHp > 0) { const side = a.owner === us ? row.ours : row.theirs; side[0] += a.sx; side[1] += a.sy; side[2]++; }
      }
      last = now;
    };
    window.__track = track;
    const cam = { x: center[0], y: center[1] };
    const aim = (sec) => {
      for (let k = 0; k <= 4; k++) { const r = track[sec - k]; if (r?.hot[2] >= 2) return [r.hot[0] / r.hot[2], r.hot[1] / r.hot[2]]; }
      const r = track[sec]; if (r?.ours[2]) return [r.ours[0] / r.ours[2], r.ours[1] / r.ours[2]];
      return center;
    };
    // Captions.
    const css = document.createElement("style");
    css.textContent = `#fo{position:fixed;left:18px;top:72px;z-index:2147483647;pointer-events:none;font:500 15px system-ui,sans-serif;color:#fff;text-shadow:0 1px 3px #000}
      #fo .t{font-size:13px;opacity:.9;max-width:${W - 300}px}#fo .c{font-size:30px;margin-top:2px}#fo .e{margin-top:8px;display:flex;flex-direction:column;gap:5px}
      #fo .e div{background:rgba(10,14,20,.62);border-radius:6px;padding:4px 10px;width:max-content;max-width:560px;transition:opacity .4s}
      #fo .e .attack{border-left:3px solid #ff6b5a}#fo .e .defend{border-left:3px solid #ffc04d}#fo .e .scout,#fo .e .sweep{border-left:3px solid #6bd0ff}#fo .e .make{border-left:3px solid #8fd18a}
      #fo .s{margin-top:8px;font-size:13px;background:rgba(10,14,20,.5);border-radius:6px;padding:4px 10px;width:max-content;max-width:640px}
      #fe{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:2147483647;pointer-events:none;font:500 64px system-ui,sans-serif;color:#fff;text-shadow:0 2px 8px #000;opacity:0;transition:opacity .8s}`;
    document.head.append(css);
    const box = document.createElement("div"); box.id = "fo";
    box.innerHTML = `<div class="t"></div><div class="c"></div><div class="e"></div><div class="s"></div>`;
    const endCard = document.createElement("div"); endCard.id = "fe"; endCard.textContent = film.result;
    document.body.append(box, endCard);
    box.querySelector(".t").textContent = film.title;
    const clock = (t) => `${Math.floor(t / film.tps / 60)}:${String(Math.floor(t / film.tps) % 60).padStart(2, "0")}`;
    const draw = () => {
      if (snap) {
        const tick = snap.header.tick;
        box.querySelector(".c").textContent = clock(tick);
        const recent = film.events.filter((e) => e.tick <= tick && tick - e.tick < film.tps * 40).slice(-5);
        box.querySelector(".e").innerHTML = recent.map((e) => `<div class="${e.kind}">${clock(e.tick)} · ${e.text.replace(/[<>&]/g, "")}</div>`).join("");
        const s = film.seen.filter((x) => x.tick <= tick).at(-1);
        box.querySelector(".s").textContent = s ? `Brain sees: ${s.text}` : "";
        endCard.style.opacity = tick >= film.end - film.tps * 2 ? "1" : "0";
        if (shot === "map") { g.cam.zoom = mapZoom; if (g.cam.x !== center[0] || g.cam.y !== center[1]) g.lookAt(center[0], center[1]); }
        else {
          const [tx, ty] = aim(Math.floor(tick / film.tps));
          cam.x += (tx - cam.x) * 0.05; cam.y += (ty - cam.y) * 0.05;
          g.cam.zoom = 0.8; g.lookAt(cam.x, cam.y);
        }
      }
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  }, [shot, { title, result: resultText, events, seen, end: endTick, tps: TPS, track }]);
  // The viewer's own speed buttons, so its transport bar shows the speed too.
  await page.locator("button", { hasText: new RegExp(`^${speed}\\s*[x×]$`) }).first().click({ timeout: 10000 }).catch(() => page.evaluate((v) => window.game.client.send({ type: "speed", speed: v }), speed));
  await page.evaluate(() => window.game.setPaused(false));
  const startedMs = Date.now() - t0;
  let tick = 0, stuck = 0, lastTick = -1;
  while (tick < endTick + TPS * 3) {
    await new Promise((r) => setTimeout(r, 500));
    tick = await page.evaluate(() => window.__tick ?? 0).catch(() => tick);
    stuck = tick === lastTick ? stuck + 1 : 0; lastTick = tick;
    if (stuck > 40) { console.warn(`${shot}: the replay stopped at tick ${tick} of ${endTick}`); break; }
  }
  const result = shot === "map" ? await page.evaluate(() => window.__track) : null;
  // A faithful replay ends as the game did: our side's win state at the last tick (0 undecided, 1 won, 2 lost).
  const ending = await page.evaluate(() => window.__ending ?? null).catch(() => null);
  if (ending !== null) console.log(`${shot}: replay ends with our win state ${ending}; the game was a ${game.result}`);
  const video = page.video();
  await context.close();
  const webm = await video.path();
  const mp4 = path.join(out, `${id}-${shot}.mp4`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(startedMs / 1000), "-i", webm, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]);
  const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4]).toString().trim());
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(Math.max(0, duration * 0.6)), "-i", mp4, "-frames:v", "1", "-q:v", "3", mp4.replace(/\.mp4$/, ".jpg")]);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${shot}: ${mp4} (${Math.round(duration)} s)`);
  return result;
}

let track = fs.existsSync(trackFile) ? JSON.parse(fs.readFileSync(trackFile, "utf8")) : null;
try {
  for (const shot of shots) {
    if (shot === "fight" && !track) track = await film("map", null);
    const t = await film(shot, track);
    if (shot === "map" && t) { track = t; fs.writeFileSync(trackFile, JSON.stringify(t)); }
  }
} finally { await browser.close(); }
