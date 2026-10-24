// AI Arena decision providers. Each answers closed questions (a name, an instruction, options with descriptions) with
// a choice and a probability per option, and reports what the answer cost: wall time, input tokens and US dollars.
// The game brain (brain.mjs) and the voice-orders adapter (order-adapter.mjs) both ask through askQuestions().
// Paid providers run only on this machine, with the owner's own keys, inside the run's and the day's caps (server.mjs).
import fs from "node:fs";
import path from "node:path";
import { RUBRIC, describe, scriptedAnswers } from "./brain.mjs";

/** List prices, US dollars per million input tokens (output is free). Sources: OpenAI Decisions GA post (22 Oct 2026),
 * TypeSafe's pricing ($42 per billion input tokens; through OpenRouter the reply carries the exact cost). */
export const PRICES = {
  openai: { input: 0.10, cached: 0.01, label: "OpenAI Decisions · gpt-6-luna" },
  jev: { input: 0.042, cached: 0.042, label: "TypeSafe Jev" },
};

const GAMES = path.resolve(import.meta.dirname, "..", "..", "..");
/** Where existing keys live on this machine (git-ignored files): OpenRA-AI's own .env (OPENAI_API_KEY, which the
 * companion's research tools read) and the BeTenshi console's .env (OPENROUTER_API_KEY, which its Decision Lab uses for
 * Jev). */
const KEY_FILES = [path.join(GAMES, "OpenRA-AI", ".env"), path.join(GAMES, "..", "..", "AI", "betenshi-console", ".env")];

export const PROVIDERS = {
  scripted: { label: "Scripted scorer", paid: false },
  laya: { label: "Laya (local)", paid: false },
  local: { label: "Local LLM", paid: false },
  openai: { label: "OpenAI Decisions", paid: true, env: ["OPENAI_API_KEY"] },
  jev: { label: "TypeSafe Jev", paid: true, env: ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"] },
};

function dotenv(file, name) {
  try {
    const line = fs.readFileSync(file, "utf8").split(/\r?\n/).find((l) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(l));
    return line ? line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") : "";
  } catch { return ""; }
}

/**
 * The credential for a paid provider, first found: one pasted into the Arena page (the local Arena folder, never a
 * repo or URL), then each accepted variable in the environment, then in the key files above. Callers only ever show
 * where it came from and its last four characters.
 */
export function keyStore(dir) {
  const file = path.join(dir, "keys.json");
  const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
  const credential = (provider) => {
    const names = PROVIDERS[provider]?.env ?? [];
    if (read()[provider]) return { key: read()[provider], env: names[0], source: "pasted in the Arena" };
    for (const env of names) if (process.env[env]) return { key: process.env[env], env, source: `the ${env} variable` };
    for (const env of names) for (const f of KEY_FILES) { const key = dotenv(f, env); if (key) return { key, env, source: path.relative(path.join(GAMES, "..", ".."), f).replaceAll("\\", "/") }; }
    return { key: "", env: "", source: "" };
  };
  return {
    credential,
    get: (provider) => credential(provider).key,
    set: (provider, key) => { const all = read(); if (key) all[provider] = key; else delete all[provider]; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(all), { mode: 0o600 }); },
    hint: (provider) => { const c = credential(provider); return c.key ? `…${c.key.slice(-4)} from ${c.source}` : ""; },
  };
}

const LOCAL_ROUTER = process.env.OPENRA_AI_ROUTER_URL ?? "http://127.0.0.1:4000";
const LAYA = process.env.RTSAI_LAYA_URL ?? "http://127.0.0.1:8040";
export async function localReady() {
  try { const r = await fetch(`${LOCAL_ROUTER}/v1/models`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}
export async function layaReady() {
  try { const r = await fetch(`${LAYA}/health`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}

/**
 * Answers closed questions about a context. context: { text, json? } — text always, json when the provider can take
 * structured input. credential: { key, env } for paid providers.
 * Returns { answers: {name: {choice, probabilities, confidence?}}, ms, inputTokens, cachedTokens, usd }.
 */
export async function askQuestions(provider, context, questions, credential = {}) {
  const t0 = performance.now();
  let done = (answers, inputTokens = 0, cachedTokens = 0, exactUsd = null) => {
    const p = PRICES[provider];
    const usd = exactUsd ?? (p ? ((inputTokens - cachedTokens) * p.input + cachedTokens * p.cached) / 1e6 : 0);
    return { answers, ms: Math.round(performance.now() - t0), inputTokens, cachedTokens, usd };
  };
  // A question with one option has its answer already (the decision APIs take 2 or more options).
  const settled = Object.fromEntries(questions.filter((q) => q.options.length < 2).map((q) => [q.name, { choice: q.options[0]?.value ?? null, probabilities: q.options[0] ? { [q.options[0].value]: 1 } : {} }]));
  questions = questions.filter((q) => q.options.length >= 2);
  if (!questions.length) return done(settled);
  const inner = done;
  done = (answers, ...rest) => inner({ ...settled, ...answers }, ...rest);
  const { key = "", env = "" } = credential;
  if (provider === "openai") {
    const content = [{ type: "input_text", text: context.text }];
    if (context.json) content.push({ type: "input_json", data: context.json });
    const r = await post("https://api.openai.com/v1/decisions", key, { model: "gpt-6-luna", input: [{ role: "user", content }],
      questions: questions.map((q) => ({ type: "choice", name: q.name, instructions: q.instructions, choices: q.options.map((o) => ({ value: o.value, description: o.description })) })) });
    const answers = {};
    for (const a of r.answers ?? []) if (a.type === "choice")
      answers[a.name] = { choice: a.choice, probabilities: Object.fromEntries((a.probabilities ?? []).map((x) => [x.value, x.probability])), confidence: a.confidence };
    return done(answers, r.usage?.input_tokens ?? 0, r.usage?.input_tokens_details?.cached_tokens ?? 0);
  }
  if (provider === "jev") {
    // TypeSafe's own API with a TypeSafe key; the same System One request through OpenRouter with an OpenRouter key.
    const viaOpenRouter = env === "OPENROUTER_API_KEY";
    const r = await post(viaOpenRouter ? "https://openrouter.ai/api/v1/systemone" : "https://api.typesafe.ai/v1/systemone", key, {
      model: viaOpenRouter ? "typesafe/jev-1.13" : "jev-latest",
      state: context.json ? `${context.text}\n\nState:\n${JSON.stringify(context.json)}` : context.text,
      questions: Object.fromEntries(questions.map((q) => [q.name, { type: "choice", instructions: q.instructions, criteria: Object.fromEntries(q.options.map((o) => [o.value, o.description])) }])),
    }, viaOpenRouter ? { "X-Title": "RTS AI Arena" } : {});
    const answers = {};
    for (const [name, a] of Object.entries(r.answers ?? {})) if (a.type === "choice") answers[name] = { choice: a.choice, probabilities: a.probabilities ?? {}, confidence: a.confidence };
    return done(answers, r.usage?.input_tokens ?? r.usage?.prompt_tokens ?? 0, 0, Number.isFinite(r.usage?.cost) ? r.usage.cost : null);
  }
  if (provider === "laya") {
    // Laya (BeTenshi console service, :8040) answers one question per call; a turn's questions go in parallel.
    const contextText = context.json ? `${context.text}\n\nState:\n${JSON.stringify(context.json)}` : context.text;
    const results = await Promise.all(questions.map(async (q) => {
      const r = await post(`${LAYA}/decide`, "", { question: q.instructions, type: "choice", context: contextText, model: "laya",
        choices: Object.fromEntries(q.options.map((o) => [o.value, o.description])) });
      return [q.name, { choice: r.choice, probabilities: r.probabilities ?? { [r.choice]: 1 }, confidence: r.confidence }];
    }));
    return done(Object.fromEntries(results));
  }
  if (provider === "local") {
    // A local OpenAI-compatible model (the companion's gateway): one JSON object whose fields are the choices.
    const schema = { type: "object", additionalProperties: false, required: questions.map((q) => q.name),
      properties: Object.fromEntries(questions.map((q) => [q.name, { type: "string", enum: q.options.map((o) => o.value), description: q.instructions }])) };
    const prompt = `${context.text}\n\n${context.json ? `State: ${JSON.stringify(context.json)}\n\n` : ""}${questions.map((q) => `${q.name}: ${q.instructions}\n${q.options.map((o) => `  - ${o.value}: ${o.description}`).join("\n")}`).join("\n\n")}`;
    const r = await post(`${LOCAL_ROUTER}/v1/chat/completions`, "", { model: process.env.OPENRA_AI_TEXT_MODEL ?? "local-coder", temperature: 0, max_tokens: 200,
      messages: [{ role: "user", content: prompt }], response_format: { type: "json_schema", json_schema: { name: "decisions", strict: true, schema } } });
    let picked = {};
    try { picked = JSON.parse(r.choices?.[0]?.message?.content ?? "{}"); } catch { /* answered below as unanswered */ }
    const answers = Object.fromEntries(questions.filter((q) => q.options.some((o) => o.value === picked[q.name])).map((q) => [q.name, { choice: picked[q.name], probabilities: { [picked[q.name]]: 1 } }]));
    return done(answers, r.usage?.prompt_tokens ?? 0, 0);
  }
  throw new Error(`unknown provider ${provider}`);
}

/**
 * The game brain's turn: the scripted scorer, or a provider asked about the described battlefield. `opts` carries the
 * run's experiment and the brain's memory to the scorer (brain.mjs EXPERIMENTS).
 */
export async function decide(provider, obs, questions, credential = {}, opts = {}) {
  if (provider === "scripted") {
    const t0 = performance.now();
    return { answers: scriptedAnswers(obs, questions, opts), ms: Math.round(performance.now() - t0), inputTokens: 0, cachedTokens: 0, usd: 0 };
  }
  return askQuestions(provider, { text: RUBRIC, json: describe(obs) }, questions, credential);
}

export async function post(url, key, body, headers = {}) {
  const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(30000),
    headers: { "content-type": "application/json", ...headers, ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
