import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createSaveVersionCatalog, validateArchive } from './save-version-catalog.mjs';
import { validSaveVersion, parseIdentity, savedBattleUrl, gameAssets, findSaveVersion, currentGameUrl } from '../web/src/sim/save-versions.ts';
import { retainBattle } from '../web/src/sim/save-records.ts';

const host = 'https://12345678.rtsai-play-cdn.pages.dev/';
const bytes = new Map();
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const version = (name, profile = 'public') => {
  const runtime = Buffer.from(name + ':engine'), content = Buffer.from(name + ':rules');
  return { identity: `${profile}:aot:${sha(runtime)}:${sha(content)}`, assetHost: host, rtRoot: 'rt-111111111111/', dataRoot: 'data-222222222222/', runtime, content };
};
const old = version('old');
const prior = { schema: 1, versions: [((({runtime, content, ...v}) => v)(old))] };
const build = { assetHost: host, rtRoot: 'rt-333333333333/', dataRoot: 'data-444444444444/', profiles: ['public', 'public-classic'] };
for (const profile of build.profiles) {
  const v = version('new', profile);
  bytes.set(`${host}${build.rtRoot}${profile}/aot/_framework/runtime-identity.json`, v.runtime);
  bytes.set(`${host}${build.dataRoot}${profile}/web-bundle.pack`, v.content);
}
const fetcher = async url => ({ ok: bytes.has(url), status: bytes.has(url) ? 200 : 404, arrayBuffer: async () => bytes.get(url) });
const catalog = await createSaveVersionCatalog(prior, [build], fetcher);
assert.equal(catalog.versions.length, 3);
assert.deepEqual(catalog.versions[0], prior.versions[0], 'updates preserve the complete original version descriptor');
assert.equal((await createSaveVersionCatalog(catalog, [build], fetcher)).versions.length, 3, 'frontend-only releases preserve existing versions');
await assert.rejects(createSaveVersionCatalog(prior, [{...build, dataRoot: 'data-555555555555/'}], fetcher), /unavailable/);
for (const bad of [ { ...prior.versions[0], assetHost: 'https://attacker.example/' }, { ...prior.versions[0], rtRoot: '../private/' }, { ...prior.versions[0], identity: 'unversioned' } ]) {
  assert.equal(validSaveVersion(bad), false);
  assert.throws(() => validateArchive(bad));
}
const classic = catalog.versions.find(v => v.identity.startsWith('public-classic:'));
const url = savedBattleUrl('https://rtsai.net/play/?mode=simulator&prompt=old', classic, 'original-id', true);
assert.equal(url.origin, 'https://rtsai.net');
assert.equal(url.pathname, '/play/');
assert.equal(url.searchParams.get('profile'), 'public-classic');
assert.equal(url.searchParams.get('openMatch'), 'original-id');
assert.equal(url.searchParams.get('saveVersion'), classic.identity);
assert.equal(url.searchParams.get('watch'), '1');
assert.equal(url.searchParams.has('prompt'), false);
assert.equal(parseIdentity(classic.identity).runtime, 'aot');
const frozen = { ...classic, clientRoot: 'saved-clients/abcdef012345/' };
assert.equal(validSaveVersion(frozen), true);
const frozenUrl = savedBattleUrl('https://rtsai.net/play/saved-clients/aaaaaaaaaaaa/?saveVersion=older', frozen, 'original-id', false);
assert.equal(frozenUrl.pathname, '/play/saved-clients/abcdef012345/');
assert.equal(currentGameUrl(frozenUrl.href).pathname, '/play/');
assert.equal(validSaveVersion({...frozen, clientRoot: '../other/'}), false);

globalThis.location = { href: 'https://rtsai.net/play/', search: `?saveVersion=${encodeURIComponent(old.identity)}` };
globalThis.fetch = async () => ({ ok: true, json: async () => catalog });
assert.deepEqual(await gameAssets('public', 'aot'), { rtBase: host + old.rtRoot, dataBase: host + old.dataRoot });
assert.equal((await findSaveVersion(old.identity)).identity, old.identity);
await assert.rejects(gameAssets('public-classic', 'aot'), /unavailable/);

const earlier = Array.from({length: 15}, (_, i) => ({id: String(i), tick: 13010 + i, log: {hashes: [1,2,3]}}));
const untouched = JSON.stringify(earlier);
const record = {id: 'new', tick: 20, thumb: 'preview', mapFiles: {'map.bin': 'exact bytes'}};
let saved;
retainBattle(record, earlier, records => { saved = records; });
assert.equal(saved.length, 16, 'an eleventh save must not silently delete the original battle');
assert.equal(saved[1], earlier[0]);
let writes = 0;
retainBattle(record, earlier, records => { if (++writes === 1) throw Error('quota'); saved = records; });
assert.equal(saved[0].thumb, undefined);
assert.deepEqual(saved[0].mapFiles, record.mapFiles, 'only the preview may be omitted; map and progress stay intact');
assert.equal(record.thumb, 'preview', 'fallback must not mutate the original export');
assert.throws(() => retainBattle(record, earlier, () => { throw Error('quota'); }), /earlier battles have been kept/);
assert.equal(JSON.stringify(earlier), untouched);
console.log(JSON.stringify({passed: true, archiveVersionsRetained: 3, oldSavesRetained: 15, coverage: ['original version routing','Classic routing','untrusted executable URLs rejected','missing archive fails safely','custom map preserved on quota fallback','no save eviction']}));
