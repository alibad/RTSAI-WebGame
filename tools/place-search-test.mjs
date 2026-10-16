import assert from 'node:assert/strict';
import { geocode, searchPlaces } from '../web/src/place-search.ts';

const calls = [];
globalThis.fetch = async (url, options) => {
  options.signal.throwIfAborted();
  calls.push({ url: new URL(url), at: Date.now() });
  if (url.includes('offline')) return new Response('', { status: 503 });
  return Response.json(url.includes('/reverse') ? { address: { country_code: 'eg' } } : [
    { display_name: 'Cairo, Egypt', name: 'Cairo', lat: '30.045', lon: '31.23' },
    { display_name: 'Cairo, Egypt', name: 'Cairo', lat: '30.048', lon: '31.24' },
    { display_name: 'Invalid coordinates', lat: 'NaN', lon: '20' },
  ]);
};
const signal = new AbortController().signal;
const first = await searchPlaces('Cairo', signal);
assert.equal(first.length, 1);
assert.equal(first[0].detail, 'Cairo, Egypt');
assert.equal(calls[0].url.searchParams.get('limit'), '5');
assert.deepEqual(await searchPlaces('Cairo', signal), first);
assert.equal(calls.length, 1, 'Repeat searches use the cache');
const cancelled = new AbortController(); cancelled.abort();
await assert.rejects(searchPlaces('cancelled', cancelled.signal), { name: 'AbortError' });
const reverse = await geocode('reverse', { lat: '30.045', lon: '31.23' }, signal);
assert.equal(reverse.address.country_code, 'eg');
assert.ok(calls[1].at - calls[0].at >= 1000, 'Search and reverse lookups share the rate limit');
await assert.rejects(searchPlaces('offline', signal), /unavailable/);
assert.deepEqual(await searchPlaces('Cairo', signal), first, 'Failed requests do not poison the queue');
assert.equal(calls.length, 3);
console.log('Place search: results, coordinates, caching, shared rate limit, cancellation and failure recovery passed.');
