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
const mission = await import(moduleUrl('web/src/mission.ts', (s) => s.replace('from "./ai-lab";', `from "${labUrl}";`).replace('from "./battle-plan";', `from "${planUrl}";`)));

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

// Forces at a place: a foreign force named at a host nation's base holds it; the attacker is its rival, named or not.
const forces = await import(moduleUrl('web/src/forces.ts'));
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
