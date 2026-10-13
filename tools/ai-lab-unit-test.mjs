import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from '../web/node_modules/typescript/lib/typescript.js';
const source = fs.readFileSync('web/src/ai-lab.ts', 'utf8').replace('import { store } from "./store";', 'const store = { get: () => ({ paused: false }) };');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { planFromText, interpret, pickUnit, validatePlan, nativeIssues, practiceScenario, formation, cleanLabel, MAX_FORCE, Coach } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const units = [{ name: 'rifle', label: 'Rifle infantry', queue: 'Infantry', modern: true }, { name: 'tank', label: 'Battle tank', queue: 'Vehicle', modern: true }];
const factions = ['saudi', 'iran'];
const p = planFromText('Defend with 6 tanks against 8 units for 2 minutes', units, factions);
assert.equal(p.count, 6); assert.equal(p.enemyCount, 8); assert.equal(p.unit, 'tank'); assert.equal(p.enemyUnit, 'tank'); assert.equal(p.objective, 'survive'); assert.equal(p.duration, 120);
assert.deepEqual(validatePlan(p, units, factions), []);
for (const bad of [{ count: 99 }, { unit: 'invented' }, { faction: 'invented' }, { duration: 0 }, { seed: NaN }]) assert.equal(validatePlan({ ...p, ...bad }, units, factions).length, 1);
const scenario = practiceScenario(p, units);
assert.equal(scenario.placements.length, 14); assert.equal(scenario.seed, 42); assert.equal(scenario.objective, 'survive'); assert.equal(scenario.duration, 120);
assert.deepEqual(practiceScenario(p, units), scenario);
assert.equal(scenario.players[0].bot, undefined, 'You command side 0 in the very world the workshop previews');
assert.deepEqual(scenario.placements.map(a => a.facing), [...Array(6).fill(768), ...Array(8).fill(256)]);

// The engine catalog as the workshop probes it: non-combat actors are listed too and must never be picked.
const catalog = [
  { name: 'amcv', label: 'Mobile Construction Vehicle', queue: 'Vehicle', modern: false, combat: false, size: [67, 55] },
  { name: 'apoc', label: 'Heavy Assault Tank', queue: 'Vehicle', modern: false, combat: true, size: [63, 51] },
  { name: 'cmin', label: 'Ore Harvester', queue: 'Vehicle', modern: false, combat: false, size: [63, 51] },
  { name: 'e1', label: 'G.I.', queue: 'Infantry', modern: false, combat: true, size: [19, 30] },
  { name: 'engineer', label: 'Engineer', queue: 'Infantry', modern: false, combat: false, size: [19, 30] },
  { name: 'r2basij', label: 'Basij Rifleman', queue: 'Infantry', modern: true, combat: true, size: [24, 31] },
  { name: 'r2karrar', label: 'Karrar Battle Tank', queue: 'Vehicle', modern: true, combat: true, size: [63, 47] },
  { name: 'r2m1a2s', label: 'M1A2S Battle Tank', queue: 'Vehicle', modern: true, combat: true, size: [63, 47] },
  { name: 'r2raad', label: 'Raad Air Defense', queue: 'Vehicle', modern: true, combat: true, size: [63, 47] },
  { name: 'r2sajtac', label: 'Saudi JTAC', queue: 'Infantry', modern: true, combat: true, size: [24, 31] },
  { name: 'r2sang', label: 'Saudi National Guard', queue: 'Infantry', modern: true, combat: true, size: [24, 31] },
];
const rosters = { saudi: ['r2sang', 'r2sajtac', 'r2m1a2s'], iran: ['r2basij', 'r2raad', 'r2karrar'], america: [] };
const all = ['america', 'saudi', 'iran'], names = { saudi: 'Saudi Arabia', iran: 'Iran', america: 'America' };
const owner = interpret('Defend with 6 tanks against 8 units for 2 minutes', catalog, all, undefined, rosters, names);
assert.deepEqual([owner.plan.faction, owner.plan.unit, owner.plan.count, owner.plan.enemy, owner.plan.enemyUnit, owner.plan.enemyCount, owner.plan.duration, owner.plan.objective],
  ['saudi', 'r2m1a2s', 6, 'iran', 'r2karrar', 8, 120, 'survive'], 'The owner\'s request: Saudi battle tanks against Iranian battle tanks, never an MCV');
assert.deepEqual(validatePlan(owner.plan, catalog, all), []);
const infantry = interpret('Survive with 6 infantry against 8 units for 30 seconds', catalog, all, undefined, rosters, names).plan;
assert.deepEqual([infantry.unit, infantry.enemyUnit, infantry.duration], ['r2sang', 'r2basij', 30]);
const swapped = interpret('Iran with 4 tanks vs 10 Saudi Arabia soldiers', catalog, all, undefined, rosters, names).plan;
assert.deepEqual([swapped.faction, swapped.unit, swapped.count, swapped.enemy, swapped.enemyUnit, swapped.enemyCount], ['iran', 'r2karrar', 4, 'saudi', 'r2sang', 10]);
const named = interpret('6 Karrar tanks against 8 Basij, seed 7', catalog, all, undefined, rosters, names);
assert.deepEqual([named.plan.unit, named.plan.enemyUnit, named.plan.seed, named.named.unit, named.named.enemyUnit], ['r2karrar', 'r2basij', 7, true, true]);
assert.equal(interpret('Hold with 3 tanks against 5 units from America', catalog, all, undefined, rosters, names).plan.enemyUnit, 'apoc', 'A country without a palette roster fields the original units');
assert.equal(interpret('Fight 100 tanks against 0 units for 90 minutes', catalog, all, undefined, rosters, names).plan.count, MAX_FORCE);
for (const text of ['8 units', 'units against units', 'vehicles vs vehicles', 'drones against harvesters', 'engineers vs MCV', 'construction vehicles against 3 units']) {
  const r = interpret(text, catalog, all, undefined, rosters, names).plan;
  for (const n of [r.unit, r.enemyUnit]) assert(catalog.find(u => u.name === n)?.combat, `"${text}" picked ${n}`);
}
for (const f of all) for (const cls of [null, 'tank', 'infantry', 'air', 'artillery', 'drone', 'vehicle']) assert(catalog.find(u => u.name === pickUnit(cls, f, catalog, rosters))?.combat);
assert.equal(cleanLabel('Heavy Assault Tank Tank'), 'Heavy Assault Tank'); assert.equal(cleanLabel('Main Battle Tank Heavy Tank'), 'Main Battle Tank Heavy Tank');

// Field-level problems: next to the field that causes them, in plain words.
assert.deepEqual(validatePlan({ ...owner.plan, count: 99 }, catalog, all), [{ field: 'count', message: 'Use 1–24 units.' }]);
assert.deepEqual(validatePlan({ ...owner.plan, enemyUnit: 'amcv' }, catalog, all), [{ field: 'enemyUnit', message: "Mobile Construction Vehicle can't fight. Pick a combat unit." }]);
assert.deepEqual(nativeIssues(['Each side needs at least one combat unit.'], { ...owner.plan, enemyUnit: 'amcv' }, catalog), [{ field: 'enemyUnit', message: "Mobile Construction Vehicle can't fight. Pick a combat unit." }]);
const noRoute = ['r2karrar: no ground route to opposing force.'], cannotReach = [{ field: 'enemyUnit', message: "Can't reach the opponent over land." }];
assert.deepEqual(nativeIssues(noRoute, owner.plan, catalog, true), cannotReach, 'Terrain route checks are trusted');
assert.deepEqual(nativeIssues(noRoute, owner.plan, catalog), [], 'An older runtime pathed into the enemy tank\'s own cell: no answer, not an error');
assert.deepEqual(nativeIssues(noRoute, { ...owner.plan, unit: 'r2sang' }, catalog), cannotReach, 'Against infantry (shared cells) the older check holds');
assert.deepEqual(nativeIssues(['r2karrar: invalid terrain.'], owner.plan, catalog), [{ field: 'enemyUnit', message: "Can't stand on this ground." }]);

// Formations: no two units' on-screen boxes overlap, for any force size and unit size (infantry to airships, MCVs).
const screen = c => ({ x: (2 * c.u + (c.v & 1)) * 30, y: c.v * 15 });
for (const size of [[19, 30], [24, 31], [30, 23], [63, 47], [63, 51], [67, 55], [69, 60], [99, 60], undefined]) for (const n of [1, 2, 6, 8, 13, MAX_FORCE]) {
  const [w, h] = size ?? [72, 60];
  const both = [0, 1].flatMap(side => formation(n, side, size).map(c => ({ ...c, side, ...screen(c) })));
  assert.equal(both.length, 2 * n);
  for (let i = 0; i < both.length; i++) {
    const a = both[i];
    assert(a.u >= 1 && a.u < 129 && a.v >= 1 && a.v < 145, 'inside the arena');
    for (let j = i + 1; j < both.length; j++) {
      const b = both[j];
      assert(Math.abs(a.x - b.x) >= w || Math.abs(a.y - b.y) >= h, `size ${size} n ${n}: ${JSON.stringify(a)} overlaps ${JSON.stringify(b)}`);
    }
  }
  const front = side => Math.min(...both.filter(c => c.side === 1).map(c => c.u)) - Math.max(...both.filter(c => c.side === 0).map(c => c.u));
  assert.equal(front(), 25, 'front ranks keep the arena distance');
}

const game = { scenarioJson: JSON.stringify({ map: 'test' }), cam: { x: 1, y: 2, zoom: 1 }, multiplayer: false, renderer: { runModels: () => {} }, command: async () => ({ doctrines: [] }), setPaused: () => {}, lookAt: () => {} };
const coach = new Coach(game);
const ui = { tick: 25, cash: 5000, power: { provided: 50, drained: 100, state: 'Low' }, queues: [{ enabled: true, items: [] }], coach: { earned: 100, losses: 0, actors: [{ id: 1, building: false, x: 10, y: 10 }] } };
const snap = tick => ({ header: { tick, localPlayer: 0 }, actors: [], actorById: new Map() });
coach.record(snap(25), ui); assert.equal(coach.events[0].kind, 'power'); assert.equal(coach.frames[0].army, 1);
coach.record(snap(50), ui); assert.equal(coach.events.filter(e => e.kind === 'loss').length, 0); // Empty viewport is not an army loss.
coach.record(snap(75), { ...ui, coach: { ...ui.coach, losses: 1, actors: [] } }); assert.equal(coach.events.at(-1).kind, 'loss');
coach.record(snap(800), ui); assert(coach.events.some(e => e.kind === 'production')); assert(coach.events.some(e => e.kind === 'cash'));
coach.seek(75); assert.equal(coach.review.tick, 75); coach.live(); assert.equal(coach.review, null);
coach.reset(); assert.equal(coach.events.length, 0); assert.equal(coach.frames.length, 0);
coach.record(snap(25), {}); assert.equal(coach.events.length, 0); // Spectator/editor UI has no player queues.
console.log('Unit checks passed: typed plans that only pick combat units of each faction, field-level issues, non-overlapping formations, deterministic scenarios, native-evidence coaching, safe seek and editor reset.');
