// The quality gate: one command before any release of rtsai.net/play, with a dated receipt. It runs the checks this
// repository already has, in one fixed order, so "it passed" means the same thing every time and can be read later:
//   source     the checkout is clean, on main, not behind the freshly fetched origin/main (unpushed commits are noted);
//   typecheck  web/ compiles (tsc --noEmit);
//   unit       the Node and Python tests that need no browser (tools/quality-gate.json "unit");
//   release    tools/release-play.mjs prepare --dry: the page built from main against the live Cloudflare roots and
//              tools/release-smoke.mjs played on it (five short matches, textures freed, nothing thrown); deploys nothing;
//   browser    the player's path on that same sign-in-free page, served locally (tools/quality-gate.json "browser");
//   gameplay   tools/gameplay-check.mjs when a new data root is being released (--pack), skipped when data is unchanged.
//   node tools/quality-gate.mjs [--only source,typecheck,unit,release,browser,gameplay] [--page-url <url>] [--pack <web-bundle.pack>]
//                               [--prepare "<what players get>"] [--data <dir>] [--inputs <dir>] [--runtime rebuild]
// --only runs a subset (the browser step then needs --page-url, or a release step before it).
// --prepare runs the real prepare (Vercel preview, new roots to Cloudflare) instead of the dry run; promote stays manual.
// Receipt: <work>/gate/<id>/ (receipt.json, GATE.md, one log per check) and a copy of GATE.md in
// hq/games/artifacts/quality-gate-<date>/. Exit code 1 on any failure. Hosted CI is not used (owner rule): run it here.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(fs.readFileSync(path.join(repo, "tools", "quality-gate.json"), "utf8"));
const releaseConfig = JSON.parse(fs.readFileSync(path.join(repo, "tools", "release-play.json"), "utf8"));
const work = path.resolve(releaseConfig.work);
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const all = ["source", "typecheck", "unit", "release", "browser", "gameplay"];
const only = opt("only") ? opt("only").split(",") : all;
for (const s of only) if (!all.includes(s)) { console.error(`unknown step ${s}; steps: ${all.join(", ")}`); process.exit(2); }
const timeouts = config.timeoutSeconds;

const id = new Date().toISOString().replace(/[:.]/g, "-");
const dir = path.join(work, "gate", id);
fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
const say = (...a) => console.log(...a);
const sec = (ms) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
const git = (args, cwd = repo) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

const receipt = { id, startedAt: new Date().toISOString(), repo, steps: [], commits: {} };
// python3 on this Windows box can be the Store stub, which exits non-zero: use whichever answers as Python 3.
const python = (() => {
  for (const exe of [process.env.PYTHON, "python3", "python"].filter(Boolean)) {
    const r = spawnSync(exe, ["-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "3") return exe;
  }
  return "python";
})();

/** Runs one check as a child process with a timeout; its output goes to a log; returns its result. */
function check(name, cmd, args, { env = {}, timeoutSeconds, cwd = repo } = {}) {
  const log = path.join(dir, "logs", `${name}.log`);
  const started = Date.now();
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 1 << 28, timeout: timeoutSeconds * 1000, killSignal: "SIGKILL", env: { ...process.env, ...env } });
  fs.writeFileSync(log, `$ ${cmd} ${args.join(" ")}\n${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  const timedOut = r.error?.code === "ETIMEDOUT" || (r.signal === "SIGKILL" && Date.now() - started >= timeoutSeconds * 1000 - 50);
  const lastLine = (r.stderr || r.stdout || "").trim().split("\n").filter((l) => l.trim()).slice(-1)[0] ?? "";
  const status = r.status === 0 ? "pass" : "fail";
  const note = status === "pass" ? "" : timedOut ? `timed out after ${timeoutSeconds} s` : (r.error ? r.error.message : lastLine.slice(0, 200));
  return { status, note, ms: Date.now() - started, log: path.relative(dir, log), stdout: r.stdout ?? "" };
}

function record(step, status, note = "", extra = {}) {
  receipt.steps.push({ step, status, note, ...extra });
  const mark = { pass: "PASS", fail: "FAIL", skip: "skip" }[status];
  say(`  ${mark.padEnd(5)} ${step}${note ? `: ${note}` : ""}`);
}

async function freePort() { return new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); }); }
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** Runs the scripts of one list (unit or browser) in order; returns their results. In a script's env and args,
 * "{url}" is the served page and "{out}" its output folder under the receipt. */
function runList(list, kind, vars = {}) {
  const results = [];
  for (const t of list) {
    const name = t.file.replace(/\.(mjs|py)$/, "");
    const out = path.join(dir, kind, name);
    fs.mkdirSync(out, { recursive: true });
    const sub = (v) => v.replace("{url}", vars.url ?? "").replace("{out}", out);
    const env = { RTSAI_TEST_OUT: out, CHAPTERS_SHOTS: out, PYTHON: python, ...Object.fromEntries(Object.entries(t.env ?? {}).map(([k, v]) => [k, sub(v)])) };
    const args = [path.join(repo, "tools", t.file), ...(t.args ?? []).map(sub)];
    const r = t.runner === "python"
      ? check(name, python, ["-B", ...args], { timeoutSeconds: timeouts[kind], env })
      : check(name, process.execPath, args, { timeoutSeconds: timeouts[kind], env });
    results.push({ file: t.file, status: r.status, note: r.note, ms: r.ms, log: r.log });
    say(`  ${r.status === "pass" ? "pass" : "FAIL"}  ${t.file.padEnd(34)} ${sec(r.ms).padStart(7)}${r.note ? `  ${r.note}` : ""}`);
  }
  return results;
}
const summarize = (step, results) => {
  const failed = results.filter((r) => r.status !== "pass");
  record(step, failed.length ? "fail" : "pass", failed.length ? `${failed.length} of ${results.length} failed: ${failed.map((f) => f.file).join(", ")}` : `${results.length} passed`, { results });
};

// -- source ---------------------------------------------------------------------------------------------------------
if (only.includes("source")) {
  say("\n== source");
  const dirty = git(["status", "--porcelain"]);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  spawnSync("git", ["fetch", "origin", "--quiet"], { cwd: repo, stdio: "ignore" });
  const [behind, ahead] = git(["rev-list", "--left-right", "--count", "origin/main...HEAD"]).split(/\s+/).map(Number);
  receipt.commits.webgame = git(["rev-parse", "--short", "HEAD"]);
  for (const [name, rel] of [["website", "../RTSAI-Web"], ["mod", "../RTSAI-Mod"]]) {
    const cwd = path.resolve(repo, rel);
    if (!fs.existsSync(cwd)) continue;
    spawnSync("git", ["fetch", "origin", "--quiet"], { cwd, stdio: "ignore" });
    receipt.commits[name] = git(["rev-parse", "--short", "origin/main"], cwd);
  }
  const problems = [];
  if (dirty) problems.push(`${dirty.split("\n").length} uncommitted file(s)`);
  if (branch !== "main") problems.push(`on ${branch}, not main`);
  if (behind) problems.push(`${behind} commit(s) behind origin/main: fetch and fast-forward first`);
  const state = `${receipt.commits.webgame} on main${ahead ? `, ${ahead} unpushed commit(s)` : ", level with origin/main"}; website ${receipt.commits.website}, mod ${receipt.commits.mod}`;
  record("source", problems.length ? "fail" : "pass", problems.length ? problems.join("; ") : state);
}

// -- typecheck ------------------------------------------------------------------------------------------------------
if (only.includes("typecheck")) {
  say("\n== typecheck (web/)");
  const r = check("typecheck", process.execPath, [path.join(repo, "web", "node_modules", "typescript", "bin", "tsc"), "-p", path.join(repo, "web"), "--noEmit"], { timeoutSeconds: timeouts.unit });
  record("typecheck", r.status, r.status === "pass" ? sec(r.ms) : r.note, { log: r.log });
}

// -- unit -----------------------------------------------------------------------------------------------------------
if (only.includes("unit")) {
  say(`\n== unit (${config.unit.length} scripts)`);
  summarize("unit", runList(config.unit, "unit"));
}

// -- release (dry run, or the real prepare) --------------------------------------------------------------------------
let build = null;
if (only.includes("release")) {
  const prepare = opt("prepare");
  say(`\n== release (${prepare ? "prepare: Vercel preview, no promote" : "dry run: page build + smoke, deploys nothing"})`);
  const args = [path.join(repo, "tools", "release-play.mjs"), "prepare", ...(prepare ? ["--update", prepare] : ["--dry", "--update", `quality gate ${id}`])];
  for (const k of ["data", "inputs", "engine", "runtime"]) if (opt(k)) args.push(`--${k}`, opt(k));
  const r = check("release", process.execPath, args, { timeoutSeconds: timeouts.release });
  const buildLine = r.stdout.split("\n").find((l) => /^Dry run passed; nothing was deployed\. Build: /.test(l));
  let buildDir = buildLine ? buildLine.replace(/^.*Build: /, "").trim() : null;
  if (!buildDir && prepare && fs.existsSync(path.join(work, "release.json"))) buildDir = JSON.parse(fs.readFileSync(path.join(work, "release.json"), "utf8")).dir;
  const rel = buildDir && fs.existsSync(path.join(buildDir, "receipt.json")) ? JSON.parse(fs.readFileSync(path.join(buildDir, "receipt.json"), "utf8")) : null;
  build = rel && { dir: buildDir, commit: rel.commit, base: rel.base, roots: rel.roots, smoke: rel.smoke, blockers: rel.blockers ?? [], stage: rel.stage };
  const smoke = build?.smoke?.matches ? build.smoke.matches.map((m) => `${m.profile}/${m.scenario}: ${(m.startMs / 1000).toFixed(1)} s to start, ${m.ticks} ticks, WASM ${m.wasmMB} MB, textures ${m.textures} -> ${m.texturesAfterQuit}`) : [];
  const wouldRefuse = build?.blockers?.length ? `; a real prepare would refuse: ${build.blockers.join(" | ")}` : "";
  record("release", r.status, r.status === "pass" ? `${build?.smoke?.matches?.length ?? "?"} smoke matches, ${sec(r.ms)}${wouldRefuse}` : r.note,
    { log: r.log, update: prepare ?? null, build: build && { dir: build.dir, commit: build.commit, base: build.base, roots: build.roots, blockers: build.blockers, smoke } });
}

// -- browser (the player's path on the sign-in-free page) --------------------------------------------------------------
if (only.includes("browser")) {
  say(`\n== browser (${config.browser.length} player-path tests)`);
  let url = opt("page-url");
  let server = null;
  const pageDir = build ? path.join(build.dir, "smoke-page") : null;
  if (!url && pageDir && fs.existsSync(pageDir)) {
    // A page-only release keeps the live NOTICE (the preview reuses every live file by SHA); the smoke page has none
    // unless the release carries data. The tests check it, so the served copy gets the one the release would keep.
    if (!fs.existsSync(path.join(pageDir, "NOTICE"))) {
      const fromPage = path.join(build.dir, "page", "NOTICE");
      if (fs.existsSync(fromPage)) fs.copyFileSync(fromPage, path.join(pageDir, "NOTICE"));
      else {
        const live = await fetch("https://rtsai.net/play/NOTICE").then((x) => (x.ok ? x.text() : null)).catch(() => null);
        if (live) { fs.writeFileSync(path.join(pageDir, "NOTICE"), live); say("  NOTICE: the live page's, which a page-only release keeps"); }
      }
    }
    const port = await freePort();
    server = spawn(process.execPath, [path.join(repo, "tools", "static-serve.mjs"), "--dir", pageDir, "--port", String(port)], { stdio: "ignore" });
    url = `http://127.0.0.1:${port}/`;
    for (let i = 0; i < 60 && !(await fetch(url).then((x) => x.ok).catch(() => false)); i++) await sleep(250);
    say(`  serving ${pageDir} at ${url}`);
  }
  if (!url) record("browser", "skip", "no page: run the release step first, or pass --page-url");
  else try {
    const results = runList(config.browser, "browser", { url });
    summarize("browser", results);
    receipt.steps[receipt.steps.length - 1].url = url;
  } finally { server?.kill(); }
}

// -- gameplay (data roots only) ----------------------------------------------------------------------------------------
if (only.includes("gameplay")) {
  say("\n== gameplay (data roots)");
  const pack = opt("pack");
  if (pack) {
    const r = check("gameplay", process.execPath, [path.join(repo, "tools", "gameplay-check.mjs"), "--pack", pack], { timeoutSeconds: timeouts.gameplay });
    record("gameplay", r.status, r.status === "pass" ? `${sec(r.ms)}; receipt in ${path.join(work, "gameplay-check", "receipts")}` : r.note, { log: r.log, pack });
  } else if (build?.roots?.dataRoot && build.base?.dataRoot && build.roots.dataRoot !== build.base.dataRoot) {
    record("gameplay", "fail", `new data root ${build.roots.dataRoot}: run again with --pack <data>/public/web-bundle.pack`);
  } else record("gameplay", "skip", build ? `data root ${build.base?.dataRoot ?? "?"} unchanged` : "no release step; pass --pack to check a data root");
}

// -- receipt ----------------------------------------------------------------------------------------------------------
receipt.finishedAt = new Date().toISOString();
receipt.passed = receipt.steps.every((s) => s.status !== "fail");
fs.writeFileSync(path.join(dir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
fs.writeFileSync(path.join(work, "gate", "latest.json"), JSON.stringify({ id, dir, passed: receipt.passed, steps: only, commit: receipt.commits.webgame ?? null, finishedAt: receipt.finishedAt }, null, 2) + "\n");
const md = [];
md.push(`# Quality gate ${id}: ${receipt.passed ? "PASSED" : "FAILED"}`, "");
md.push(`RTSAI-WebGame ${receipt.commits.webgame ?? "(source step not run)"}, website origin/main ${receipt.commits.website ?? "?"}, mod origin/main ${receipt.commits.mod ?? "?"}. ${receipt.startedAt} to ${receipt.finishedAt}.`, "");
md.push("| step | result | note |", "|---|---|---|");
for (const s of receipt.steps) md.push(`| ${s.step} | ${s.status.toUpperCase()} | ${s.note.replace(/\|/g, "/")} |`);
const rel = receipt.steps.find((s) => s.step === "release")?.build;
if (rel?.smoke?.length) { md.push("", "Smoke matches:", ""); for (const m of rel.smoke) md.push(`- ${m}`); }
for (const name of ["unit", "browser"]) {
  const s = receipt.steps.find((x) => x.step === name);
  if (s?.results?.some((r) => r.status !== "pass")) { md.push("", `${name} failures:`, ""); for (const r of s.results.filter((x) => x.status !== "pass")) md.push(`- ${r.file}: ${r.note} (${r.log})`); }
}
md.push("", `Logs and screenshots: ${dir}`, "");
fs.writeFileSync(path.join(dir, "GATE.md"), md.join("\n"));
const artifacts = path.resolve(repo, "..", "artifacts", `quality-gate-${id.slice(0, 10).replace(/-/g, "")}`);
try { fs.mkdirSync(artifacts, { recursive: true }); fs.copyFileSync(path.join(dir, "GATE.md"), path.join(artifacts, `${id}.md`)); } catch { /* the hq artifacts folder is optional */ }
say(`\n${receipt.passed ? "GATE PASSED" : "GATE FAILED"}: ${path.join(dir, "GATE.md")}`);
process.exit(receipt.passed ? 0 : 1);
