// Random map names (web/src/map-names.ts): the same seed and landscape always give the same name, different seeds give
// varied names, every landscape has its own words, and no name has digits or reads like an id.
//   node tools/map-names-unit-test.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from '../web/node_modules/typescript/lib/typescript.js';

const source = fs.readFileSync('web/src/map-names.ts', 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { generatedMapName } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

// The landscapes MapGen.cs reports (sim/OpenRA.WebSim/MapGen.cs Landscapes).
const LANDSCAPES = ['Lakes', 'Ponds', 'Plains', 'Parkland', 'Woodlands', 'Rocky hills', 'Mountain lakes', 'Mountains', 'Open ground'];
const seeds = Array.from({ length: 400 }, (_, i) => (i * 2654435761 + 12345) % 2147483647);

// Deterministic: every browser (a multiplayer guest making the host's map) names it the same.
for (const landscape of LANDSCAPES)
  for (const seed of seeds.slice(0, 50)) assert.equal(generatedMapName(seed, landscape), generatedMapName(seed, landscape));
assert.equal(generatedMapName(254202489, 'Lakes'), generatedMapName(254202489, 'Lakes'));
// Pinned: a change to the word lists or the generator renames everyone's maps; make it on purpose.
assert.equal(generatedMapName(254202489, 'Lakes'), 'Greyfen Strand');
assert.equal(generatedMapName(771515670, 'Mountain lakes'), generatedMapName(771515670, 'Mountain lakes'));

const samples = {};
for (const landscape of LANDSCAPES) {
  const names = seeds.map((seed) => generatedMapName(seed, landscape));
  samples[landscape] = names.slice(0, 8);
  for (const name of names) {
    assert.ok(!/\d/.test(name), `no digits: ${name}`);
    assert.ok(!name.toLowerCase().includes(landscape.toLowerCase()), `not the landscape chip again: ${name}`);
    assert.match(name, /^[A-Z][a-z]+( [A-Z][a-z]+)+$/, `title case words: ${name}`);
    assert.ok(!/(.)\1\1/i.test(name), `no tripled letters: ${name}`);
    const [first, ...rest] = name.split(' ');
    assert.ok(!rest.some((w) => w.toLowerCase() === first.toLowerCase()), `no doubled word: ${name}`);
  }
  // Varied: 400 seeds give hundreds of names, and two maps rarely share one.
  const distinct = new Set(names).size;
  assert.ok(distinct >= 250, `${landscape}: ${distinct} distinct names of 400`);
}

// The landscape picks the words: lake maps get water words, mountain maps ridge words, forest maps forest words.
const words = (landscape) => new Set(seeds.flatMap((seed) => generatedMapName(seed, landscape).split(' ')));
const has = (landscape, pattern) => [...words(landscape)].some((w) => pattern.test(w));
assert.ok(has('Lakes', /^(Shallows|Narrows|Inlet|Shore|Basin)$/));
assert.ok(!has('Lakes', /^(Pass|Summit|Peaks|Woods|Forest)$/));
assert.ok(has('Mountains', /^(Pass|Ridge|Summit|Peaks|Gap)$/));
assert.ok(!has('Mountains', /^(Shallows|Inlet|Woods|Gardens)$/));
assert.ok(has('Woodlands', /^(Woods|Forest|Thicket|Weald|Timberline)$/));
assert.ok(!has('Woodlands', /^(Shallows|Summit|Peaks)$/));
assert.ok(has('Mountain lakes', /^(Tarns|Falls|Gap|Pass|Basin)$/));
// Same seed, different landscape: a different name (the seed alone does not name the map).
assert.ok(seeds.slice(0, 50).filter((seed) => generatedMapName(seed, 'Lakes') !== generatedMapName(seed, 'Mountains')).length >= 48);
// A landscape this list does not know still gets a name.
assert.match(generatedMapName(42, 'Volcanic'), /^[A-Z][a-z]+( [A-Z][a-z]+)+$/);
// The map id works as a seed too (the page's fallback when the engine reports none).
assert.equal(generatedMapName('gen-497a2cb26d620f38', 'Lakes'), generatedMapName('gen-497a2cb26d620f38', 'Lakes'));

for (const [landscape, names] of Object.entries(samples)) console.log(`${landscape.padEnd(15)} ${names.join(' | ')}`);
console.log('PASS map names: deterministic, varied, landscape words, no digits');
