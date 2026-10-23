// node --test tools/arena/brain.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { plan, scriptedAnswers, describe, armyFront } from "./brain.mjs";
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

test("new units always gather at the front instead of piling up at home or trickling into the enemy base", () => {
  const army = Array.from({ length: 12 }, (_, i) => actor(10 + i, "mtnk", 22, 22, { canAttack: true, speed: 60 }));
  const obs = { ...base, cash: 300, buildings: [actor(2, "gacnst", 20, 20)], units: army, rememberedEnemyBuildings: [actor(99, "nacnst", 100, 100)] };
  const { questions, auto, armyTurn } = plan(obs);
  assert.ok(armyTurn);
  const q = questions.find((x) => x.name === "army");
  assert.ok(!q?.options.some((o) => o.value === "attack"), "nothing is forward yet");
  const gather = auto.find((a) => /Gather/.test(a.label));
  assert.equal(gather.commands.length, 12);
  assert.ok(gather.commands.every((c) => c.action === "move"));
});

test("a gathered group attacks together; units already fighting are left alone", () => {
  const gathered = Array.from({ length: 12 }, (_, i) => actor(10 + i, "mtnk", 52, 52, { canAttack: true, speed: 60 }));
  const fighting = actor(40, "mtnk", 90, 90, { canAttack: true, idle: false, targetId: 99 });
  const obs = { ...base, cash: 300, buildings: [actor(2, "gacnst", 20, 20)], units: [...gathered, fighting], rememberedEnemyBuildings: [actor(99, "nacnst", 100, 100), actor(98, "napowr", 104, 100)] };
  const { questions } = plan(obs);
  const attack = questions.find((x) => x.name === "army").options.find((o) => o.value === "attack");
  assert.equal(scriptedAnswers(obs, questions).army.choice, "attack");
  assert.equal(attack.commands.length, 12);
  assert.ok(!attack.commands.some((c) => c.actor_id === 40));
  assert.deepEqual([attack.commands[0].target_x, attack.commands[0].target_y], [100, 100], "the nearest enemy building comes first");
});

test("a building in sight gets an explicit attack order; units do not fire at plain buildings on their own", () => {
  const gathered = Array.from({ length: 12 }, (_, i) => actor(10 + i, "mtnk", 52, 52, { canAttack: true, speed: 60 }));
  const yard = actor(99, "nacnst", 100, 100);
  const obs = { ...base, cash: 300, buildings: [actor(2, "gacnst", 20, 20)], units: gathered, visibleEnemyBuildings: [yard], rememberedEnemyBuildings: [yard] };
  const attack = plan(obs).questions.find((x) => x.name === "army").options.find((o) => o.value === "attack");
  assert.ok(attack.commands.every((c) => c.action === "attack" && c.target_actor_id === 99));
});

test("early defence: the war factory waits for the first two towers unless credits are plentiful", () => {
  const obs = { ...base, tick: 25 * 80, cash: 1500, buildings: [actor(2, "gacnst", 20, 20), actor(3, "gapowr", 22, 20), actor(4, "garefn", 24, 20), actor(5, "gapile", 26, 20)],
    availableProduction: ["gaweap", "gapill", "gapowr"] };
  const { questions } = plan(obs);
  const a = scriptedAnswers(obs, questions);
  assert.notEqual(a.build.choice, "gaweap");
  assert.equal(a.defense.choice, "gapill");
  const rich = { ...obs, cash: 3000 };
  assert.equal(scriptedAnswers(rich, plan(rich).questions).build.choice, "gaweap");
});

test("early defence: walls are never offered, and two real towers go up by minute 2", () => {
  const obs = { ...base, tick: 25 * 150, cash: 2000, buildings: [actor(2, "gacnst", 20, 20), actor(3, "gapowr", 22, 20), actor(4, "garefn", 24, 20), actor(5, "gapile", 26, 20)],
    availableProduction: ["gawall", "gapill", "gagap", "nasam"] };
  const q = plan(obs).questions.find((x) => x.name === "defense");
  assert.ok(q, "the defense line is asked once minute 2 has passed without towers");
  assert.ok(!q.options.some((o) => o.value === "gawall"));
  assert.equal(scriptedAnswers(obs, [q]).defense.choice, "gapill");
});

test("while weak, the army gathers just in front of the base; strong, it moves up", () => {
  const few = Array.from({ length: 4 }, (_, i) => actor(10 + i, "e1", 21, 21, { canAttack: true }));
  const weak = { ...base, buildings: [actor(2, "gacnst", 20, 20)], units: few, rememberedEnemyBuildings: [actor(99, "nacnst", 100, 100)] };
  const tanks = Array.from({ length: 12 }, (_, i) => actor(10 + i, "mtnk", 21, 21, { canAttack: true }));
  const strong = { ...weak, units: tanks };
  assert.ok(armyFront(weak).staging.cellX < 35, "weak: staging near home");
  assert.ok(armyFront(strong).staging.cellX > 45, "strong: staging 40% of the way");
});

test("under pressure, credits go to combat units, not a second harvester or technology", () => {
  const raiders = Array.from({ length: 10 }, (_, i) => actor(50 + i, "htnk", 26, 26, { canAttack: true }));
  const obs = { ...base, cash: 2500, harvesterCount: 1, buildings: [actor(2, "gacnst", 20, 20), actor(3, "gapowr", 22, 20), actor(4, "garefn", 24, 20), actor(5, "gaweap", 26, 20)],
    units: [actor(10, "mtnk", 22, 22, { canAttack: true })], visibleEnemies: raiders, availableProduction: ["cmin", "mtnk", "gaairc", "garefn"] };
  const { questions } = plan(obs);
  const a = scriptedAnswers(obs, questions);
  assert.notEqual(a.vehicle.choice, "cmin");
  assert.notEqual(a.build.choice, "garefn");
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
