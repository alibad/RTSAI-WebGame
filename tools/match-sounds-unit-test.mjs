// The sounds a match fetches ahead (web/src/sim/match-sounds.ts): the announcer and interface first, then the
// battlefield, then the local player's own unit voices; never music, other announcers or other modern countries' voices.
//   node tools/match-sounds-unit-test.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from '../web/node_modules/typescript/lib/typescript.js';

const source = fs.readFileSync('web/src/sim/match-sounds.ts', 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { matchSounds } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

// File names as the live audio index has them (data-ada60803287d, 15 November 2026).
const v = (p) => `/vfs/mods/rtsai/${p}`;
const paths = [
  v('standalone/audio/music/rtsai-plateau-engines.ogg'),
  v('modern-factions/audio/eva/iran/eva-unit-ready.wav'), v('modern-factions/audio/eva/saudi/eva-unit-ready.wav'),
  v('standalone/audio/ui/click.wav'),
  v('audio/sfx/rtsai-explode-large.wav'), v('standalone/audio/sfx/igiat1a.wav'),
  v('modern-factions/audio/redsea-m1-fire.wav'), v('modern-factions/audio/naval-ciws-burst.wav'), v('modern-factions/audio/china-role-aa.wav'),
  v('modern-factions/audio/iran-inf-select-fa.wav'), v('modern-factions/audio/iran-air-attack-en.wav'), v('modern-factions/audio/shadow-select-fa.wav'),
  v('modern-factions/audio/rsa-falcon-build-ar.wav'), v('modern-factions/audio/hz-drone-move-ar.wav'), v('modern-factions/audio/il-air-action-he.wav'),
  v('modern-factions/audio/rcn-infantry-action-zh.wav'), v('modern-factions/audio/tr-greywolf-attack-tr.wav'), v('modern-factions/audio/rye-ghost-build-en.wav'),
  v('standalone/audio/voices/ienasea.wav'),
  v('web/ea/audio/igisea.wav'),
];
const names = (list) => list.map((p) => p.split('/').pop());

// Iran against Saudi Arabia: Iran's announcer, the interface, the battlefield, then Iran's voices and the shared ones.
const iran = names(matchSounds(paths, 'iran', ['iran', 'saudi']));
assert.deepEqual(iran.slice(0, 2).sort(), ['click.wav', 'eva-unit-ready.wav']);
assert.deepEqual(iran.slice(2, 7).sort(), ['china-role-aa.wav', 'igiat1a.wav', 'naval-ciws-burst.wav', 'redsea-m1-fire.wav', 'rtsai-explode-large.wav']);
assert.deepEqual(iran.slice(7).sort(), ['ienasea.wav', 'iran-air-attack-en.wav', 'iran-inf-select-fa.wav', 'shadow-select-fa.wav']);
// Nothing of anyone else's: no music, one announcer only, no other country's voice lines, no original-country sounds.
assert.equal(matchSounds(paths, 'iran', ['iran', 'saudi']).filter((p) => p.includes('/eva/')).length, 1);
for (const other of ['rtsai-plateau-engines.ogg', 'rsa-falcon-build-ar.wav', 'hz-drone-move-ar.wav', 'il-air-action-he.wav', 'rcn-infantry-action-zh.wav', 'tr-greywolf-attack-tr.wav', 'rye-ghost-build-en.wav', 'igisea.wav'])
  assert.ok(!iran.includes(other), `${other} is not Iran's to fetch`);

// Each modern country gets its own voice lines.
for (const [country, file] of [['china', 'rcn-infantry-action-zh.wav'], ['turkey', 'tr-greywolf-attack-tr.wav'], ['saudi', 'rsa-falcon-build-ar.wav'], ['israel', 'il-air-action-he.wav'], ['yemen', 'rye-ghost-build-en.wav'], ['lebanon', 'hz-drone-move-ar.wav']])
  assert.ok(names(matchSounds(paths, country)).includes(file), `${country} fetches ${file}`);

// An original country against Iran: the originals' own folder (voices and weapons in one), no modern voice lines.
const america = names(matchSounds(paths, 'america', ['america', 'iran']));
assert.ok(america.includes('igisea.wav') && america.includes('igiat1a.wav') && america.includes('redsea-m1-fire.wav'));
assert.ok(!america.some((n) => /-(select|move|attack|action|build)-[a-z]{2}\.wav$/.test(n)), 'no modern voice lines for an original country');
// Iran against an original country hears that country's weapons: its folder comes with the battlefield.
const mixed = names(matchSounds(paths, 'iran', ['iran', 'america']));
assert.ok(mixed.indexOf('igisea.wav') > 1 && mixed.indexOf('igisea.wav') < mixed.indexOf('iran-inf-select-fa.wav'));

console.log('match sounds: ok');
