// Selection panel names and pictures: every actor's name from the mod's Fluent messages (web/src/sim/fluent-names.ts),
// the panel's name fallback and when it draws the actor instead of the engine's cameo (web/src/ui/actor-display.ts).
//   node tools/actor-names-unit-test.mjs [web-bundle.pack ...]
// With game data bundles (data-<hash>/public/web-bundle.pack, public-classic/...), also checks their real names.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from '../web/node_modules/typescript/lib/typescript.js';

const load = async (file) => {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
};
const { fluentFiles, fluentActorNames } = await load('web/src/sim/fluent-names.ts');
const { actorName, drawsActor, pictureKey, ORIGINAL_COUNTRIES } = await load('web/src/ui/actor-display.ts');

// ---- Fluent files in the mod's load order, through its package aliases
const modYaml = (extra = '') => `Metadata:\n\tTitle: RTS AI\n\nPackages:\n\t\t^EngineDir\n\t\t$rtsai: ra2\n${extra}\t\t^EngineDir|mods/common: common\n\t\tra2|bits\n\n` +
  'FluentMessages:\n\tra2|languages/game-modes.ftl\n\tcommon|fluent/rules.ftl\n\tra2|languages/rules/en.ftl\n\n\t# names for the standalone game\n\tra2|standalone/names.ftl\n\nHotkeys:\n\tcommon|hotkeys/game.yaml\n';
const files = {
  'mods/rtsai/mod.yaml': modYaml(),
  'mods/rtsai/languages/game-modes.ftl': 'game-mode-x = X\n',
  'ora/mods/common/fluent/rules.ftl': 'actor-mpspawn-name = Spawn point\n',
  'mods/rtsai/languages/rules/en.ftl': [
    '## Allied structures', 'actor-gacnst-name = Construction Yard', 'actor-gacnst-description = Builds structures.',
    'actor-mtnk-name = Grizzly Battle Tank', 'actor-nacnst-name =    Construction Yard   ', 'actor-dog-china-name = Attack Dog',
    'actor-gapile-name = { actor-barracks }', 'actor-multi-name =', '    Multi line', 'actor-gaweap-name = War Factory\r',
  ].join('\n'),
  'mods/rtsai/standalone/names.ftl': 'actor-mtnk-name = Medium Tank Battle Tank\nlevant-r2hzbunker-name = Field Bunker\nra2-r2cnrifle-name = Rifle Squad\n',
  'mods/rtsai/unlisted.ftl': 'actor-gacnst-name = Not loaded\n',
};
const names = Object.keys(files), read = (name) => files[name];
assert.deepEqual(fluentFiles(names, read), ['mods/rtsai/languages/game-modes.ftl', 'ora/mods/common/fluent/rules.ftl', 'mods/rtsai/languages/rules/en.ftl', 'mods/rtsai/standalone/names.ftl']);
const actorNames = fluentActorNames(fluentFiles(names, read).map(read));
assert.equal(actorNames.gacnst, 'Construction Yard');
assert.equal(actorNames.nacnst, 'Construction Yard', 'trimmed');
assert.equal(actorNames.gaweap, 'War Factory', 'CRLF files');
assert.equal(actorNames.mtnk, 'Medium Tank Battle Tank', 'a later file overrides, as the engine loads them');
assert.equal(actorNames['dog-china'], 'Attack Dog');
assert.equal(actorNames.r2hzbunker, 'Field Bunker', 'modern factions name their actors with their own prefixes');
assert.equal(actorNames.r2cnrifle, 'Rifle Squad');
assert.equal(actorNames.mpspawn, 'Spawn point');
assert.equal(actorNames.gapile, undefined, 'a message with placeables is not a plain name');
assert.equal(actorNames.multi, undefined);
assert.equal(actorNames['gacnst-description'], undefined);

// Classic: rtsai-topdown builds on rtsai ($rtsai: ra2); its own files are "classic|".
const classic = { ...files, 'mods/rtsai-topdown/mod.yaml': modYaml('\t\t$rtsai-topdown: classic\n').replace('FluentMessages:\n', 'FluentMessages:\n\tclassic|mode.ftl\n'), 'mods/rtsai-topdown/mode.ftl': 'actor-gacnst-name = Yard\n' };
const classicFiles = fluentFiles(Object.keys(classic), (n) => classic[n]);
assert.equal(classicFiles[0], 'mods/rtsai-topdown/mode.ftl', 'the mod that builds on the other one is the game');
assert.equal(fluentActorNames(classicFiles.map((n) => classic[n])).gacnst, 'Construction Yard', 'later rules/en.ftl overrides mode.ftl');
assert.deepEqual(fluentFiles(['mods/rtsai/languages/rules/en.ftl'], read), [], 'no mod.yaml, no files');

// ---- The panel's name: the engine's, else a plain word, never the type id
const labels = new Map([['gacnst', 'Construction Yard'], ['e1', 'G.I.']]);
assert.equal(actorName('gacnst', labels, true), 'Construction Yard');
assert.equal(actorName('e1', labels, false), 'G.I.');
assert.equal(actorName('caoild', labels, true), 'Structure');
assert.equal(actorName('civ1', labels, false), 'Unit');
assert.equal(actorName('x', new Map([['x', '']]), false), 'Unit');

// ---- When the panel draws the actor instead of the engine's cameo
const icon = 'data:image/png;base64,AAAA';
assert.deepEqual([...ORIGINAL_COUNTRIES].sort(), ['america', 'cuba', 'england', 'france', 'germany', 'iraq', 'korea', 'libya', 'russia']);
const MODERN = ['saudi', 'iran', 'china', 'turkey', 'israel', 'yemen', 'hezbollah'];
for (const country of ORIGINAL_COUNTRIES) {
  assert.equal(drawsActor('gacnst', icon, country, country, 'public'), true, `${country}: its own yard's cameo is the stand-in`);
  assert.equal(drawsActor('nacnst', icon, country, country, 'public'), true);
  assert.equal(drawsActor('gacnst', icon, country, 'saudi', 'public'), true, `${country}: a modern enemy's yard, not the stand-in`);
  assert.equal(drawsActor('nacnst', undefined, country, country, 'public'), true, 'never shows the stand-in, even before the cameo arrives');
  assert.equal(drawsActor('gapowr', icon, country, country, 'public'), false, 'real original cameos stay');
  assert.equal(drawsActor('gacnst', icon, country, country, 'public-classic'), false, 'Classic draws the base kit yards, which have cameos');
}
for (const modern of MODERN) {
  assert.equal(drawsActor('gacnst', icon, modern, modern, 'public'), false, `${modern}: its own base kit yard cameo stays`);
  assert.equal(drawsActor('gacnst', icon, modern, 'america', 'public'), true, `${modern}: an original country's yard is drawn in its own art`);
  assert.equal(drawsActor('nacnst', icon, modern, modern === 'iran' ? 'yemen' : 'iran', 'public'), true, `${modern}: another nation's yard`);
  assert.equal(drawsActor('r2m1a2s', icon, modern, modern, 'public'), false);
  assert.equal(drawsActor('gapowr', icon, modern, 'america', 'public'), false, 'other types keep the engine cameo');
}
assert.equal(drawsActor('caoild', null, 'saudi', 'neutral', 'public'), true, 'no cameo at all: drawn');
assert.equal(drawsActor('caoild', undefined, 'saudi', 'neutral', 'public'), false, 'cameo not answered yet');
assert.equal(drawsActor('gacnst', icon, undefined, undefined, 'public'), false);
assert.equal(pictureKey('gacnst', 3), 'gacnst@3');

// ---- Real game data, when given: every original country's actors are named
for (const pack of process.argv.slice(2)) {
  const b = fs.readFileSync(pack);
  assert.equal(b.subarray(0, 8).toString(), 'ORAPACK1', pack);
  const entries = new Map();
  for (let i = 0, p = 12, n = b.readInt32LE(8); i < n; i++) {
    const l = b.readUInt16LE(p); p += 2;
    const name = b.subarray(p, p + l).toString(); p += l;
    const len = b.readInt32LE(p); p += 4;
    entries.set(name, b.subarray(p, p + len)); p += len;
  }
  const text = (n) => entries.get(n)?.toString('utf8') ?? '';
  const order = fluentFiles([...entries.keys()], text);
  const real = fluentActorNames(order.map(text));
  const expect = { gacnst: 'Construction Yard', nacnst: 'Construction Yard', gapowr: 'Power Plant', garefn: 'Ore Refinery', gapile: 'Barracks', amcv: 'Mobile Construction Vehicle', dog: 'Attack Dog' };
  for (const [type, name] of Object.entries(expect)) assert.equal(real[type], name, `${pack}: ${type}`);
  for (const type of ['gaweap', 'gadept', 'gatech', 'gaairc', 'gayard', 'gapill', 'atesla', 'gacsph', 'gagap', 'nahand', 'napowr', 'narefn', 'nadept', 'natech', 'naradr', 'nayard', 'nalasr', 'naflak', 'tesla', 'nairon', 'nanrct', 'smcv', 'e1', 'e2', 'engineer', 'mtnk', 'htnk', 'cmin', 'harv'])
    assert.ok(real[type] && real[type] !== type, `${pack}: ${type} has a name (${real[type]})`);
  console.log(`${pack}: ${order.length} Fluent files, ${Object.keys(real).length} actor names; gacnst=${real.gacnst}, nacnst=${real.nacnst}, mtnk=${real.mtnk}, tesla=${real.tesla}`);
}
console.log('PASS actor names: Fluent load order and names, panel name fallback, drawn pictures for cameo-less actors');
