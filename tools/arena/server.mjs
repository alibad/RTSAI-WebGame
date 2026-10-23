// AI Arena runner: a loopback-only local service behind the admin's Arena page (RTSAI-Web /workshop/arena).
//   node tools/arena/server.mjs            (127.0.0.1:3463; RTSAI_ARENA_PORT overrides)
// It serves the live game's sign-in-free twin (the smoke page tools/release-play.mjs built for the release that is live)
// on 127.0.0.1:3464, plays queued matches in headless Chromium (tools/arena/match.mjs), opens a game window for the
// owner to play, and keeps every result, decision log and replay in %LOCALAPPDATA%\RTSAI-WebGame\arena. Paid decision
// providers use the owner's own keys and stop at the run's and the day's spending caps. Nothing here is deployed.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runMatch, OPPONENTS, BRAINS } from "./match.mjs";
import { PROVIDERS, PRICES, keyStore, localReady, layaReady } from "./providers.mjs";
import { runBench, BENCH_BRAINS } from "./bench.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.RTSAI_ARENA_PORT ?? 3463);
const PAGE_PORT = Number(process.env.RTSAI_ARENA_PAGE_PORT ?? 3464);
// RTSAI_ARENA_DIR: a separate data folder, e.g. for a trial runner beside the main one (with other ports).
const dir = process.env.RTSAI_ARENA_DIR ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "RTSAI-WebGame", "arena");
for (const sub of ["decisions", "replays"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
const { chromium } = await import(pathToFileURL(path.join(repo, "web", "node_modules", "playwright-core", "index.mjs")).href);
const keys = keyStore(dir);
export const MODERN = ["china", "iran", "turkey", "saudi", "israel", "yemen", "hezbollah"];
const MAPS = ["ra2-tournament-2B", "twin-fords", "harbor-line", "ra2-little-big-lake"];

// ---------------------------------------------------------------------------------------------------------------
// The game under test: the live release's twin page.

function livePage() {
  const config = JSON.parse(fs.readFileSync(path.join(repo, "tools", "release-play.json"), "utf8"));
  const releases = path.join(config.work, "releases");
  const live = (fs.existsSync(releases) ? fs.readdirSync(releases) : []).sort().reverse()
    .map((id) => { try { return { id, receipt: JSON.parse(fs.readFileSync(path.join(releases, id, "receipt.json"), "utf8")) }; } catch { return null; } })
    .find((r) => r?.receipt.stage === "live" && fs.existsSync(path.join(releases, r.id, "smoke-page", "index.html")));
  if (!live) return null;
  return { release: live.id, dir: path.join(releases, live.id, "smoke-page"), page: live.receipt.commit?.slice(0, 7), runtime: live.receipt.roots?.rtRoot, data: live.receipt.roots?.dataRoot, since: live.receipt.startedAt };
}
const page = livePage();
let pageServer = null;
if (page) {
  pageServer = spawn(process.execPath, [path.join(repo, "tools", "static-serve.mjs"), "--dir", page.dir, "--port", String(PAGE_PORT)], { stdio: "ignore" });
  process.on("exit", () => pageServer?.kill());
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(signal, () => process.exit(0));
}
const pageUrl = `http://127.0.0.1:${PAGE_PORT}/`;

function chromiumPath() {
  const root = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  const found = (fs.existsSync(root) ? fs.readdirSync(root) : []).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    .map((d) => path.join(root, d, "chrome-win64", "chrome.exe")).find((f) => fs.existsSync(f));
  return found ?? undefined;
}
const GPU = ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "--autoplay-policy=no-user-gesture-required"];
let headless = null, idleTimer = null;
async function browser() {
  clearTimeout(idleTimer);
  if (!headless?.isConnected()) headless = await chromium.launch({ executablePath: chromiumPath(), headless: true, args: [...GPU, "--mute-audio"] });
  return headless;
}
function maybeCloseBrowser() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!active.size && headless) { headless.close().catch(() => {}); headless = null; } }, 120000);
}

// ---------------------------------------------------------------------------------------------------------------
// Storage: games.jsonl (one finished game a line), decisions/<id>.json, replays/<id>.json, runs.json, budget.json.

const gamesFile = path.join(dir, "games.jsonl"), runsFile = path.join(dir, "runs.json"), budgetFile = path.join(dir, "budget.json");
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const games = fs.existsSync(gamesFile) ? fs.readFileSync(gamesFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const runs = readJson(runsFile, []);
for (const r of runs) if (["queued", "running"].includes(r.status)) { r.status = "stopped"; r.note = "The Arena runner restarted"; for (const j of r.jobs) if (j.state !== "done") j.state = "skipped"; }
const saveRuns = () => fs.writeFileSync(runsFile, JSON.stringify(runs.slice(-100), null, 1));
saveRuns();
const budget = readJson(budgetFile, { dailyCapUsd: 5, maxParallel: 2, spent: {} });
const today = () => new Date().toISOString().slice(0, 10);
const saveBudget = () => fs.writeFileSync(budgetFile, JSON.stringify(budget, null, 1));
const spentToday = () => budget.spent[today()] ?? 0;

export const competitor = (g) => (g.brain === "decision" ? `decision:${g.provider}` : g.brain);
const COMPETITOR_LABEL = (id) => id.startsWith("decision:") ? `Decision · ${PROVIDERS[id.slice(9)]?.label ?? id.slice(9)}` : id.startsWith("bot:") ? `${OPPONENTS[id.slice(4)]?.label ?? id.slice(4)} AI` : BRAINS[id]?.label ?? id;

// ---------------------------------------------------------------------------------------------------------------
// Queue

const active = new Map(); // job key -> { run, job }
function nextJob() {
  for (const run of runs) if (["queued", "running"].includes(run.status)) {
    const job = run.jobs.find((j) => j.state === "queued");
    if (job) return { run, job };
  }
  return null;
}
function pump() {
  const max = budget.maxParallel ?? 2;
  while ([...active.values()].filter((a) => a.job.brain !== "you").length < max) {
    const next = nextJob();
    if (!next) break;
    start(next.run, next.job);
  }
  for (const run of runs) if (run.status === "running" && run.jobs.every((j) => j.state !== "queued" && j.state !== "running")) { run.status = run.status === "running" ? "done" : run.status; run.finishedAt = new Date().toISOString(); saveRuns(); }
  if (!active.size) maybeCloseBrowser();
}

async function start(run, job) {
  job.state = "running"; run.status = "running"; saveRuns();
  const key = `${run.id}:${job.index}`;
  active.set(key, { run, job });
  const id = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${crypto.randomBytes(3).toString("hex")}`;
  const spec = { id, runId: run.id, brain: run.brain, provider: run.provider, opponent: job.opponent, ours: job.ours, theirs: job.theirs, map: run.map, seed: job.seed,
    speed: run.speed, limit: run.limit, pauseWhileThinking: run.pauseWhileThinking, page: page && { release: page.release, page: page.page, runtime: page.runtime, data: page.data } };
  try {
    let env;
    if (run.brain === "you") {
      // A real window for the owner, at normal speed and full size.
      const visible = await chromium.launch({ executablePath: chromiumPath(), headless: false, args: [...GPU, "--start-maximized"] });
      job.window = visible;
      const ctx = await visible.newContext({ viewport: null });
      env = { browser: { newPage: () => ctx.newPage() }, url: pageUrl, stopped: () => run.status === "stopped", charge: () => true, progress: (p) => Object.assign(job, p) };
    } else {
      env = { browser: await browser(), url: pageUrl, credential: PROVIDERS[run.provider]?.paid ? keys.credential(run.provider) : {}, stopped: () => run.status === "stopped",
        charge: (usd) => { run.spentUsd = (run.spentUsd ?? 0) + usd; budget.spent[today()] = spentToday() + usd; saveBudget(); return run.spentUsd < run.capUsd && spentToday() < budget.dailyCapUsd; },
        progress: (p) => Object.assign(job, p) };
    }
    const { result, decisions, replay } = await runMatch(spec, env);
    if (job.window) await job.window.close().catch(() => {});
    fs.writeFileSync(path.join(dir, "decisions", `${id}.json`), JSON.stringify(decisions));
    if (replay) fs.writeFileSync(path.join(dir, "replays", `${id}.json`), JSON.stringify(replay));
    const { pauseWhileThinking, ...kept } = result;
    games.push(kept);
    fs.appendFileSync(gamesFile, JSON.stringify(kept) + "\n");
    Object.assign(job, { state: "done", gameId: id, result: result.result });
    if (result.result === "stopped" && result.stopReason === "Spending cap reached") { run.status = "capped"; for (const j of run.jobs) if (j.state === "queued") j.state = "skipped"; }
  } catch (e) {
    Object.assign(job, { state: "done", result: "error", error: String(e.message ?? e).slice(0, 300) });
  } finally {
    active.delete(key);
    saveRuns();
    pump();
  }
}

function createRun(body) {
  const brain = BRAINS[body.brain] ? body.brain : null;
  if (!brain) throw new Error("Choose a brain.");
  const provider = brain === "decision" ? body.provider : null;
  if (brain === "decision" && !PROVIDERS[provider]) throw new Error("Choose a decision provider.");
  if (PROVIDERS[provider]?.paid && !keys.get(provider)) throw new Error(`Add your ${PROVIDERS[provider].label} key first.`);
  const opponents = (body.opponents ?? []).filter((o) => OPPONENTS[o]);
  if (!opponents.length) throw new Error("Choose at least one opponent.");
  const n = brain === "you" ? 1 : Math.max(1, Math.min(20, Number(body.games) || 2));
  const map = MAPS.includes(body.map) ? body.map : MAPS[0];
  const pick = (choice, i) => (choice && choice !== "rotate" && [...MODERN, "america", "russia"].includes(choice) ? choice : MODERN[i % MODERN.length]);
  const run = { id: crypto.randomBytes(4).toString("hex"), createdAt: new Date().toISOString(), status: "queued", brain, provider, map,
    speed: Math.max(1, Math.min(8, Number(body.speed) || 6)), limit: Math.max(300, Math.min(3600, Number(body.limit) || 2400)),
    capUsd: Math.max(0, Math.min(20, Number(body.capUsd) || 1)), spentUsd: 0, pauseWhileThinking: body.pauseWhileThinking !== false, jobs: [] };
  let index = 0;
  for (const opponent of opponents) for (let i = 0; i < n; i++) {
    const ours = pick(body.ours, i), theirs = body.theirs === "mirror" || !body.theirs ? ours : pick(body.theirs, i);
    run.jobs.push({ index: index++, opponent, ours, theirs, seed: 1000 + i, state: "queued", brain });
  }
  runs.push(run);
  saveRuns();
  pump();
  return run;
}

// ---------------------------------------------------------------------------------------------------------------
// Summary: win/draw/loss per competitor and opponent, one rating ladder, speed and cost.

function summary() {
  const finished = games.filter((g) => ["win", "loss", "draw"].includes(g.result));
  const matrix = {};
  for (const g of finished) {
    const c = competitor(g), cell = ((matrix[c] ??= {})[g.opponent] ??= { win: 0, draw: 0, loss: 0 });
    cell[g.result]++;
  }
  // Ratings: a Bradley-Terry fit on the Elo scale with two virtual draws per player, anchored at Normal AI = 1000.
  const players = new Set(), pairs = [];
  for (const g of finished) { const a = competitor(g), b = `bot:${g.opponent}`; players.add(a); players.add(b); pairs.push([a, b, g.result === "win" ? 1 : g.result === "draw" ? 0.5 : 0]); }
  const r = Object.fromEntries([...players].map((p) => [p, 1000]));
  for (let it = 0; it < 400; it++) {
    const grad = Object.fromEntries([...players].map((p) => [p, 0]));
    for (const [a, b, s] of pairs) { const e = 1 / (1 + 10 ** ((r[b] - r[a]) / 400)); grad[a] += s - e; grad[b] -= s - e; }
    for (const p of players) { const e = 1 / (1 + 10 ** ((1000 - r[p]) / 400)); grad[p] += 2 * (0.5 - e); r[p] += 12 * grad[p]; }
  }
  const shift = r["bot:normal"] !== undefined ? 1000 - r["bot:normal"] : 0;
  const counts = {};
  for (const [a, b] of pairs) { counts[a] = (counts[a] ?? 0) + 1; counts[b] = (counts[b] ?? 0) + 1; }
  const ladder = [...players].map((p) => ({ id: p, label: COMPETITOR_LABEL(p), rating: Math.round(r[p] + shift), games: counts[p], kind: p.startsWith("bot:") ? "opponent" : p === "you" ? "you" : "brain" }))
    .sort((a, b) => b.rating - a.rating);
  const perf = {};
  for (const g of games) {
    const c = competitor(g), p = (perf[c] ??= { label: COMPETITOR_LABEL(c), games: 0, decisions: 0, questions: 0, usd: 0, tokens: 0, ms: [], fallbacks: 0, wall: 0 });
    p.games++; p.decisions += g.decisionCount ?? 0; p.questions += g.questionCount ?? 0; p.usd += g.usd ?? 0; p.tokens += g.inputTokens ?? 0; p.fallbacks += g.fallbacks ?? 0; p.wall += g.wallSeconds ?? 0;
    if (g.ms?.p50) p.ms.push(g.ms.p50);
  }
  for (const p of Object.values(perf)) { const s = p.ms.sort((a, b) => a - b); p.msMedian = s.length ? s[Math.floor(s.length / 2)] : 0; delete p.ms; p.usdPerGame = p.games ? p.usd / p.games : 0; p.wallPerGame = p.games ? Math.round(p.wall / p.games) : 0; }
  return { matrix, ladder, perf, games: games.slice(-300).reverse() };
}

async function status() {
  const providers = {};
  const [local, laya] = await Promise.all([localReady(), layaReady()]);
  for (const [id, p] of Object.entries(PROVIDERS)) providers[id] = { ...p, keyHint: p.paid ? keys.hint(id) : "", ready: p.paid ? !!keys.get(id) : id === "local" ? local : id === "laya" ? laya : true, price: PRICES[id] ?? null };
  return { ready: !!page, page, pageUrl, providers, opponents: OPPONENTS, brains: BRAINS, factions: MODERN, maps: MAPS,
    budget: { dailyCapUsd: budget.dailyCapUsd, spentToday: spentToday(), maxParallel: budget.maxParallel ?? 2 },
    runs: runs.slice(-20).reverse().map(({ jobs, ...r }) => ({ ...r, jobs: jobs.map(({ window, ...j }) => j) })) };
}

// ---------------------------------------------------------------------------------------------------------------
// Voice-orders bench (bench.mjs): one at a time, in the background; records in <dir>/bench/<id>/record.json.

let benchJob = null;
const benchQueue = [];
function benchRecords() {
  const root = path.join(dir, "bench");
  return (fs.existsSync(root) ? fs.readdirSync(root) : []).sort().reverse()
    .map((id) => readJson(path.join(root, id, "record.json"), null)).filter(Boolean);
}
function startBench(spec) {
  if (spec.orders !== "offline" && PROVIDERS[spec.orders]?.paid && !keys.get(spec.orders)) throw new Error(`No key for ${PROVIDERS[spec.orders].label}.`);
  if (spec.orders === "laya") spec.needsLaya = true;
  benchQueue.push(spec);
  pumpBench();
  return { queued: benchQueue.length + (benchJob ? 1 : 0) };
}
async function pumpBench() {
  if (benchJob || !benchQueue.length) return;
  const spec = benchQueue.shift();
  benchJob = { ...spec, label: BENCH_BRAINS[spec.orders], state: "running", done: 0, last: "", startedAt: new Date().toISOString() };
  try {
    if (spec.needsLaya && !(await layaReady())) throw new Error("Laya is not running: start it in the BeTenshi console.");
    const record = await runBench({ orders: spec.orders, pathMode: spec.path, only: spec.only ?? "", dir, keys,
      progress: (line) => { if (/^(nl|ho)-\d+/.test(line)) { benchJob.done++; benchJob.last = line.replace(/\s+/g, " ").slice(0, 120); } },
      stopped: () => benchJob?.state === "stopping" });
    budget.spent[today()] = spentToday() + record.usd;
    saveBudget();
  } catch (e) {
    fs.mkdirSync(path.join(dir, "bench"), { recursive: true });
    benchJob.error = String(e.message ?? e).slice(0, 300);
  } finally {
    const finished = benchJob;
    benchJob = null;
    if (finished?.error) lastBenchError = { orders: finished.orders, error: finished.error, at: new Date().toISOString() };
    pumpBench();
  }
}
let lastBenchError = null;

// ---------------------------------------------------------------------------------------------------------------
// HTTP: loopback clients only; CORS for the admin pages on any loopback origin.

const loopback = (host) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host ?? "");
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const remote = req.socket.remoteAddress ?? "";
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote) || (origin && !loopback(new URL(origin).host))) { res.writeHead(403).end(); return; }
  if (origin) res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET, POST");
  res.setHeader("cross-origin-resource-policy", "cross-origin");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body)); };
  const body = async () => { let s = ""; for await (const c of req) { s += c; if (s.length > 1e5) throw new Error("too large"); } return s ? JSON.parse(s) : {}; };
  const url = new URL(req.url, "http://127.0.0.1");
  try {
    if (req.method === "GET" && url.pathname === "/status") return send(200, await status());
    if (req.method === "GET" && url.pathname === "/summary") return send(200, summary());
    let m = /^\/games\/([\w-]+)\/decisions$/.exec(url.pathname);
    if (req.method === "GET" && m) { const f = path.join(dir, "decisions", `${m[1]}.json`); return fs.existsSync(f) ? send(200, JSON.parse(fs.readFileSync(f, "utf8"))) : send(404, { error: "No decision log" }); }
    if (req.method === "POST" && url.pathname === "/runs") { if (!page) return send(409, { error: "No live game page to test." }); return send(200, createRun(await body())); }
    if (req.method === "POST" && url.pathname === "/play") {
      if (!page) return send(409, { error: "No live game page to test." });
      const b = await body();
      return send(200, createRun({ brain: "you", opponents: [b.opponent], ours: b.ours, theirs: b.theirs, map: b.map, limit: 3600 }));
    }
    m = /^\/runs\/(\w+)\/stop$/.exec(url.pathname);
    if (req.method === "POST" && m) {
      const run = runs.find((r) => r.id === m[1]);
      if (!run) return send(404, { error: "No such run" });
      if (["queued", "running"].includes(run.status)) { run.status = "stopped"; for (const j of run.jobs) if (j.state === "queued") j.state = "skipped"; saveRuns(); }
      return send(200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/bench") return send(200, { brains: BENCH_BRAINS, running: benchJob, queued: benchQueue, lastError: lastBenchError, records: benchRecords() });
    if (req.method === "POST" && url.pathname === "/bench") {
      const b = await body();
      if (!BENCH_BRAINS[b.orders]) return send(400, { error: "Choose a bench brain." });
      return send(200, startBench({ orders: b.orders, path: b.path === "pipeline" ? "pipeline" : "model", only: typeof b.only === "string" ? b.only : "" }));
    }
    if (req.method === "POST" && url.pathname === "/bench/stop") { if (benchJob) benchJob.state = "stopping"; benchQueue.length = 0; return send(200, { ok: true }); }
    if (req.method === "POST" && url.pathname === "/keys") {
      const b = await body();
      if (!PROVIDERS[b.provider]?.paid) return send(400, { error: "Unknown provider" });
      keys.set(b.provider, String(b.key ?? "").trim());
      return send(200, { keyHint: keys.hint(b.provider) });
    }
    if (req.method === "POST" && url.pathname === "/settings") {
      const b = await body();
      if (Number.isFinite(b.dailyCapUsd)) budget.dailyCapUsd = Math.max(0, Math.min(50, b.dailyCapUsd));
      if (Number.isFinite(b.maxParallel)) budget.maxParallel = Math.max(1, Math.min(4, Math.round(b.maxParallel)));
      saveBudget();
      return send(200, { ok: true });
    }
    send(404, { error: "Not found" });
  } catch (e) { send(400, { error: String(e.message ?? e) }); }
});
server.listen(PORT, "127.0.0.1", () => console.log(`AI Arena runner on http://127.0.0.1:${PORT}/ · game ${page ? `${page.page} (${page.release}) on ${pageUrl}` : "unavailable: no live release twin page"} · data ${dir}`));
