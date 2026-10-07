// Footage of the AI co-commander for the marketing film (standalone profile only: project art and audio).
// Each take: hold V, the player's line (Kokoro "onyx", played into the browser microphone, transcribed by the
// companion's Whisper), the spoken reply, the proposal card, a visible click on accept, the order executing.
// Capture: headless Chromium at a true 2x device scale, CSS viewport 1180x740 -> 2360x1480 frames (CDP screencast,
// JPEG q95) resampled by their timestamps to constant 30 fps, H.264 CRF 14; audio stems as 48 kHz WAV: the reply
// (exact bytes played), the player's line, game SFX (tapped before music and voice). Plus a 2x crop of the
// co-commander region and a 6 s HUD-free clean plate. A README lists every event's time and the texts.
//   node tools/film-takes.mjs --out <dir> [--mode local] [--takes A,B,C] [--faction iran] [--dry]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "../web/node_modules/playwright-core/index.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const out = path.resolve(opt("out", "film-takes"));
const mode = opt("mode", "local");
const faction = opt("faction", "iran");
const takes = opt("takes", "A,B").split(",");
const lineB = opt("line-b", "Send the tanks to the center of the map.");
// The Kokoro voices behind the OpenAI names (the product's runtime: alloy -> af_sarah; the machine's GPU server:
// alloy -> af_heart). onyx is am_michael in both.
const replyVoice = opt("reply-voice", "af_sarah");
const server = "http://127.0.0.1:3490";
const gateway = opt("gateway", mode === "local" ? "http://127.0.0.1:4020" : "http://127.0.0.1:4010"); // --gateway: the server's RTSAI_WEB_AI_GATEWAY
const CSS_W = 1180, CSS_H = 740, FPS = 30;
const LINES = { A: "Build a power plant.", B: lineB, C: "Build a power plant." };
// The card each take accepts (other offers, e.g. alerts, are left alone).
const CARD = { A: /power plant/i, B: /move|send|tank|center|centre/i, C: /power plant/i };
fs.mkdirSync(out, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------- the companion
const started = await (await fetch(`${server}/api/companion/start`, { method: "POST", body: JSON.stringify({ mode }) })).json();
if (!started.running) throw new Error(`companion did not start: ${started.error}`);
async function speak(text, voice) {
  const res = await fetch(`${gateway}/v1/audio/speech`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "local-kokoro", voice, input: text, response_format: "wav" }) });
  const wav = Buffer.from(await res.arrayBuffer());
  if (!res.ok || wav.subarray(0, 4).toString() !== "RIFF") throw new Error(`speech "${text}": HTTP ${res.status}`);
  return { wav, seconds: wav.readUInt32LE(40) / (wav.readUInt32LE(24) * 2) };
}

// ------------------------------------------------------------------------------------------------- the browser
const exe = path.join(process.env.LOCALAPPDATA, "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe");
async function openGame() {
  // A real 2x device (not emulation): the screencast then delivers device pixels. The window size is the viewport
  // plus the headless window frame, corrected below if it differs.
  const browser = await chromium.launch({ executablePath: exe, headless: true,
    args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream", "--force-device-scale-factor=2", `--window-size=${CSS_W + 22},${CSS_H + 98}`, "--hide-scrollbars"] });
  const context = await browser.newContext({ viewport: null, permissions: ["microphone"] });
  await context.addInitScript((m) => {
    localStorage.setItem("rtsai.cocommander", JSON.stringify({ enabled: true, mode: m, muted: false }));
    window.__nextLine = null;
    window.__events = [];
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      if (!window.__nextLine) return real(c);
      const ctx = new AudioContext();
      const buf = await ctx.decodeAudioData(window.__nextLine.slice(0));
      window.__nextLine = null;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const dest = ctx.createMediaStreamDestination();
      src.connect(dest);
      src.start(ctx.currentTime + 0.05);
      window.__events.push({ name: "line audio start", t: performance.timeOrigin + performance.now() + 50 });
      return dest.stream;
    };
    // A drawn pointer (headless capture shows no OS cursor): a plain white arrow and a click ring, same every take.
    addEventListener("DOMContentLoaded", () => {
      const css = document.createElement("style");
      css.textContent = `#film-cursor{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:22px;height:30px;transform:translate(-2px,-2px);filter:drop-shadow(0 1px 2px rgba(0,0,0,.7))}
        .film-ring{position:fixed;z-index:2147483646;pointer-events:none;width:34px;height:34px;margin:-17px 0 0 -17px;border:2px solid #fff;border-radius:50%;animation:film-ring .45s ease-out forwards}
        @keyframes film-ring{from{transform:scale(.35);opacity:1}to{transform:scale(1.25);opacity:0}}
        body.film-clean .hud-panel, body.film-clean aside, body.film-clean #film-cursor{display:none!important}`;
      document.head.appendChild(css);
      const c = document.createElement("div");
      c.id = "film-cursor";
      c.innerHTML = `<svg viewBox="0 0 22 30" width="22" height="30"><path d="M2 2 L2 24 L7.5 18.5 L11.5 27.5 L15 26 L11 17 L19 17 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
      c.style.display = "none";
      document.body.appendChild(c);
      addEventListener("mousemove", (e) => { c.style.display = "block"; c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
      addEventListener("mousedown", (e) => {
        const r = document.createElement("div");
        r.className = "film-ring";
        r.style.left = e.clientX + "px";
        r.style.top = e.clientY + "px";
        document.body.appendChild(r);
        setTimeout(() => r.remove(), 600);
      }, true);
    });
  }, mode);
  const page = await context.newPage();
  page.on("pageerror", (e) => log("pageerror", String(e)));
  const cdp = await context.newCDPSession(page);
  // Exact viewport: resize the window until the page is 1180x740 CSS px.
  for (let i = 0; i < 3; i++) {
    const [w, h] = await page.evaluate(() => [innerWidth, innerHeight]).catch(() => [0, 0]);
    if (w === CSS_W && h === CSS_H) break;
    const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget");
    if (w && h) await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: bounds.width + (CSS_W - w), height: bounds.height + (CSS_H - h) } });
    else await page.goto("about:blank");
  }
  return { browser, context, page, cdp };
}

const { browser, page, cdp } = await openGame();
const until = async (f, arg, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await page.evaluate(f, arg); if (v) return v; await sleep(100); }
  return null;
};
const now = () => page.evaluate(() => performance.timeOrigin + performance.now());

// ------------------------------------------------------------------------------------------------- recording
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
    async start() { on = true; await cdp.send("Page.startScreencast", { format: "jpeg", quality: 95, everyNthFrame: 1 }); },
    async stop() { await cdp.send("Page.stopScreencast"); on = false; cdp.off("Page.screencastFrame", handler); },
  };
}

/** Constant-frame-rate H.264 from timestamped frames (each output frame shows the latest frame at its time). */
function encode(frames, dir, file, t0ms, durationMs, crop) {
  const list = [];
  let j = 0;
  for (let k = 0; k * (1000 / FPS) < durationMs; k++) {
    const t = t0ms + k * (1000 / FPS);
    while (j + 1 < frames.length && frames[j + 1].t <= t) j++;
    list.push(`file '${frames[j].name}'\nduration ${(1 / FPS).toFixed(6)}`);
  }
  fs.writeFileSync(path.join(dir, "list.txt"), list.join("\n") + `\nfile '${frames[j].name}'\n`);
  // The screencast JPEGs are full-range BT.601 YCbCr; the delivery is limited-range BT.709 yuv420p.
  const vf = [crop ? `crop=${crop}` : null,
    "scale=trunc(iw/2)*2:trunc(ih/2)*2:in_range=full:in_color_matrix=bt601:out_range=limited:out_color_matrix=bt709", "format=yuv420p",
    "setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709"].filter(Boolean).join(",");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", "list.txt", "-r", String(FPS), "-vf", vf,
    "-c:v", "libx264", "-preset", "slow", "-crf", "14",
    "-movflags", "+faststart", file], { cwd: dir });
}

/** 48 kHz mono/stereo WAV (resampled with ffmpeg). */
function wav48(input, output) {
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", input, "-ar", "48000", "-c:a", "pcm_s16le", output]);
}

/** The game's SFX bus, tapped in the page (before music and voice are mixed in). */
async function startSfxTap() {
  await page.evaluate(() => {
    const a = window.game.audio, ctx = a.context();
    const tap = ctx.createScriptProcessor(4096, 2, 2);
    const left = [], right = [];
    tap.onaudioprocess = (e) => { left.push(new Float32Array(e.inputBuffer.getChannelData(0))); right.push(new Float32Array(e.inputBuffer.getChannelData(1))); };
    const sink = ctx.createGain();
    sink.gain.value = 0;
    a.buses.sfx.connect(tap);
    tap.connect(sink).connect(ctx.destination);
    const ts = ctx.getOutputTimestamp();
    window.__sfx = { tap, sink, left, right, rate: ctx.sampleRate, startEpoch: performance.timeOrigin + ts.performanceTime - (ts.contextTime - ctx.currentTime) * 1000 };
  });
}
async function stopSfxTap(file) {
  const r = await page.evaluate(() => {
    const s = window.__sfx;
    window.game.audio.buses.sfx.disconnect(s.tap);
    s.tap.disconnect();
    const n = s.left.reduce((k, c) => k + c.length, 0);
    const pcm = new Int16Array(n * 2);
    let o = 0;
    for (let i = 0; i < s.left.length; i++) {
      const l = s.left[i], r = s.right[i];
      for (let k = 0; k < l.length; k++) { pcm[o++] = Math.max(-32767, Math.min(32767, l[k] * 32767)); pcm[o++] = Math.max(-32767, Math.min(32767, r[k] * 32767)); }
    }
    const bytes = new Uint8Array(pcm.buffer);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return { b64: btoa(bin), rate: s.rate, startEpoch: s.startEpoch };
  });
  const pcm = Buffer.from(r.b64, "base64");
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + pcm.length, 4); head.write("WAVE", 8); head.write("fmt ", 12);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22); head.writeUInt32LE(r.rate, 24);
  head.writeUInt32LE(r.rate * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(pcm.length, 40);
  const raw = file.replace(/\.wav$/, ".raw.wav");
  fs.writeFileSync(raw, Buffer.concat([head, pcm]));
  wav48(raw, file);
  fs.unlinkSync(raw);
  return r.startEpoch;
}

// ------------------------------------------------------------------------------------------------- the game
await page.goto(`${server}/?runtime=aot&profile=public`);
await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 600000 });
log("viewport", JSON.stringify(await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio])));
const scenario = { map: "twin-fords", seed: 2026,
  players: [{ slot: "Multi1", faction, color: "D83A2E" }, { slot: "Multi0", faction, bot: "normal", color: "2A6FDB" }],
  options: { startingunits: "medium", explored: "True", fog: "False", crates: "False" } };
await page.evaluate((s) => window.game.start(s), JSON.stringify(scenario));
await page.waitForFunction(() => window.store.getState().phase === "playing" && !!window.game.client.cur && !!window.store.getState().ui, null, { timeout: 600000 });
await until(() => window.store.getState().cc.linked ? true : null, null, 120000);
// Base deployed off camera time; nothing stays selected (no selection panel with internal names).
await page.evaluate(async () => {
  const g = window.game, s = g.client.cur;
  const mcv = s.actors.find((a) => a.owner === s.header.localPlayer && g.client.str(a.type).includes("mcv"));
  await g.select([mcv.id]);
  await g.command({ cmd: "deploy" });
  await g.select([]);
});
await until(() => window.store.getState().catalog.find((c) => c.type === "Building")?.items.some((i) => i.buildable) || null, null, 60000);
// The pointer's resting place: open ground in the lower right of the battlefield, never over a unit or building
// (hovering one draws its selection bracket).
const REST = [CSS_W * 0.61, CSS_H * 0.83];
await page.mouse.move(REST[0], REST[1]);
await page.evaluate(() => {
  window.game.audio.onVoice = (wav, at, seconds) => {
    const b = new Uint8Array(wav);
    let bin = "";
    for (let i = 0; i < b.length; i += 32768) bin += String.fromCharCode(...b.subarray(i, i + 32768));
    window.__events.push({ name: "reply audio start", t: performance.timeOrigin + at, seconds, wav: btoa(bin) });
  };
  // Hygiene: every visible text checked twice a second for stock names (the engine draws no text; cameo labels are
  // project art).
  const banned = /red alert|ra2|westwood|electronic arts|EA|tesla|war factory|battle lab|ore refinery|service depot|chrono|war miner|flak track|airforce command|gacnst|nacnst/i;
  window.__hygiene = [];
  setInterval(() => {
    const text = document.body.innerText;
    const m = text.match(banned);
    if (m) window.__hygiene.push({ t: performance.timeOrigin + performance.now(), hit: m[0], context: text.slice(Math.max(0, m.index - 40), m.index + 40) });
  }, 500);
  // Proposal cards and receipts as they appear (page time).
  let seen = 0;
  window.store.subscribe((s) => {
    const feed = s.cc.feed;
    if (feed.length < seen) seen = 0; // the feed was cleared (a new take)
    for (; seen < feed.length; seen++) {
      const f = feed[seen];
      window.__events.push({ name: f.kind === "proposal" ? "card visible" : f.kind === "you" ? "line transcribed" : f.kind === "done" ? "order start" : f.kind, text: f.text, t: performance.timeOrigin + performance.now() });
    }
  });
});

/**
 * Frames the own base (or the given actors) with the view kept inside the map (no black border past the map edge):
 * the subject sits off-centre toward the map's corner, the rest of the frame shows the battlefield.
 */
async function frameOn(ids, zoom = 1.25) {
  await page.evaluate(([ids, zoom]) => {
    const g = window.game, s = g.client.cur;
    const own = s.actors.filter((a) => (ids.length ? ids.includes(a.id) : a.owner === s.header.localPlayer && (a.flags & 8)));
    if (!own.length) return;
    const c = own.reduce((acc, a) => [acc[0] + a.sx / own.length, acc[1] + a.sy / own.length], [0, 0]);
    g.cam.zoom = zoom;
    const halfW = g.canvas.width / zoom / 2, halfH = g.canvas.height / zoom / 2;
    const m = 72, b0 = g.info.bounds; // the map's visible rectangle (screen px), kept clear of its ragged edge
    const b = b0 && [b0[0] + m, b0[1] + m, b0[2] - m, b0[3] - m];
    // The subject in the lower part of the frame: the open co-commander feed covers the top centre.
    let x = c[0] + halfW * 0.12, y = c[1] - halfH * 0.38;
    if (b) {
      x = Math.min(b[2] - halfW, Math.max(b[0] + halfW, x));
      y = Math.min(b[3] - halfH, Math.max(b[1] + halfH, y));
    }
    g.lookAt(x, y);
  }, [ids, zoom]);
}

/** Moves the drawn pointer to the pending card's accept button, clicks it, returns the click (CSS and device px). */
async function clickAccept(re = /./) {
  const box = await page.evaluate((src) => {
    const re = new RegExp(src, "i");
    const b = [...document.querySelectorAll("button[title^='Accept']")].filter((x) => re.test(x.parentElement?.parentElement?.textContent ?? "")).pop()?.getBoundingClientRect();
    return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
  }, re.source);
  if (!box) return null;
  await page.mouse.move(box.x, box.y, { steps: 24 });
  await sleep(350);
  const t = await now();
  await page.mouse.down();
  await sleep(70);
  await page.mouse.up();
  await sleep(200);
  await page.mouse.move(REST[0], REST[1], { steps: 18 }); // out of the way, over open ground
  return { t, css: [Math.round(box.x), Math.round(box.y)], device: [Math.round(box.x * 2), Math.round(box.y * 2)] };
}

async function take(name) {
  const dir = path.join(out, `take-${name}`);
  const tmp = path.join(dir, "frames");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const line = LINES[name];
  const { wav, seconds } = await speak(line, "onyx");
  // Scripted brain (dry runs): its transcription returns the line as given.
  if (mode === "mock") await fetch(`${gateway}/mock/next-transcript`, { method: "POST", body: line.replace(/\.$/, "") });
  fs.writeFileSync(path.join(dir, "player-line.raw.wav"), wav);
  wav48(path.join(dir, "player-line.raw.wav"), path.join(dir, `take-${name}-player-line.wav`));
  fs.unlinkSync(path.join(dir, "player-line.raw.wav"));
  const events = [];
  const ev = (name, t, extra = {}) => events.push({ name, t, ...extra });

  await frameOn([]);
  await page.evaluate(() => { window.__events = []; });
  const tanks = name === "B" ? await page.evaluate(() => {
    const g = window.game, s = g.client.cur;
    return s.actors.filter((a) => a.owner === s.header.localPlayer && /karrar|tank|m1a2|merkava|altay|ztz|zulfiqar|type99/i.test(g.client.str(a.type))).map((a) => ({ id: a.id, sx: a.sx, sy: a.sy }));
  }) : [];
  const rec = recorder(tmp);
  await startSfxTap();
  await rec.start();
  const start = await now();
  await sleep(2000);

  // Push-to-talk: hold V while the line plays into the microphone.
  await page.evaluate((b64) => {
    const bin = atob(b64), buf = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) buf[k] = bin.charCodeAt(k);
    window.__nextLine = buf.buffer;
  }, wav.toString("base64"));
  ev("V down", await now());
  await page.keyboard.down("v");
  await sleep(Math.round(seconds * 1000) + 450);
  ev("V up", await now());
  await page.keyboard.up("v");

  const card = await until((re) => window.__events.find((e) => e.name === "card visible" && new RegExp(re, "i").test(e.text)) ?? null, CARD[name].source, 120000);
  const voice = await until(() => window.__events.find((e) => e.name === "reply audio start") ?? null, null, 60000);
  // A beat after the reply ends and the card shows, then the click.
  const replyEnd = voice ? voice.t + voice.seconds * 1000 : 0;
  const wait = Math.max(0, Math.max(replyEnd, card?.t ?? 0) + 1500 - (await now()));
  await sleep(wait);
  const click = card ? await clickAccept(CARD[name]) : null;
  if (click) ev("click accept", click.t, { css: click.css, device: click.device });
  await until(() => window.__events.find((e) => e.name === "order start") ?? null, null, 20000);

  let done = null;
  if (name === "A" || name === "C") {
    // The structure builds; the co-commander proposes its placement: a second card, a second click, then it stands.
    const second = await until(() => window.__events.some((e) => e.name === "card visible" && /place/i.test(e.text)) ? true : null, null, 90000);
    if (second) {
      await sleep(1500);
      const click2 = await clickAccept(/place/);
      if (click2) ev("click place", click2.t, { css: click2.css, device: click2.device });
      done = await until(() => {
        const g = window.game, s = g.client.cur;
        return s.actors.some((a) => a.owner === s.header.localPlayer && /powr|pwr|power/i.test(g.client.str(a.type))) ? performance.timeOrigin + performance.now() : null;
      }, null, 20000);
      if (done) ev("result complete (power plant placed)", done);
    }
  } else if (click) {
    // The tanks drive: the camera follows them until they stop (at most 60 s).
    let last = null, still = 0;
    for (let k = 0; k < 600 && still < 15; k++) {
      const pos = await page.evaluate((ids) => {
        const s = window.game.client.cur;
        const own = s.actors.filter((a) => ids.includes(a.id));
        return own.length ? own.reduce((acc, a) => [acc[0] + a.sx / own.length, acc[1] + a.sy / own.length], [0, 0]) : null;
      }, tanks.map((t) => t.id));
      if (!pos) break;
      await page.evaluate(([x, y]) => {
        const g = window.game;
        const m = 72, b0 = g.info.bounds, halfW = g.canvas.width / g.cam.zoom / 2, halfH = g.canvas.height / g.cam.zoom / 2, b = b0 && [b0[0] + m, b0[1] + m, b0[2] - m, b0[3] - m];
        let tx = g.cam.x + (x - g.cam.x) * 0.06, ty = g.cam.y + (y - g.cam.y) * 0.06;
        if (b) { tx = Math.min(b[2] - halfW, Math.max(b[0] + halfW, tx)); ty = Math.min(b[3] - halfH, Math.max(b[1] + halfH, ty)); }
        g.lookAt(tx, ty);
      }, pos);
      const moved = Math.hypot(pos[0] - tanks[0].sx, pos[1] - tanks[0].sy) > 4;
      if (moved && last && Math.hypot(pos[0] - last[0], pos[1] - last[1]) < 0.5) still++; else still = 0;
      if (last && !events.some((e) => e.name.startsWith("tanks moving")) && Math.hypot(pos[0] - tanks[0].sx, pos[1] - tanks[0].sy) > 4) ev("tanks moving", await now());
      last = pos;
      await sleep(100);
    }
    done = await now();
    ev("result complete (tanks arrived)", done);
  }
  // At least 30 s, and a beat at the end.
  const elapsed = (await now()) - start;
  await sleep(Math.max(2500, 30000 - elapsed + 500));
  const end = await now();
  await rec.stop();
  const sfxStart = await stopSfxTap(path.join(dir, `take-${name}-sfx.wav`));

  // Page events (line audio, transcript, reply audio with its bytes, cards, receipts).
  const pageEvents = await page.evaluate(() => window.__events);
  for (const e of pageEvents) {
    if (e.name === "reply audio start" && e.wav) {
      const n = events.filter((x) => x.name === "reply audio start").length + 1;
      const raw = path.join(dir, `reply-${n}.raw.wav`);
      fs.writeFileSync(raw, Buffer.from(e.wav, "base64"));
      wav48(raw, path.join(dir, `take-${name}-reply-${n}.wav`));
      fs.unlinkSync(raw);
      ev("reply audio start", e.t, { file: `take-${name}-reply-${n}.wav`, seconds: +e.seconds.toFixed(2) });
      ev("reply audio end", e.t + e.seconds * 1000);
    } else ev(e.name, e.t, e.text ? { text: e.text } : {});
  }
  // The texts.
  const feed = await page.evaluate(() => window.store.getState().cc.feed);

  // Video: the take, the co-commander region at 2x, then a 6 s clean plate.
  const frames = rec.frames;
  encode(frames, tmp, path.join(dir, `take-${name}.mp4`), start, end - start);
  const panel = await page.evaluate(() => {
    const strip = document.querySelector("[aria-label^='Co-commander']")?.closest(".pointer-events-auto")?.getBoundingClientRect();
    return strip ? { x: strip.x, y: strip.y, w: strip.width } : null;
  });
  if (panel) {
    const x = Math.max(0, Math.round((panel.x - 12) * 2)), y = 0, w = Math.round((panel.w + 24) * 2), h = Math.round(Math.min(CSS_H, 330) * 2);
    encode(frames, tmp, path.join(dir, `take-${name}-copilot-2x.mp4`), start, end - start, `${w}:${h}:${x}:${y}`);
  }
  for (const f of fs.readdirSync(tmp)) fs.unlinkSync(path.join(tmp, f));
  await page.evaluate(() => { document.body.classList.add("film-clean"); document.documentElement.style.setProperty("--sidebar-w", "0px"); window.dispatchEvent(new Event("resize")); });
  await sleep(600);
  // The wider view (no sidebar) kept inside the map as well.
  await page.evaluate(() => {
    const g = window.game, m = 72, b0 = g.info.bounds, halfW = g.canvas.width / g.cam.zoom / 2, halfH = g.canvas.height / g.cam.zoom / 2;
    g.lookAt(Math.min(b0[2] - m - halfW, Math.max(b0[0] + m + halfW, g.cam.x)), Math.min(b0[3] - m - halfH, Math.max(b0[1] + m + halfH, g.cam.y)));
  });
  await sleep(400);
  const plate = recorder(tmp);
  await plate.start();
  const pStart = await now();
  await sleep(6200);
  await plate.stop();
  encode(plate.frames, tmp, path.join(dir, `take-${name}-clean-plate.mp4`), pStart, 6000);
  fs.rmSync(tmp, { recursive: true, force: true });
  await page.evaluate(() => { document.body.classList.remove("film-clean"); document.documentElement.style.removeProperty("--sidebar-w"); window.dispatchEvent(new Event("resize")); });
  await sleep(600);

  const rel = (t) => +((t - start) / 1000).toFixed(2);
  const timeline = events.sort((a, b) => a.t - b.t).map((e) => ({ ...e, at: rel(e.t), t: undefined }));
  const hygiene = await page.evaluate((t) => window.__hygiene.filter((h) => h.t >= t), start);
  const meta = { take: name, line, hygiene: hygiene.length ? hygiene.slice(0, 5).map((h) => ({ at: rel(h.t), hit: h.hit, context: h.context })) : "clean", playerVoice: "Kokoro v1.0 'am_michael' (synthetic, requested as 'onyx'); not a human recording",
    replyVoice: `Kokoro v1.0 '${replyVoice}' (the co-commander's voice, requested as 'alloy')`, durationS: rel(end), sfxOffsetS: rel(sfxStart), timeline,
    transcript: feed.filter((f) => f.kind === "you").map((f) => f.text), replies: feed.filter((f) => f.kind !== "you").map((f) => `${f.kind}: ${f.text}`) };
  fs.writeFileSync(path.join(dir, `take-${name}.json`), JSON.stringify(meta, null, 2));
  log(`take ${name}: ${meta.durationS} s, transcript ${JSON.stringify(meta.transcript)}, events ${timeline.map((e) => `${e.name}@${e.at}`).join(", ")}`);
  return meta;
}

const metas = [];
for (const name of takes) {
  // Each take on a fresh feed (the previous take's lines cleared), only this take's exchange in it: no stray
  // offers or alerts, and nothing left pending from before.
  await page.evaluate(async (src) => {
    const g = window.game;
    g.cc.focus = new RegExp(src, "i");
    const state = await (await fetch("companion/api/v1/state")).json();
    if (state.pending_action) await fetch("companion/api/v1/actions/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proposal_id: state.pending_action.proposal_id }) });
    const s = window.store.getState();
    s.set({ cc: { ...s.cc, feed: [], open: true } });
  }, name === "B" ? "a^" : "place.*power plant");
  metas.push(await take(name));
  if (name === "A") await sleep(2000);
}
await browser.close();
fs.writeFileSync(path.join(out, "takes.json"), JSON.stringify(metas, null, 2));
log("done", out);
