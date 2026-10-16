import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { build } from '../web/node_modules/esbuild/lib/main.js';

const bundle = await build({ entryPoints: ['web/src/earth-terrain.ts'], alias: { '@site': path.resolve('../RTSAI-Web') }, bundle: true, platform: 'node', format: 'esm', write: false });
const api = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
globalThis.location = { href: 'http://127.0.0.1:3496/' };
const manifest = JSON.parse(fs.readFileSync('web/public/earth-terrain/manifest.json'));
for (const e of manifest.areas) {
  const bytes = fs.readFileSync(path.join('web/public/earth-terrain', e.file));
  assert.equal(bytes.length, e.bytes);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), e.sha256);
}
let downloads = [], live = 0;
globalThis.fetch = async url => {
  downloads.push(String(url));
  return new Response(fs.readFileSync(path.join('web/public/earth-terrain', path.basename(new URL(url).pathname))));
};
const entry = manifest.areas.find(e => e.title === 'Cairo selected area'), b = entry.bounds;
const lat = (b.s + b.n) / 2, lon = (b.e + b.w) / 2;
const options = { signal: new AbortController().signal, title: 'Cairo', request: async () => { live++; throw Error('Provider offline'); } };
let result = await api.acquireTerrain(lat, lon, 1500, options);
assert.equal(result.source, 'packaged');
assert.equal(live, 0, 'The exact failed Cairo selection needs no public terrain request');
assert.ok(result.snapshot.payload.elements.length > 5000);
assert.equal(downloads.length, 2, 'Only the manifest and one containing pack are fetched');
result = await api.acquireTerrain(lat + .0001, lon - .0001, 1400, options);
assert.equal(result.source, 'browser', 'Nearby selections fully inside saved coverage reuse the snapshot');
assert.equal(downloads.length, 2);
result = await api.acquireTerrain(lat, lon, 1500, { ...options, refresh: true });
assert.equal(result.refreshFailed, true, 'A failed optional refresh keeps the saved terrain playable');
assert.equal(live, 1);
await assert.rejects(api.acquireTerrain(lat + .001, lon - .003, 1500, options), /selection is kept/, 'Partial overlap is not falsely advertised as coverage');
await assert.rejects(api.acquireTerrain(12, 12, 1500, { ...options, request: async () => ({ elements: [], remark: 'runtime error: Query timed out' }) }), /no saved terrain/);
const payload = { elements: [{ type: 'way', id: 1, tags: { highway: 'primary' }, geometry: [{ lat: 12, lon: 12 }, { lat: 12.01, lon: 12 }] }] };
result = await api.acquireTerrain(12, 12, 2500, { ...options, request: async () => payload });
assert.equal(result.source, 'live');
result = await api.acquireTerrain(12.001, 12.001, 1500, options);
assert.equal(result.source, 'browser', 'Successful downloads persist by coverage, not exact floating point request');
assert.equal(api.validTerrainPayload({ elements: [], remark: 'runtime error: out of memory' }), false);
assert.equal(api.coversTerrain(b, { ...b, w: b.w - .00001 }), false);
const aborted = new AbortController(); aborted.abort();
await assert.rejects(api.acquireTerrain(lat, lon, 1500, { ...options, signal: aborted.signal }), { name: 'AbortError' });
console.log('Terrain coverage, immutable-pack integrity, offline generation input, refresh fallback, partial-response rejection and cancellation passed.');
