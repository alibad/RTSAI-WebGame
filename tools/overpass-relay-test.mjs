import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createOverpassRelay } from '../server/overpass.mjs';
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtsai-overpass-test-'));
let requests = 0, cancelled = 0, fail = false, hold = false;
const body = 'data=test-terrain', file = path.join(cacheDir, crypto.createHash('sha1').update(body).digest('hex') + '.json');
fs.writeFileSync(file, JSON.stringify({ elements: [], remark: 'runtime error: Query timed out' }));
const handler = createOverpassRelay({ cacheDir, mirrors: ['slow', 'good'], timeout: 200, request: async (url, options) => {
  requests++;
  if (fail) throw Error('offline');
  if (url === 'good' && !hold) return Response.json({ elements: [{ type: 'way', id: 12 }] });
  return new Promise((_, reject) => options.signal.addEventListener('abort', () => { cancelled++; reject(options.signal.reason); }, { once: true }));
} });
const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
try {
  let response = await fetch(url, { method: 'POST', body });
  assert.equal(response.status, 200); assert.equal(response.headers.get('X-RTSAI-Overpass'), 'live');
  assert.equal((await response.json()).elements[0].id, 12, 'Cached partial results are rejected');
  assert.equal(cancelled, 1, 'Losing mirror is cancelled');
  const before = requests; fail = true;
  response = await fetch(url, { method: 'POST', body });
  assert.equal(response.status, 200); assert.equal(response.headers.get('X-RTSAI-Overpass'), 'saved');
  await response.text(); assert.equal(requests, before, 'Saved replies work while providers are offline');
  response = await fetch(url, { method: 'POST', body: 'data=uncached' });
  assert.equal(response.status, 504); await response.text();
  assert.equal(fs.readdirSync(cacheDir).filter(f => f.endsWith('.json')).length, 2, 'Failures are never saved');
  fail = false; hold = true;
  const started = performance.now();
  response = await fetch(url, { method: 'POST', body: 'data=held' });
  assert.equal(response.status, 504); await response.text();
  assert.ok(performance.now() - started < 1500, 'The overall deadline bounds hung providers');
  const cancelledBefore = cancelled;
  await new Promise(resolve => {
    const req = http.request(url, { method: 'POST' }); req.on('error', resolve);
    req.end('data=disconnect'); setTimeout(() => req.destroy(), 40);
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(cancelled > cancelledBefore, 'Closing the page cancels provider work');
  console.log('Relay rejects poisoned cache, cancels losing mirrors, reuses saved replies and bounds failed requests.');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(path.resolve(cacheDir)), path.resolve(os.tmpdir()));
  fs.rmSync(cacheDir, { recursive: true, force: true });
}
