// Runs AI-vs-AI matches (tools/match.mjs) from a job list with N at a time, appending each RESULT to a JSONL file.
// Jobs already in the results file (same a, b, map, seed) are skipped, so a stopped run resumes. Each job is claimed
// (<run>/claims/) before it starts, so a second runner on the same run (more workers) never plays it twice; claims
// left by runners that are gone are dropped at start.
//   node tools/tournament.mjs --run runs/<name> [--workers 3] [--limit 2400] [--speed 8] [--url <page>] [--bundle <pack>]
// The run folder holds jobs.json; results.jsonl, replays/ and tournament.log are written there. A job may set
// units and cash (the lobby's starting units and starting cash).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const run = path.resolve(opt("run", "."));
const jobs = JSON.parse(fs.readFileSync(path.join(run, "jobs.json"), "utf8"));
const out = path.join(run, "results.jsonl");
const workers = Number(opt("workers", 3));
const limit = opt("limit", "2400");
const speed = opt("speed", "8");
const key = (j) => `${j.a}|${j.b}|${j.map}|${j.seed}`;
const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => key(JSON.parse(l))) : []);
// --reverse: from the end of the list (a second runner working toward the first one).
const todo = jobs.filter((j) => !done.has(key(j)));
if (argv.includes("--reverse")) todo.reverse();
const claims = path.join(run, "claims");
fs.mkdirSync(claims, { recursive: true });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
for (const f of fs.readdirSync(claims)) if (!alive(Number(fs.readFileSync(path.join(claims, f), "utf8")))) fs.rmSync(path.join(claims, f));
const claimFile = (j) => path.join(claims, key(j).replace(/[|:]/g, "_"));
function claim(j) {
  const finished = fs.existsSync(out) ? fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => { try { return key(JSON.parse(l)); } catch { return ""; } }) : [];
  if (finished.includes(key(j))) return false;
  try { fs.writeFileSync(claimFile(j), String(process.pid), { flag: "wx" }); return true; } catch { return false; }
}
const t0 = Date.now();
console.log(`${jobs.length} jobs, ${done.size} done, ${todo.length} to run, ${workers} workers`);

function runOne(j) {
  return new Promise((resolve) => {
    const args = [path.join(here, "match.mjs"), "--a", j.a, "--b", j.b, "--map", j.map, "--seed", String(j.seed), "--limit", limit, "--speed", speed,
      "--replays", path.join(run, "replays"), ...(opt("url") ? ["--url", opt("url")] : []), ...(opt("bundle") ? ["--bundle", path.resolve(opt("bundle"))] : []), ...(j.bot ? ["--bot", j.bot] : []), ...(j.units ? ["--units", j.units] : []), ...(j.cash ? ["--cash", String(j.cash)] : [])];
    const p = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    const kill = setTimeout(() => p.kill(), 120 * 60 * 1000);
    p.on("close", (code) => {
      clearTimeout(kill);
      const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
      const r = line ? JSON.parse(line.slice(7)) : { ...j, winner: null, failed: `exit ${code}: ${stderr.slice(-1500)}`, errors: [] };
      resolve({ ...r, a: j.a, b: j.b, map: j.map, seed: j.seed });
    });
  });
}

let next = 0, finished = 0;
async function worker() {
  while (next < todo.length) {
    const j = todo[next++];
    if (!claim(j)) continue;
    const r = await runOne(j);
    fs.appendFileSync(out, JSON.stringify(r) + "\n");
    fs.rmSync(claimFile(j), { force: true });
    finished++;
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    console.log(`[${mins} min] ${finished}/${todo.length} ${j.a} vs ${j.b} (${j.map} s${j.seed}): ${r.winner ?? (r.failed ? "FAILED" : "draw")} at ${r.gameSeconds ?? "?"} s, wall ${r.wallSeconds} s, errors ${r.errors?.length ?? 0}`);
  }
}
await Promise.all(Array.from({ length: workers }, worker));
console.log("all done");
