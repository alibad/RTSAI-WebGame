// One real turn per provider on a small fixed battlefield: proves the request format, prints the choices, the time,
// the tokens and the cost. Never prints a key.
//   node tools/arena/provider-smoke.mjs [openai|jev|local|laya ...]
import os from "node:os";
import path from "node:path";
import { plan } from "./brain.mjs";
import { decide, keyStore, PROVIDERS } from "./providers.mjs";

const actor = (actorId, kind, cellX, cellY, extra = {}) => ({ actorId, kind, cellX, cellY, idle: true, canAttack: false, ...extra });
const obs = {
  tick: 25 * 150, cash: 2600, powerProvided: 150, powerDrained: 120, harvesterCount: 1, mapWidth: 120, mapHeight: 120, exploredPercent: 35,
  done: false, buildings: [actor(1, "gacnst", 20, 20), actor(2, "gapowr", 22, 20), actor(3, "garefn", 24, 20)],
  units: [actor(10, "e1", 25, 25, { canAttack: true, speed: 50 }), actor(11, "e1", 26, 25, { canAttack: true, speed: 50 }), actor(12, "mtnk", 27, 25, { canAttack: true, speed: 70 })],
  visibleEnemies: [], visibleEnemyBuildings: [], rememberedEnemyBuildings: [], production: [], availableProduction: ["gapowr", "gapile", "garefn", "e1"],
  actorNames: {},
};
const keys = keyStore(path.join(process.env.LOCALAPPDATA ?? os.homedir(), "RTSAI-WebGame", "arena"));
const { questions } = plan(obs, {});
for (const provider of process.argv.slice(2).length ? process.argv.slice(2) : ["openai"]) {
  const credential = PROVIDERS[provider]?.paid ? keys.credential(provider) : {};
  if (PROVIDERS[provider]?.paid && !credential.key) { console.log(`${provider}: no key`); continue; }
  try {
    const r = await decide(provider, obs, questions, credential);
    console.log(`${provider}: ${r.ms} ms, ${r.inputTokens} input tokens (${r.cachedTokens ?? 0} cached), $${r.usd.toFixed(6)}`);
    for (const q of questions) {
      const a = r.answers[q.name];
      const top = Object.entries(a?.probabilities ?? {}).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([v, p]) => `${v} ${Math.round(p * 100)}%`).join(", ");
      console.log(`  ${q.name}: ${a?.choice ?? "(no answer)"}  [${top}]`);
    }
  } catch (e) { console.log(`${provider}: failed ${String(e.message ?? e).slice(0, 300)}`); }
}
