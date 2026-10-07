// SyncHash parity: run the same scenario, seed and order script natively (CoreCLR x64) and in WebAssembly
// (Node/V8, interpreter or AOT), then compare OpenRA's per-net-frame SyncHash one by one.
//   node tools/fidelity.mjs --scenario scenarios/battle-50.json --ticks 1500 --runtime interp
// With --replay <session.json> the native side replays a recorded browser session's order packets instead.

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
const tag = `${path.basename(scenario, ".json")}-${runtime}-${ticks}`;
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
console.log(run(process.execPath, ["tools/wasm-node.mjs", "--runtime", runtime, "--scenario", scenario, "--ticks", ticks, "--hashes", wasmHashes, "--log", wasmLog]).trim());

console.log("Native (CoreCLR) run...");
const websim = path.join(repo, "bin", "OpenRA.WebSim.Native", "Release", "net10.0", "websim.exe");
const root = path.join(scratch, "vfs-native");
const nativeArgs = ["run", "--root", root, "--scenario", scenario, "--ticks", ticks, "--hashes", nativeHashes];
if (args.replay) nativeArgs.push("--replay", wasmLog);
console.log(run(websim, nativeArgs).trim());

const read = (f) => fs.readFileSync(f, "utf8").trim().split(/\r?\n/).map((l) => Number(l.split(" ")[1]));
const a = read(wasmHashes), b = read(nativeHashes);
const n = Math.min(a.length, b.length);
let first = -1;
for (let i = 0; i < n; i++) if (a[i] !== b[i]) { first = i + 1; break; }
const result = { scenario, runtime, ticks: Number(ticks), compared: n, identical: first < 0, firstMismatch: first, lastHash: a[n - 1] };
console.log(JSON.stringify(result));
fs.appendFileSync(path.join(repo, "data", "fidelity.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n");
process.exit(first < 0 ? 0 : 3);
