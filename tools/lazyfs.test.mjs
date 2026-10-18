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
