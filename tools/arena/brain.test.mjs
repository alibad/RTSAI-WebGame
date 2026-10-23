// node --test tools/arena/brain.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { plan, scriptedAnswers, describe } from "./brain.mjs";
import { decide } from "./providers.mjs";

const actor = (actorId, kind, cellX, cellY, extra = {}) => ({ actorId, kind, cellX, cellY, idle: true, canAttack: false, ...extra });
const base = {
  tick: 3000, cash: 2400, powerProvided: 200, powerDrained: 120, harvesterCount: 1, mapWidth: 120, mapHeight: 120, exploredPercent: 30,
  done: false, units: [], buildings: [], visibleEnemies: [], visibleEnemyBuildings: [], rememberedEnemyBuildings: [], production: [], availableProduction: [], actorNames: {},
};

test("a construction vehicle with no base is deployed without asking", () => {
  const obs = { ...base, units: [actor(1, "amcv", 20, 20)] };
  const { auto, questions } = plan(obs);
  assert.deepEqual(auto.map((a) => a.commands[0].action), ["deploy"]);
  assert.equal(questions.length, 0);
});

test("finished buildings are placed; idle lines become questions with a wait option", () => {
  const obs = { ...base, buildings: [actor(2, "gacnst", 20, 20), actor(3, "gapowr", 22, 20)],
    production: [{ item: "gapile", queueType: "Building", progress: 1, remainingTicks: 0 }],
    availableProduction: ["gapowr", "garefn", "gapile", "e1", "gapowrf"] };
  const { auto, questions } = plan(obs);
  assert.equal(auto[0].commands[0].action, "place_building");
  // The building line is busy (a finished Barracks waits to be placed): only infantry is asked.
  assert.deepEqual(questions.map((q) => q.name), ["infantry"]);
  assert.ok(questions[0].options.some((o) => o.value === "wait"));
  assert.ok(!questions[0].options.some((o) => o.value === "gapowrf"), "fake structures are never offered");
});

test("the scripted scorer builds a refinery before anything else when there is none", () => {
  const obs = { ...base, buildings: [actor(2, "gacnst", 20, 20), actor(3, "gapowr", 22, 20)], availableProduction: ["gapowr", "garefn", "gapile"] };
  const { questions } = plan(obs);
  const a = scriptedAnswers(obs, questions);
  assert.equal(a.build.choice, "garefn");
  const sum = Object.values(a.build.probabilities).reduce((s, p) => s + p, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test("a building that is both radar and airfield counts as both, so it is not built twice", () => {
  const obs = { ...base, cash: 2600, buildings: [actor(2, "gacnst", 20, 20), actor(3, "gapowr", 22, 20), actor(4, "garefn", 24, 20), actor(5, "gapile", 26, 20), actor(6, "gaweap", 28, 20), actor(7, "amradr", 30, 20)],
    availableProduction: ["gapowr", "garefn", "gapile", "gaweap", "amradr"] };
  const a = scriptedAnswers(obs, plan(obs).questions);
  assert.notEqual(a.build.choice, "amradr");
  assert.notEqual(a.build.choice, "gaweap");
});

test("the army is sent at the enemy base once it is large and the base is known", () => {
  const army = Array.from({ length: 12 }, (_, i) => actor(10 + i, "mtnk", 25, 25, { canAttack: true, speed: 60 }));
  const obs = { ...base, cash: 300, buildings: [actor(2, "gacnst", 20, 20)], units: army, rememberedEnemyBuildings: [actor(99, "nacnst", 100, 100)] };
  const { questions } = plan(obs);
  const q = questions.find((x) => x.name === "army");
  assert.ok(q);
  const a = scriptedAnswers(obs, questions);
  assert.equal(a.army.choice, "attack");
  assert.equal(q.options.find((o) => o.value === "attack").commands.length, 12);
});

test("the shared state names things and never exposes engine ids", async () => {
  const obs = { ...base, buildings: [actor(2, "gacnst", 20, 20)], availableProduction: ["gapowr"] };
  const d = describe(obs);
  assert.equal(d.time, "2:00");
  assert.ok(!JSON.stringify(d).includes("actorId"));
  const r = await decide("scripted", obs, plan(obs).questions);
  assert.equal(r.usd, 0);
  assert.ok(r.answers.build);
});
