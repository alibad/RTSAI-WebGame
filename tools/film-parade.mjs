// A country's parade in the real web game, for reviewing how its units and buildings look and sound at normal zoom
// (1x). Every unit of the roster is selected (its voice), walks a short dog-leg (its facings), is ordered to fire at a
// target it can hit (weapon sound, flash, projectile) and is destroyed (death animation or explosion); then the
// country's buildings are shown standing and are brought down. One take per row of units; the takes are joined.
//
// It films a page that is already being served (the release tool's smoke page of the live build, or any local build)
// in headless Chromium: the frames are the page's own (CDP screencast), the sound is the game's effects bus (unit
// voices, weapons, explosions, announcer), tapped in the page. Nothing here is drawn by the engine differently: only
// a caption, a name tag under each unit and the HUD being hidden are the film's own.
//
//   node tools/film-parade.mjs --base http://127.0.0.1:3590/ --out <dir> [--factions iran,germany:tnkd+mtnk+e1] [--rows infantry,vehicles,ships,defenses,buildings]
//        [--units tnkd,mtnk] [--map web-arena] [--crf 22] [--keep-takes] [--cold-audio [--settle 15000]]
// Writes <out>/<faction>.mp4 (H.264 + AAC, 1280x720, 30 fps) and <out>/<faction>.json: per unit, what was heard and
// seen (voices on select and on orders, shots counted by the engine, distinct facings, body sequences, death).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { browserArgs, browserExecutable } from "./browser-launch.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(pathToFileURL(process.env.RTSAI_PLAYWRIGHT_MODULE ?? path.join(repo, "web/node_modules/playwright-core/index.mjs")).href);
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);
const base = opt("base", "http://127.0.0.1:3590/");
const out = path.resolve(opt("out", "parade"));
const crf = opt("crf", "22");
// --settle <ms>: wait this long after each battle is built, before the camera rolls (with --cold-audio, the time a
// page's own background sound fetch gets, as a match gets while the player sets up a base).
const settle = Number(opt("settle", "0"));
// --note "text": a label in the middle of the frame for the whole film (which build this is, in a before/after pair).
const note = opt("note", "");
const onlyRows = opt("rows", "")?.split(",").filter(Boolean);
const unitsForAll = opt("units", "")?.split(",").filter(Boolean); // a short parade of just these roster units
const W = 1280, H = 720, FPS = 30;
fs.mkdirSync(out, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------- the stage
// Land rows stand on Web Arena (plain grass, the simulator's own default battlefield): nothing but the units to look
// at. The navy sails Little Big Lake. Cells are map cells (u, v); a cell's screen px is x = 30 + (2u + (v & 1)) * 30,
// y = 15 + v * 15, so two v rows are one cell down the screen and the 1280 x 720 view is 21 cells by 48 v rows.
const STAGES = {
  land: { map: opt("map", "web-arena"), centre: null /* the map's middle */ },
  // The same grass with four player slots: a row that stands beside Westwood's originals needs a third, allied player
  // to own them (an original unit owned by a modern country is drawn and voiced with the modern stand-ins).
  land4: { map: "web-arena-four", centre: null },
  water: { map: "ra2-little-big-lake", centre: { u: 20, v: 70 }, power: { u: 8, v: 126 }, keep: { u: 10, v: 20 }, shore: { u: 29, v: 72 }, yard: { u: 14, v: 55 } },
};

// Who brings a row down, spawned beside it at the end (elite, the other side's): machine guns for infantry (the
// plain death), heavy tanks for anything with armour or walls, destroyers at sea.
const KILLERS = { infantry: "gapill", vehicles: "apoc", defenses: "apoc", buildings: "apoc", ships: "dest" };

const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true,
  args: [...browserArgs(), "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--hide-scrollbars"] });
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, locale: "en-US" });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => { pageErrors.push(String(e).slice(0, 300)); log("pageerror", String(e).slice(0, 200)); });
if (["127.0.0.1", "localhost"].includes(new URL(base).hostname)) {
  // A local film must not write to production (analytics, feedback): reads only, anywhere else.
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(u.hostname) || ["blob:", "data:"].includes(u.protocol) || ["GET", "HEAD"].includes(route.request().method())
      ? route.continue() : route.abort();
  });
}
// The web game fetches each sound file the first time it is needed and skips that first play (worker.ts: only the
// announcer and the interface sounds are fetched ahead). A parade would be half silent for that reason alone, so the
// film asks for every sound except music ahead, by widening that one filter in the worker on its way to the browser:
// the film then sounds like a session in which each sound has been needed once. --cold-audio films the page as it is.
let audioFiles = 0, audioLast = Date.now();
page.on("requestfinished", (r) => { if (/\/audio\//.test(r.url())) { audioFiles++; audioLast = Date.now(); } });
if (!flag("cold-audio")) {
  await page.route(/\/assets\/worker-[^/]+\.js$/, async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const patched = body.replace(/\.filter\((\w+)=>\1\.includes\(`\/eva\/\$\{\w+\}\/`\)\|\|\1\.includes\("\/audio\/ui\/"\)\)/, '.filter($1=>!$1.includes("/music/"))');
    if (patched === body) log("WARNING: the worker's audio prefetch filter was not found; sounds will be skipped on first play");
    await route.fulfill({ response, body: patched });
  });
}
// --pack <file>: the page's data bundle (public/web-bundle.pack) is answered from this file: a copy of the live
// bundle with a rules change under test, so a proposed rules fix can be filmed on the live build before any data build.
const packFile = opt("pack", "");
if (packFile) {
  const body = fs.readFileSync(packFile);
  await page.route(/\/public\/web-bundle\.pack(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: "application/octet-stream",
    headers: { "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" }, body }));
  log(`data bundle answered from ${packFile}`);
}
const cdp = await context.newCDPSession(page);

await page.goto(`${base}?profile=public&mode=simulator&private=0`);
await page.waitForFunction(() => window.store?.getState().sandbox?.units?.length > 0 && window.store.getState().phase === "playing", null, { timeout: 600000 });
const catalog = await page.evaluate(() => { const s = window.store.getState().sandbox; return { units: s.units, rosters: s.rosters }; });
const unitOf = Object.fromEntries(catalog.units.map((u) => [u.name, u]));
// --factions iran,germany:tnkd+mtnk+e1 : a country alone is its whole roster; with ":unit+unit" only those units.
const wanted = (opt("factions", "") || Object.keys(catalog.rosters).join(",")).split(",").filter(Boolean).map((f) => { const [faction, units] = f.split(":"); return { faction, units: units ? units.split("+") : unitsForAll }; });
log(`page ready: ${catalog.units.length} units, ${Object.keys(catalog.rosters).length} countries; filming ${wanted.map((w) => w.faction).join(", ")}`);

// The film's own layer: caption, name tags, the audio log and the sound tap.
await page.evaluate((note) => {
  const css = document.createElement("style");
  css.textContent = `
    :root,.fixed.inset-0{--sidebar-w:0px !important}
    #parade-caption{position:fixed;left:18px;top:14px;z-index:2147483000;display:flex;align-items:center;gap:10px;padding:7px 12px 7px 8px;border-radius:9px;
      background:rgba(10,12,16,.72);color:#fff;font:600 17px/1.1 system-ui,Segoe UI,sans-serif;letter-spacing:.01em;pointer-events:none}
    #parade-caption img{height:22px;border-radius:3px;display:block}
    #parade-caption .row{font-weight:500;opacity:.85}
    #parade-note{position:fixed;left:50%;top:150px;transform:translateX(-50%);z-index:2147483000;padding:6px 14px;border-radius:9px;background:rgba(233,180,60,.95);
      color:#111;font:700 17px/1.2 system-ui,Segoe UI,sans-serif;white-space:nowrap;pointer-events:none}
    #parade-caption .step{margin-left:6px;padding:3px 8px;border-radius:6px;background:#e9644b;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
    .parade-tag{position:fixed;z-index:2147482999;transform:translate(-50%,0);padding:1px 6px;border-radius:5px;background:rgba(10,12,16,.62);color:#fff;
      font:500 11px/1.35 system-ui,Segoe UI,sans-serif;white-space:nowrap;pointer-events:none;transition:opacity .5s}
    .parade-tag.ref{background:rgba(233,180,60,.88);color:#111}
    .parade-tag.cloaks{outline:1px dashed rgba(255,255,255,.85);outline-offset:-1px}
    .parade-tag.gone{opacity:.35}
    .parade-tag.aside{opacity:0;transition:none}`;
  document.head.appendChild(css);
  const cap = document.createElement("div");
  cap.id = "parade-caption";
  cap.style.display = "none";
  document.body.appendChild(cap);
  if (note) { const n = document.createElement("div"); n.id = "parade-note"; n.textContent = note; document.body.appendChild(n); }
  const P = window.__parade = { tags: new Map(), audio: [], cap, t: () => performance.timeOrigin + performance.now() };
  P.caption = (flag, country, row, step) => {
    cap.style.display = country ? "flex" : "none";
    cap.innerHTML = `${flag ? `<img src="flags/${flag}.svg" alt="">` : ""}<span>${country ?? ""}</span><span class="row">${row ?? ""}</span>${step ? `<span class="step">${step}</span>` : ""}`;
  };
  P.setTags = (list) => { // [{id, label, ref}]
    for (const t of P.tags.values()) t.el.remove();
    P.tags.clear();
    for (const t of list) {
      const el = document.createElement("div");
      el.className = "parade-tag" + (t.ref ? " ref" : "") + (t.cloaks ? " cloaks" : "");
      el.textContent = t.label;
      document.body.appendChild(el);
      P.tags.set(t.id, { el, x: 0, y: 0, dy: t.dy ?? 26 });
    }
  };
  /** Shows only this unit's name (null: every name). */
  P.focus = (id) => { for (const [k, t] of P.tags) t.el.classList.toggle("aside", id != null && k !== id); };
  const place = () => {
    const g = window.game, s = g?.client?.cur;
    if (s && P.tags.size) {
      const seen = new Set();
      for (const a of s.actors) {
        const t = P.tags.get(a.id);
        if (!t) continue;
        seen.add(a.id);
        const [x, y] = g.toClient(a.sx, a.sy + (a.worldZ > 0 ? 0 : 0));
        t.x = x; t.y = y + t.dy;
        t.el.style.left = `${Math.round(t.x)}px`; t.el.style.top = `${Math.round(t.y)}px`;
        t.el.classList.toggle("gone", (a.flags & 16) !== 0 || a.hp <= 0);
      }
      for (const [id, t] of P.tags) if (!seen.has(id)) t.el.classList.add("gone");
    }
    requestAnimationFrame(place);
  };
  requestAnimationFrame(place);
  // Every sound the engine asks the page to play (source ids; relative = not placed on the battlefield).
  window.game.client.on("audio", (m) => { if (m.op === "play") P.audio.push({ t: P.t(), source: m.source, relative: m.relative, x: m.x, y: m.y, volume: m.volume }); });
  P.startTap = () => {
    const a = window.game.audio, ctx = a.context();
    if (ctx.state === "suspended") void ctx.resume();
    const tap = ctx.createScriptProcessor(4096, 2, 2);
    const left = [], right = [];
    tap.onaudioprocess = (e) => { if (!left.length) P.tap.startEpoch = performance.timeOrigin + performance.now() - 1000 * e.inputBuffer.length / ctx.sampleRate; left.push(new Float32Array(e.inputBuffer.getChannelData(0))); right.push(new Float32Array(e.inputBuffer.getChannelData(1))); };
    const sink = ctx.createGain();
    sink.gain.value = 0;
    a.buses.sfx.connect(tap);
    tap.connect(sink).connect(ctx.destination);
    P.tap = { tap, left, right, rate: ctx.sampleRate, state: ctx.state, startEpoch: performance.timeOrigin + performance.now() };
    return ctx.state;
  };
  P.stopTap = () => {
    const s = P.tap;
    window.game.audio.buses.sfx.disconnect(s.tap);
    s.tap.disconnect();
    const n = s.left.reduce((k, c) => k + c.length, 0);
    const pcm = new Int16Array(n * 2);
    let o = 0, peak = 0;
    for (let i = 0; i < s.left.length; i++) {
      const l = s.left[i], r = s.right[i];
      for (let k = 0; k < l.length; k++) {
        peak = Math.max(peak, Math.abs(l[k]), Math.abs(r[k]));
        pcm[o++] = Math.max(-32767, Math.min(32767, l[k] * 32767)); pcm[o++] = Math.max(-32767, Math.min(32767, r[k] * 32767));
      }
    }
    const bytes = new Uint8Array(pcm.buffer);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return { b64: btoa(bin), rate: s.rate, startEpoch: s.startEpoch, peak };
  };
}, note);

// ---------------------------------------------------------------------------------------------------- recording
function recorder(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const frames = [];
  let on = false;
  const handler = async (f) => {
    if (on) {
      const name = `f${String(frames.length).padStart(6, "0")}.jpg`;
      fs.writeFileSync(path.join(dir, name), Buffer.from(f.data, "base64"));
      frames.push({ t: f.metadata.timestamp * 1000, name });
    }
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  };
  cdp.on("Page.screencastFrame", handler);
  return {
    frames,
    async start() { on = true; await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, everyNthFrame: 1 }); },
    async stop() { await cdp.send("Page.stopScreencast"); on = false; cdp.off("Page.screencastFrame", handler); },
  };
}

/**
 * One take: constant 30 fps H.264 from the timestamped frames, with the tapped sound laid under it at its own time.
 * `lens`: [{ t (epoch ms), x, y (frame px) }]: while a unit is being selected, a 3x enlargement of it (exact pixels,
 * no smoothing) sits in the top right corner, so the art can be judged close up and at 1x in the same frame.
 */
function encodeTake(frames, dir, file, audio, lens = []) {
  const first = frames[0].t, durationMs = frames[frames.length - 1].t - first;
  const list = [];
  let j = 0;
  for (let k = 0; k * (1000 / FPS) < durationMs; k++) {
    const t = first + k * (1000 / FPS);
    while (j + 1 < frames.length && frames[j + 1].t <= t) j++;
    list.push(`file '${frames[j].name}'\nduration ${(1 / FPS).toFixed(6)}`);
  }
  fs.writeFileSync(path.join(dir, "list.txt"), list.join("\n") + `\nfile '${frames[j].name}'\n`);
  const pcm = Buffer.from(audio.b64, "base64");
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + pcm.length, 4); head.write("WAVE", 8); head.write("fmt ", 12);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22); head.writeUInt32LE(audio.rate, 24);
  head.writeUInt32LE(audio.rate * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(path.join(dir, "sound.wav"), Buffer.concat([head, pcm]));
  // The sound's first sample against the first frame: positive = the sound starts later (delay it), negative = trim.
  const offset = (audio.startEpoch - first) / 1000;
  const af = (offset >= 0 ? `adelay=${Math.round(offset * 1000)}:all=1` : `atrim=start=${(-offset).toFixed(3)},asetpts=PTS-STARTPTS`) + `,apad,atrim=end=${(durationMs / 1000).toFixed(3)}`;
  // The screencast JPEGs are full-range BT.601 YCbCr; the delivery is limited-range BT.709 yuv420p.
  const colour = "scale=trunc(iw/2)*2:trunc(ih/2)*2:in_range=full:in_color_matrix=bt601:out_range=limited:out_color_matrix=bt709,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709";
  const CW = 132, CH = 108, Z = 3, B = 3;
  const shots = lens.map((l, k) => ({ a: Math.max(0, (l.t - first) / 1000), b: Math.max(0, ((lens[k + 1]?.t ?? l.t + (l.ms ?? 800)) - first) / 1000),
    x: Math.round(Math.min(W - CW, Math.max(0, l.x - CW / 2))), y: Math.round(Math.min(H - CH, Math.max(0, l.y - CH / 2 - 6))) }));
  let graph = `[0:v]${colour}[v0]`, last = "v0";
  if (shots.length) {
    graph += `;[v0]split=${shots.length + 1}[b0]${shots.map((_, k) => `[s${k}]`).join("")}`;
    last = "b0";
    shots.forEach((sh, k) => {
      graph += `;[s${k}]crop=${CW}:${CH}:${sh.x}:${sh.y},scale=${CW * Z}:${CH * Z}:flags=neighbor,pad=${CW * Z + 2 * B}:${CH * Z + 2 * B}:${B}:${B}:color=0xF2F2F2[l${k}]`;
      graph += `;[${last}][l${k}]overlay=x=${W - CW * Z - 2 * B - 16}:y=14:enable='between(t,${sh.a.toFixed(3)},${sh.b.toFixed(3)})'[b${k + 1}]`;
      last = `b${k + 1}`;
    });
  }
  graph += `;[1:a]${af}[a]`;
  fs.writeFileSync(path.join(dir, "graph.txt"), graph);
  execFileSync("ffmpeg", ["-nostdin", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", "list.txt", "-i", "sound.wav", "-r", String(FPS), "-filter_complex_script", "graph.txt",
    "-map", `[${last}]`, "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", crf, "-g", "60", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-shortest", "-movflags", "+faststart", file], { cwd: dir });
  return { first, seconds: durationMs / 1000, frames: frames.length, framesPerSecond: Number((frames.length / (durationMs / 1000)).toFixed(1)), soundOffset: Number(offset.toFixed(3)), peak: Number(audio.peak.toFixed(2)), lens: shots.length ? [CW * Z + 2 * B, CH * Z + 2 * B] : undefined };
}

// ---------------------------------------------------------------------------------------------------- the game
const g = (f, arg) => page.evaluate(f, arg);
const until = async (f, arg, ms = 20000, step = 100) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await page.evaluate(f, arg).catch(() => null); if (v) return v; await sleep(step); }
  return null;
};
const actors = () => g(() => { const c = window.game.client, s = c.cur; return s ? s.actors.map((a) => ({ id: a.id, type: c.str(a.type), own: a.owner === s.header.localPlayer, sx: a.sx, sy: a.sy, hp: a.hp, flags: a.flags, facing: a.facing, seq: c.str(a.sequence), z: a.worldZ })) : []; });
const cellPx = (u, v) => [30 + (2 * u + (v & 1)) * 30, 15 + v * 15];
const audioSince = (t) => g((t) => window.__parade.audio.filter((a) => a.t >= t), t);
const pageNow = () => g(() => window.__parade.t());
// The game's own clock against the wall clock: a take filmed while the PC could not keep up is not at normal speed.
const gameClock = () => g(() => ({ tick: window.game.client.cur?.header.tick ?? 0, t: performance.now() }));
const gameSpeed = async (from) => { const to = await gameClock(); return { ticksPerSecond: Number(((to.tick - from.tick) / ((to.t - from.t) / 1000)).toFixed(1)) }; };
const label = (name) => unitOf[name]?.label ?? name;
/** Each unit's `at`: the second of its take at which it is selected (so a note pinned to a second names a unit). */
const stamp = (report, take) => { for (const r of report) if (r.t) { r.at = Number(((r.t - take.first) / 1000).toFixed(2)); delete r.t; } delete take.first; };
const setupMaps = await g(() => window.store.getState().setup.maps.map((m) => ({ id: m.id, slots: m.slots })));
// Each unit's voice set, from the rules the engine resolved (cmd unitrules). Selected units share one voice channel
// (Sound.PlayPredefined: a selected actor's voice is refused while another selected actor's is still playing), so
// the film waits a voice out only the first time a set is heard and moves on quickly otherwise.
const voiceSets = {}, cloaks = {}, ruleText = {};
const blocks = (text, trait) => {
  const out = [], re = new RegExp("^" + trait + "(?:@[^:\\n]*)?:\\n((?:\\t.*\\n?)*)", "gm");
  for (let m; (m = re.exec(text));) out.push(Object.fromEntries(m[1].split("\n").filter((l) => /^\t[^\t]/.test(l)).map((l) => { const i = l.indexOf(":"); return [l.slice(1, i).trim(), l.slice(i + 1).trim()]; })));
  return out;
};
const holds = (expr, granted) => !expr || expr.split("||").some((or) => or.split("&&").every((t) => { t = t.trim().replace(/[()]/g, ""); return t.startsWith("!") ? !granted.has(t.slice(1).trim()) : granted.has(t); }));
/** The voice set this country's owner hears from the unit (an original country's units switch to their own sets). */
async function voiceSetOf(name, faction) {
  if (!(name in ruleText)) {
    const r = await g((type) => window.game.command({ cmd: "unitrules", type }), name).catch(() => null);
    ruleText[name] = r?.actor ?? "";
    // A unit that hides when it stands still (Cloak that a move or a shot lifts): pale to its owner after a few seconds.
    cloaks[name] = /^Cloak(?:@[^:\n]*)?:\n(?:\t.*\n)*?\tUncloakOn:/m.test(ruleText[name]);
  }
  const key = `${faction}|${name}`;
  if (!(key in voiceSets)) {
    const granted = new Set(blocks(ruleText[name], "GrantConditionOnFaction").filter((x) => (x.Factions ?? "").split(",").map((f) => f.trim()).includes(faction)).map((x) => x.Condition));
    voiceSets[key] = [...blocks(ruleText[name], "RTSAIVoiced"), ...blocks(ruleText[name], "Voiced")].find((x) => holds(x.RequiresCondition, granted))?.VoiceSet ?? null;
  }
  return voiceSets[key];
}
/** The voice (a sound not placed on the battlefield) that started since t, with its length, or null. */
const voiceSince = (t) => g((t) => { const a = window.__parade.audio.find((x) => x.t >= t && x.relative); return a ? { t: a.t, seconds: window.game.audio.sources?.get(a.source)?.duration ?? 1.2 } : null; }, t);

/** Starts a battle from placements, paused, camera on the stage at 1x, art on the GPU. Returns the camera centre cell. */
async function startBattle(st, faction, enemy, placements, ally = null) {
  const slots = setupMaps.find((m) => m.id === st.map)?.slots ?? [];
  const scenario = { map: st.map, seed: 20261120, sandbox: true, bare: true,
    players: [{ slot: slots[0] ?? "Multi0", faction, color: "2A6FDB", team: ally ? 1 : 0 }, { slot: slots[1] ?? "Multi1", faction: enemy, color: "D83A2E", bot: "webidle", team: ally ? 2 : 0 },
      // The ally (placements with side 2) wears the player's colour and does nothing by itself.
      ...(ally ? [{ slot: slots[2] ?? "Multi2", faction: ally, color: "2A6FDB", bot: "webidle", team: 1 }] : [])],
    options: { explored: "True", fog: "False", crates: "False", shortgame: "False", startingcash: "0" }, placements };
  await g(({ scenario, map }) => {
    window.game.sandbox.configure({ map });
    window.game.sandbox.patch({ mode: "run", paused: true, replay: null });
    window.store.setState({ uiHidden: true });
    window.game.start(JSON.stringify(scenario), true);
  }, { scenario, map: st.map });
  await page.waitForFunction(() => ["playing", "error"].includes(window.store.getState().phase), null, { timeout: 180000 });
  if (await g(() => window.store.getState().phase) === "error") throw new Error(`the battle did not start: ${await g(() => window.store.getState().error)}`);
  const [cx, cy] = cellPx(st.centre.u, st.centre.v);
  const look = () => g(([x, y]) => { const gm = window.game; gm.cam.zoom = 1; gm.lookAt(x, y); window.store.setState({ uiHidden: true }); }, [cx, cy]);
  await look();
  await g(() => window.game.client.send({ type: "step" }));
  await until(() => (window.game.client.cur?.actors.length ?? 0) > 0);
  await look();
  // Every sheet the two sides and the effects need is on the GPU before the camera rolls.
  await page.waitForFunction(() => window.game.renderer.stats.skipped === 0, null, { timeout: 60000 }).catch(() => log("  (some sprites still loading)"));
  await sleep(350 + settle);
}

/** Where the land stage's middle is (the map's own middle), asked once. */
async function landCentre(st, first) {
  if (st.centre) return;
  st.centre = { u: 30, v: 60 };
  await startBattle(st, "america", "russia", [{ id: "gapowr", side: 0, u: 30, v: 60 }]);
  const b = await g(() => window.game.info.bounds);
  const c = await g((b) => window.game.command({ cmd: "cellat", x: Math.round((b[0] + b[2]) / 2), y: Math.round((b[1] + b[3]) / 2) }), b);
  st.centre = { u: c.u, v: c.v & ~1 };
  st.power = { u: st.centre.u - 8, v: st.centre.v + 34 };
  st.keep = { u: st.centre.u - 24, v: st.centre.v - 40 };
  log(`land stage: ${st.map}, centre cell ${st.centre.u},${st.centre.v}`);
  if (first && !flag("cold-audio")) {
    // The first battle's start asked for the sounds: wait until they stop arriving.
    const t = Date.now();
    while (Date.now() - t < 600000 && (audioFiles < 50 || Date.now() - audioLast < 5000)) await sleep(500);
    log(`sounds fetched ahead: ${audioFiles} files in ${((Date.now() - t) / 1000).toFixed(0)} s`);
  }
}

/** Can any of the unit's weapons hit an actor of this type (the catalog's target types)? */
function canHit(unit, type, airborne) {
  const types = airborne ? ["Air"] : (unitOf[type]?.targets ?? []);
  return (unit.weapons ?? []).some((w) => (w.valid ?? []).some((t) => types.includes(t)) && !(w.invalid ?? []).some((t) => types.includes(t)));
}

/**
 * One row of units: select each (voice), a dog-leg walk (facings), fire at a target, destroyed.
 * row = { kind, title, units: [name], refs: [name] (another country's originals, tagged in amber), yard: name? }.
 */
async function unitTake(faction, country, enemy, row, takeDir, heard) {
  const water = row.kind === "ships";
  const refs = water ? [] : (row.refs ?? []);
  const st = water ? STAGES.water : refs.length ? STAGES.land4 : STAGES.land;
  const c = st.centre;
  for (const name of row.units) await voiceSetOf(name, faction);
  const names = [...row.units.filter((u) => cloaks[u]), ...row.units.filter((u) => !cloaks[u]), ...refs];
  const n = names.length;
  const fixed = row.kind === "defenses";
  const gap = water ? (n > 4 ? 2 : 3) : n > 7 ? 2 : 3; // cells between neighbours: 8 across the frame, 6 at sea
  const u0 = Math.round(c.u - (gap * (n - 1)) / 2);
  // Low in the frame at the start, a third up after the walk; targets near the top. Defences stand where they fire.
  const vStart = c.v + (fixed ? 4 : 13), vEnd = c.v + (fixed ? 4 : 6), vTargets = c.v - (fixed ? 4 : row.kind === "infantry" ? 2 : 6);
  const placements = [];
  names.forEach((name, i) => placements.push({ id: name, side: refs.includes(name) ? 2 : 0, u: u0 + gap * i, v: vStart, facing: 384, ...(refs.includes(name) ? { order: "hold" } : {}) }));
  // The other side's dummies: buildings (ground), engineers (infantry), a miner (vehicle), transports (sea), and two
  // airships that lift off and drift across the row (air). None of them shoots back.
  const dummies = [];
  const dummy = (type, u, v, extra = {}) => { dummies.push({ type, u, v, air: type === "zep" }); placements.push({ id: type, side: 1, u, v, facing: 640, order: "hold", ...extra }); };
  if (water) {
    for (const du of [-4, 0, 4]) dummy("lcrf", c.u + du, vTargets);
    dummy("gapowr", st.shore.u, st.shore.v);
    dummy("zep", c.u - 5, c.v + 2, { order: "move", destination: { u: c.u + 9, v: c.v + 2 } });
    dummy("zep", c.u + 6, c.v - 2, { order: "move", destination: { u: c.u - 8, v: c.v - 2 } });
    if (row.yard) placements.push({ id: row.yard, side: 0, u: st.yard.u, v: st.yard.v });
  } else {
    for (const du of [-8, -3, 3, 8]) dummy("gapowr", c.u + du, vTargets);
    for (const du of [-6, 6]) dummy("engineer", c.u + du, vTargets + 4);
    dummy("cmin", c.u, vTargets + 3);
    dummy("zep", c.u - (fixed ? 5 : 9), c.v + 2, { order: "move", destination: { u: c.u + 12, v: c.v + 2 } });
    dummy("zep", c.u + (fixed ? 4 : 9), c.v, { order: "move", destination: { u: c.u - 12, v: c.v } });
  }
  // Out of frame: own power (defences need it), and a building each so the battle is never over by elimination.
  const power = catalog.rosters[faction].find((x) => /powr|nrct/.test(x)) ?? "gapowr";
  for (let i = 0; i < 6; i++) placements.push({ id: power, side: 0, u: st.power.u + 4 * (i % 3), v: st.power.v + 8 * Math.floor(i / 3) });
  placements.push({ id: "napowr", side: 1, u: st.keep.u, v: st.keep.v });

  await startBattle(st, faction, enemy, placements, refs.length ? ALLY : null);
  const all = await actors();
  const pool = all.filter((a) => a.own), strangers = all.filter((a) => !a.own);
  const live = [];
  const report = names.map((name) => ({ unit: name, label: label(name), ref: refs.includes(name), combat: !!unitOf[name]?.combat, spawned: false }));
  names.forEach((name, i) => {
    const [wx, wy] = cellPx(u0 + gap * i, vStart);
    const from = refs.includes(name) ? strangers : pool;
    const a = from.filter((x) => x.type === name).sort((p, q) => Math.hypot(p.sx - wx, p.sy - wy) - Math.hypot(q.sx - wx, q.sy - wy))[0];
    if (a && Math.hypot(a.sx - wx, a.sy - wy) < 200) { from.splice(from.indexOf(a), 1); live.push({ name, i, id: a.id, ref: refs.includes(name) }); report[i].spawned = true; }
  });
  const mine = live.filter((p) => !p.ref);
  const others = strangers;
  for (const d of dummies) {
    const [wx, wy] = cellPx(d.u, d.v);
    const e = others.filter((a) => a.type === d.type).sort((p, q) => Math.hypot(p.sx - wx, p.sy - wy) - Math.hypot(q.sx - wx, q.sy - wy))[0];
    if (e) { d.id = e.id; others.splice(others.indexOf(e), 1); }
  }
  const yard = row.yard ? all.find((a) => a.own && a.type === row.yard) : null;
  // The stage's ground level (the lake lies above the map's zero): heights are measured from it.
  const groundZ = Math.min(...all.map((a) => a.z));
  const tags = live.map((p) => ({ id: p.id, label: p.ref ? REF_LABEL[p.name] ?? `Westwood's ${label(p.name)}` : label(p.name), ref: p.ref, cloaks: !!cloaks[p.name], dy: unitOf[p.name]?.kind === "aircraft" ? 28 : fixed ? 30 : 24 }));
  if (yard) tags.push({ id: yard.id, label: label(row.yard), dy: 40 });
  await g(({ tags, flagId, country, title }) => { const P = window.__parade; P.setTags(tags); P.caption(flagId, country, title, ""); }, { tags, flagId: faction, country, title: row.title });

  const rec = recorder(path.join(takeDir, "frames"));
  await g(() => window.__parade.startTap());
  await rec.start();
  // The whole row is boxed, as a player would, and told to hold fire until the fire step, while the world is still
  // paused: the order holds from the first tick (no long-range unit gets a shot off at the dummies first), and the
  // voice that answers a group, its first unit's, starts with the game, on camera. That is the first unit's line.
  const tGroup = await pageNow();
  await g(async (ids) => { await window.game.select(ids); await window.game.command({ cmd: "stance", stance: "holdfire" }); }, mine.map((p) => p.id));
  await g(() => window.game.setPaused(false));
  const tStart = await pageNow();
  const clock = await gameClock();
  await sleep(800);
  const step = (s) => g(([flagId, country, title, s]) => window.__parade.caption(flagId, country, title, s), [faction, country, row.title, s]);
  const track = { facings: new Map(live.map((p) => [p.id, new Set()])), seqs: new Map(live.map((p) => [p.id, new Set()])) };
  const sampler = setInterval(() => { void actors().then((list) => { for (const a of list) { track.facings.get(a.id)?.add(a.facing >> 5); track.seqs.get(a.id)?.add(a.seq); } }).catch(() => {}); }, 110);

  let voiceUntil = 0; // when the selected units' voice channel is free again (page clock)
  const rowVoices = {};
  /** Boxes the player's row; a select line it may answer with is accounted for. */
  const boxRow = async () => {
    const t = await pageNow();
    await g((ids) => window.game.select(ids), mine.map((p) => p.id));
    await sleep(140);
    const v = await voiceSince(t);
    if (v) voiceUntil = v.t + v.seconds * 1000;
  };
  /**
   * One order for the whole row, given on a silent voice channel, so that the row's own line for that order is the
   * one heard. (The engine refuses a voice while a selected unit is still speaking, and answers every selection made
   * on a silent channel with a select line: a unit that is selected and ordered in one go never says its order line.)
   * Returns the seconds of the line that answered, or 0.
   */
  const rowOrder = async ([x, y]) => {
    await boxRow();
    const busy = voiceUntil - (await pageNow());
    if (busy > 0) await sleep(Math.min(2600, busy + 80));
    const t = await pageNow();
    await g(([x, y]) => window.game["click"](x, y, 2, 0), [x, y]);
    await sleep(240);
    const v = await voiceSince(t);
    if (v) voiceUntil = v.t + v.seconds * 1000;
    return v ? Number(v.seconds.toFixed(2)) : 0;
  };

  // 1. Select each: the voice.
  await step("select");
  const lens = [];
  const groupVoice = await voiceSince(tGroup);
  if (groupVoice) voiceUntil = Math.max(groupVoice.t, tStart) + groupVoice.seconds * 1000;
  for (const [k, p] of live.entries()) {
    const set = p.ref ? null : await voiceSetOf(p.name, faction);
    if (k > 0 && set && !heard.has(set)) { const busy = voiceUntil - (await pageNow()); if (busy > 0) await sleep(Math.min(2400, busy + 60)); }
    const t = await pageNow();
    const at = await g(async (id) => { const gm = window.game; window.__parade.focus(id); await gm.select([id]); const a = gm.client.cur.actors.find((x) => x.id === id); return a ? gm.toClient(a.sx, a.sy) : null; }, p.id);
    if (at) lens.push({ t, x: at[0], y: at[1] });
    if (p.ref) { report[p.i].t = t; await sleep(1100); continue; }
    const free = t >= voiceUntil;
    await sleep(320);
    let voice = await voiceSince(t);
    if (voice) voiceUntil = voice.t + voice.seconds * 1000;
    // The first unit's line is the one that answered the group.
    else if (k === 0 && groupVoice) voice = groupVoice;
    Object.assign(report[p.i], { t, voiceSet: set, cloaks: !!cloaks[p.name] || undefined, selectVoice: voice ? Number(voice.seconds.toFixed(2)) : free ? 0 : null });
    // A set heard for the first time is heard out (at most 2.4 s); otherwise the next unit follows after 0.65 s.
    const firstHearing = voice && set && !heard.has(set);
    if (firstHearing) heard.add(set);
    const left = firstHearing ? Math.min(2400, voiceUntil - (await pageNow()) + 120) : 0;
    await sleep(Math.max(330, left));
  }
  if (lens.length) lens[lens.length - 1].ms = 800;
  if (yard) { await g((id) => { window.__parade.focus(id); return window.game.select([id]); }, yard.id); await sleep(600); }
  await g(() => window.__parade.focus(null));
  // 2. A dog-leg: three short legs, so every unit shows several facings and its moving frames.
  if (!fixed) {
    await step("move");
    rowVoices.move = await rowOrder(cellPx(c.u, vStart - 12));
    for (const p of mine) {
      const u = u0 + gap * p.i;
      const legs = [[u + 1, vStart - 3], [u - 1, vStart - 5], [u, vEnd]].map(([a, b]) => cellPx(a, b));
      await g(async ({ id, legs }) => { const gm = window.game; await gm.select([id]); legs.forEach(([x, y], k) => gm["click"](x, y, 2, k ? 1 : 0)); }, { id: p.id, legs });
      await sleep(90);
    }
    // The row stays boxed for the attack order to come (boxing it then, on a silent channel, would answer with a
    // select line instead).
    await boxRow();
    await sleep(1200);
    // Until they stand still again (idle), at most 5 s more.
    await until((ids) => { const s = window.game.client.cur; return ids.every((id) => { const a = s.actors.find((x) => x.id === id); return !a || (a.flags & 4) !== 0; }); }, mine.map((p) => p.id), 5000, 150);
    await sleep(200);
  }
  // 3. Fire: each at a target it can hit (the nearest of the first kind it can: ground before air).
  await step("fire");
  const now0 = await actors();
  const results = () => g(() => window.store.getState().ui?.sandbox ?? null);
  const before = await results();
  const kinds = water ? ["lcrf", "gapowr", "zep"] : ["gapowr", "cmin", "engineer", "zep"];
  if (!fixed) {
    const first = dummies.filter((d) => d.type === kinds[0] && d.id != null).map((d) => now0.find((x) => x.id === d.id)).find((a) => a && a.hp > 0);
    if (first) rowVoices.attack = await rowOrder([first.sx, first.sy]);
  }
  for (const p of mine) {
    const unit = unitOf[p.name], me = now0.find((x) => x.id === p.id);
    let target = null;
    if (unit?.combat && me) {
      for (const kind of kinds) {
        const cands = dummies.filter((d) => d.type === kind && d.id != null).map((d) => ({ d, a: now0.find((x) => x.id === d.id) })).filter((x) => x.a && x.a.hp > 0 && (!x.d.air || x.a.z - groundZ > 1500));
        if (!cands.length || !canHit(unit, kind, kind === "zep")) continue;
        target = cands.sort((p1, p2) => Math.hypot(p1.a.sx - me.sx, p1.a.sy - me.sy) - Math.hypot(p2.a.sx - me.sx, p2.a.sy - me.sy))[0];
        break;
      }
    }
    report[p.i].target = target?.d.type ?? null;
    // A unit with nothing to shoot at stays where it is (the row's order would send an engineer into the building).
    if (!target) { if (!fixed) await g(async (id) => { const gm = window.game; await gm.select([id]); await gm.command({ cmd: "stop" }); }, p.id); continue; }
    p.target = { id: target.d.id, hp: target.a.hp };
    await g(async ({ id, x, y }) => { const gm = window.game; await gm.select([id]); gm["click"](x, y, 2, 0); }, { id: p.id, x: target.a.sx, y: target.a.sy });
    await sleep(90);
  }
  await g(() => window.game.select([]));
  const tFire = await pageNow();
  await sleep(row.kind === "infantry" ? 4400 : 3800);
  const after = await results();
  const shots = (r, type) => (r?.types ?? []).filter((x) => x.side === 0 && x.type === type).reduce((k, x) => k + x.shots, 0);
  const now1 = await actors();
  for (const p of live) {
    report[p.i].shots = shots(after, p.name) - shots(before, p.name);
    // What its target lost while the row fired (several units may share a target).
    if (p.target) { const a = now1.find((x) => x.id === p.target.id); report[p.i].targetLost = p.target.hp - (a?.hp ?? 0); }
  }
  const fireSounds = (await audioSince(tFire)).filter((a) => !a.relative).length;
  // 4. Destroyed: the other side's elite squad appears beside the row.
  await step("destroyed");
  const posNow = (await actors()).filter((a) => live.some((p) => p.id === a.id) || a.id === yard?.id);
  const tDie = await pageNow();
  await g(async ({ posNow, row, killers, water }) => {
    const gm = window.game;
    gm.setPaused(true);
    await gm.select(posNow.map((a) => a.id));
    await gm.command({ cmd: "stance", stance: "holdfire" });
    await gm.select([]);
    for (const a of posNow) {
      // Infantry fall to machine guns; anything flying or armoured to heavy tanks; ships to destroyers.
      const killer = a.kind === "aircraft" ? killers.vehicles : a.kind === "infantry" ? killers.infantry : killers[row];
      await gm.command({ cmd: "spawn", type: killer, player: 1, x: Math.round(a.sx + (water ? 0 : 30)), y: Math.round(a.sy + a.zpx + (water ? 120 : 75)), level: 3, count: water ? 2 : 1 });
      // At sea a submarine joins each pair of destroyers: torpedoes sink a hull the guns only dent.
      if (water && a.kind !== "building") await gm.command({ cmd: "spawn", type: "sub", player: 1, x: Math.round(a.sx - 90), y: Math.round(a.sy + 60), level: 3 });
    }
    gm.setPaused(false);
  }, { posNow: posNow.map((a) => ({ id: a.id, sx: a.sx, sy: a.sy, zpx: Math.max(0, a.z - groundZ) * 30 / 1448, kind: unitOf[a.type]?.queue === "Ship" ? "ship" : unitOf[a.type]?.kind })), row: row.kind, killers: KILLERS, water });
  const dead = await until((ids) => { const s = window.game.client.cur; return ids.every((id) => !s.actors.some((x) => x.id === id && x.hp > 0 && !(x.flags & 16))); }, live.map((p) => p.id), 6000, 150);
  await sleep(1500);
  const end = await actors();
  clearInterval(sampler);
  for (const p of live) {
    const a = end.find((x) => x.id === p.id);
    report[p.i].died = !a || a.hp <= 0 || (a.flags & 16) !== 0;
    report[p.i].facings = track.facings.get(p.id).size;
    report[p.i].sequences = [...track.seqs.get(p.id)];
  }
  const deathSounds = (await audioSince(tDie)).filter((a) => !a.relative).length;
  const speed = await gameSpeed(clock);
  await rec.stop();
  await g(() => window.game.setPaused(true));
  const audio = await g(() => window.__parade.stopTap());
  const take = encodeTake(rec.frames, path.join(takeDir, "frames"), path.join(takeDir, "take.mp4"), audio, lens);
  fs.rmSync(path.join(takeDir, "frames"), { recursive: true, force: true });
  stamp(report, take);
  return { row: row.title, kind: row.kind, map: st.map, ...take, ...speed, moveLine: rowVoices.move, attackLine: rowVoices.attack, allDead: !!dead, battlefieldSoundsWhileFiring: fireSounds, battlefieldSoundsWhileDying: deathSounds, units: report };
}

/** The buildings: standing (each selected in turn), or the same base worn down to a sliver and brought down. */
async function buildingTake(faction, country, enemy, names, takeDir, wrecked) {
  const st = STAGES.land, c = st.centre;
  const fp = (name) => unitOf[name]?.footprint ?? [2, 2];
  // Three ranks, big buildings first; each gets a slot as wide as its footprint's diamond.
  const ranks = [[], [], []];
  [...names].sort((a, b) => fp(b)[0] * fp(b)[1] - fp(a)[0] * fp(a)[1]).forEach((name, i) => ranks[i % 3].push(name));
  const placements = [], slots = [];
  ranks.forEach((rank, r) => {
    const widths = rank.map((name) => Math.max(2.4, (fp(name)[0] + fp(name)[1]) / 2 + 1.2));
    let u = c.u - widths.reduce((a, b) => a + b, 0) / 2;
    rank.forEach((name, k) => {
      const cu = Math.round(u + widths[k] / 2), cv = c.v - 12 + r * 13;
      // The placement cell is the footprint's top corner; the footprint runs down the screen from it.
      placements.push({ id: name, side: 0, u: cu, v: cv - fp(name)[1], health: wrecked ? 12 : 100 });
      slots.push({ name, u: cu, v: cv });
      u += widths[k];
    });
  });
  const power = catalog.rosters[faction].find((x) => /powr|nrct/.test(x)) ?? "gapowr";
  for (let i = 0; i < 6; i++) placements.push({ id: power, side: 0, u: st.power.u + 4 * (i % 3), v: st.power.v + 8 * Math.floor(i / 3) });
  placements.push({ id: "napowr", side: 1, u: st.keep.u, v: st.keep.v });
  await startBattle(st, faction, enemy, placements);
  const all = await actors();
  const pool = all.filter((a) => a.own && names.includes(a.type));
  const report = slots.map((s) => ({ unit: s.name, label: label(s.name), spawned: false }));
  const shown = [];
  slots.forEach((s, i) => {
    const [wx, wy] = cellPx(s.u, s.v);
    const a = pool.filter((x) => x.type === s.name).sort((p, q) => Math.hypot(p.sx - wx, p.sy - wy) - Math.hypot(q.sx - wx, q.sy - wy))[0];
    if (a) { pool.splice(pool.indexOf(a), 1); shown.push({ ...s, i, id: a.id, sx: a.sx, sy: a.sy }); report[i].spawned = true; }
  });
  shown.sort((a, b) => (Math.round(a.sy / 120) - Math.round(b.sy / 120)) || (a.sx - b.sx));
  const title = wrecked ? "Buildings, worn down" : "Buildings";
  await g(({ tags, flagId, country, title }) => { const P = window.__parade; P.setTags(tags); P.caption(flagId, country, title, ""); },
    { tags: shown.map((p) => ({ id: p.id, label: label(p.name), dy: 34 })), flagId: faction, country, title });
  const rec = recorder(path.join(takeDir, "frames"));
  await g(() => window.__parade.startTap());
  await rec.start();
  await g(() => window.game.setPaused(false));
  const clock = await gameClock();
  await sleep(900);
  const step = (s) => g(([flagId, country, title, s]) => window.__parade.caption(flagId, country, title, s), [faction, country, title, s]);
  if (!wrecked) {
    await step("select");
    for (const p of shown) {
      const t = await pageNow();
      await g((id) => window.game.select([id]), p.id);
      report[p.i].t = t;
      await sleep(380);
      report[p.i].selectSounds = (await audioSince(t)).length;
    }
    await g(() => window.game.select([]));
    await sleep(1000);
  } else {
    await sleep(900);
    await step("destroyed");
    await g(async ({ shown, killer }) => {
      const gm = window.game;
      gm.setPaused(true);
      for (const a of shown) await gm.command({ cmd: "spawn", type: killer, player: 1, x: Math.round(a.sx + 20), y: Math.round(a.sy + 100), level: 3 });
      gm.setPaused(false);
    }, { shown: shown.map((p) => ({ id: p.id, sx: p.sx, sy: p.sy })), killer: KILLERS.buildings });
    await until((ids) => { const s = window.game.client.cur; return ids.every((id) => !s.actors.some((x) => x.id === id && x.hp > 0 && !(x.flags & 16))); }, shown.map((p) => p.id), 9000, 150);
    await sleep(2000);
    const end = await actors();
    for (const p of shown) { const a = end.find((x) => x.id === p.id); report[p.i].died = !a || a.hp <= 0 || (a.flags & 16) !== 0; }
  }
  const speed = await gameSpeed(clock);
  await rec.stop();
  await g(() => window.game.setPaused(true));
  const audio = await g(() => window.__parade.stopTap());
  const take = encodeTake(rec.frames, path.join(takeDir, "frames"), path.join(takeDir, "take.mp4"), audio);
  fs.rmSync(path.join(takeDir, "frames"), { recursive: true, force: true });
  stamp(report, take);
  return { row: title, kind: "buildings", map: st.map, ...take, ...speed, units: report };
}

// ---------------------------------------------------------------------------------------------------- the parade
const countryNames = await g(() => Object.fromEntries((window.store.getState().setup?.factions ?? []).map((f) => [f.id, f.name])));
const MODERN = new Set(["china", "iran", "turkey", "saudi", "israel", "yemen", "lebanon"]);
// Roster entries that never stand on the field by themselves: the Refinery Purifier is an upgrade plugged into the
// refinery (it removes itself as soon as it is placed).
const NOT_STANDING = new Set(["gapurifier"]);
// Westwood's originals stood beside a modern country's row, for the "reads like the original at 1x" bar. They are an
// allied America's (so the game draws the original art), stand still and say nothing: they are not the player's.
const REFS = { infantry: ["e1"], vehicles: ["mtnk"] };
const REF_LABEL = { e1: "Westwood's G.I.", mtnk: "Westwood's Grizzly" };
const ALLY = "america";
const chunk = (list, n) => { const parts = Math.ceil(list.length / n), size = Math.ceil(list.length / parts); const o = []; for (let i = 0; i < list.length; i += size) o.push(list.slice(i, i + size)); return o; };
await landCentre(STAGES.land, true);
if (wanted.some((w) => MODERN.has(w.faction))) await landCentre(STAGES.land4, false);

for (const { faction, units: onlyUnits } of wanted) {
  const roster = catalog.rosters[faction];
  if (!roster) { log(`unknown country ${faction}`); continue; }
  const country = countryNames[faction] ?? faction[0].toUpperCase() + faction.slice(1);
  // --resume: a country already filmed into this folder is left alone (the PC may have restarted mid-run).
  if (flag("resume") && fs.existsSync(path.join(out, `${faction}.mp4`)) && fs.existsSync(path.join(out, `${faction}.json`))) { log(`${country}: already filmed`); continue; }
  const enemy = faction === "russia" ? "america" : "russia";
  const kindOf = (name) => {
    const u = unitOf[name];
    if (!u) return null;
    if (u.kind === "ship" || (u.kind === "infantry" && u.queue === "Ship")) return "ships";
    if (u.kind === "infantry") return "infantry";
    if (u.kind === "vehicle" || u.kind === "aircraft") return "vehicles";
    if (u.kind === "defense") return u.combat || (u.footprint?.[0] ?? 1) * (u.footprint?.[1] ?? 1) === 1 ? "defenses" : "buildings";
    return "buildings";
  };
  const groups = { infantry: [], vehicles: [], ships: [], defenses: [], buildings: [] };
  for (const name of roster) { const k = kindOf(name); if (k && !NOT_STANDING.has(name) && (!onlyUnits.length || onlyUnits.includes(name))) groups[k].push(name); }
  // Aircraft fly at the end of the vehicles' row; shipyards stand on water, so they are filmed with the navy.
  groups.vehicles.sort((a, b) => (unitOf[a].kind === "aircraft") - (unitOf[b].kind === "aircraft"));
  const yard = groups.buildings.find((b) => /yard/.test(b)) ?? (onlyUnits.length ? undefined : roster.find((b) => /yard/.test(b)));
  groups.buildings = groups.buildings.filter((b) => b !== yard);
  const titles = { infantry: "Infantry", vehicles: "Vehicles and aircraft", ships: "Navy", defenses: "Defences" };
  const rows = [];
  for (const kind of ["infantry", "vehicles", "ships", "defenses"]) {
    if (onlyRows.length && !onlyRows.includes(kind)) continue;
    const refs = MODERN.has(faction) ? (REFS[kind] ?? []).filter((r) => !groups[kind].includes(r)) : [];
    if (!groups[kind].length) continue;
    const parts = chunk(groups[kind], (kind === "ships" ? 6 : 8) - refs.length);
    parts.forEach((units, k) => rows.push({ kind, title: titles[kind] + (parts.length > 1 ? ` ${k + 1}/${parts.length}` : ""), units, refs: k === 0 ? refs : [], yard: kind === "ships" && k === 0 ? yard : undefined }));
  }
  const dir = path.join(out, `${faction}-takes`);
  fs.rmSync(dir, { recursive: true, force: true });
  const takes = [], heard = new Set();
  const attempt = async (title, kind, takeDir, f) => {
    try {
      let take = await f();
      // The normal speed is 25 game ticks a second; a take the PC could not keep up with (under 21) is filmed again,
      // once. Each take's measured speed stays in the report either way.
      if (take.ticksPerSecond < 21 || take.framesPerSecond < 20) { log(`  slow take (${take.ticksPerSecond} ticks/s, ${take.framesPerSecond} frames/s): again`); take = { ...(await f()), retried: true }; }
      takes.push({ file: path.join(takeDir, "take.mp4"), ...take });
    }
    catch (e) { log(`  TAKE FAILED: ${String(e).slice(0, 300)}`); takes.push({ row: title, kind, failed: String(e).slice(0, 300) }); await g(() => window.game.setPaused(true)).catch(() => {}); await cdp.send("Page.stopScreencast").catch(() => {}); }
  };
  for (const [i, row] of rows.entries()) {
    log(`${country}: ${row.title} (${row.units.join(" ")}${row.refs.length ? " + " + row.refs.join(" ") : ""}${row.yard ? " + " + row.yard : ""})`);
    const takeDir = path.join(dir, String(i).padStart(2, "0"));
    await attempt(row.title, row.kind, takeDir, () => unitTake(faction, country, enemy, row, takeDir, heard));
  }
  if (groups.buildings.length && (!onlyRows.length || onlyRows.includes("buildings"))) {
    for (const wrecked of [false, true]) {
      log(`${country}: buildings${wrecked ? ", worn down" : ""} (${groups.buildings.join(" ")})`);
      const takeDir = path.join(dir, wrecked ? "91" : "90");
      await attempt("Buildings", "buildings", takeDir, () => buildingTake(faction, country, enemy, groups.buildings, takeDir, wrecked));
    }
  }
  const good = takes.filter((t) => t.file && fs.existsSync(t.file));
  if (good.length) {
    fs.writeFileSync(path.join(dir, "concat.txt"), good.map((t) => `file '${t.file.replace(/\\/g, "/")}'`).join("\n") + "\n");
    const file = path.join(out, `${faction}.mp4`);
    execFileSync("ffmpeg", ["-nostdin", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", path.join(dir, "concat.txt"), "-c", "copy", "-movflags", "+faststart", file]);
    let at = 0;
    for (const t of takes) { if (t.file && fs.existsSync(t.file)) { t.startsAt = Number(at.toFixed(2)); at += t.seconds; } if (!flag("keep-takes")) delete t.file; }
    fs.writeFileSync(path.join(out, `${faction}.json`), JSON.stringify({ faction, country, enemy, base, filmedAt: new Date().toISOString(), seconds: Number(at.toFixed(1)),
      bytes: fs.statSync(file).size, pageErrors: [...pageErrors], takes }, null, 1));
    if (!flag("keep-takes")) fs.rmSync(dir, { recursive: true, force: true });
    log(`${country}: ${file} (${at.toFixed(0)} s, ${(fs.statSync(file).size / 1e6).toFixed(1)} MB)`);
  }
}
await browser.close();
