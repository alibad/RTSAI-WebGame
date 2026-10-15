// The campaign co-commander's planner (web/src/mission-adviser.ts) on synthetic observations: no browser or game.
// Covers the map reader, actor ids, sensor sweeps, crossing a zone only while it sleeps, the objective errands
// (reach, capture, demolish, escort, disperse, defend), the memory of units sent, and the new command fields on the
// wire. The page's playtests (tools/chapters-playtest.mjs) cover the real missions.
//   node tools/mission-adviser-test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { build } = await import(pathToFileURL(path.join(repo, "web/node_modules/esbuild/lib/main.js")).href);
// The page's TypeScript, bundled for Node.
const load = async (entry) => {
  const file = path.join(process.env.TEMP ?? os.tmpdir(), `mission-adviser-${process.pid}-${path.basename(entry, ".ts")}.mjs`);
  await build({ entryPoints: [path.join(repo, entry)], bundle: true, format: "esm", outfile: file, platform: "neutral", logLevel: "error" });
  try { return await import(pathToFileURL(file).href); } finally { fs.rmSync(file, { force: true }); }
};
const { missionAdvice, parseMissionMap, placeName, MissionMemory, missionInternals } = await load("web/src/mission-adviser.ts");
const { encodeAdviserActions } = await load("web/src/sim/adviser-rpc.ts");
const techTree = JSON.parse(fs.readFileSync(path.join(repo, "web/src/adviser-tree.json"), "utf8"));
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`); };

// Open ground, all in sight: W × H cells (MPos), 12 channels like the engine's grid (3: passable, 4: visible).
const W = 60, H = 120;
function spatial(blocked = () => false) {
  const f = new Float32Array(W * H * 12);
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) { const i = (v * W + u) * 12; f[i + 3] = blocked(u, v) ? 0 : 1; f[i + 4] = 1; }
  return { channels: 12, bytes: new Uint8Array(f.buffer) };
}
// A cell's centre in the engine's distance units (isometric: 1448 × 724 world units a cell), and in world units.
const S = Math.SQRT2;
const wxy = (u, v) => [(u + (v & 1 ? 0.5 : 0)) * S, v * S / 2];
const at = (u, v) => ({ cellX: u, cellY: v, x: 1448 * u + 724 * (v & 1) + 724, y: 724 * (v + 1) });
const unit = (actorId, kind, u, v, extra = {}) => ({ actorId, kind, ...at(u, v), idle: true, canAttack: true, hpPercent: 1, speed: 56, ...extra });
const observe = (o = {}) => ({ tick: 1000, cash: 0, powerProvided: 0, powerDrained: 0, harvesterCount: 0, mapWidth: W, mapHeight: H, exploredPercent: 100, done: false,
  units: [], buildings: [], visibleEnemies: [], visibleEnemyBuildings: [], rememberedEnemyBuildings: [], production: [], availableProduction: [], actorNames: {},
  spatial: spatial(), ...o });
// A map.yaml with these actors ([name, type, owner, u, v]; Location in the engine's cell coordinates).
const yaml = (actors) => `MapFormat: 12\nActors:\n${actors.map(([name, type, owner, u, v]) =>
  `\t${name}: ${type}\n\t\tOwner: ${owner}\n\t\tLocation: ${(v + 2 * u + (v & 1)) / 2},${(v - 2 * u - (v & 1)) / 2}\n`).join("")}Rules:\n`;
const live = (spec) => ({ difficulty: "normal", events: [], objectives: spec.objectives.map(() => ({ status: "active", waiting: false, progress: "" })) });
const plan = (spec, map, obs, memory = new MissionMemory()) => missionAdvice(obs, { spec, live: live(spec), map, memory, techTree, now: 0 });

test("map.yaml actors in file order, cells as MPos", () => {
  const map = parseMissionMap(yaml([["Spawn", "mpspawn", "Neutral", 3, 39], ["Tanya", "tany", "China", 4, 38], ["Mast", "naradr", "Orion", 14, 40]]));
  assert.deepEqual(map.actors.map((a) => [a.name, a.type, a.u, a.v, a.index]), [["Spawn", "mpspawn", 3, 39, 0], ["Tanya", "tany", 4, 38, 1], ["Mast", "naradr", 14, 40, 2]]);
  // The real Glass Island map: Location 23,15 is MPos (4, 38).
  const glass = parseMissionMap(fs.readFileSync(path.join(repo, "content/maps/glass-island/map.yaml"), "utf8"));
  assert.deepEqual([glass.named.Tanya.u, glass.named.Tanya.v], [4, 38]);
  assert.equal(placeName("DomeWest"), "the west dome");
  assert.equal(placeName("SurvivorsCove"), "the survivors cove");
  assert.equal(placeName("MastVaultNorth"), "the north vault mast");
});

test("map actor ids: the index plus the engine's offset, found from the actors in sight", () => {
  const map = parseMissionMap(yaml([["A", "waypoint", "Neutral", 1, 1], ["Rifle1", "e1", "Me", 10, 20], ["Rifle2", "e1", "Me", 11, 20], ["Tank", "htnk", "Them", 30, 60], ["Gen", "gapowr", "Them", 40, 80]]));
  const spec = { id: "t", slot: "Me", enemy: "Them", objectives: [{ text: "Destroy the generator.", kind: "destroy", targets: ["Gen"] }] };
  const memory = new MissionMemory();
  const w = new missionInternals.World(observe({ units: [unit(6, "e1", 10, 20), unit(7, "e1", 11, 20)], visibleEnemies: [unit(8, "htnk", 30, 60)] }),
    { spec, live: live(spec), map, memory, techTree });
  assert.equal(memory.offset, 5);
  assert.equal(w.find("Tank").actorId, 8);
  assert.equal(w.idOf("Gen"), 9);
});

// A specialist must reach the cove past a sweeping mast (radius 4; on 4 s, asleep 16 s), through a gap in a wall.
const sweepSpec = (sweep) => ({ id: "t", slot: "Me", enemy: "Them", sensors: [{ actor: "Mast", radius: 4, sweep, offset: 0 }],
  objectives: [{ text: "Bring the specialist to the cove.", kind: "reach", types: ["r2cnnetwork"], target: "Cove", radius: 4 },
    { text: "Stay out of the sensor masts' sight.", kind: "undetected", targets: ["Mast"], allowed: 1 }] });
const sweepMap = parseMissionMap(yaml([["Spec", "r2cnnetwork", "Me", 20, 20], ["Mast", "naradr", "Them", 20, 50], ["Cove", "waypoint", "Neutral", 20, 80]]));
const walled = spatial((u, v) => v >= 48 && v <= 52 && Math.abs(u - 20) > 1);
const mast = unit(2, "naradr", 20, 50, { canAttack: false });
const specialist = (u, v) => unit(1, "r2cnnetwork", u, v, { speed: 55 });

test("sensor sweep: on for its first seconds each cycle, as Missions.cs reckons it", () => {
  const spec = sweepSpec([6, 14]);
  const w = new missionInternals.World(observe({ units: [specialist(20, 20)], visibleEnemyBuildings: [mast] }),
    { spec, live: live(spec), map: sweepMap, memory: new MissionMemory(), techTree });
  const s = w.watching()[0];
  assert.deepEqual([0, 149, 150, 499, 500].map((t) => w.sensorOn(s, t)), [true, true, false, false, true]);
});

test("stealth: walk to the zone's edge, hold while it sweeps, cross while it sleeps", () => {
  const spec = sweepSpec([4, 16]);
  const far = plan(spec, sweepMap, observe({ tick: 1000, units: [specialist(20, 10)], visibleEnemyBuildings: [mast], spatial: walled }));
  assert.match(far.key, /:(walk|stage):/);
  assert(far.commands.every((c) => c.action === "move" && c.target_y < 44), JSON.stringify(far.commands));
  // At the edge while the sweep is on (ticks 1000-1100 of a 500-tick cycle): hold, with no order.
  const edge = observe({ tick: 1000, units: [specialist(20, 40)], visibleEnemyBuildings: [mast], spatial: walled });
  const hold = plan(spec, sweepMap, edge);
  assert.equal(hold.commands.length, 0);
  assert.match(hold.text, /hold at the edge/);
  // Just after it went to sleep: cross, in one order that ends past the zone.
  const cross = plan(spec, sweepMap, { ...edge, tick: 1110 });
  assert.match(cross.text, /cross now/);
  assert(cross.commands.at(-1).target_y >= 57, JSON.stringify(cross.commands));
  // Late in its sleep, with too little time left to get through: hold.
  assert.equal(plan(spec, sweepMap, { ...edge, tick: 1300 }).commands.length, 0);
});

test("stealth: a zone that never sleeps is walked around, never entered", () => {
  const spec = sweepSpec([]);
  const memory = new MissionMemory();
  const w = new missionInternals.World(observe({ units: [specialist(20, 20)], visibleEnemyBuildings: [mast] }), { spec, live: live(spec), map: sweepMap, memory, techTree });
  const leg = missionInternals.stealthLeg(w, w.units, { u: 20, v: 80 }, "move", "Go", "g");
  assert(leg.commands.length > 0);
  const [mx, my] = wxy(20, 50);
  for (const c of leg.commands) { const [x, y] = wxy(c.target_x, c.target_y); assert(Math.hypot(x - mx, y - my) > 4.4, JSON.stringify(c)); }
});

test("a unit caught in a zone about to sweep gets out at once", () => {
  const spec = sweepSpec([4, 16]);
  // Tick 480: asleep, but the sweep starts in 20 ticks.
  const a = plan(spec, sweepMap, observe({ tick: 480, units: [specialist(21, 52)], visibleEnemyBuildings: [mast] }));
  assert.match(a.key, /evade/);
  assert.equal(a.commands[0].action, "move");
});

test("capture: the engineer goes in once the place is clear, by actor id", () => {
  const map = parseMissionMap(yaml([["W0", "waypoint", "Neutral", 1, 1], ["Eng", "engineer", "Me", 10, 20], ["Rifle", "e1", "Me", 11, 20], ["Node", "gaairc", "Neutral", 12, 30]]));
  const spec = { id: "t", slot: "Me", enemy: "Them", objectives: [{ text: "Capture the radar node.", kind: "capture", targets: ["Node"] }] };
  const memory = new MissionMemory();
  memory.offset = 10;
  const engineer = unit(11, "engineer", 10, 20, { canAttack: false, canCapture: true, captureTargets: [13] });
  // The army still on its way: it clears the node first, the engineer waits.
  const far = plan(spec, map, observe({ units: [engineer, unit(12, "e1", 11, 20)] }), memory);
  assert(far.commands.length && far.commands.every((c) => c.action === "attack_move" && c.actor_id === 12), JSON.stringify(far));
  // The army holds it, all in sight, no guards: the engineer goes in.
  const known = () => Object.assign(new MissionMemory(), { offset: 10 });
  const a = plan(spec, map, observe({ units: [engineer, unit(12, "e1", 12, 27)] }), known());
  assert.deepEqual(a.commands, [{ action: "capture", actor_id: 11, target_actor_id: 13 }]);
  assert.match(a.text, /capture it now/);
  // Guards at the node: not yet.
  const b = plan(spec, map, observe({ units: [engineer, unit(12, "e1", 12, 27)], visibleEnemies: [unit(40, "e2", 12, 32)] }), known());
  assert(b.commands.every((c) => c.action !== "capture"), JSON.stringify(b));
});

test("destroy: a commando charges every target in reach, one after another", () => {
  const map = parseMissionMap(yaml([["W0", "waypoint", "Neutral", 1, 1], ["Tanya", "tany", "Me", 10, 20], ["G1", "gapowr", "Them", 12, 30], ["G2", "gapowr", "Them", 30, 30]]));
  const spec = { id: "t", slot: "Me", enemy: "Them", objectives: [{ text: "Charge the generators.", kind: "destroy", targets: ["G1", "G2"], limit: 540 }] };
  const memory = new MissionMemory();
  memory.offset = 10;
  const a = plan(spec, map, observe({ units: [unit(11, "tany", 10, 20, { canDemolish: true, demolishTargets: [12, 13] })],
    visibleEnemyBuildings: [unit(12, "gapowr", 12, 30, { canAttack: false }), unit(13, "gapowr", 30, 30, { canAttack: false })] }), memory);
  assert.deepEqual(a.commands, [{ action: "demolish", actor_id: 11, target_actor_id: 12 }, { action: "demolish", actor_id: 11, target_actor_id: 13, queued: true }]);
});

test("reach with the army; units sent are left alone while on their way", () => {
  const map = parseMissionMap(yaml([["Cove", "waypoint", "Neutral", 40, 100]]));
  const spec = { id: "t", slot: "Me", enemy: "Them", objectives: [{ text: "Find the survivors at the cove.", kind: "reach", target: "Cove", radius: 5, count: 3,
    types: ["r2technical", "r2ymr", "r2yrpg", "r2ymlr"] }] };
  const army = [unit(1, "r2technical", 10, 20), unit(2, "r2ymr", 11, 20), unit(3, "r2yrpg", 12, 20), unit(4, "r2ymlr", 13, 20)];
  const memory = new MissionMemory();
  const a = plan(spec, map, observe({ units: army }), memory);
  assert.equal(a.commands.length, 4);
  assert(a.commands.every((c) => c.action === "attack_move" && c.target_x === 40 && c.target_y === 100));
  memory.record(a, 1000);
  const moving = army.map((u) => ({ ...u, idle: false, ...at(u.cellX + 5, u.cellY + 20) }));
  assert.equal(plan(spec, map, observe({ tick: 1100, units: moving }), memory).commands.length, 0);
});

test("escort: the army clears the road a step ahead of the leading truck, and never orders the trucks", () => {
  const map = parseMissionMap(yaml([["Entry", "waypoint", "Neutral", 50, 100], ["R1", "waypoint", "Neutral", 40, 90], ["R2", "waypoint", "Neutral", 30, 80], ["R3", "waypoint", "Neutral", 20, 70]]));
  const spec = { id: "t", slot: "Me", enemy: "Them", objectives: [{ text: "Escort the convoy.", kind: "escort", entry: "Entry", route: ["R1", "R2", "R3"], count: 2 }] };
  const a = plan(spec, map, observe({ units: [unit(1, "sapc", 41, 91, { idle: false, canAttack: false }), unit(2, "e1", 45, 95), unit(3, "e1", 46, 95)] }));
  assert.equal(a.commands.length, 2);
  assert(a.commands.every((c) => c.actor_id !== 1 && c.target_x === 30 && c.target_y === 80), JSON.stringify(a.commands));
});

test("disperse: units leave the marked area before the sweep", () => {
  const spec = { id: "t", slot: "Me", enemy: "Them", objectives: [{ text: "Leave the zone.", kind: "disperse", area: [20, 40, 30, 60], seconds: 120, allowed: 1 }] };
  const a = plan(spec, parseMissionMap(yaml([])), observe({ units: [unit(1, "e1", 25, 50), unit(2, "e1", 26, 50), unit(3, "e1", 5, 5)] }));
  assert.equal(a.commands.length, 2);
  for (const c of a.commands) assert(c.target_x < 19 || c.target_x > 31 || c.target_y < 38 || c.target_y > 62, JSON.stringify(c));
});

test("defend what the mission protects", () => {
  const map = parseMissionMap(yaml([["Clinic", "cahosp", "Me", 20, 40]]));
  const spec = { id: "t", slot: "Me", enemy: "Them", protect: ["Clinic"], objectives: [{ text: "Keep the clinic standing.", kind: "protect", targets: ["Clinic"] },
    { text: "Hold.", kind: "survive", seconds: 480 }] };
  const a = plan(spec, map, observe({ units: [unit(1, "e1", 20, 52), unit(2, "e1", 21, 52)], buildings: [unit(9, "cahosp", 20, 40, { canAttack: false })],
    visibleEnemies: [unit(30, "htnk", 22, 44)] }));
  assert.match(a.text, /Enemies are at the clinic/);
  assert.equal(a.commands.length, 2);
});

test("unverified contacts: return fire only, verify by going close, never fire on them", () => {
  const map = parseMissionMap(yaml([["Picture", "waypoint", "Neutral", 30, 50], ["Shelter", "gapile", "Civilians", 20, 30], ["Contact1", "htnk", "Contacts", 22, 36],
    ["Relay", "naradr", "Them", 50, 100]]));
  const spec = { id: "t", slot: "Me", enemy: "Them", sensors: [{ actor: "Contact1", radius: 3 }],
    objectives: [{ text: "Fire on nothing you have not verified.", kind: "protect", targets: ["Picture"] }, { text: "Destroy the relay.", kind: "destroy", targets: ["Relay"] },
      { text: "Keep the shelter standing.", kind: "protect", targets: ["Shelter"] }, { text: "Verify every contact.", kind: "scout", targets: ["Contact1"], radius: 3, secondary: true }] };
  const memory = new MissionMemory();
  const contact = unit(30, "htnk", 22, 36, { canAttack: false });
  const tanks = (stance, extra = {}) => [unit(1, "r2merkava", 10, 10, { stance, speed: 80, ...extra }), unit(2, "r2merkava", 11, 10, { stance, ...extra })];
  // First: everyone to return fire.
  const a = plan(spec, map, observe({ units: tanks(3), visibleEnemies: [contact] }), memory);
  assert.deepEqual(a.commands, [{ action: "set_stance", actor_id: 1, target_x: 1 }, { action: "set_stance", actor_id: 2, target_x: 1 }]);
  memory.record(a, 1000);
  // Then a unit goes to see what the contact is (a move, not an attack), though it stands by the shelter.
  const b = plan(spec, map, observe({ tick: 1100, units: tanks(1), visibleEnemies: [contact] }), memory);
  assert.equal(b.commands.length, 1);
  assert.equal(b.commands[0].action, "move");
  assert.match(b.text, /Verify/);
  memory.record(b, 1100);
  // The relay strike moves (no attack-move) while the contact is unverified.
  const c = plan(spec, map, observe({ tick: 1200, units: [tanks(1)[0], unit(2, "r2merkava", 11, 10, { stance: 1 })], visibleEnemies: [contact] }), memory);
  assert(c.commands.every((x) => x.action !== "attack_move" && x.target_actor_id !== 30), JSON.stringify(c));
  // Verified (a unit within its radius): fire at will again.
  const d = plan(spec, map, observe({ tick: 1300, units: [unit(1, "r2merkava", 22, 38, { stance: 1 }), unit(2, "r2merkava", 11, 10, { stance: 1 })], visibleEnemies: [contact] }), memory);
  assert.deepEqual(d.commands.map((x) => [x.action, x.target_x]), [["set_stance", 3], ["set_stance", 3]]);
});

test("orders on the wire: the target actor (field 3) and queued (field 7)", () => {
  const bytes = encodeAdviserActions("mission-test-1", 100, [{ action: "demolish", actor_id: 5, target_actor_id: 9, queued: true }]);
  // The request: 1 id (16 bytes), 2 tick (2), then 3 the command { 1 action 24, 2 actor, 3 target actor, 7 queued }.
  assert.deepEqual([...bytes.subarray(18)], [0x1a, 8, 0x08, 24, 0x10, 5, 0x18, 9, 0x38, 1]);
});

console.log(`${passed} mission adviser tests passed`);
