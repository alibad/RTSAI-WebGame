// Voice-orders adapter: an OpenAI-compatible model address for the OpenRA-AI companion, so its own order interpreter
// and 281-case benchmark (OpenRA-AI services/companion/evals/nl_orders) can run on a decision model.
//
// The companion turns what the player says into a form (nl_orders.ORDER_SCHEMA): intent, then one step with action,
// units, count, item, target and stance. A chat model fills it in as JSON. Here every field becomes a closed question
// whose options come from the vocabulary the companion sends (the units, buildings, production and enemies in view),
// and a decision model (OpenAI Decisions, Jev or the local Laya) picks them. Everything else the companion asks (free
// answers to questions) goes to an ordinary chat model, which is also the "llm" baseline that fills the whole form.
//   node tools/arena/order-adapter.mjs --orders openai|jev|laya|llm [--port 3465]
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { askQuestions, keyStore, post } from "./providers.mjs";

/** The chat model the companion defaults to for an external endpoint (RuntimeConfig.text_model), at list price. */
export const CHAT_MODEL = { id: "gpt-4.1-mini", input: 0.40, output: 1.60 };

const INTENTS = {
  command: "The player wants units, buildings or production to do something.",
  question: "The player asks for information or advice and gives no order.",
  clarify: "An order too vague to act on: missing which units, where, or which item.",
  refuse: "Surrender, quitting, pausing, cheats, support powers or superweapons, attacking your own forces, selling everything, or revealing hidden enemies.",
};
const ACTIONS = {
  train: "train units", build: "build a structure", place: "put a finished structure down", deploy: "unpack the construction vehicle or deploy a unit",
  move: "move units somewhere", attack_move: "move and fight on the way", attack: "attack one visible enemy", stop: "stop what they are doing",
  harvest: "send harvesters to gather", repair: "repair a structure or unit", sell: "sell a structure", rally: "set a rally point",
  guard: "follow and protect one of ours", stance: "change fire stance", load: "board a transport", unload: "unload a transport",
  capture: "capture a building with engineers", infiltrate: "infiltrate with a spy", disguise: "disguise a spy", demolish: "demolish with explosives",
  primary: "make a production building primary", power_down: "power a building down", cancel: "cancel production",
};
const DIRECTIONS = ["north", "south", "east", "west", "north east", "north west", "south east", "south west"];
const STANCES = ["hold fire", "return fire", "defend", "attack anything"];

/** "Light Tank x3 (2 idle), Rifle Infantry" -> ["Light Tank", "Rifle Infantry"] */
const names = (line) => !line || /^(none|nothing)$/i.test(line.trim()) ? [] :
  [...new Set(line.split(/,\s*/).map((part) => part.replace(/\s+x\d+.*$/, "").replace(/\s+(ready to place|\d+%)$/, "").trim()).filter(Boolean))];

/** The companion's user message: "Vocabulary:\n<lines>\n\nPlayer: \"...\"" */
export function parseOrderRequest(messages) {
  const text = String(messages.findLast((m) => m.role === "user")?.content ?? "");
  const field = (label) => text.match(new RegExp(`^${label}:\\s*(.*)$`, "m"))?.[1] ?? "";
  let player = "";
  try { player = JSON.parse(text.match(/^Player:\s*(.*)$/m)?.[1] ?? '""'); } catch { player = text.match(/^Player:\s*(.*)$/m)?.[1] ?? ""; }
  return {
    vocabulary: text.split(/\n\nPlayer:/)[0].replace(/^Vocabulary:\n/, ""), player,
    units: names(field("Your units")), buildings: names(field("Your buildings")), canBuild: names(field("Can build")), canTrain: names(field("Can train")),
    producing: names(field("In production")), enemies: names(field("Visible enemies")), enemyBase: field("Enemy base"),
  };
}

const cap = (options) => options.slice(0, 64);
/** The form as closed questions, options from the vocabulary only (decision APIs take 2 to 64 options). */
export function orderQuestions(v) {
  const option = (value, description) => ({ value, description });
  const items = [...new Set([...v.canTrain, ...v.canBuild, ...v.producing, ...v.buildings])];
  return [
    { name: "intent", instructions: "What does the player want?", options: Object.entries(INTENTS).map(([k, d]) => option(k, d)) },
    { name: "action", instructions: "If it is an order, which action is it?", options: Object.entries(ACTIONS).map(([k, d]) => option(k, d)) },
    { name: "item", instructions: "Which unit or structure does the order name (to train, build, place, cancel, sell, repair, rally or make primary)?",
      options: cap([option("none", "The order names no unit or structure type."), ...items.map((n) => option(n, `${n}${v.canTrain.includes(n) ? " (can train)" : v.canBuild.includes(n) ? " (can build)" : v.producing.includes(n) ? " (in production)" : " (we have one)"}`))]) },
    { name: "units", instructions: "Which of our units carry the order out?",
      options: cap([option("none", "Nobody: a production order."), option("everyone", "All our units."), option("idle units", "Our units doing nothing."),
        option("harvesters", "Our harvesters."), option("all tanks", "Every tank we have."), option("all infantry", "Every infantry soldier we have."),
        ...v.units.map((n) => option(`all ${n}`, `Every ${n} we have.`))]) },
    { name: "count", instructions: "How many units to train or send? 0 when the player did not say.", options: Array.from({ length: 13 }, (_, i) => option(String(i), i ? `${i}` : "not stated")) },
    { name: "target", instructions: "Where to, or at what?",
      options: cap([option("none", "No place or target."), ...[...v.player.matchAll(/(\d{1,3})\s*,\s*(\d{1,3})/g)].map((m) => option(`${m[1]},${m[2]}`, `The map cell ${m[1]},${m[2]} the player named.`)),
        option("enemy base", `The enemy base (${v.enemyBase || "unknown"}).`), option("our base", "Our own base."),
        ...DIRECTIONS.map((d) => option(d, `The ${d} of the map.`)), ...v.enemies.map((n) => option(`visible ${n}`, `The visible enemy ${n}.`)),
        ...v.buildings.map((n) => option(`the ${n}`, `Our ${n}.`)), ...v.units.map((n) => option(`the ${n}`, `Our ${n}.`))]) },
    { name: "stance", instructions: "Only for a stance order: which stance?", options: [option("none", "Not a stance order."), ...STANCES.map((s) => option(s, s))] },
  ];
}

export function orderFromAnswers(answers) {
  const pick = (name) => answers[name]?.choice ?? "none";
  const blank = (value) => (value === "none" ? "" : value);
  const intent = pick("intent") in INTENTS ? pick("intent") : "clarify";
  const reply = intent === "clarify" ? "Which units should do that, and where?" : intent === "refuse" ? "I can't do that by voice; that stays in your hands." : "";
  const steps = intent === "command" ? [{ action: pick("action") in ACTIONS ? pick("action") : "move", units: blank(pick("units")), count: Number(pick("count")) || 0,
    item: blank(pick("item")), target: blank(pick("target")), stance: blank(pick("stance")) }] : [];
  return { intent, reply, steps };
}

/**
 * Starts the adapter. orders: "llm" (the chat model fills the form) or a decision provider. Every model call is
 * appended to `calls`: { kind: "order"|"chat", provider, ms, inputTokens, outputTokens, usd, error? }.
 */
export function startAdapter({ orders, port = 0, credentialFor }) {
  const calls = [];
  const chatCredential = credentialFor("openai");
  async function chat(body) {
    const t0 = performance.now();
    // The router adds reasoning_effort for local reasoning models; a non-reasoning OpenAI model refuses it.
    const { reasoning_effort: _, ...forwarded } = body;
    const r = await post("https://api.openai.com/v1/chat/completions", chatCredential.key, { ...forwarded, model: CHAT_MODEL.id });
    const inputTokens = r.usage?.prompt_tokens ?? 0, outputTokens = r.usage?.completion_tokens ?? 0;
    return { r, ms: Math.round(performance.now() - t0), inputTokens, outputTokens, usd: (inputTokens * CHAT_MODEL.input + outputTokens * CHAT_MODEL.output) / 1e6 };
  }
  const server = http.createServer(async (req, res) => {
    const send = (code, value) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(value));
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/health")) return send(200, { object: "list", data: [{ id: `orders-${orders}`, object: "model" }] });
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") return send(404, { error: { message: "not found" } });
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    const isOrder = body.response_format?.json_schema?.name === "player_order";
    try {
      if (isOrder && orders !== "llm") {
        const v = parseOrderRequest(body.messages ?? []);
        const context = { text: `${String(body.messages?.[0]?.content ?? "").split("\n\nExamples:")[0]}\n\nVocabulary:\n${v.vocabulary}\n\nPlayer: ${JSON.stringify(v.player)}` };
        const r = await askQuestions(orders, context, orderQuestions(v), credentialFor(orders));
        calls.push({ kind: "order", provider: orders, ms: r.ms, inputTokens: r.inputTokens, outputTokens: 0, usd: r.usd, player: v.player, answers: Object.fromEntries(Object.entries(r.answers).map(([k, a]) => [k, a.choice])) });
        return send(200, { id: `adapter-${calls.length}`, object: "chat.completion", model: `orders-${orders}`,
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(orderFromAnswers(r.answers)) }, finish_reason: "stop" }],
          usage: { prompt_tokens: r.inputTokens, completion_tokens: 0, total_tokens: r.inputTokens } });
      }
      const c = await chat(body);
      calls.push({ kind: isOrder ? "order" : "chat", provider: CHAT_MODEL.id, ms: c.ms, inputTokens: c.inputTokens, outputTokens: c.outputTokens, usd: c.usd });
      return send(200, c.r);
    } catch (e) {
      calls.push({ kind: isOrder ? "order" : "chat", provider: isOrder && orders !== "llm" ? orders : CHAT_MODEL.id, ms: 0, inputTokens: 0, outputTokens: 0, usd: 0, error: String(e.message ?? e).slice(0, 300) });
      // The router reads an error's detail to decide whether to retry without response_format.
      return send(502, { error: { message: String(e.message ?? e).slice(0, 500) } });
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() })));
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll("\\", "/")}`) {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const keys = keyStore(path.join(process.env.LOCALAPPDATA ?? os.homedir(), "RTSAI-WebGame", "arena"));
  const a = await startAdapter({ orders: opt("orders", "openai"), port: Number(opt("port", 3465)), credentialFor: (p) => keys.credential(p) });
  console.log(`voice-orders adapter (${opt("orders", "openai")}) on ${a.url}`);
}
