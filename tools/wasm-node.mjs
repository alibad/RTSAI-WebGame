// Runs the browser (WebAssembly) build of the simulation headless under Node (same V8 engine as Chrome):
//   node tools/wasm-node.mjs --runtime interp|aot --scenario scenarios/battle-50.json --ticks 600 [--hashes out.txt]
//        [--snapshot] [--replay session.json]
// Used for repeatable WASM benchmarks and SyncHash comparisons against the native runner.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]);
  return acc;
}, []));
const runtime = args.runtime ?? "interp";
const ticks = Number(args.ticks ?? 300);
const privatePack = path.join(process.env.LOCALAPPDATA, "RTSAI-WebGame", "private", "ra2-all.pack");

const t0 = performance.now();
const fw = path.join(repo, "data", `wasm-${runtime}`, "wwwroot", "_framework");
const { dotnet } = await import(pathToFileURL(path.join(fw, "dotnet.js")).href);
let snapshots = 0, snapshotBytes = 0;
const api = await dotnet.create();
api.setModuleImports("websim", {
  publish: (view) => { snapshots++; snapshotBytes += view.length; },
  progress: (step) => process.stdout.write(`  [${((performance.now() - t0) / 1000).toFixed(1)}s] ${step}\n`),
});
const S = (await api.getAssemblyExports(api.getConfig().mainAssemblyName)).OpenRA.WebSim.Browser.Interop;
const tRuntime = performance.now() - t0;
if (args["debug-fluent"]) { console.log("fluent:", S.DebugFluent()); process.exit(0); }

S.Mount(new Uint8Array(fs.readFileSync(path.join(repo, "data", "web-bundle.pack"))));
S.Mount(new Uint8Array(fs.readFileSync(privatePack)));
const tMount = performance.now() - t0;
const boot = JSON.parse(S.Boot());
const tBoot = performance.now() - t0;

const scenario = fs.readFileSync(path.join(repo, args.scenario ?? "scenarios/battle-50.json"), "utf8");
if (args.replay) throw new Error("replay is done natively; wasm-node records sessions");
const info = JSON.parse(S.Start(scenario));
const tStart = performance.now() - t0;
console.log(`runtime ${tRuntime.toFixed(0)} ms, mount ${(tMount - tRuntime).toFixed(0)} ms, boot ${(tBoot - tMount).toFixed(0)} ms, start ${(tStart - tBoot).toFixed(0)} ms`);
console.log("boot timings", JSON.stringify(boot));
console.log("start timings", JSON.stringify(info.timings));

const times = [];
const withSnapshot = !!args.snapshot;
for (let i = 0; i < ticks; i++) {
  const s = performance.now();
  if (withSnapshot) S.Tick(); else S.TickMany(1);
  times.push(performance.now() - s);
  if (args.progress && (i + 1) % 100 === 0) {
    const st = JSON.parse(S.Stats());
    const last = times.slice(-100);
    console.log(`  tick ${st.tick}: units ${st.units}, last 100 mean ${(last.reduce((a, b) => a + b, 0) / last.length).toFixed(2)} ms, managed ${st.managedMB} MB`);
  }
}
const sorted = [...times].sort((a, b) => a - b);
const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const mean = times.reduce((a, b) => a + b, 0) / times.length;
const stats = JSON.parse(S.Stats());
console.log(`ticks ${ticks}: mean ${mean.toFixed(2)} p50 ${q(0.5).toFixed(2)} p95 ${q(0.95).toFixed(2)} max ${sorted.at(-1).toFixed(2)} ms` +
  (withSnapshot ? `; snapshots ${snapshots}, mean ${(snapshotBytes / Math.max(1, snapshots)).toFixed(0)} bytes` : ""));
console.log(`heap ${(api.Module.HEAPU8.length / 1048576).toFixed(0)} MB wasm memory, managed ${stats.managedMB} MB, units ${stats.units}, ${stats.framework}`);

if (args["read"]) for (const f of args["read"].split(",")) console.log(`---- ${f}\n${S.ReadText(f)}`);
if (args["players"]) console.log("players", JSON.stringify(info.players));

const log = JSON.parse(S.SessionLog());
if (args.hashes) fs.writeFileSync(args.hashes, log.hashes.map((h, i) => `${i + 1} ${h}`).join("\n") + "\n");
if (args.log) fs.writeFileSync(args.log, JSON.stringify(log));
if (args.timings) fs.writeFileSync(args.timings, times.map((t) => t.toFixed(3)).join("\n"));
process.exit(0);
