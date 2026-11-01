// The one way to release the browser game at rtsai.net/play. It builds only from origin/main, rebuilds the runtime
// whenever the simulation source, the engine pin or the mod changed since the live runtime (and never otherwise),
// keeps the page settings in tools/release-play.json, checks everything in a real browser, and refuses when another
// release changed production in the meantime. Two steps, so production changes only on the owner's approval:
//   node tools/release-play.mjs status                 what is live, what main would change, who holds the lock
//   node tools/release-play.mjs prepare --update "<what players get>" [--runtime rebuild] [--data <build-public output>]
//        [--inputs <prepare-inputs output>] [--sizes <dir>...] [--no-smoke] [--dry [--engine <commit>]]
//        [--published-site: verify/export the already-live website commit as a Git-free build dependency]
//     builds, smoke-tests, adds new runtime/data roots to Cloudflare (immutable, unused until the page names them)
//     and makes a Vercel PREVIEW of the page, checked byte for byte. Production is untouched.
//     --dry: build and smoke-test only (new roots served locally); deploys nothing, and may run on unpushed commits
//     on top of origin/main, and with --engine <commit> on an engine commit that is not pinned yet.
//   node tools/release-play.mjs promote                 the prepared preview to production, then checks rtsai.net/play
//   node tools/release-play.mjs abort                   gives up the prepared release (and the lock)
// The release in progress is <work>/release.json; it is also the lock: one release at a time on this machine.
// Receipts of finished releases are in <work>/releases/.
import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createSaveVersionCatalog, refreshSaveClients } from './save-version-catalog.mjs';
import { publishedSiteInput, verifySiteInput } from './release-site-input.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(fs.readFileSync(path.join(repo, "tools", "release-play.json"), "utf8"));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const all = (k) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []));
const flag = (k) => argv.includes(`--${k}`);
const work = path.resolve(config.work);
const lockFile = path.join(work, "release.json");
const host = config.cdn.host;

class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message); };
const run = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, ...o })?.trim();
const git = (...a) => run("git", a, { cwd: repo });
const gitIn = (dir, ...a) => run("git", a, { cwd: dir });
const sha = (algo, buf) => crypto.createHash(algo).update(buf).digest("hex");
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const walk = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const f = path.join(dir, e.name);
  return e.isDirectory() ? walk(f, base) : [[path.relative(base, f).split(path.sep).join("/"), f]];
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log(...a);
const step = (s) => console.log(`\n== ${s}`);

// ---------------------------------------------------------------------------------------------------------------
// Sources

/** The runtime's source identity within this repository: sim/ (minus the native tools, not part of the runtime) and
 *  the root build props. Two commits with the same value build the same runtime from the same engine and mod. */
function runtimeSourceHash(rev) {
  const lines = git("ls-tree", "-r", rev, "--", "sim", "Directory.Build.props", "Directory.Packages.props", "global.json", "NuGet.config")
    .split("\n").filter((l) => l && !l.includes("\tsim/OpenRA.WebSim.Native/"));
  return sha("sha256", lines.join("\n")).slice(0, 16);
}

function source() {
  git("fetch", "--quiet", "origin");
  const head = git("rev-parse", "HEAD"), main = git("rev-parse", "origin/main");
  // Untracked files count under web/ (web/public is copied into the page) and sim/; ignored ones (node_modules) do not.
  const dirty = git("status", "--porcelain", "--", "web", "sim", "tools", "scenarios", "Directory.Build.props");
  return { head, main, dirty };
}

/** The engine every new runtime is built with: RTSAI-Mod main's pin, which must already be pushed. */
function enginePin() {
  gitIn(config.repos.mod, "fetch", "--quiet", "origin");
  const m = gitIn(config.repos.mod, "show", "origin/main:mod.config").match(/^ENGINE_VERSION="([0-9a-f]{40})"/m);
  if (!m) refuse("RTSAI-Mod origin/main has no ENGINE_VERSION in mod.config");
  const [remote] = config.repos.engineBranch.split("/");
  gitIn(config.repos.engine, "fetch", "--quiet", remote);
  const on = gitIn(config.repos.engine, "branch", "-r", "--contains", m[1]).split("\n").map((s) => s.trim());
  if (!on.includes(config.repos.engineBranch)) refuse(`the engine pin ${m[1].slice(0, 10)} is not on ${config.repos.engineBranch}: push the engine branch first`);
  return m[1];
}

/** The mod snapshot (tools/prepare-inputs.py output) whose mod identity is the data root's: the runtime compiles the
 *  mod's code from it, so code and rules come from the same mod source. */
function inputsFor(modHash) {
  // Also any <root>/rtsai-*/inputs and <root>/rtsai-*/release/inputs, where sessions keep their snapshots.
  const found = (config.inputsRoots ?? []).flatMap((root) => (fs.existsSync(root) ? fs.readdirSync(root) : [])
    .filter((d) => d.startsWith("rtsai-")).flatMap((d) => [path.join(root, d, "inputs"), path.join(root, d, "release", "inputs")]));
  const candidates = [opt("inputs"), ...config.inputsSearch, ...found].filter(Boolean);
  for (const dir of candidates) {
    const f = path.join(dir, "build-inputs.json");
    if (fs.existsSync(f) && JSON.parse(fs.readFileSync(f, "utf8")).inputs?.mod === modHash && fs.existsSync(path.join(dir, "mod"))) return path.resolve(dir);
  }
  refuse(`no prepare-inputs output with mod ${modHash.slice(0, 12)} (looked in ${candidates.length} folders, e.g. ${candidates.slice(0, 3).join(", ")}): pass --inputs <dir>`);
}

// ---------------------------------------------------------------------------------------------------------------
// Live state

let vercelToken;
async function vercel(p, init = {}) {
  if (!vercelToken) {
    execSync("vercel whoami", { stdio: "ignore" }); // refreshes the CLI's login token
    const dir = process.env.APPDATA ? path.join(process.env.APPDATA, "xdg.data") : path.join(os.homedir(), ".local", "share");
    vercelToken = JSON.parse(fs.readFileSync(path.join(dir, "com.vercel.cli", "auth.json"), "utf8")).token;
  }
  const r = await fetch(`https://api.vercel.com${p}${p.includes("?") ? "&" : "?"}slug=${config.vercel.team}`,
    { ...init, headers: { Authorization: `Bearer ${vercelToken}`, ...(init.headers ?? {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${init.method ?? "GET"} ${p}: ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function live() {
  const production = (await vercel(`/v13/deployments/${config.vercel.alias}`)).id;
  const r = await fetch(`https://${config.vercel.alias}/BUILD.json?release=${Date.now()}`);
  if (!r.ok) refuse(`live BUILD.json: ${r.status}`);
  const build = await r.json();
  const commit = build.frontendSourceCommit?.split("@")[1];
  if (!commit) refuse("the live BUILD.json names no page commit");
  return { production, build, commit };
}

/** What the live runtime was built from: recorded in BUILD.json by this tool, or listed in release-play.json. */
function runtimeOf(build) {
  if (build.runtimeSource) return build.runtimeSource;
  const known = config.knownRuntimes[build.rtRoot];
  return known && { webgame: git("rev-parse", known.webgame), hash: runtimeSourceHash(known.webgame), engine: known.engine, mod: known.mod };
}

/**
 * The usage report the workspace rules ask for before a production deployment. Vercel counts billing periods in Los
 * Angeles time and answers "Costs not found (404)" for a period with no costs recorded yet, so for the first hours of a
 * new period this reports the previous one instead (and says so). Any other failure still refuses.
 */
function vercelUsage(team) {
  const run = (extra) => spawnSync(`vercel usage --scope ${team}${extra}`, { shell: true, encoding: "utf8" });
  const r = run("");
  if (r.status === 0) { process.stdout.write(r.stdout); return; }
  const text = `${r.stdout}${r.stderr}`;
  if (!/Costs not found \(404\)/.test(text)) { process.stdout.write(text); refuse("vercel usage failed"); }
  const la = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const first = new Date(la.getFullYear(), la.getMonth() - 1, 1), last = new Date(la.getFullYear(), la.getMonth(), 0);
  const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  say(`  the current billing period has no costs recorded yet (Vercel: Costs not found); the previous period ${day(first)}..${day(last)}:`);
  const prev = run(` --from ${day(first)} --to ${day(last)}`);
  process.stdout.write(`${prev.stdout}${prev.stderr}`);
  if (prev.status !== 0) refuse("vercel usage failed for the previous billing period too");
}

function readLock() {
  return fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, "utf8")) : null;
}

function describeLock(lock) {
  const alive = (() => { try { process.kill(lock.pid, 0); return true; } catch { return false; } })();
  return `${lock.stage} release ${lock.id} of ${lock.commit?.slice(0, 7)} started ${lock.startedAt} from ${lock.cwd} (pid ${lock.pid}${alive ? "" : ", no longer running"})`;
}

/** Everything prepare decides, without building anything. */
async function plan() {
  const src = source();
  const { production, build, commit } = await live();
  const pinned = enginePin();
  // --engine <commit> (dry runs only): build the runtime with an engine commit that is not pinned or pushed yet.
  const pin = opt("engine") ? gitIn(config.repos.engine, "rev-parse", "--verify", `${opt("engine")}^{commit}`) : pinned;
  const liveRuntime = runtimeOf(build);
  const hash = runtimeSourceHash("HEAD");
  const dataDir = opt("data");
  const data = dataDir ? JSON.parse(fs.readFileSync(path.join(dataDir, "BUILD.json"), "utf8")) : build;
  const mod = data.inputs?.inputs?.mod;
  const why = [];
  if (!liveRuntime) why.push(`the live runtime ${build.rtRoot} has no recorded source`);
  else {
    if (liveRuntime.hash !== hash) why.push(`sim/ changed since ${liveRuntime.webgame.slice(0, 7)} (the live runtime's source)`);
    if (liveRuntime.engine !== pin) why.push(`engine pin ${pin.slice(0, 10)} differs from the live runtime's ${liveRuntime.engine.slice(0, 10)}`);
    if (liveRuntime.mod !== mod) why.push(`the data's mod ${mod?.slice(0, 12)} differs from the live runtime's ${liveRuntime.mod?.slice(0, 12)}`);
  }
  if (flag("runtime") && opt("runtime") === "rebuild") why.push("--runtime rebuild");
  let ancestor = true;
  try { git("merge-base", "--is-ancestor", commit, "HEAD"); } catch { ancestor = false; }
  const pageChanged = ancestor ? git("diff", "--name-only", commit, "HEAD", "--", "web").split("\n").filter(Boolean).length : null;
  const settingsChanged = JSON.stringify(build.pageSettings ?? null) !== JSON.stringify(config.page);
  gitIn(config.repos.site, "fetch", "--quiet", "origin");
  const siteMain = gitIn(config.repos.site, "rev-parse", "origin/main");
  const siteChanged = build.release?.site !== siteMain;
  return { src, production, build, commit, pin, pinned, liveRuntime, hash, data, dataDir, mod, why, ancestor, pageChanged, settingsChanged, siteMain, siteChanged };
}

// ---------------------------------------------------------------------------------------------------------------
// Builds

/** The pinned engine as a private, Git-free copy, stamped the way tools/public.py stamps its engine copy. */
function engineCopy(pin) {
  const dir = path.join(work, `engine-${pin.slice(0, 12)}`);
  if (fs.existsSync(path.join(dir, ".release-engine"))) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const tar = `${dir}.tar`;
  gitIn(config.repos.engine, "archive", "--format=tar", "-o", tar, pin);
  const windowsTar = path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe");
  run(fs.existsSync(windowsTar) ? windowsTar : "tar", ["-xf", tar, "-C", dir]);
  fs.rmSync(tar);
  fs.writeFileSync(path.join(dir, "VERSION"), `${pin}\n`);
  for (const mod of fs.readdirSync(path.join(dir, "mods"))) {
    const f = path.join(dir, "mods", mod, "mod.yaml");
    if (fs.existsSync(f)) fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/Version: .*/g, `Version: ${pin}`));
  }
  fs.writeFileSync(path.join(dir, ".release-engine"), `${pin}\n`);
  return dir;
}

const brotli = (raw) => zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
  [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });

/** AOT runtime from this checkout, the pinned engine and the data's mod snapshot, as a root laid out and named
 *  exactly like tools/build-public.mjs lays it out: rt-<hash>/<profile>/aot/_framework/<file>, brotli in place.
 *  dir/runtime.json is written last; a dir that has it is a finished build of the same sources and is reused. */
function buildRuntime(rel, pin, inputs, profiles) {
  const meta = path.join(rel, "runtime.json");
  if (fs.existsSync(meta)) {
    say(`  reusing the runtime built from the same sources in ${rel}`);
    return { ...JSON.parse(fs.readFileSync(meta, "utf8")), framework: path.join(rel, "wasm-aot", "wwwroot", "_framework") };
  }
  fs.rmSync(rel, { recursive: true, force: true });
  fs.mkdirSync(rel, { recursive: true });
  const engine = engineCopy(pin);
  const out = path.join(rel, "wasm-aot");
  const tmp = path.join(work, "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const logFile = path.join(rel, "publish.log");
  say(`dotnet publish (AOT, several minutes): engine ${pin.slice(0, 10)}, mod ${inputs}; log ${logFile}`);
  const fd = fs.openSync(logFile, "w");
  try {
    execFileSync(config.dotnet ?? "dotnet", ["publish", "sim/OpenRA.WebSim.Browser/OpenRA.WebSim.Browser.csproj", "-c", "Release", "--runtime", "browser-wasm", "-p:DefineConstants=BROWSER",
      "-p:WebProfile=public", `-p:EngineRoot=${engine.replaceAll("\\", "/")}/`, `-p:ModRoot=${inputs.replaceAll("\\", "/")}/mod/`,
      `-p:WebBuildRoot=${path.join(work, "web-build").replaceAll("\\", "/")}/`, "-p:Aot=true", "-o", out],
    { cwd: repo, stdio: ["ignore", fd, fd], env: { ...process.env, TEMP: tmp, TMP: tmp } });
  } catch {
    refuse(`the runtime build failed: see ${logFile}`);
  } finally {
    fs.closeSync(fd);
  }
  const framework = path.join(out, "wwwroot", "_framework");
  run(process.execPath, [path.join(repo, "tools", "stamp-runtime.mjs"), framework]);
  run(process.execPath, [path.join(repo, "tools", "verify-runtime.mjs"), framework]);
  const files = fs.readdirSync(framework).map((f) => path.join(framework, f)).filter((f) => fs.statSync(f).isFile());
  const h = crypto.createHash("sha256");
  for (const f of [...files].sort()) h.update(path.basename(f)).update(fs.readFileSync(f));
  const rtRoot = `rt-${h.digest("hex").slice(0, 12)}/`;
  let raw = 0, wire = 0;
  for (const f of files) {
    const bytes = fs.readFileSync(f), packed = brotli(bytes);
    for (const profile of profiles) {
      const to = path.join(rel, "roots", rtRoot, profile, "aot", "_framework", path.basename(f));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, packed);
      raw += bytes.length; wire += packed.length;
    }
  }
  const result = { rtRoot, files: files.length * profiles.length, raw, wire };
  fs.writeFileSync(meta, `${JSON.stringify(result, null, 2)}\n`);
  return { ...result, framework };
}

function firebaseEnv() {
  for (const f of config.firebaseEnv.map((f) => path.resolve(repo, f))) {
    if (!fs.existsSync(f)) continue;
    const env = Object.fromEntries(fs.readFileSync(f, "utf8").split(/\r?\n/)
      .map((l) => l.match(/^\s*(VITE_FIREBASE_[A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
    if (["VITE_FIREBASE_API_KEY", "VITE_FIREBASE_AUTH_DOMAIN", "VITE_FIREBASE_PROJECT_ID", "VITE_FIREBASE_APP_ID"].every((k) => env[k])) return env;
  }
  refuse(`no rtsai-net Firebase web config in ${config.firebaseEnv.join(" or ")} (see docs/DEPLOY-PUBLIC.md)`);
}

/** Vite also reads web/.env* files: anything there beyond the Firebase keys would change the page behind the
 *  settings in release-play.json. */
function checkEnvFiles() {
  const web = path.join(repo, "web");
  const stray = fs.readdirSync(web).filter((f) => f.startsWith(".env")).flatMap((f) => fs.readFileSync(path.join(web, f), "utf8").split(/\r?\n/)
    .map((l) => l.match(/^\s*(VITE_[A-Z0-9_]+)\s*=/)?.[1]).filter((k) => k && !k.startsWith("VITE_FIREBASE_")).map((k) => `${f}: ${k}`));
  if (stray.length) refuse(`web/.env* files set page settings that belong in tools/release-play.json: ${stray.join(", ")}`);
}

/** web/node_modules as web/package-lock.json says: a checkout installed before a dependency was added on main
 *  builds a page that fails (or worse, one that resolves a stale version). */
function webDependencies() {
  const web = path.join(repo, "web");
  const lock = sha("sha1", fs.readFileSync(path.join(web, "package-lock.json")));
  const marker = path.join(web, "node_modules", ".release-play-lock");
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === lock) return;
  say("  npm ci in web/ (installed for another package-lock.json)");
  execSync("npm ci --no-audit --no-fund", { cwd: web, stdio: "inherit" });
  fs.writeFileSync(marker, lock);
}

/** Build from the clean canonical website checkout at origin/main. Worktrees require an explicit owner request. */
function siteCheckout(webgame, publishedCommit) {
  const site = config.repos.site;
  gitIn(site, "fetch", "--quiet", "origin");
  const commit = gitIn(site, "rev-parse", "origin/main");
  if (gitIn(site, "branch", "--show-current") !== "main")
    refuse(`${site} must remain on canonical main`);
  let input = { dir: site, commit, webgame };
  if (flag("published-site")) {
    if (!/^[a-f0-9]{40}$/.test(publishedCommit ?? '')) refuse('live BUILD.json has no verified website source commit');
    try { gitIn(site, 'merge-base', '--is-ancestor', publishedCommit, 'origin/main'); }
    catch { refuse('the already-live website commit is not on origin/main; preserve pending work and coordinate its history'); }
    input = { ...publishedSiteInput(site, work, publishedCommit), originAtCapture: commit, webgame };
    say(`  verified frozen website dependency ${publishedCommit.slice(0, 7)}; canonical unpublished work is untouched`);
  }
  const dir = input.dir;
  if (!input.frozen && gitIn(dir, "rev-parse", "HEAD") !== commit)
    refuse(`${dir} must be on canonical main at origin/main before a release; no automatic worktree or checkout is created`);
  if (!input.frozen && gitIn(dir, "status", "--porcelain", "--untracked-files=no"))
    refuse(`${dir} has local source changes; commit and validate them on main before a release`);
  const lock = sha("sha1", fs.readFileSync(path.join(dir, "package-lock.json")));
  const marker = path.join(dir, "node_modules", ".release-play-lock");
  if (!input.sharedDependencies && (!fs.existsSync(marker) || fs.readFileSync(marker, "utf8") !== lock)) {
    say(`  npm ci in ${dir} (its package-lock.json changed)`);
    execSync("npm ci --no-audit --no-fund", { cwd: dir, stdio: "inherit" });
    fs.writeFileSync(marker, lock);
  }
  // The viewer data and the faction catalog (web/src/data/factions.json) are generated and ignored by Git: regenerate
  // them, or the page ships whatever an earlier sync left (build snapshots may not contain generated catalogs).
  fs.rmSync(path.join(repo, "web", "public", "viewer"), { recursive: true, force: true });
  // The website's reviewed generated metadata is committed with its release. Regenerating it from a sibling Mod
  // would mix local editing candidates into a production page whose runtime and data use frozen published inputs.
  run(process.execPath, [path.join(repo, "tools", "sync-viewer.mjs"), "--from", dir, "--published"], { stdio: ["ignore", "ignore", "inherit"] });
  run(process.execPath, [path.join(repo, "tools", "sync-catalog.mjs"), "--from", dir], { stdio: ["ignore", "ignore", "inherit"] });
  return input;
}

// A build may spend minutes compiling its already-captured runtime. Recheck page inputs around both Vite builds
// so a concurrent editor cannot silently change the page while BUILD.json still names the initial commit.
function assertPageSources(site) {
  const changed = git("diff", "--name-only", site.webgame, "--", "web");
  const untracked = git("ls-files", "--others", "--exclude-standard", "--", "web");
  if (changed || untracked) refuse(`web/ changed after release source capture ${site.webgame.slice(0, 7)}: coordinate a clean page window before retrying`);
  if (site.frozen) {
    verifySiteInput(site.dir);
    if (gitIn(site.canonical, "rev-parse", "origin/main") !== site.originAtCapture)
      refuse('published website origin/main changed during page build');
    if (site.sharedDependencies && sha('sha256', fs.readFileSync(path.join(site.canonical, 'package-lock.json'))) !== sha('sha256', fs.readFileSync(path.join(site.dir, 'package-lock.json'))))
      refuse('canonical website dependency lock changed during frozen-input build');
  } else if (gitIn(site.dir, "rev-parse", "HEAD") !== site.commit || gitIn(site.dir, "status", "--porcelain", "--untracked-files=no"))
    refuse(`website source changed after capture ${site.commit.slice(0, 7)}: preserve the pending work and retry in a clean page window`);
}

/** The page against the CDN roots: the real one (sign-in required) or the smoke-test twin (no sign-in gate). */
function buildPage(out, { rtBase, dataBase, profiles, gate, site }) {
  assertPageSources(site);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITE_")));
  Object.assign(env, config.page, {
    VITE_DEFAULT_PROFILE: "public", VITE_GAME_MODES: profiles.join(","), RTSAI_PUBLIC_BUILD: "1", VITE_STATIC_BUILD: "1",
    VITE_RT_BASE: rtBase, VITE_DATA_BASE: dataBase, VITE_FIREBASE_EMULATORS: "", RTSAI_SITE_ROOT: site.dir, RTSAI_SITE_COMMIT: site.commit,
  }, gate ? { ...firebaseEnv(), VITE_REQUIRE_SIGNIN: "1" }
    : { VITE_REQUIRE_SIGNIN: "", VITE_FIREBASE_API_KEY: "", VITE_FIREBASE_AUTH_DOMAIN: "", VITE_FIREBASE_PROJECT_ID: "", VITE_FIREBASE_APP_ID: "", VITE_FIREBASE_MEASUREMENT_ID: "" });
  fs.rmSync(out, { recursive: true, force: true });
  execSync(`npx vite build --outDir "${out}" --emptyOutDir${gate ? "" : " --mode nogate"} --logLevel warn`, { cwd: path.join(repo, "web"), stdio: "inherit", env });
  for (const [rel, f] of walk(out)) if (rel.endsWith(".map")) fs.rmSync(f);
  assertPageSources(site);
  say(`  ${gate ? "production" : "smoke"} page inputs captured: game ${site.webgame.slice(0, 7)}, website ${site.commit.slice(0, 7)}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Smoke test: the nogate twin of the page, served like a CDN, with the runtime and data from Cloudflare.

async function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

/** local: roots not on Cloudflare (a dry run), served next to the page with their header rules. */
async function smoke(rel, roots, profiles, local, site) {
  const dir = path.join(rel, "smoke-page");
  const base = (root) => (local[root] ? root : host + root);
  buildPage(dir, { rtBase: base(roots.rtRoot), dataBase: base(roots.dataRoot), profiles, gate: false, site });
  fs.copyFileSync(path.join(rel, 'page', 'save-versions.json'), path.join(dir, 'save-versions.json'));
  const savedClients = path.join(rel, 'page', 'saved-clients');
  if (fs.existsSync(savedClients)) for (const [name, file] of walk(savedClients)) {
    const target = path.join(dir, 'saved-clients', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
  }
  let headers = "/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n  Cross-Origin-Resource-Policy: same-origin\n";
  for (const [root, { from, rules }] of Object.entries(local)) {
    for (const [r, f] of walk(from)) {
      fs.mkdirSync(path.dirname(path.join(dir, root, r)), { recursive: true });
      try { fs.linkSync(f, path.join(dir, root, r)); } catch { fs.copyFileSync(f, path.join(dir, root, r)); }
    }
    headers += rules;
  }
  fs.writeFileSync(path.join(dir, "_headers"), headers);
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(repo, "tools", "static-serve.mjs"), "--dir", dir, "--port", String(port)], { stdio: "ignore" });
  try {
    for (let i = 0; i < 40 && !(await fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok).catch(() => false)); i++) await sleep(250);
    const runs = profiles.includes("public-classic") ? undefined : "public:skirmish-public,public:battle-originals,public:skirmish-public";
    const args = [path.join(repo, "tools", "release-smoke.mjs"), `http://127.0.0.1:${port}/`, "--shots", path.join(rel, "smoke-shots"), "--asset-origin", host, ...(runs ? ["--runs", runs] : [])];
    let out;
    try { out = run(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] }); } catch (e) { out = String(e.stdout ?? ""); }
    const line = out.split("\n").find((l) => l.startsWith("RESULT "));
    if (!line) refuse(`the smoke test printed no result:\n${out.slice(-2000)}`);
    const result = JSON.parse(line.slice(7));
    for (const m of result.matches) say(`  ${m.profile} ${m.scenario}: started in ${(m.startMs / 1000).toFixed(1)} s, ${m.ticks} ticks, ${m.actors} actors, WASM ${m.wasmMB} MB, garbage ${m.allocMBps ?? "?"} MB/s, textures ${m.textures} -> ${m.texturesAfterQuit} after quit`);
    if (!result.passed) refuse(`the smoke test failed: ${result.failures.join("; ")}`);
    return result;
  } finally {
    server.kill();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Cloudflare: the shared folder holds every root ever served; wrangler replaces the whole deployment with it.

/**
 * A new data root should have passed tools/gameplay-check.mjs (every death and impact draws, both games ship the same
 * units, the catalog copies agree): its receipt is keyed by the bundle's SHA-256. Warn-only for now (owner, 23 Oct
 * 2026): it becomes a refusal once a release has gone out with it.
 */
function gameplayReceipt(pack) {
  if (!fs.existsSync(pack)) { say(`  WARNING: no ${pack}; gameplay check not looked up`); return; }
  // Static data stores the bundle brotli-compressed; the check fingerprints the plain bundle (final/public).
  const bytes = fs.readFileSync(pack);
  const sha = crypto.createHash("sha256").update(bytes.subarray(0, 7).toString("latin1") === "ORAPACK" ? bytes : zlib.brotliDecompressSync(bytes)).digest("hex");
  const file = path.join(work, "gameplay-check", "receipts", `${sha}.json`);
  const fix = `run node tools/gameplay-check.mjs --pack ${pack}`;
  if (!fs.existsSync(file)) { say(`  WARNING: this data has not been through the gameplay check; ${fix}`); return; }
  const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  const games = Object.entries(receipt.results?.games ?? {}).map(([k, g]) => `${k} ${g.passed ? "agree" : `${g.new.length} new difference(s)`}`).join(", ");
  if (receipt.passed) say(`  gameplay check passed ${receipt.at.slice(0, 16)}Z (mod ${receipt.mod.slice(0, 7)}; ${games || "games not compared"})`);
  else say(`  WARNING: gameplay check FAILED ${receipt.at.slice(0, 16)}Z (${games || "effects"}${receipt.results?.catalog === false ? ", catalog copies differ" : ""}); see ${file}`);
}

function folderManifest(dir) {
  const files = {};
  for (const [rel, f] of walk(dir)) if (rel !== "MANIFEST.json") files[rel] = fs.statSync(f).size;
  return files;
}

async function cdnPublish(rel, roots, liveBuild) {
  const dir = config.cdn.dir;
  const added = [];
  // 0. Retired roots leave the deployment so it stays under Cloudflare's file limit: they are moved to cdn.retiredDir
  //    (never deleted; move one back to serve it again). Never the live page's roots, nor a root this release adds.
  const retired = (config.cdn.retired ?? []).map((r) => r.replace(/\/?$/, "/"));
  for (const r of retired) {
    if (r === liveBuild.rtRoot || r === liveBuild.dataRoot || r in roots) refuse(`${r} is live or being added: it cannot be retired`);
    const from = path.join(dir, r), to = path.join(config.cdn.retiredDir, r);
    if (fs.existsSync(from)) {
      if (fs.existsSync(to)) refuse(`${to} already exists: compare it with ${from} by hand`);
      fs.mkdirSync(config.cdn.retiredDir, { recursive: true });
      fs.renameSync(from, to);
      say(`  retired ${r} to ${config.cdn.retiredDir}`);
    } else if (!fs.existsSync(to)) refuse(`the retired root ${r} is in neither ${dir} nor ${config.cdn.retiredDir}`);
  }
  // 1. Nothing live may vanish: the folder must hold every file of the live manifest (or, before the first manifest,
  //    the live roots and the files release-play.json keeps), except the retired roots. Files under cdn.mutable (the
  //    campaign's films and index, which the page does not pin by hash) may change but not vanish.
  const local = folderManifest(dir);
  const liveManifest = await fetch(`${host}MANIFEST.json?release=${Date.now()}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  // The deployment control file gains an encoding rule for each new immutable runtime.
  // It must remain present, and its rules are validated below; it is not an immutable game asset.
  const mutable = (p) => p === '_headers' || (config.cdn.mutable ?? []).some((m) => p.startsWith(m));
  const missing = liveManifest
    ? Object.entries(liveManifest.files).filter(([p, size]) => !retired.some((r) => p.startsWith(r)) && (mutable(p) ? !(p in local) : local[p] !== size)).map(([p]) => p)
    : [liveBuild.rtRoot, liveBuild.dataRoot].filter((r) => !fs.existsSync(path.join(dir, r))).concat(config.cdn.keep.filter((p) => !(p in local)));
  if (missing.length) refuse(`${dir} lacks ${missing.length} live file(s), e.g. ${missing.slice(0, 5).join(", ")}: deploying it would delete them from ${host}`);

  // 2. The new roots (web-art.pack stays out: over Cloudflare's 25 MiB limit, and only read when a sheet is missing).
  for (const [root, from] of Object.entries(roots)) {
    const to = path.join(dir, root);
    if (fs.existsSync(to)) { say(`  ${root} is already in ${dir}`); continue; }
    for (const [relPath, f] of walk(from)) {
      if (relPath.endsWith("web-art.pack")) continue;
      fs.mkdirSync(path.dirname(path.join(to, relPath)), { recursive: true });
      fs.copyFileSync(f, path.join(to, relPath));
    }
    added.push(root);
  }
  // Missing files answer 404: Cloudflare Pages serves 404.html for them. Without it every unknown path got the root
  // index.html with HTTP 200, which a tab of a retired release took for its own files (faction showdown bug B2).
  const notFound = path.join(dir, "404.html");
  if (!fs.existsSync(notFound)) fs.writeFileSync(notFound, '<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not a file of <a href="https://rtsai.net/play/">rtsai.net/play</a>. Reload the game for the current version.</p>\n');
  // A runtime root needs its own rule (data roots are covered by the generic /:root/... rules).
  const headersFile = path.join(dir, "_headers");
  let headers = fs.readFileSync(headersFile, "utf8");
  for (const root of Object.keys(roots).filter((r) => r.startsWith("rt-") && !headers.includes(`/${r}*`))) {
    headers = `${headers.replace(/\n*$/, "\n")}/${root}*\n  Cache-Control: public, max-age=31536000, immutable\n  Content-Encoding: br\n`;
    fs.writeFileSync(headersFile, headers);
  }

  // 3. Cloudflare Pages limits: 100 header rules (the rest are silently ignored), 20,000 files, 25 MiB a file.
  const rules = headers.split(/\r?\n/).filter((l) => l.startsWith("/")).length;
  const files = folderManifest(dir);
  const big = Object.entries(files).filter(([, s]) => s > 25 * 1048576).map(([p]) => p);
  const rtRules = fs.readdirSync(dir).filter((d) => d.startsWith("rt-") && !headers.includes(`/${d}/*`));
  if (rules > 100) refuse(`${headersFile} has ${rules} rules; Cloudflare ignores all past 100`);
  if (Object.keys(files).length >= 20000) refuse(`${dir} has ${Object.keys(files).length} files; Cloudflare Pages takes under 20,000`);
  if (big.length) refuse(`files over 25 MiB: ${big.join(", ")}`);
  if (rtRules.length) refuse(`runtime roots without their Content-Encoding rule: ${rtRules.join(", ")}`);
  // A failed prepare can leave new roots staged on disk. Their presence is not proof they were deployed.
  // Retiring an alias copy also needs publication, even when this run adds no local files.
  const alreadyPublished = liveManifest && Object.keys(files).length === Object.keys(liveManifest.files).length
    && Object.entries(files).every(([name, size]) => liveManifest.files[name] === size);
  if (!added.length && alreadyPublished) { say("  Cloudflare already serves these roots"); return { deployed: false, added, rules, files: Object.keys(files).length }; }

  // 4. Deploy, with the manifest the next release checks against.
  fs.writeFileSync(path.join(dir, "MANIFEST.json"), JSON.stringify({ writtenAt: new Date().toISOString(), files }) + "\n");
  const output = execSync(`npx wrangler pages deploy "${dir}" --project-name ${config.cdn.project} --branch main --commit-dirty=true`, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  say(output);
  const deployment = output.match(/https:\/\/[a-f0-9]{8}\.rtsai-play-cdn\.pages\.dev/)?.[0];
  if (!deployment) refuse('Cloudflare did not return an immutable deployment URL for saved battles');
  return { deployed: true, added, rules, files: Object.keys(files).length, deployment };
}

/** Page-only releases still pin the existing data/runtime to a deployment that future CDN updates cannot change. */
function savedGameArchiveHost(cdn) {
  if (cdn.deployment) return cdn.deployment.replace(/\/*$/, '/');
  const list = JSON.parse(run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['wrangler', 'pages', 'deployment', 'list', '--project-name', config.cdn.project, '--json'], { cwd: work, shell: process.platform === 'win32' }));
  const deployment = list.find(d => d.Environment === 'Production' && d.Branch === 'main')?.Deployment;
  if (!deployment || !/^https:\/\/[a-f0-9]{8}\.rtsai-play-cdn\.pages\.dev$/.test(deployment)) refuse('No immutable production asset deployment is available for saved battles');
  return deployment + '/';
}

/** Cloudflare must serve the roots byte for byte (decoded), with the encoding the browser needs. */
async function cdnVerify(roots, runtime) {
  for (let attempt = 1; ; attempt++) {
    try {
      if (runtime) {
        for (const f of fs.readdirSync(runtime.framework)) {
          const r = await fetch(`${host}${roots.rtRoot}public/aot/_framework/${f}`);
          if (!r.ok) throw new Error(`${f}: ${r.status}`);
          if (sha("sha1", Buffer.from(await r.arrayBuffer())) !== sha("sha1", fs.readFileSync(path.join(runtime.framework, f)))) throw new Error(`${f} differs`);
        }
      }
      for (const p of [roots.rtRoot && `${roots.rtRoot}public/aot/_framework/dotnet.js`, roots.dataRoot && `${roots.dataRoot}public/web-bundle.pack`].filter(Boolean)) {
        const r = await fetch(`${host}${p}`, { method: "HEAD", headers: { "Accept-Encoding": "br" } });
        if (!r.ok || r.headers.get("content-encoding") !== "br") throw new Error(`${p}: ${r.status} ${r.headers.get("content-encoding")}`);
      }
      return;
    } catch (e) {
      if (attempt >= 6) refuse(`Cloudflare does not serve the roots correctly: ${e.message}`);
      await sleep(10000);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Vercel: a preview that keeps every live file (old pages' scripts and roots, for tabs still open) by SHA and adds the
// new page. Sizes of live files come from a cache by SHA, a HEAD, or (files compressed on the fly) a checked GET.

async function vercelPreview(rel, pageDir, production) {
  const tree = await vercel(`/v6/deployments/${production}/files`);
  const liveFiles = new Map();
  (function flat(nodes, p) {
    for (const n of nodes) {
      const q = p ? `${p}/${n.name}` : n.name;
      if (n.type === "directory") flat(n.children ?? [], q); else liveFiles.set(q.replace(/^src\//, ""), n.uid);
    }
  })(tree, "");
  const cacheFile = path.join(work, "vercel-sizes.json");
  const sizes = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};
  for (const dir of all("sizes")) for (const [, f] of walk(dir)) {
    const st = fs.statSync(f);
    if (st.size <= 300 * 1048576) sizes[sha("sha1", fs.readFileSync(f))] = st.size;
  }
  const unknown = [...liveFiles].filter(([, s]) => !(s in sizes));
  if (unknown.length) say(`  sizing ${unknown.length} live files (cached for next time)`);
  const origin = `https://${config.vercel.alias}/`;
  const queue = [...unknown];
  await Promise.all(Array.from({ length: 16 }, async () => {
    for (let item; (item = queue.shift());) {
      const [p, s] = item;
      const url = origin + p.split("/").map(encodeURIComponent).join("/");
      const h = await fetch(url, { method: "HEAD", headers: { "Accept-Encoding": "br" } });
      const len = Number(h.headers.get("content-length"));
      if (h.ok && len) { sizes[s] = len; continue; }
      const g = await fetch(url, { headers: { "Accept-Encoding": "identity" } });
      const buf = Buffer.from(await g.arrayBuffer());
      if (g.ok && sha("sha1", buf) === s) sizes[s] = buf.length;
    }
  }));
  // Files the site does not serve (vercel.json, .vercelignore): their contents from the deployment itself.
  for (const [, s] of [...liveFiles].filter(([, s]) => !(s in sizes))) {
    const file = await vercel(`/v8/deployments/${production}/files/${s}`).catch(() => null);
    const buf = file?.data != null ? Buffer.from(file.data, "base64") : null;
    if (buf && sha("sha1", buf) === s) sizes[s] = buf.length;
  }
  fs.writeFileSync(cacheFile, JSON.stringify(sizes));
  const unsized = [...liveFiles].filter(([, s]) => !(s in sizes)).map(([p]) => p);
  if (unsized.length) refuse(`no size for ${unsized.length} live Vercel file(s), e.g. ${unsized.slice(0, 3).join(", ")}: pass --sizes <dir with copies>`);

  const files = new Map([...liveFiles].map(([p, s]) => [p, { file: p, sha: s, size: sizes[s] }]));
  const liveShas = new Set(liveFiles.values());
  const uploads = [];
  for (const [p, f] of walk(pageDir)) {
    const buf = fs.readFileSync(f), s = sha("sha1", buf);
    files.set(p, { file: p, sha: s, size: buf.length });
    if (!liveShas.has(s)) uploads.push({ p, buf, s });
  }
  say(`  live ${liveFiles.size} files; page ${walk(pageDir).length} files, ${uploads.length} new; deployment ${files.size} files`);
  for (const u of uploads) {
    const r = await fetch(`https://api.vercel.com/v2/files?slug=${config.vercel.team}`, { method: "POST", body: u.buf,
      headers: { Authorization: `Bearer ${vercelToken}`, "Content-Type": "application/octet-stream", "x-vercel-digest": u.s, "Content-Length": String(u.buf.length) } });
    if (!r.ok) throw new Error(`upload ${u.p}: ${r.status} ${await r.text()}`);
  }
  const d = await vercel("/v13/deployments?skipAutoDetectionConfirmation=1", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: config.vercel.project, project: config.vercel.projectId, files: [...files.values()],
      projectSettings: { framework: null, buildCommand: null, installCommand: null, devCommand: null, outputDirectory: null } }) });
  for (let i = 0; i < 120; i++) {
    const s = await vercel(`/v13/deployments/${d.id}`);
    if (s.readyState === "READY") return { id: d.id, url: `https://${d.url}`, uploaded: uploads.length };
    if (["ERROR", "CANCELED"].includes(s.readyState)) refuse(`preview ${d.id} ${s.readyState}`);
    await sleep(3000);
  }
  refuse(`preview ${d.id} not ready after 6 minutes`);
}

/** `vercel curl` reaches previews behind deployment protection; it needs a folder linked to the project. */
function vcurl(deployment, p) {
  const link = path.join(work, "vercel-link", ".vercel");
  fs.mkdirSync(link, { recursive: true });
  fs.writeFileSync(path.join(link, "project.json"), JSON.stringify({ projectId: config.vercel.projectId, orgId: config.vercel.teamId, projectName: config.vercel.project }));
  const out = execSync(`vercel curl ${p} --deployment ${deployment} -- -s -i`, { cwd: path.dirname(link), env: { ...process.env, MSYS_NO_PATHCONV: "1" }, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28 });
  const split = out.indexOf("\r\n\r\n");
  const head = out.subarray(0, split).toString("latin1");
  return { status: Number(head.match(/^HTTP\/[\d.]+ (\d+)/)?.[1]), headers: head.toLowerCase(), body: out.subarray(split + 4) };
}

function checkPreview(preview, pageDir, build) {
  const b = vcurl(preview.id, "/BUILD.json");
  if (b.status !== 200 || JSON.stringify(JSON.parse(b.body.toString())) !== JSON.stringify(build)) refuse("the preview's BUILD.json is not the one built");
  const index = vcurl(preview.id, "/");
  // Vercel appends its feedback toolbar's script to a preview's HTML (never to production's): ignore exactly that.
  const served = index.body.toString().replace(/\n?<script async data-explicit-opt-in="true" data-deployment-id="[^"]*" src="https:\/\/vercel\.live\/[^"]*"><\/script>\s*$/, "\n");
  if (index.status !== 200 || served !== fs.readFileSync(path.join(pageDir, "index.html"), "utf8")) refuse("the preview's index.html is not the one built");
  for (const h of ["cross-origin-opener-policy: same-origin", "cross-origin-embedder-policy: require-corp"]) if (!index.headers.includes(h)) refuse(`the preview's page lacks ${h}`);
  const scripts = [...index.body.toString().matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  if (!scripts.length) refuse("no scripts found in the built index.html");
  for (const s of scripts) if (!vcurl(preview.id, `/${s}`).body.equals(fs.readFileSync(path.join(pageDir, s)))) refuse(`the preview's ${s} differs from the build`);
  return scripts.length;
}

// ---------------------------------------------------------------------------------------------------------------
// Commands

async function status() {
  const p = await plan();
  const lock = readLock();
  say(`checkout   ${repo}`);
  say(`HEAD       ${p.src.head.slice(0, 7)}${p.src.head === p.src.main ? " = origin/main" : `  (origin/main is ${p.src.main.slice(0, 7)}: releases build only from origin/main)`}${p.src.dirty ? "  UNCOMMITTED CHANGES" : ""}`);
  say(`production ${p.production}: page ${p.commit} (${p.build.frontendBuiltAt ?? p.build.builtAt}), runtime ${p.build.rtRoot}, data ${p.build.dataRoot}`);
  say(`           ${p.ancestor ? `main contains the live page; ${p.pageChanged} web/ file(s) changed since` : "THE LIVE PAGE IS NOT ON MAIN: a release from main would drop it (merge its branch first)"}`);
  say(`runtime    ${p.why.length ? `NEW RUNTIME NEEDED: ${p.why.join("; ")}` : `the live runtime matches main (source ${p.hash}, engine ${p.pin.slice(0, 10)})`}`);
  say(`engine pin ${p.pin.slice(0, 10)} (RTSAI-Mod origin/main)`);
  say(`website    RTSAI-Web origin/main ${p.siteMain.slice(0, 7)}${p.build.release?.site ? (p.siteChanged ? `, changed since the live page's ${p.build.release.site.slice(0, 7)}` : ", as in the live page") : ""}`);
  say(`lock       ${lock ? describeLock(lock) : "free"}`);
}

async function prepare() {
  const update = opt("update");
  if (!update) refuse('--update "<what players get>" is required (it goes into BUILD.json and the receipt)');
  fs.mkdirSync(work, { recursive: true });
  let fd;
  try { fd = fs.openSync(lockFile, "wx"); } catch {
    refuse(`another release holds the lock: ${describeLock(readLock())}. Finish it (promote) or give it up (abort) first`);
  }
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const rel = path.join(work, "releases", id);
  const state = { id, stage: "preparing", pid: process.pid, cwd: repo, startedAt: new Date().toISOString(), dir: rel };
  fs.mkdirSync(rel, { recursive: true });
  fs.writeSync(fd, JSON.stringify(state, null, 2));
  fs.closeSync(fd);
  const save = () => fs.writeFileSync(lockFile, JSON.stringify(state, null, 2) + "\n");
  try {
    step("sources");
    const p = await plan();
    Object.assign(state, { commit: p.src.head, base: { production: p.production, page: p.commit, rtRoot: p.build.rtRoot, dataRoot: p.build.dataRoot } });
    save();
    // A dry run may check commits not pushed yet, as long as they are on top of the latest main.
    let onMain = p.src.head === p.src.main;
    if (!onMain && flag("dry")) try { git("merge-base", "--is-ancestor", p.src.main, "HEAD"); onMain = true; } catch { /* behind or diverged */ }
    // A dry run reports what would stop the real release and goes on building.
    const blockers = [];
    const block = (message) => (flag("dry") ? blockers.push(message) : refuse(message));
    if (!onMain) block(`HEAD ${p.src.head.slice(0, 7)} is not origin/main ${p.src.main.slice(0, 7)}: releases build only from origin/main (git pull --ff-only, or merge your work into main first)`);
    if (p.pin !== p.pinned) {
      if (!flag("dry")) refuse("--engine is for dry runs: a release builds with RTSAI-Mod main's engine pin");
      blockers.push(`the engine ${p.pin.slice(0, 10)} is not RTSAI-Mod main's pin ${p.pinned.slice(0, 10)}: push rtsai/engine and repin first`);
    }
    if (p.src.dirty) block(`uncommitted changes would not be in the release:\n${p.src.dirty}`);
    if (!p.ancestor) block(`the live page ${p.commit} is not on origin/main: releasing main would drop it. Merge its branch into main first`);
    checkEnvFiles();
    if (!p.why.length && !p.dataDir && p.pageChanged === 0 && !p.settingsChanged && !p.siteChanged) block(`nothing to release: the live page ${p.commit} has the same web/ and website source, runtime and data as main`);
    const profiles = p.data.modes.map((m) => m.profile);
    say(`page ${p.src.head.slice(0, 7)} (live ${p.commit}, ${p.pageChanged ?? "?"} web/ file(s) changed); runtime: ${p.why.length ? `new (${p.why.join("; ")})` : `${p.build.rtRoot} unchanged`}; data: ${p.dataDir ? `new ${p.data.dataRoot}` : `${p.build.dataRoot} unchanged`}`);

    // The runtime (only when needed) and the data root.
    const roots = { rtRoot: p.build.rtRoot, dataRoot: p.data.dataRoot };
    const newRoots = {};
    let runtime = null, runtimeSource = p.liveRuntime;
    if (p.why.length) {
      step("runtime");
      if (!p.mod) refuse("the data's BUILD.json names no mod input");
      const inputs = inputsFor(p.mod);
      // Built from committed sources, a runtime is kept by source identity (a dry run's build serves the release).
      const simDirty = git("status", "--porcelain", "--", "sim", "Directory.Build.props");
      const runtimeDir = simDirty ? path.join(rel, "runtime") : path.join(work, "runtimes", `${p.hash}-${p.pin.slice(0, 12)}-${p.mod.slice(0, 12)}`);
      runtime = buildRuntime(runtimeDir, p.pin, inputs, profiles);
      roots.rtRoot = runtime.rtRoot;
      newRoots[runtime.rtRoot] = path.join(runtimeDir, "roots", runtime.rtRoot);
      runtimeSource = { webgame: p.src.head, hash: p.hash, engine: p.pin, mod: p.mod };
      say(`  ${runtime.rtRoot}: ${runtime.files} files, ${mb(runtime.raw)} raw, ${mb(runtime.wire)} brotli`);
    }
    if (p.dataDir) {
      if (!fs.existsSync(path.join(p.dataDir, p.data.dataRoot))) refuse(`${p.dataDir} has no ${p.data.dataRoot}`);
      newRoots[p.data.dataRoot] = path.join(p.dataDir, p.data.dataRoot);
      gameplayReceipt(path.join(p.dataDir, p.data.dataRoot, "public", "web-bundle.pack"));
    }
    Object.assign(state, { roots, runtimeSource });
    save();

    step("page");
    webDependencies();
    const site = siteCheckout(p.src.head, p.build.release?.site);
    const siteInput = site.frozen ? { kind: 'published-commit-export',
      manifestSha256: sha('sha256', fs.readFileSync(path.join(site.dir, '.release-site-input.json'))),
      files: Object.keys(verifySiteInput(site.dir).files).length } : { kind: 'canonical-checkout' };
    Object.assign(state, { siteInput }); save();
    say(`  website source: RTSAI-Web origin/main ${site.commit.slice(0, 7)}`);
    const pageDir = path.join(rel, "page");
    buildPage(pageDir, { rtBase: host + roots.rtRoot, dataBase: host + roots.dataRoot, profiles, gate: true, site });
    // A new content package owns its asset notices as well as its data roots.
    // Carry the audited Classic/isometric notice into the promoted page.
    if (p.dataDir && fs.existsSync(path.join(p.dataDir, "NOTICE")))
      fs.copyFileSync(path.join(p.dataDir, "NOTICE"), path.join(pageDir, "NOTICE"));
    const { frontendSourceCommit, frontendBuiltAt, frontendUpdate, assetHost, runtimeSource: _r, pageSettings: _s, release: _l, ...data } = p.data;
    const pageBytes = walk(pageDir).reduce((n, [, f]) => n + fs.statSync(f).size, 0);
    const build = { ...data, rtRoot: roots.rtRoot, dataRoot: roots.dataRoot,
      groups: { ...data.groups, page: { files: walk(pageDir).length, raw: pageBytes, wire: pageBytes },
        ...(runtime ? { "runtime (AOT)": { files: runtime.files, raw: runtime.raw, wire: runtime.wire } } : {}) },
      runtimeSource, pageSettings: config.page,
      frontendSourceCommit: `alibad/RTSAI-WebGame@${p.src.head.slice(0, 7)}`, frontendBuiltAt: new Date().toISOString(), frontendUpdate: update, assetHost: host,
      release: { tool: "tools/release-play.mjs", id, commit: p.src.head, site: site.commit, siteInput, base: p.production } };
    fs.writeFileSync(path.join(pageDir, "BUILD.json"), JSON.stringify(build, null, 2) + "\n");
    if (config.page.VITE_CAMPAIGN_BASE) {
      const r = await fetch(`${config.page.VITE_CAMPAIGN_BASE}index.json`, { method: "HEAD" });
      if (!r.ok) refuse(`the campaign files are not served at ${config.page.VITE_CAMPAIGN_BASE} (${r.status})`);
    }

    const dry = flag("dry");
    step(dry ? "cloudflare (dry run: checks the live roots only)" : "cloudflare");
    const cdn = dry || !Object.keys(newRoots).length ? { deployed: false, added: [] } : await cdnPublish(rel, newRoots, p.build);
    const local = dry ? Object.fromEntries(Object.entries(newRoots).map(([root, from]) => [root, { from, rules: root.startsWith("rt-")
      ? `/${root}*\n  Content-Encoding: br\n`
      : fs.readFileSync(path.join(p.dataDir, "_headers"), "utf8").split(/\n(?=\/)/).filter((b) => b.startsWith(`/${root}`)).join("\n").replace(/\n*$/, "\n") }])) : {};
    await cdnVerify({ rtRoot: local[roots.rtRoot] ? null : roots.rtRoot, dataRoot: local[roots.dataRoot] ? null : roots.dataRoot }, dry ? null : runtime);
    say(`  ${host} serves ${[roots.rtRoot, roots.dataRoot].filter((r) => !local[r]).join(" and ")} correctly`);
    Object.assign(state, { cdn });
    save();

    step('saved-game compatibility archive');
    const previousResponse = await fetch(`${config.vercel.public}save-versions.json`, { cache: 'no-store' });
    if (!previousResponse.ok && previousResponse.status !== 404) refuse(`the existing saved-game catalog could not be read (${previousResponse.status})`);
    const previousCatalog = previousResponse.ok ? await previousResponse.json() : null;
    const archiveHost = savedGameArchiveHost(cdn);
    const clientRoot = `saved-clients/${p.src.head.slice(0, 12)}/`;
    const archives = [...(config.saveArchiveSeeds ?? []), ...(dry && Object.keys(local).length ? [] : [{ ...roots, assetHost: archiveHost, profiles }])]
      .map(archive => ({ ...archive, clientRoot }));
    const saveCatalog = refreshSaveClients(await createSaveVersionCatalog(previousCatalog, archives), config.saveClientRefresh ?? [], clientRoot);
    fs.writeFileSync(path.join(pageDir, 'save-versions.json'), JSON.stringify(saveCatalog, null, 2) + '\n');
    build.saveArchive = { catalog: 'save-versions.json', versions: saveCatalog.versions.length, assetHost: archiveHost };
    fs.writeFileSync(path.join(pageDir, 'BUILD.json'), JSON.stringify(build, null, 2) + '\n');
    // Keep this compatible UI/worker too. Future wire-protocol changes must not strand an older simulation.
    // The ordinary release merger preserves these files on the same origin across all later deployments.
    const clientFiles = walk(pageDir);
    for (const [name, file] of clientFiles) {
      const target = path.join(pageDir, clientRoot, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file, target);
    }
    say(`  ${saveCatalog.versions.length} original engine/content pairs retained on immutable asset deployments`);

    step(`smoke test (the page without the sign-in gate, on the ${dry && Object.keys(local).length ? "new roots served locally and the" : ""} Cloudflare roots)`);
    state.smoke = flag("no-smoke") ? { skipped: true } : await smoke(rel, roots, profiles, local, site);
    save();
    if (dry) {
      state.stage = "dry run";
      state.blockers = blockers;
      fs.writeFileSync(path.join(rel, "receipt.json"), JSON.stringify(state, null, 2) + "\n");
      fs.rmSync(lockFile);
      say(`\nDry run passed; nothing was deployed. Build: ${rel}`);
      if (blockers.length) say(`A real prepare would refuse:\n${blockers.map((b) => `- ${b}`).join("\n")}`);
      return;
    }

    step("vercel preview");
    const preview = await vercelPreview(rel, pageDir, p.production);
    const scripts = checkPreview(preview, pageDir, build);
    say(`  ${preview.id} ${preview.url}: BUILD.json, index.html, isolation headers and ${scripts} script(s) match the build`);
    Object.assign(state, { stage: "prepared", preview, build: { rtRoot: build.rtRoot, dataRoot: build.dataRoot, frontendSourceCommit: build.frontendSourceCommit }, pageDir, update });
    save();
    say(`\nPrepared. Production is unchanged (${p.production}). With the owner's approval: node tools/release-play.mjs promote`);
  } catch (e) {
    // A failed prepare leaves nothing to promote: give the lock back, keep the record of why.
    state.stage = "failed";
    state.error = e.message;
    fs.mkdirSync(rel, { recursive: true });
    fs.writeFileSync(path.join(rel, "receipt.json"), JSON.stringify(state, null, 2) + "\n");
    fs.rmSync(lockFile, { force: true });
    throw e;
  }
}

async function promote() {
  const state = readLock();
  if (state?.stage === "promoted, checks failed") { await checkPromoted(state); return; }
  if (!state || state.stage !== "prepared") refuse(state ? `the release in progress is ${describeLock(state)}, not prepared` : "nothing is prepared: run prepare first");
  const now = await vercel(`/v13/deployments/${config.vercel.alias}`);
  if (now.id !== state.base.production) refuse(`production changed since prepare (now ${now.id}, prepared on ${state.base.production}): another release went out. Run abort, then prepare again from the new main`);
  // Workspace rules for a production deployment: standard build machine, and the usage report before it.
  const project = await vercel(`/v9/projects/${config.vercel.project}`);
  if (project.resourceConfig?.buildMachineType !== "standard") refuse(`${config.vercel.project} uses the ${project.resourceConfig?.buildMachineType} build machine, not standard`);
  step(`vercel usage --scope ${config.vercel.team}`);
  vercelUsage(config.vercel.team);
  step(`promote ${state.preview.id}`);
  execSync(`vercel promote ${state.preview.url} --scope ${config.vercel.team} --yes`, { stdio: "inherit", cwd: path.join(work, "vercel-link") });
  try {
    await checkPromoted(state);
  } catch (e) {
    // Production may already serve it: keep the lock and say so, so nobody prepares on top of an unchecked release.
    Object.assign(state, { stage: "promoted, checks failed", error: e.message });
    fs.writeFileSync(lockFile, JSON.stringify(state, null, 2) + "\n");
    throw e;
  }
}

async function checkPromoted(state) {
  let production = null;
  for (let i = 0; i < 40 && !production; i++) {
    const d = await vercel(`/v13/deployments/${config.vercel.alias}`);
    if (d.id !== state.base.production) production = d.id; else await sleep(3000);
  }
  if (!production) refuse(`${config.vercel.alias} still points at ${state.base.production} after promoting`);
  step(`check ${config.vercel.public}`);
  let build = null;
  for (let i = 0; i < 20; i++) {
    build = await fetch(`${config.vercel.public}BUILD.json?release=${Date.now()}`).then((r) => r.json()).catch(() => null);
    if (build?.release?.id === state.id) break;
    await sleep(3000);
  }
  if (build?.release?.id !== state.id) refuse(`${config.vercel.public} does not serve this release's BUILD.json yet (it names ${build?.frontendSourceCommit}); production is ${production}`);
  const page = await fetch(config.vercel.public);
  for (const h of ["cross-origin-opener-policy", "cross-origin-embedder-policy"]) if (!page.headers.get(h)) refuse(`${config.vercel.public} lacks ${h}`);
  Object.assign(state, { stage: "live", production, promotedAt: new Date().toISOString() });
  fs.mkdirSync(state.dir, { recursive: true });
  fs.writeFileSync(path.join(state.dir, "receipt.json"), JSON.stringify(state, null, 2) + "\n");
  fs.rmSync(lockFile);
  const cdn = state.cdn?.deployed ? `Cloudflare ${config.cdn.project}: added ${state.cdn.added.join(", ")} (${state.cdn.rules} header rules, ${state.cdn.files} files)` : "Cloudflare unchanged";
  say(`\nLIVE. For the release record (docs/RELEASE-*.md):
- Page main \`${state.commit.slice(0, 7)}\` on runtime \`${state.roots.rtRoot}\`${state.roots.rtRoot === state.base.rtRoot ? " (unchanged)" : ` (new; source ${state.runtimeSource.webgame.slice(0, 7)}, engine ${state.runtimeSource.engine.slice(0, 10)})`} and data \`${state.roots.dataRoot}\`${state.roots.dataRoot === state.base.dataRoot ? " (unchanged)" : " (new)"}.
- ${cdn}.
- Vercel: build machine standard; preview \`${state.preview.id}\` on production \`${state.base.production}\` with ${state.preview.uploaded} new file(s), checked (BUILD.json, index.html, isolation headers, scripts byte-identical); promoted to \`${production}\`; ${config.vercel.public} serves it.
- Smoke test: ${state.smoke?.skipped ? "skipped (--no-smoke)" : state.smoke.matches.map((m) => `${m.profile} ${m.scenario} ${m.ticks} ticks, WASM ${m.wasmMB} MB`).join("; ")}.
Receipt: ${path.join(state.dir, "receipt.json")}`);
}

function abort() {
  const state = readLock();
  if (!state) { say("no release in progress"); return; }
  state.stage = `aborted (was ${state.stage})`;
  fs.mkdirSync(state.dir, { recursive: true });
  fs.writeFileSync(path.join(state.dir, "receipt.json"), JSON.stringify(state, null, 2) + "\n");
  fs.rmSync(lockFile);
  const touched = state.stage.includes("promoted") ? "production WAS promoted to it and is unchecked: check rtsai.net/play" : "production was not touched by it";
  say(`aborted ${state.id}; ${touched}${state.cdn?.added?.length ? ` (Cloudflare keeps the roots ${state.cdn.added.join(", ")})` : ""}`);
}

const commands = { status, prepare, promote, abort };
const command = commands[argv[0]];
if (!command) {
  console.error("usage: node tools/release-play.mjs status|prepare|promote|abort  (see the top of this file)");
  process.exit(2);
}
try {
  await command();
} catch (e) {
  console.error(e instanceof Refusal ? `\nREFUSED: ${e.message}` : e);
  process.exit(1);
}
