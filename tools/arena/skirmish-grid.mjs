// Plays a list of AI-vs-AI skirmishes (tools/arena/skirmish-match.mjs), a few at a time, appending each RESULT to
// <run>/results.jsonl. Jobs already in the results file are skipped, so a stopped run carries on.
//   node tools/arena/skirmish-grid.mjs --run <folder> [--workers 3] [--limit 2400] [--speed 8] [--url <page>] [--bundle <pack>]
// <run>/jobs.json: [{ a, aSkill, b, bSkill, map, seed }], seat a against seat b. Replays go to <run>/replays/.
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
const key = (j) => `${j.a}|${j.b}|${j.map}|${j.seed}`;
const lines = () => (fs.existsSync(out) ? fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const done = new Set(lines().filter((r) => !r.failed).map(key));
const todo = jobs.filter((j) => !done.has(key(j)));
const t0 = Date.now();
console.log(`${jobs.length} jobs, ${done.size} done, ${todo.length} to play`);

function play(j) {
  return new Promise((resolve) => {
    const args = [path.join(here, "skirmish-match.mjs"), "--a", j.a, "--a-skill", j.aSkill ?? "normal", "--b", j.b, "--b-skill", j.bSkill ?? "normal", "--map", j.map, "--seed", String(j.seed),
      "--limit", opt("limit", "2400"), "--speed", opt("speed", "8"), "--out", run, ...(opt("url") ? ["--url", opt("url")] : []), ...(opt("bundle") ? ["--bundle", path.resolve(opt("bundle"))] : [])];
    const p = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    const kill = setTimeout(() => p.kill(), 60 * 60 * 1000);
    p.on("close", (code) => {
      clearTimeout(kill);
      const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
      resolve({ ...(line ? JSON.parse(line.slice(7)) : { failed: `exit ${code}: ${stderr.slice(-1500)}`, errors: [] }), id: j.id, a: j.a, b: j.b, map: j.map, seed: j.seed });
    });
  });
}

let next = 0, finished = 0;
async function worker() {
  while (next < todo.length) {
    const j = todo[next++];
    const r = await play(j);
    fs.appendFileSync(out, JSON.stringify(r) + "\n");
    finished++;
    console.log(`[${((Date.now() - t0) / 60000).toFixed(1)} min] ${finished}/${todo.length} ${j.a} (${j.aSkill ?? "normal"}) vs ${j.b} (${j.bSkill ?? "normal"}) on ${j.map}: ${r.failed ? "FAILED" : r.winner ?? "no winner"} at ${r.gameSeconds ?? "?"} s, wall ${r.wallSeconds} s, errors ${r.errors?.length ?? 0}`);
  }
}
await Promise.all(Array.from({ length: Number(opt("workers", 3)) }, worker));
console.log("all done");
