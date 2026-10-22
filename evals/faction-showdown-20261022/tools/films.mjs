// Films finished tournament matches from their replays (tools/film.mjs), N at a time, as they arrive in the run's
// results. --configs picks which starting settings to film ("<units>-<cash>", e.g. none-10000); default: all.
//   node tools/films.mjs --run runs/<name> [--configs none-10000,heavy-10000] [--workers 2] [--crf 28]
// Videos go to <run>/videos/.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const run = path.resolve(opt("run", "."));
const resultsFile = path.join(run, "results.jsonl");
const jobs = JSON.parse(fs.readFileSync(path.join(run, "jobs.json"), "utf8"));
const out = path.join(run, "videos");
const workers = Number(opt("workers", 2));
const configs = opt("configs", "") ? new Set(opt("configs").split(",")) : null;
const crf = opt("crf", "28");
fs.mkdirSync(out, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 60000).toFixed(1)} min]`, ...a);
const key = (r) => `${r.a}|${r.b}|${r.map}|${r.seed}`;
const config = (j) => `${j.units}-${j.cash}`;
const UNITS = { none: "No starting units", light: "Light starting units", medium: "Medium starting units", heavy: "Heavy starting units" };
// Match numbers count within a configuration (each has every pairing once).
const numbered = new Map();
const perConfig = {};
for (const j of jobs) { const c = config(j); perConfig[c] = (perConfig[c] ?? 0) + 1; numbered.set(key(j), { ...j, n: perConfig[c] }); }
const busy = new Set();
const failed = new Set();

function pending() {
  if (!fs.existsSync(resultsFile)) return [];
  return fs.readFileSync(resultsFile, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) // a line may be mid-append
    .filter((r) => r.replay && fs.existsSync(r.replay) && !r.failed)
    .filter((r) => { const j = numbered.get(key(r)); return j && (!configs || configs.has(config(j))); })
    .filter((r) => !busy.has(key(r)) && !failed.has(key(r)) && !fs.existsSync(path.join(out, `${r.a}-vs-${r.b}-s${r.seed}.json`)));
}

function film(r) {
  const j = numbered.get(key(r));
  const label = `Match ${j.n} of ${perConfig[config(j)]} · ${UNITS[j.units] ?? j.units} · $${Number(j.cash).toLocaleString("en-US")}`;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(here, "film.mjs"), "--replay", r.replay, "--result", resultsFile, "--out", out, "--label", label, "--crf", crf],
      { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    const kill = setTimeout(() => p.kill(), 60 * 60 * 1000);
    p.on("close", (code) => {
      clearTimeout(kill);
      const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
      if (!line) { failed.add(key(r)); log(`FAILED ${r.a} vs ${r.b}: exit ${code} ${stderr.slice(-600)}`); fs.appendFileSync(path.join(out, "failures.log"), `${key(r)} exit ${code}\n${stderr.slice(-3000)}\n${stdout.slice(-2000)}\n\n`); }
      else { const v = JSON.parse(line.slice(7)); log(`filmed ${r.a} vs ${r.b} (${config(j)}): ${v.videoSeconds} s of video, wall ${v.wallSeconds} s, gap ${v.longestFrameGapMs} ms, errors ${v.errors.length}`); }
      resolve();
    });
  });
}

const tournamentDone = () => fs.existsSync(path.join(run, "tournament.log")) && fs.readFileSync(path.join(run, "tournament.log"), "utf8").includes("all done");
async function worker() {
  for (;;) {
    const next = pending()[0];
    if (!next) { if (tournamentDone() && busy.size === 0) return; await new Promise((r) => setTimeout(r, 60000)); continue; }
    busy.add(key(next));
    await film(next);
    busy.delete(key(next));
  }
}
log(`filming ${configs ? [...configs].join(", ") : "every configuration"} of ${run}, ${workers} at a time`);
await Promise.all(Array.from({ length: workers }, worker));
log("all filmed");
