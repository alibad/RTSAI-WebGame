// The AI co-commander end to end with its real voice path: spoken lines (Kokoro, a voice distinct from the
// co-commander's) are played into the browser microphone, transcribed by the companion's speech model, answered,
// spoken back and, for orders, proposed, accepted and executed by the engine. Measures push-to-talk latency per
// stage (release of the talk key -> transcript -> answer -> speech -> playback), transcript accuracy and order
// outcomes, then checks SyncHash parity of the whole session against the native engine.
//   node tools/cocommander-live.mjs [--mode local|mock] [--runtime aot] [--profile public] [--out dir]
// --mode local runs the product's local models (llama.cpp Qwen3-VL 2B, whisper.cpp base.en, Kokoro); check the GPU
// claim first (AI\logs\gpu-claim.txt).
import fs from "node:fs";
import path from "node:path";
import { chromium } from "../web/node_modules/playwright-core/index.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const mode = opt("mode", "local");
const runtime = opt("runtime", "aot");
const profile = opt("profile", "public");
const out = opt("out", "cocommander-live");
const server = "http://127.0.0.1:3490";
const gateway = mode === "local" ? "http://127.0.0.1:4020" : "http://127.0.0.1:4010";
fs.mkdirSync(out, { recursive: true });

// The turns: questions and orders, with what a correct order proposal mentions.
const TURNS = [
  { line: "What should I build first?" },
  { line: "Build a power plant.", expect: /power/i },
  { line: "How is our economy?" },
  { line: "Build a refinery.", expect: /refin/i },
  { line: "Where is the enemy?" },
  { line: "Send the tanks east.", expect: /east|move/i },
  { line: "Build a barracks.", expect: /barrack/i },
  { line: "What is our power status?" },
  { line: "Train three soldiers.", expect: /train|soldier|infantry|rifle/i },
  { line: "Stop all units.", expect: /stop/i },
  { line: "What should I do next?" },
  { line: "Send the infantry north.", expect: /north|move/i },
];

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// 1. The companion with the chosen brain (the server starts the local AI runtime for --mode local).
log(`starting the companion (${mode})...`);
const started = await (await fetch(`${server}/api/companion/start`, { method: "POST", body: JSON.stringify({ mode }) })).json();
if (!started.running) throw new Error(`companion did not start: ${started.error ?? JSON.stringify(started.log?.slice(-5))}`);
log("companion up", JSON.stringify({ mode: started.mode, localRuntime: started.localRuntime }));

// 2. The player's lines, spoken by Kokoro "onyx" (am_michael); the co-commander speaks as "alloy" (af_sarah).
const lines = [];
for (const turn of TURNS) {
  const res = await fetch(`${gateway}/v1/audio/speech`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "local-kokoro", voice: "onyx", input: turn.line, response_format: "wav" }) });
  const wav = Buffer.from(await res.arrayBuffer());
  if (!res.ok || wav.subarray(0, 4).toString() !== "RIFF") throw new Error(`speech for "${turn.line}": HTTP ${res.status}`);
  const rate = wav.readUInt32LE(24), bytes = wav.readUInt32LE(40);
  lines.push({ wav, seconds: bytes / (rate * 2) });
  fs.writeFileSync(path.join(out, `player-${lines.length.toString().padStart(2, "0")}.wav`), wav);
}
log(`player lines ready (${lines.length})`);

// 3. The game, with the microphone fed from those lines.
const exe = path.join(process.env.LOCALAPPDATA, "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe");
const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined, headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, permissions: ["microphone"] });
await context.addInitScript((m) => {
  localStorage.setItem("rtsai.cocommander", JSON.stringify({ enabled: true, mode: m, muted: false }));
  // The next getUserMedia plays the queued WAV (the player's line) as the microphone.
  window.__nextLine = null;
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
    return dest.stream;
  };
}, mode);
const page = await context.newPage();
page.on("pageerror", (e) => log("pageerror", String(e)));
page.on("console", (m) => { if (m.type() === "error") log("console", m.text().slice(0, 200)); });
const until = async (f, arg, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await page.evaluate(f, arg); if (v) return v; await page.waitForTimeout(150); }
  return null;
};
await page.goto(`${server}/?runtime=${runtime}${profile ? `&profile=${profile}` : ""}`);
await page.waitForFunction(() => ["setup", "error"].includes(window.store?.getState().phase), null, { timeout: 600000 });
const scenario = { map: profile ? "twin-fords" : "tournament-2A", seed: 31337,
  players: [{ slot: "Multi0", faction: "iran", color: "D83A2E" }, { slot: "Multi1", faction: "iran", bot: "normal", color: "2A6FDB" }],
  options: { startingunits: "medium", explored: "False", fog: "True", crates: "False" } };
await page.evaluate((s) => window.game.start(s), JSON.stringify(scenario));
await page.waitForFunction(() => window.store.getState().phase === "playing" && !!window.game.client.cur && !!window.store.getState().ui, null, { timeout: 600000 });
const linked = await until(() => window.store.getState().cc.linked && window.store.getState().ui?.companion ? true : null, null, 120000);
log("game playing; co-commander linked:", !!linked);

// The base first, so build orders are possible.
await page.evaluate(async () => {
  const g = window.game, s = g.client.cur;
  const mcv = s.actors.find((a) => a.owner === s.header.localPlayer && g.client.str(a.type).includes("mcv"));
  await g.select([mcv.id]);
  await g.command({ cmd: "deploy" });
  await g.select([]);
});
await until(() => window.store.getState().catalog.find((c) => c.type === "Building")?.items.some((i) => i.buildable) || null, null, 60000);

// Stage timing: responses of the companion's API and the start of the spoken reply.
await page.evaluate(() => {
  window.__marks = [];
  const mark = (name, extra) => window.__marks.push({ name, t: performance.now(), ...extra });
  const f = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const stage = /v1\/transcribe/.test(url) ? "transcribe" : /v1\/ask/.test(url) ? "answer" : /v1\/speak/.test(url) ? "speech" : null;
    const res = await f(input, init);
    if (stage) mark(stage);
    return res;
  };
  window.game.audio.onVoice = (_wav, at, seconds) => window.__marks.push({ name: "playing", t: at, seconds });
});

const feedSince = (n) => page.evaluate((n) => window.store.getState().cc.feed.slice(n), n);
const words = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
const results = [];
for (let i = 0; i < TURNS.length; i++) {
  const turn = TURNS[i], { wav, seconds } = lines[i];
  const feedStart = (await page.evaluate(() => window.store.getState().cc.feed.length));
  await page.evaluate((b64) => {
    const bin = atob(b64), buf = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) buf[k] = bin.charCodeAt(k);
    window.__nextLine = buf.buffer;
    window.__marks = [];
  }, wav.toString("base64"));
  await page.keyboard.down("v");
  await page.waitForTimeout(Math.round(seconds * 1000) + 450);
  const released = await page.evaluate(() => performance.now());
  await page.keyboard.up("v");
  const done = await until(() => window.__marks.some((m) => m.name === "playing") || (!window.store.getState().cc.thinking && window.__marks.some((m) => m.name === "answer")) ? true : null, null, 120000);
  await page.waitForTimeout(400);
  const marks = await page.evaluate(() => window.__marks);
  const at = (name) => marks.find((m) => m.name === name)?.t;
  const feed = await feedSince(feedStart);
  const heard = feed.find((f) => f.kind === "you")?.text ?? "";
  const proposal = feed.find((f) => f.kind === "proposal");
  const said = feed.filter((f) => f.kind === "ai" || f.kind === "rejected").map((f) => f.text).join(" ");
  const want = words(turn.line), got = words(heard);
  const wordAccuracy = want.length ? want.filter((w) => got.includes(w)).length / want.length : 0;
  const r = { turn: i + 1, line: turn.line, heard, wordAccuracy: +wordAccuracy.toFixed(2), reply: said || proposal?.text || "", proposal: proposal?.text ?? null,
    ms: { transcribe: at("transcribe") && at("transcribe") - released, answer: at("answer") && at("transcribe") && at("answer") - at("transcribe"),
      speech: at("speech") && at("answer") && at("speech") - at("answer"), play: at("playing") && at("speech") && at("playing") - at("speech"),
      total: at("playing") && at("playing") - released }, completed: !!done };
  // Orders: accept the proposal and see the engine take it.
  if (turn.expect) {
    r.proposalMatches = !!proposal && turn.expect.test(proposal.text);
    if (proposal) {
      await page.evaluate(() => { const g = window.game; g.cc.decide(g.cc.pending(), true); });
      const receipt = await until((n) => window.store.getState().cc.feed.slice(n).find((f) => f.kind === "done" || f.kind === "rejected") ?? null, feedStart, 30000);
      r.receipt = receipt ? { kind: receipt.kind, text: receipt.text } : null;
    }
  }
  results.push(r);
  log(`turn ${r.turn}: "${r.line}" -> heard "${r.heard}" (${Math.round((r.wordAccuracy) * 100)}%) | ${r.ms.total ? Math.round(r.ms.total) + " ms" : "no speech"} | ${r.proposal ? `proposal "${r.proposal}" ${r.receipt?.kind ?? "-"}` : (r.reply || "").slice(0, 90)}`);
  // Accept any placement proposal the companion raises meanwhile (a finished building).
  await page.waitForTimeout(1500);
  const pending = await page.evaluate(() => window.game.cc.pending()?.text ?? null);
  if (pending) { log(`  accepting follow-up: "${pending}"`); await page.evaluate(() => { const g = window.game; g.cc.decide(g.cc.pending(), true); }); await page.waitForTimeout(1500); }
}

// 4. Parity: the session, every accepted order included, replayed natively.
await page.evaluate(() => window.game.requestVerify());
const verify = await until(() => { const v = window.store.getState().verify; return v && !/\.\.\.$|…$/.test(v) ? v : null; }, null, 300000);
log("verify:", verify);
const relay = (await (await fetch(`${server}/api/companion/status`)).json()).relay;
await browser.close();

const totals = results.map((r) => r.ms.total).filter(Boolean).sort((a, b) => a - b);
const pct = (q) => totals.length ? Math.round(totals[Math.min(totals.length - 1, Math.floor(q * totals.length))]) : null;
const stage = (k) => { const v = results.map((r) => r.ms[k]).filter(Boolean).sort((a, b) => a - b); return v.length ? Math.round(v[Math.floor(v.length / 2)]) : null; };
const orders = results.filter((r) => TURNS[r.turn - 1].expect);
const summary = {
  mode, turns: results.length, spokenReplies: totals.length,
  latencyMs: { median: pct(0.5), p95: pct(0.95), max: totals.length ? Math.round(totals.at(-1)) : null,
    medianByStage: { transcribe: stage("transcribe"), answer: stage("answer"), speech: stage("speech"), play: stage("play") } },
  transcriptWordAccuracy: +(results.reduce((n, r) => n + r.wordAccuracy, 0) / results.length).toFixed(2),
  orders: { total: orders.length, proposed: orders.filter((r) => r.proposal).length, proposalMatches: orders.filter((r) => r.proposalMatches).length,
    acceptedByEngine: orders.filter((r) => r.receipt?.kind === "done").length },
  verify, observationStream: relay.observations,
};
fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 2));
