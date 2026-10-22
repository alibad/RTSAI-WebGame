// Gameplay a data release must keep, checked in the engine itself before it ships:
//  - websim effectsaudit: every roster unit of every faction killed by each damage set weapons deal leaves something on
//    screen (death animation, explosion, husk or fall), and every weapon with an explosion draws it on each kind of
//    target it can hit and as a miss on ground and water;
//  - websim effectstest: rendered infantry deaths and falling-aircraft land/water impacts in simulator and skirmish.
// Both read what the snapshot sends the browser (effects registered in the screen map), so "drawn" means drawn.
//   node tools/gameplay-check.mjs --pack <data>/public/web-bundle.pack [--work <dir>] [--factions a,b]
// Builds the native runner from the pinned engine (RTSAI-Mod origin/main mod.config, staged by release-play in its work
// folder) and origin/main's mod sources,
// unpacks the bundle with its art, and exits non-zero on any failure. Reports land in <work>/gameplay-check/.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(fs.readFileSync(path.join(repo, "tools", "release-play.json"), "utf8"));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const pack = opt("pack");
if (!pack || !fs.existsSync(pack)) { console.error("usage: node tools/gameplay-check.mjs --pack <data>/public/web-bundle.pack [--work <dir>] [--factions a,b]"); process.exit(2); }
const work = path.resolve(opt("work", config.work));
const out = path.join(work, "gameplay-check");
fs.mkdirSync(out, { recursive: true });
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28, ...options });
const git = (dir, ...args) => run("git", ["-C", dir, ...args]).trim();

// The engine the runtime is pinned to, and the mod sources of origin/main, as the release tool builds them.
const mod = config.repos.mod;
git(mod, "fetch", "--quiet", "origin");
const pin = git(mod, "show", "origin/main:mod.config").match(/^ENGINE_VERSION="([0-9a-f]{40})"/m)?.[1];
if (!pin) throw new Error("RTSAI-Mod origin/main has no ENGINE_VERSION");
const engine = path.join(config.work, `engine-${pin.slice(0, 12)}`);
if (!fs.existsSync(path.join(engine, ".release-engine"))) throw new Error(`${engine} is missing: run a release-play prepare (or --dry) once to stage the pinned engine`);
const modSha = git(mod, "rev-parse", "origin/main");
const modDir = path.join(out, `mod-${modSha.slice(0, 12)}`);
if (!fs.existsSync(path.join(modDir, "mod.config"))) {
  fs.mkdirSync(modDir, { recursive: true });
  const tar = `${modDir}.tar`;
  git(mod, "archive", "--format=tar", "-o", tar, modSha);
  const windowsTar = path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe");
  run(fs.existsSync(windowsTar) ? windowsTar : "tar", ["-xf", tar, "-C", modDir]);
  fs.rmSync(tar);
}
const build = path.join(out, "build");
console.log(`building websim: engine ${pin.slice(0, 10)}, mod ${modSha.slice(0, 7)}`);
run(config.dotnet ?? "dotnet", ["build", "sim/OpenRA.WebSim.Native/OpenRA.WebSim.Native.csproj", "-c", "Release", "-p:WebProfile=public", "-v:q", "-nologo",
  `-p:EngineRoot=${engine.replaceAll("\\", "/")}/`, `-p:ModRoot=${modDir.replaceAll("\\", "/")}/`, `-p:WebBuildRoot=${build.replaceAll("\\", "/")}/`], { cwd: repo });
const websim = path.join(build, "bin", "OpenRA.WebSim.Native-public", "Release", "net10.0", process.platform === "win32" ? "websim.exe" : "websim");

const vfs = path.join(out, "vfs");
fs.rmSync(vfs, { recursive: true, force: true });
console.log(run(websim, ["unpack", "--pack", path.resolve(pack), "--root", vfs]).trim());

let failed = 0;
const check = (name, args) => {
  let text, code = 0;
  try { text = run(websim, args); } catch (e) { text = String(e.stdout ?? ""); code = e.status ?? 1; }
  const last = text.trim().split("\n").at(-1) ?? "";
  const summary = (() => { try { return JSON.parse(last); } catch { return null; } })();
  const ok = code === 0 && summary?.passed === true;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${summary ? JSON.stringify({ ...summary, cases: undefined, first: summary.first?.slice(0, 10) }) : last.slice(0, 400)}`);
};
const factions = opt("factions") ? ["--factions", opt("factions")] : [];
check("effectsaudit (deaths and impacts, every faction)", ["effectsaudit", "--root", vfs, "--out", path.join(out, "effectsaudit.json"), ...factions]);
check("effectstest (rendered deaths, falling aircraft)", ["effectstest", "--root", vfs, "--map", "twin-fords"]);
console.log(failed ? `${failed} check(s) failed; reports in ${out}` : `all gameplay checks passed; reports in ${out}`);
process.exit(failed ? 1 : 0);
