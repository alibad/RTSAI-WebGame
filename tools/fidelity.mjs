// SyncHash parity: run the same scenario, seed and order script natively (CoreCLR x64) and in WebAssembly
// (Node/V8, interpreter or AOT), then compare OpenRA's per-net-frame SyncHash one by one.
//   node tools/fidelity.mjs --scenario scenarios/battle-50.json --ticks 1500 --runtime interp
// With --replay <session.json> the native side replays a recorded browser session's order packets instead.
// --profile public compares the standalone game (data/public, native twin built with -p:WebProfile=public).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]);
  return acc;
}, []));
const scenario = args.scenario ?? "scenarios/battle-50.json";
const ticks = args.ticks ?? "1000";
const runtime = args.runtime ?? "interp";
const scratch = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "RTSAI-WebGame", "scratch");
fs.mkdirSync(scratch, { recursive: true });
const profile = args.profile && args.profile !== "true" ? args.profile : "";
const tag = `${profile ? profile + "-" : ""}${path.basename(scenario, ".json")}-${runtime}-${ticks}`;
const wasmHashes = path.join(scratch, `${tag}.wasm.hashes`);
const wasmLog = path.join(scratch, `${tag}.wasm.session.json`);
const nativeHashes = path.join(scratch, `${tag}.native.hashes`);
const env = { ...process.env, OPENRA_AI_HOST: "0" };

function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd: repo, env, encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`${cmd} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

console.log(`WASM (${runtime}) run...`);
console.log(run(process.execPath, ["tools/wasm-node.mjs", "--runtime", runtime, "--scenario", scenario, "--ticks", ticks, "--hashes", wasmHashes, "--log", wasmLog,
  ...(profile ? ["--profile", profile] : [])]).trim());

console.log("Native (CoreCLR) run...");
const websim = path.join(repo, "bin", `OpenRA.WebSim.Native${profile ? "-" + profile : ""}`, "Release", "net10.0", "websim.exe");
const root = path.join(scratch, `vfs-native${profile ? "-" + profile : ""}`);
{
  // The native VFS root mirrors the browser's: the bundle and its art (plus the private RA2 files, except for a
  // profile), rebuilt whenever the bundle changes.
  const pack = path.join(repo, "data", profile, "web-bundle.pack");
  const stamp = path.join(scratch, `vfs-native${profile ? "-" + profile : ""}.stamp`);
  const want = String(fs.statSync(pack).mtimeMs);
  if (!fs.existsSync(root) || !fs.existsSync(stamp) || fs.readFileSync(stamp, "utf8") !== want) {
    fs.rmSync(root, { recursive: true, force: true });
    const priv = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "RTSAI-WebGame", "private", "ra2-all.pack");
    console.log(run(websim, ["unpack", "--pack", pack, "--root", root, ...(profile ? [] : ["--private", priv])]).trim());
    fs.writeFileSync(stamp, want);
  }
}
const nativeArgs = ["run", "--root", root, "--scenario", scenario, "--ticks", ticks, "--hashes", nativeHashes];
if (args.replay) nativeArgs.push("--replay", wasmLog);
console.log(run(websim, nativeArgs).trim());

const read = (f) => fs.readFileSync(f, "utf8").trim().split(/\r?\n/).map((l) => Number(l.split(" ")[1]));
const a = read(wasmHashes), b = read(nativeHashes);
const n = Math.min(a.length, b.length);
let first = -1;
for (let i = 0; i < n; i++) if (a[i] !== b[i]) { first = i + 1; break; }
const result = { scenario, ...(profile ? { profile } : {}), runtime, ticks: Number(ticks), compared: n, identical: first < 0, firstMismatch: first, lastHash: a[n - 1] };
console.log(JSON.stringify(result));
fs.appendFileSync(path.join(repo, "data", "fidelity.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n");
process.exit(first < 0 ? 0 : 3);
