// AI Arena decision providers. Each answers the brain's questions (brain.mjs) with a choice and a probability per
// option, and reports what the answer cost: wall time, input tokens and US dollars at list price. Paid providers run
// only on this machine, with the owner's own key, inside the run's and the day's spending caps (server.mjs).
import fs from "node:fs";
import path from "node:path";
import { RUBRIC, describe, scriptedAnswers } from "./brain.mjs";

/** List prices, US dollars per million input tokens (output is free for both). Sources: OpenAI Decisions GA post
 * (22 Oct 2026) and TypeSafe's pricing ($42 per billion input tokens). */
export const PRICES = {
  openai: { input: 0.10, cached: 0.01, label: "OpenAI Decisions · gpt-6-luna" },
  jev: { input: 0.042, cached: 0.042, label: "TypeSafe Jev · jev-latest" },
};

export const PROVIDERS = {
  scripted: { label: "Scripted scorer", paid: false },
  local: { label: "Local model", paid: false },
  openai: { label: "OpenAI Decisions", paid: true, env: "OPENAI_API_KEY" },
  jev: { label: "TypeSafe Jev", paid: true, env: "TYPESAFE_API_KEY" },
};

/** Keys the owner pasted into the Arena page, kept in the local Arena folder only (never in a repo or a URL). */
export function keyStore(dir) {
  const file = path.join(dir, "keys.json");
  const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
  return {
    get: (provider) => read()[provider] || process.env[PROVIDERS[provider]?.env ?? ""] || "",
    set: (provider, key) => { const all = read(); if (key) all[provider] = key; else delete all[provider]; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(all), { mode: 0o600 }); },
    hint: (provider) => { const k = read()[provider] || process.env[PROVIDERS[provider]?.env ?? ""] || ""; return k ? `…${k.slice(-4)}` : ""; },
  };
}

const LOCAL_ROUTER = process.env.OPENRA_AI_ROUTER_URL ?? "http://127.0.0.1:4000";
export async function localReady() {
  try { const r = await fetch(`${LOCAL_ROUTER}/v1/models`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}

const usd = (provider, input, cached = 0) => {
  const p = PRICES[provider];
  return p ? ((input - cached) * p.input + cached * p.cached) / 1e6 : 0;
};

/** Normalised result: { answers: {name: {choice, probabilities}}, ms, inputTokens, cachedTokens, usd, error? } */
export async function decide(provider, obs, questions, { key } = {}) {
  const t0 = performance.now();
  const done = (answers, inputTokens = 0, cachedTokens = 0) => ({ answers, ms: Math.round(performance.now() - t0), inputTokens, cachedTokens, usd: usd(provider, inputTokens, cachedTokens) });
  if (!questions.length) return done({});
  if (provider === "scripted") return done(scriptedAnswers(obs, questions));
  const state = describe(obs);
  if (provider === "openai") {
    const body = {
      model: "gpt-6-luna",
      input: [{ role: "user", content: [{ type: "input_text", text: RUBRIC }, { type: "input_json", data: state }] }],
      questions: questions.map((q) => ({ type: "choice", name: q.name, instructions: q.instructions, choices: q.options.map((o) => ({ value: o.value, description: o.description })) })),
    };
    const r = await post("https://api.openai.com/v1/decisions", key, body);
    const answers = {};
    for (const a of r.answers ?? []) {
      if (a.type !== "choice") continue;
      answers[a.name] = { choice: a.choice, probabilities: Object.fromEntries((a.probabilities ?? []).map((p) => [p.value, p.probability])), confidence: a.confidence };
    }
    return done(answers, r.usage?.input_tokens ?? 0, r.usage?.input_tokens_details?.cached_tokens ?? 0);
  }
  if (provider === "jev") {
    const body = {
      model: "jev-latest",
      state: `${RUBRIC}\n\nState:\n${JSON.stringify(state)}`,
      questions: Object.fromEntries(questions.map((q) => [q.name, { type: "choice", instructions: q.instructions, criteria: Object.fromEntries(q.options.map((o) => [o.value, o.description])) }])),
    };
    const r = await post("https://api.typesafe.ai/v1/systemone", key, body);
    const answers = {};
    for (const [name, a] of Object.entries(r.answers ?? {})) if (a.type === "choice") answers[name] = { choice: a.choice, probabilities: a.probabilities ?? {}, confidence: a.confidence };
    return done(answers, r.usage?.input_tokens ?? 0, 0);
  }
  if (provider === "local") {
    // A local OpenAI-compatible model (the companion's gateway): one JSON object whose fields are the choices.
    const schema = { type: "object", additionalProperties: false, required: questions.map((q) => q.name),
      properties: Object.fromEntries(questions.map((q) => [q.name, { type: "string", enum: q.options.map((o) => o.value), description: q.instructions }])) };
    const prompt = `${RUBRIC}\n\nState: ${JSON.stringify(state)}\n\n${questions.map((q) => `${q.name}: ${q.instructions}\n${q.options.map((o) => `  - ${o.value}: ${o.description}`).join("\n")}`).join("\n\n")}`;
    const r = await post(`${LOCAL_ROUTER}/v1/chat/completions`, "", { model: process.env.OPENRA_AI_TEXT_MODEL ?? "local-coder", temperature: 0, max_tokens: 200,
      messages: [{ role: "user", content: prompt }], response_format: { type: "json_schema", json_schema: { name: "decisions", strict: true, schema } } });
    let picked = {};
    try { picked = JSON.parse(r.choices?.[0]?.message?.content ?? "{}"); } catch { /* answered below as unanswered */ }
    const answers = Object.fromEntries(questions.filter((q) => q.options.some((o) => o.value === picked[q.name])).map((q) => [q.name, { choice: picked[q.name], probabilities: { [picked[q.name]]: 1 } }]));
    return done(answers, r.usage?.prompt_tokens ?? 0, 0);
  }
  throw new Error(`unknown provider ${provider}`);
}

async function post(url, key, body) {
  const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(20000),
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
