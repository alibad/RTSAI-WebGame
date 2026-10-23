// Gameplay a data release must keep, checked in the engine itself before it ships:
//  - websim effectsaudit: every roster unit of every faction killed by each damage set weapons deal leaves something on
//    screen (death animation, explosion, husk or fall), and every weapon with an explosion draws it on each kind of
//    target it can hit and as a miss on ground and water;
//  - websim effectstest: rendered infantry deaths and falling-aircraft land/water impacts in simulator and skirmish.
// Both read what the snapshot sends the browser (effects registered in the screen map), so "drawn" means drawn.
//  - both games agree: the bundle's units against the desktop game as origin/main builds it, faction by faction (each
//    read by its own engine; tools/roster-audit/compare.py). Differences in tools/roster-audit/accepted-differences.json
//    pass, any other fails. Classic too when the bundle's public-classic sibling (or --classic-pack) is there;
//  - the faction catalog's copies all match the master (RTSAI-Mod tools/sync-faction-catalog.py --check).
//   node tools/gameplay-check.mjs --pack <data>/public/web-bundle.pack [--classic-pack <pack>] [--work <dir>]
//        [--factions a,b] [--skip-effects]
// Builds the native runner from the pinned engine (RTSAI-Mod origin/main mod.config, staged by release-play in its work
// folder) and origin/main's mod sources, and a second one against the desktop engine (canonical OpenRA fork/main),
// unpacks the bundle with its art, and exits non-zero on any failure. Reports land in <work>/gameplay-check/; a receipt
// keyed by the bundle's SHA-256 lands in <release work>/gameplay-check/receipts/, where release-play looks for it.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
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
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28, ...options });const git = (dir, ...args) => run("git", ["-C", dir, ...args]).trim();

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
const results = {};
const check = (name, args) => {
  let text, code = 0;
  try { text = run(websim, args); } catch (e) { text = String(e.stdout ?? ""); code = e.status ?? 1; }
  const last = text.trim().split("\n").at(-1) ?? "";
  const summary = (() => { try { return JSON.parse(last); } catch { return null; } })();
  const ok = code === 0 && summary?.passed === true;
  if (!ok) failed++;
  results[name] = ok;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${summary ? JSON.stringify({ ...summary, cases: undefined, first: summary.first?.slice(0, 10) }) : last.slice(0, 400)}`);
};
const factions = opt("factions") ? ["--factions", opt("factions")] : [];
if (!argv.includes("--skip-effects")) {
  check("effectsaudit (deaths and impacts, every faction)", ["effectsaudit", "--root", vfs, "--out", path.join(out, "effectsaudit.json"), ...factions]);
  check("effectstest (rendered deaths, falling aircraft)", ["effectstest", "--root", vfs, "--map", "twin-fords"]);
}

// Both games agree. The desktop game is what origin/main builds: canonical OpenRA fork/main's mods/common plus the mod's
// packs, read by a websim built against that engine (desktop manifests use FinalRules, which the web pin does not read).
const [remote] = config.repos.engineBranch.split("/");
git(config.repos.engine, "fetch", "--quiet", remote);
const desktopSha = git(config.repos.engine, "rev-parse", config.repos.engineBranch);
const desktopEngine = path.join(out, `desktop-engine-${desktopSha.slice(0, 12)}`);
if (!fs.existsSync(path.join(desktopEngine, ".desktop-engine"))) {
  fs.rmSync(desktopEngine, { recursive: true, force: true });
  fs.mkdirSync(desktopEngine, { recursive: true });
  const tar = `${desktopEngine}.tar`;
  git(config.repos.engine, "archive", "--format=tar", "-o", tar, desktopSha);
  const windowsTar = path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe");
  run(fs.existsSync(windowsTar) ? windowsTar : "tar", ["-xf", tar, "-C", desktopEngine]);
  fs.rmSync(tar);
  fs.writeFileSync(path.join(desktopEngine, "VERSION"), `${desktopSha}\n`);
  fs.writeFileSync(path.join(desktopEngine, ".desktop-engine"), `${desktopSha}\n`);
}
const desktopBuild = path.join(out, "build-desktop");
console.log(`building websim for the desktop game: engine ${desktopSha.slice(0, 10)}, mod ${modSha.slice(0, 7)}`);
run(config.dotnet ?? "dotnet", ["build", "sim/OpenRA.WebSim.Native/OpenRA.WebSim.Native.csproj", "-c", "Release", "-p:WebProfile=public", "-v:q", "-nologo",
  `-p:EngineRoot=${desktopEngine.replaceAll("\\", "/")}/`, `-p:ModRoot=${modDir.replaceAll("\\", "/")}/`, `-p:WebBuildRoot=${desktopBuild.replaceAll("\\", "/")}/`], { cwd: repo });
const desktopWebsim = path.join(desktopBuild, "bin", "OpenRA.WebSim.Native-public", "Release", "net10.0", process.platform === "win32" ? "websim.exe" : "websim");
const desktop = path.join(out, `desktop-${modSha.slice(0, 7)}-${desktopSha.slice(0, 7)}`);
if (!fs.existsSync(path.join(desktop, "mods", "common"))) {
  fs.mkdirSync(path.join(desktop, "mods"), { recursive: true });
  for (const name of ["common", "common-content"])
    if (fs.existsSync(path.join(desktopEngine, "mods", name))) fs.cpSync(path.join(desktopEngine, "mods", name), path.join(desktop, "mods", name), { recursive: true });
  for (const name of fs.readdirSync(path.join(modDir, "mods"))) fs.cpSync(path.join(modDir, "mods", name), path.join(desktop, "mods", name), { recursive: true });
}
const games = path.join(out, "games");
const support = path.join(out, "desktop-support");
fs.mkdirSync(games, { recursive: true });
fs.mkdirSync(support, { recursive: true });
const exportEnv = { env: { ...process.env, OPENRA_UTILITY_EXPERIENCE_PROFILE: "world-war-iii", DOTNET_GCHeapHardLimit: "0x80000000" } };
const classicPack = opt("classic-pack") ?? path.join(path.dirname(path.dirname(path.resolve(pack))), "public-classic", "web-bundle.pack");
const pairs = [{ key: "ra2", vfs, desktopMod: "rtsai" }];
if (fs.existsSync(classicPack)) {
  const vfsClassic = path.join(out, "vfs-classic");
  fs.rmSync(vfsClassic, { recursive: true, force: true });
  // Classic's manifest mounts original audio folders (web/ea/allies…), which only its audio pack provides.
  console.log(run(websim, ["unpack", "--pack", classicPack, "--root", vfsClassic, "--audio"]).trim());
  pairs.push({ key: "classic", vfs: vfsClassic, desktopMod: "rtsai-classic-core" });
} else console.log(`no Classic bundle beside the pack (${classicPack}): Classic not compared`);
results.games = {};
for (const { key, vfs: root, desktopMod } of pairs) {
  const web = path.join(games, `web-${key}.json`), desk = path.join(games, `desktop-${key}.json`);
  run(websim, ["rosteraudit", "--root", root, "--rules-only", "--out", web], exportEnv);
  run(desktopWebsim, ["rosteraudit", "--desktop", desktop, "--support", support, "--mod", desktopMod, "--out", desk], exportEnv);
  let text, code = 0;
  try {
    text = run("python", [path.join(repo, "tools", "roster-audit", "compare.py"), web, desk, "--accepted", path.join(repo, "tools", "roster-audit", "accepted-differences.json"),
      "--key", key, "--out", path.join(games, `differences-${key}.json`)]);
  } catch (e) { text = String(e.stdout ?? ""); code = e.status ?? 1; }
  const summary = JSON.parse(text);
  results.games[key] = { passed: code === 0, accepted: summary.accepted, new: summary.new, resolved: summary.resolved };
  if (code !== 0) failed++;
  console.log(`${code === 0 ? "PASS" : "FAIL"} both games agree (${key}): ${summary.accepted} accepted difference(s), ${summary.new.length} new` +
    `${summary.resolved ? `, ${summary.resolved} accepted one(s) now gone` : ""}${summary.new.length ? `: ${summary.new.slice(0, 10).join("; ")}` : ""}`);
}
try {
  run("python", [path.join(mod, "tools", "sync-faction-catalog.py"), "--check"]);
  results.catalog = true;
  console.log("PASS faction catalog: every copy matches the master");
} catch (e) {
  results.catalog = false;
  failed++;
  console.log(`FAIL faction catalog:\n${String(e.stdout ?? "").trim()}`);
}

// The receipt release-play looks for: this exact bundle, checked against this mod and both engines.
const receipts = path.join(config.work, "gameplay-check", "receipts");
fs.mkdirSync(receipts, { recursive: true });
const packSha = crypto.createHash("sha256").update(fs.readFileSync(path.resolve(pack))).digest("hex");
fs.writeFileSync(path.join(receipts, `${packSha}.json`), JSON.stringify({ passed: failed === 0, at: new Date().toISOString(), pack: path.resolve(pack),
  packSha256: packSha, mod: modSha, webEngine: pin, desktopEngine: desktopSha, effects: !argv.includes("--skip-effects"), results }, null, 2) + "\n");
console.log(failed ? `${failed} check(s) failed; reports in ${out}` : `all gameplay checks passed; reports in ${out}`);
process.exit(failed ? 1 : 0);
