// The battle simulator's layout code (web/src/battle-plan.ts) and the Earth missions (web/src/mission.ts), without a
// browser: formations face their target without stacking, facings follow the engine's WAngle, the Earth compiler's
// projection and start positions convert to MPos, and a mission places a base on its site and both armies.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from '../web/node_modules/typescript/lib/typescript.js';

// Each module transpiled to a data: URL, its relative imports pointed at the others' URLs (the store stubbed).
const moduleUrl = (file, replace = (s) => s) => {
  const code = ts.transpileModule(replace(fs.readFileSync(file, 'utf8')), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
};
const labUrl = moduleUrl('web/src/ai-lab.ts', (s) => s.replace('import { store } from "./store";', 'const store = { get: () => ({ paused: false }) };'));
const planUrl = moduleUrl('web/src/battle-plan.ts', (s) => s.replace('from "./ai-lab";', `from "${labUrl}";`));
const plan = await import(planUrl);
const strengthUrl = moduleUrl('web/src/strength.ts');
const strength = await import(strengthUrl);
const mission = await import(moduleUrl('web/src/mission.ts', (s) => s.replace('from "./ai-lab";', `from "${labUrl}";`).replace('from "./battle-plan";', `from "${planUrl}";`).replace('from "./strength";', `from "${strengthUrl}";`)));

// Facings: north 0, west 256, south 512, east 768 (WAngle).
assert.equal(plan.facingToward({ u: 10, v: 20 }, { u: 10, v: 10 }), 0);
assert.equal(plan.facingToward({ u: 10, v: 20 }, { u: 5, v: 20 }), 256);
assert.equal(plan.facingToward({ u: 10, v: 20 }, { u: 10, v: 30 }), 512);
assert.equal(plan.facingToward({ u: 10, v: 20 }, { u: 15, v: 20 }), 768);

// Formations: every unit on its own cell, the front rank nearest the target.
for (const n of [1, 6, 13, 24]) {
  const cells = plan.formationAt({ u: 40, v: 60 }, { u: 40, v: 20 }, n);
  assert.equal(cells.length, n);
  assert.equal(new Set(cells.map((c) => `${c.u},${c.v}`)).size, n, `${n} units on distinct cells`);
}

// The Earth compiler's projection (north-up, size wide, 2 x size tall) and its start positions.
const center = { lat: 25.1, lon: 51.3 };
assert.deepEqual(mission.geoToCell(25.1, 51.3, center, 2500, 80), { u: 40, v: 80 });
assert.ok(mission.geoToCell(25.11, 51.3, center, 2500, 80).v < 80, 'north is up');
assert.ok(mission.geoToCell(25.1, 51.31, center, 2500, 80).u > 40, 'east is right');
assert.deepEqual(mission.spawnCells('Actors:\n\tSpawn0: mpspawn\n\t\tOwner: Neutral\n\t\tLocation: 60,22\n\tSpawn1: mpspawn\n\t\tOwner: Neutral\n\t\tLocation: 30,60\n'), [{ u: 19, v: 82 }, { u: -15, v: 90 }]);

// A mission: the defender's base on the site from its own roster, both armies placed, the attack from the far start.
const units = [
  { name: 'gacnst', label: 'Construction Yard', queue: 'Building', kind: 'building', cost: 3000, modern: false },
  { name: 'gapowr', label: 'Power Plant', queue: 'Building', kind: 'building', cost: 800, modern: false },
  { name: 'gapile', label: 'Barracks', queue: 'Building', kind: 'building', cost: 500, modern: false },
  { name: 'gaweap', label: 'War Factory', queue: 'Building', kind: 'building', cost: 2000, modern: false },
  { name: 'r2saguard', label: 'Guard Tower', queue: 'Support', kind: 'defense', cost: 600, modern: true },
  { name: 'r2m1a2s', label: 'M1A2S Battle Tank', queue: 'Vehicle', kind: 'vehicle', cost: 1150, modern: true },
  { name: 'engineer', label: 'Engineer', queue: 'Infantry', kind: 'infantry', cost: 500, modern: false, combat: false },
  { name: 'r2sang', label: 'National Guard Rifleman', queue: 'Infantry', kind: 'infantry', cost: 200, modern: true },
  { name: 'r2karrar', label: 'Karrar Battle Tank', queue: 'Vehicle', kind: 'vehicle', cost: 1100, modern: true },
  { name: 'r2basij', label: 'Basij Rifleman', queue: 'Infantry', kind: 'infantry', cost: 150, modern: true },
];
const rosters = { saudi: ['gacnst', 'gapowr', 'gapile', 'gaweap', 'r2saguard', 'r2m1a2s', 'engineer', 'r2sang'], iran: ['r2karrar', 'r2basij'] };
const spec = { map: 'earth-x', title: 'Air base', site: { u: 40, v: 90, name: 'Air base' }, fa: 'saudi', fb: 'iran', youDefend: true, points: [{ u: 18, v: 52 }, { u: 62, v: 108 }] };
const placed = mission.missionPlacements(spec, units, rosters);
const yard = placed.find((p) => p.id === 'gacnst');
assert.deepEqual([yard.u, yard.v, yard.side], [40, 90, 0], 'the yard stands on the site, yours');
assert.ok(placed.some((p) => p.id === 'r2saguard' && p.side === 0), 'defences from the defender roster');
assert.ok(placed.some((p) => p.id === 'r2sang') && !placed.some((p) => p.id === 'engineer'), 'only units the engine says can fight');
const enemy = placed.filter((p) => p.side === 1);
assert.ok(enemy.length >= 10 && enemy.every((p) => ['r2karrar', 'r2basij'].includes(p.id) && p.order === 'engage'), 'the attackers are Iranian and engage');
const avg = (k) => enemy.reduce((s, p) => s + p[k], 0) / enemy.length;
assert.ok(avg('v') < 80, 'the attack comes from the start position farthest from the site');
const worth = (side) => placed.filter((p) => p.side === side && !/^ga/.test(p.id) && p.id !== 'r2saguard').reduce((sum, p) => sum + units.find((u) => u.name === p.id).cost, 0);
assert.ok(worth(0) >= worth(1) * 0.8, `armies of about equal value (${worth(0)} vs ${worth(1)})`);
// The mainline infantry of a classic country: the G.I., not the attack dog first in its palette.
const lab = await import(labUrl);
assert.equal(lab.pickUnit('infantry', 'america', [{ name: 'dog', label: 'Attack Dog', queue: 'Infantry', modern: false }, { name: 'e1', label: 'G.I.', queue: 'Infantry', modern: false }], { america: ['dog', 'e1'] }), 'e1');

// The mission as an operation: named targets, objectives, waves, briefing and radio from the intel.
assert.equal(placed.find((p) => p.id === 'gacnst').name, 'ConstructionYard');
assert.equal(placed.find((p) => p.id === 'gaweap').name, 'WarFactory');
const names = { saudi: 'Saudi Arabia', iran: 'Iran' };
const intel = { summary: 'Air base one. It hosts many jets. Third sentence.', holds: 'the country it is in (SA)', attacks: 'the regional rival of Saudi Arabia' };
const hold = mission.missionOperation({ ...spec, intel }, placed, (n) => names[n]);
assert.equal(hold.title, 'Hold Air base');
assert.deepEqual(hold.objectives.map((o) => [o.kind, !!o.secondary]), [['survive', false], ['protect', false], ['protect', true]]);
assert.deepEqual(hold.objectives[1].targets, ['ConstructionYard']);
assert.deepEqual(hold.waveFrom, [18, 52], 'the waves come from the far start position');
assert.deepEqual(hold.waveUnits.sort(), ['r2basij', 'r2karrar']);
assert.equal(hold.situation[0], 'Air base one. It hosts many jets.', 'two sentences of the place');
assert.equal(hold.situation[1], 'Saudi Arabia holds Air base. Iran, the regional rival of Saudi Arabia, is moving on it from the north-west.');
assert.ok(hold.radio.some((c) => c.when === 'start') && hold.radio.some((c) => c.when === 'victory') && hold.radio.some((c) => typeof c.when === 'object' && 'time' in c.when));
const strike = mission.missionOperation({ ...spec, youDefend: false, fa: 'iran', fb: 'saudi' }, placed, (n) => names[n]);
assert.deepEqual(strike.objectives.map((o) => o.targets), [['ConstructionYard'], ['WarFactory']]);
assert.deepEqual(strike.waveUnits, [], 'no waves when you attack');
assert.equal(mission.direction({ u: 40, v: 90 }, { u: 40, v: 20 }), 'north');
assert.equal(mission.direction({ u: 40, v: 90 }, { u: 60, v: 90 }), 'east');

// Strength from the rules: damage per second against the target's armor, only with weapons that can hit it.
const gun = { dps: { '': 10, Heavy: 4, Light: 12 }, valid: ['Ground'], invalid: [] };
const flak = { dps: { '': 20 }, valid: ['Air'], invalid: [] };
const tankA = { name: 'a', hp: 400, armor: 'Heavy', targets: ['Ground', 'Vehicle'], weapons: [gun] };
const tankB = { name: 'b', hp: 800, armor: 'Heavy', targets: ['Ground', 'Vehicle'], weapons: [{ ...gun, dps: { Heavy: 8 } }] };
const heli = { name: 'h', hp: 200, armor: 'Light', targets: ['Air'], weapons: [gun] };
assert.equal(strength.dps(tankA, tankB), 4);
assert.equal(strength.dps(tankA, heli), 0, 'a tank gun cannot hit a helicopter');
assert.equal(strength.dps({ ...tankA, weapons: [gun, flak] }, heli), 20);
// B is twice as tough and hits twice as hard: A needs twice the tanks (square law), not four times.
assert.ok(Math.abs(strength.evenScale([[tankA, 8]], [[tankB, 8]]) - 2) < 1e-9);
assert.equal(strength.evenScale([[{ name: 'x' }, 8]], [[tankB, 8]]), null, 'no stats: no answer');

// A mission with the rules' stats: armies even in strength, and air defence against an attack with aircraft.
const W = (dpsHeavy, valid = ['Ground']) => ({ dps: { '': 10, Heavy: dpsHeavy, None: 10, Light: 10 }, valid, invalid: [] });
const stat = (name, label, kind, queue, cost, hp, armor, targets, weapons, modern = true) => ({ name, label, kind, queue, cost, hp, armor, targets, weapons, modern });
const statUnits = [
  ...units.filter((u) => u.kind === 'building' || u.kind === 'defense'),
  stat('grizzly', 'Grizzly Battle Tank', 'vehicle', 'Vehicle', 700, 300, 'Heavy', ['Ground', 'Vehicle'], [W(27)], false),
  stat('gi', 'G.I.', 'infantry', 'Infantry', 200, 125, 'None', ['Ground', 'Infantry'], [W(6)], false),
  stat('ifv', 'IFV', 'vehicle', 'Vehicle', 600, 200, 'Light', ['Ground', 'Vehicle'], [W(5, ['Air'])], false),
  stat('karrar', 'Karrar Battle Tank', 'vehicle', 'Vehicle', 1100, 420, 'Heavy', ['Ground', 'Vehicle'], [W(30)]),
  stat('basij', 'Basij Rifleman', 'infantry', 'Infantry', 150, 105, 'None', ['Ground', 'Infantry'], [W(3)]),
  stat('heli', 'Toufan Gunship', 'aircraft', 'Aircraft', 1450, 220, 'Light', ['Air'], [W(4)]),
];
const statRosters = { america: ['gacnst', 'gapowr', 'gapile', 'gaweap', 'r2saguard', 'grizzly', 'gi', 'ifv'], iran: ['karrar', 'basij', 'heli'] };
const usMission = mission.missionPlacements({ ...spec, fa: 'america', fb: 'iran' }, statUnits, statRosters);
const count = (id) => usMission.filter((p) => p.id === id).length;
assert.ok(count('heli') === 2 && count('ifv') > 0, 'air defence (the IFV) against the gunships');
assert.ok(count('grizzly') > 8, `more Grizzlies than Karrars to be even in strength (${count('grizzly')})`);
const noAA = mission.missionPlacements({ ...spec, fa: 'america', fb: 'iran' }, statUnits, { ...statRosters, america: statRosters.america.filter((n) => n !== 'ifv') });
assert.ok(!noAA.some((p) => p.id === 'heli') && noAA.filter((p) => p.id === 'karrar').length === 10, 'no air defence: the attack comes without aircraft');

// Forces at a place: a foreign force named at a host nation's base holds it; the attacker is its rival, named or not.
const forces = await import(moduleUrl('web/src/forces.ts', (s) => s.replace('import { geocode } from "./place-search";', 'const geocode = async () => null; // countryAt is not under test')));
const all = ['america', 'england', 'russia', 'saudi', 'iran', 'israel', 'hezbollah', 'yemen', 'china', 'turkey'];
const udeid = forces.inferForces('qa', [{ text: 'Al Udeid Air Base. It is the largest US military base in the Middle East.', from: 'Wikipedia: Al Udeid Air Base' }], all);
assert.deepEqual([udeid.defender.id, udeid.attacker.id], ['america', 'iran']);
assert.match(udeid.defender.why, /US military/);
const riyadh = forces.inferForces('sa', [{ text: 'King Salman Air Base. Royal Saudi Air Force.', from: 'OpenStreetMap: King Salman Air Base' }], all);
assert.deepEqual([riyadh.defender.id, riyadh.attacker.id], ['saudi', 'iran'], 'the home force, its first rival');
const hormuz = forces.inferForces('om', [{ text: 'The Strait of Hormuz lies between Oman and Iran.', from: 'Wikipedia: Strait of Hormuz' }], all);
assert.deepEqual([hormuz.defender.id, hormuz.attacker.id], ['saudi', 'iran'], 'a named rival is not the holder');
assert.equal(forces.inferForces(null, [], all), null);
console.log(`Battle plan checks passed: facings, formations, the Earth projection and start positions, a ${placed.length}-actor mission, and the forces at a place.`);
