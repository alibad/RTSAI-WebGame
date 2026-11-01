// Voice-orders bench: the companion's own (RTSAI-Mod/companion) 281 spoken/typed order cases (evals/nl_orders), interpreted with
// the chosen brain behind the order-adapter, graded by the benchmark's own grader. Writes one record per run.
//   node tools/arena/bench.mjs --orders llm|openai|jev|laya|offline [--path model|pipeline] [--only <ids, fixtures, ...>]
// path "pipeline" is the product: the companion's rules answer what they can and the model gets the rest. path "model"
// (the default) turns the rules off for the run (bench-model-only/sitecustomize.py), so every order is the brain's.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { startAdapter } from "./order-adapter.mjs";
import { keyStore } from "./providers.mjs";

const GAMES = path.resolve(import.meta.dirname, "..", "..", "..");
const COMPANION = path.join(GAMES, "RTSAI-Mod", "companion");
const PYTHON = path.join(COMPANION, ".venv", "Scripts", "python.exe");
const RUN_EVAL = path.join(COMPANION, "services", "companion", "evals", "nl_orders", "run_eval.py");
export const BENCH_BRAINS = {
  offline: "Companion rules only (no model)",
  llm: "LLM fills the form (gpt-4.1-mini)",
  openai: "OpenAI Decisions picks the form",
  jev: "Jev picks the form",
  laya: "Laya picks the form (local)",
};

const pct = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

function run(args, env, { progress, stopped }) {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, args, { cwd: COMPANION, env, stdio: ["ignore", "pipe", "pipe"] });
    const watch = setInterval(() => { if (stopped()) child.kill(); }, 1000);
    let buffer = "";
    const onData = (d) => { buffer += d; const lines = buffer.split(/\r?\n/); buffer = lines.pop(); for (const l of lines) if (l.trim()) progress(l); };
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    child.on("exit", (c) => { clearInterval(watch); resolve(c); });
  });
}

/** The case ids the benchmark would select for --only (all when empty), from its own cases.py. */
async function caseIds(only) {
  const wanted = JSON.stringify(only.split(",").map((s) => s.trim()).filter(Boolean));
  const code = `import json,sys; sys.path.insert(0, ${JSON.stringify(path.dirname(RUN_EVAL))}); from cases import cases; w=set(json.loads(${JSON.stringify(wanted)}))
print("\\n".join(c["id"] for c in cases() if not w or w & {c["id"], c["fixture"], c["variant"], c["category"], c["split"]}))`;
  let out = "";
  await new Promise((resolve) => { const c = spawn(PYTHON, ["-c", code], { cwd: COMPANION }); c.stdout.on("data", (d) => { out += d; }); c.on("exit", resolve); });
  return out.split(/\r?\n/).filter(Boolean);
}

/** Runs one bench; resolves to its record. progress(line) gets the benchmark's per-case lines. */
export async function runBench({ orders, only = "", pathMode = "model", dir, keys, progress = () => {}, stopped = () => false }) {
  if (!BENCH_BRAINS[orders]) throw new Error(`unknown bench brain ${orders}`);
  if (!fs.existsSync(PYTHON) || !fs.existsSync(RUN_EVAL)) throw new Error("The companion (RTSAI-Mod/companion and its .venv) is needed for the bench.");
  if (orders !== "offline" && !keys.get("openai")) throw new Error("The bench needs an OpenAI key for the chat model (questions are answered by gpt-4.1-mini).");
  const modelOnly = pathMode === "model" && orders !== "offline";
  const id = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${orders}-${modelOnly ? "model" : "pipeline"}-${crypto.randomBytes(2).toString("hex")}`;
  const out = path.join(dir, "bench", id);
  fs.mkdirSync(out, { recursive: true });
  const adapter = orders === "offline" ? null : await startAdapter({ orders, credentialFor: (p) => keys.credential(p) });
  const startedAt = new Date().toISOString();
  const label = `${BENCH_BRAINS[orders]}${modelOnly ? ", every order" : ""}`;
  try {
    let code;
    if (!modelOnly) {
      code = await run([RUN_EVAL, "--output", out, "--label", label, "--timeout", "45",
        ...(adapter ? ["--router-url", adapter.url, "--external", "--model", `orders-${orders}`] : ["--offline"]), ...(only ? ["--only", only] : [])], process.env, { progress, stopped });
    } else {
      // The benchmark's worker, started the way run_eval.py starts it, plus the rules switch; then its own grader.
      fs.writeFileSync(path.join(out, "cases.txt"), (await caseIds(only)).join("\n") + "\n");
      fs.mkdirSync(path.join(out, "appdata"), { recursive: true });
      const { OPENAI_API_KEY: _, ...base } = process.env;
      const env = { ...base, PYTHONPATH: [path.join(COMPANION, "services", "companion", "src"), path.join(COMPANION, "services", "worldgen", "src"), path.join(import.meta.dirname, "bench-model-only")].join(path.delimiter),
        RTSAI_BENCH_MODEL_ONLY: "1", OPENRA_AI_BRAIN_STATE: path.join(out, "brain-blackboard.jsonl"), APPDATA: path.join(out, "appdata"), PYTHONDONTWRITEBYTECODE: "1",
        OPENRA_AI_AGENT_PROVIDER: "local", OPENRA_AI_AGENT_MODEL: `orders-${orders}`, OPENRA_AI_AGENT_ROUTER_URL: adapter.url, OPENRA_AI_ROUTER_URL: adapter.url };
      code = await run([RUN_EVAL, "--worker", "--case-file", path.join(out, "cases.txt"), "--outcomes", path.join(out, "outcomes.jsonl"), "--mode", "direct",
        "--router-url", adapter.url, "--model", `orders-${orders}`, "--profile", "lightweight", "--timeout", "45", "--external"], env, { progress, stopped });
      if (code === 0) code = await run([RUN_EVAL, "--grade-only", "--output", out, "--label", label], process.env, { progress: () => {}, stopped });
    }
    const summaryFile = path.join(out, "summary.json");
    if (code !== 0 || !fs.existsSync(summaryFile)) throw new Error(`the benchmark exited with ${code}`);
    const s = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
    const calls = adapter?.calls ?? [];
    fs.writeFileSync(path.join(out, "model-calls.json"), JSON.stringify(calls));
    const orderCalls = calls.filter((c) => c.kind === "order" && !c.error), chatCalls = calls.filter((c) => c.kind === "chat" && !c.error);
    const usd = calls.reduce((t, c) => t + (c.usd ?? 0), 0);
    const record = {
      id, orders, path: modelOnly ? "model" : "pipeline", label, only, startedAt, finishedAt: new Date().toISOString(),
      cases: s.cases, overall: s.overall_pass_rate, executable: s.executable_pass_rate, guarded: s.guarded_pass_rate, questions: s.question_pass_rate,
      multistep: s.multistep_pass_rate, unsafeAccepts: s.unsafe_accepts, malformed: s.malformed_replies, errors: s.errors,
      turnMs: s.latency_ms, modelCalledCases: s.model_call_latency_ms?.count ?? 0,
      orderCalls: { count: orderCalls.length, p50: pct(orderCalls.map((c) => c.ms), 0.5), p95: pct(orderCalls.map((c) => c.ms), 0.95), usd: orderCalls.reduce((t, c) => t + c.usd, 0), provider: orderCalls[0]?.provider ?? null },
      chatCalls: { count: chatCalls.length, p50: pct(chatCalls.map((c) => c.ms), 0.5), usd: chatCalls.reduce((t, c) => t + c.usd, 0) },
      failedCalls: calls.filter((c) => c.error).length, usd, usdPer1000Turns: s.cases ? (usd / s.cases) * 1000 : 0,
    };
    fs.writeFileSync(path.join(out, "record.json"), JSON.stringify(record, null, 1));
    return record;
  } finally {
    adapter?.close();
  }
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll("\\", "/")}`) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const dir = path.join(process.env.LOCALAPPDATA ?? os.homedir(), "RTSAI-WebGame", "arena");
  const record = await runBench({ orders: opt("orders", "openai"), only: opt("only", ""), pathMode: opt("path", "model"), dir, keys: keyStore(dir), progress: (l) => console.log(l) });
  console.log(JSON.stringify(record, null, 1));
}
