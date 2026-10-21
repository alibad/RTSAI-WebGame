import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import ts from '../web/node_modules/typescript/lib/typescript.js';
const source = fs.readFileSync(new URL('../web/src/sim/lazyfs.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { LazyMount } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
function fakeFs() {
  const files = new Map();
  class ErrnoError extends Error { constructor(errno) { super(`errno ${errno}`); this.errno = errno; } }
  return { files, ErrnoError, mkdirTree() {}, createFile(dir, name) { const node = { stream_ops: {} }; files.set(`${dir}/${name}`, node); return node; } };
}
for (const cached of [false, true]) {
  test(`short asset reads fail instead of looping (cached=${cached})`, () => {
    const vfs = fakeFs(), mount = new LazyMount(vfs);
    mount.add('/vfs/cursors.png', 8, () => new Uint8Array(), cached);
    assert.throws(() => vfs.files.get('/vfs/cursors.png').stream_ops.read(null, new Int8Array(8), 0, 8, 0), e => e.errno === 29);
  });
}
test('resident and cached reads preserve bytes across chunk boundaries and EOF', () => {
  const bytes = Uint8Array.from({ length: 300000 }, (_, i) => i % 251);
  for (const cached of [false, true]) {
    const vfs = fakeFs(), mount = new LazyMount(vfs), out = new Int8Array(bytes.length);
    mount.add('/vfs/sprite', bytes.length, (a, b) => bytes.slice(a, b), cached);
    const read = vfs.files.get('/vfs/sprite').stream_ops.read;
    assert.equal(read(null, out, 0, out.length, 0), bytes.length);
    assert.deepEqual(new Uint8Array(out.buffer), bytes);
    assert.equal(read(null, out, 0, 1, bytes.length), 0);
  }
});
// The CDN answers a path it cannot serve (e.g. mid-deploy) with its 118-byte placeholder page and HTTP 200. A sound
// fetched in the background must not keep that body: the engine would read it as the sound and end the match
// ("... is not a valid sound file!"). The sound stays unready, and a later fetch caches the real bytes.
test('a background fetch shorter than the file is not cached', async () => {
  const placeholder = new TextEncoder().encode('<!doctype html><title>RTS AI game files</title>'.padEnd(118, ' '));
  const wav = Uint8Array.from({ length: 8484 }, (_, i) => i % 253);
  const vfs = fakeFs(), mount = new LazyMount(vfs);
  let body = placeholder;
  mount.add('/vfs/audio/irocdiea.wav', wav.length, (a, b) => wav.slice(a, b), true, async (a, b) => body.slice(a, b));
  assert.equal(mount.ready('/vfs/audio/irocdiea.wav'), false); // starts the background fetch (the placeholder)
  await mount.prefetch(['/vfs/audio/irocdiea.wav']);
  body = wav;
  // Nothing was kept: still unready, and this check fetches again (now the real file).
  assert.equal(mount.ready('/vfs/audio/irocdiea.wav'), false, 'a short background body must not make the sound ready');
  await mount.prefetch(['/vfs/audio/irocdiea.wav']);
  assert.equal(mount.ready('/vfs/audio/irocdiea.wav'), true);
  const out = new Int8Array(wav.length);
  assert.equal(vfs.files.get('/vfs/audio/irocdiea.wav').stream_ops.read(null, out, 0, out.length, 0), wav.length);
  assert.deepEqual(new Uint8Array(out.buffer), wav);
});
// A whole-file reader that received a short body (the placeholder) must not keep it: a later read fetches again.
test('a whole file read shorter than its size is refetched, not kept', async () => {
  const { wholeFileReader } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  const bodies = [new Uint8Array(118), Uint8Array.from({ length: 8484 }, (_, i) => i % 7)];
  globalThis.XMLHttpRequest = class { open() {} send() { this.status = 200; this.response = bodies.shift().buffer; } };
  try {
    const read = wholeFileReader('https://cdn.example/irocdiea.wav', 8484);
    assert.throws(() => read(0, 8484), /118/);
    assert.equal(read(0, 8484).length, 8484);
  } finally { delete globalThis.XMLHttpRequest; }
});
