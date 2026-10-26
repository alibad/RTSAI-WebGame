import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../web/node_modules/esbuild/lib/main.js';

// Exercise the real controller with a worker that is still answering an earlier
// pointer event when the player switches tools and immediately clicks twice.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  stdin: {
    contents: 'export { EditorController } from "./editor"; export { store } from "./store";',
    resolveDir: path.join(root, 'web/src'), loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', write: false,
  define: { 'import.meta.env': '{}' }, logLevel: 'silent',
});
globalThis.location = new URL('http://unit.invalid/');
const { EditorController, store } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
let releasePointer, undoFinished;
const pendingPointer = new Promise(resolve => { releasePointer = resolve; });
const finished = new Promise(resolve => { undoFinished = resolve; });
let firstPointer = true, brush = 'actor:tree';
const placements = [];
const controller = new EditorController({
  canvas: { matches: () => true },
  client: { async editor(op) {
    if (op.op === 'pointer' && firstPointer) { firstPointer = false; await pendingPointer; }
    if (op.op === 'brush') brush = op.brush === 'actor' ? `actor:${op.type}` : op.brush;
    if (op.op === 'pointer' && op.event === 'down') placements.push({ brush, x: op.x, y: op.y });
    if (op.op === 'undo') undoFinished();
    return { brush, ...(op.event === 'up' ? { placement: { added: 1 } } : {}) };
  } },
});
store.set({ phase: 'playing', editor: { ...controller.state, map: 'order-test', brush } });
controller.pointer('move', 1, 1, 0, 0);
controller.setTool('spawn');
assert.equal(controller.state.tool, 'spawn', 'the selected tool responds immediately');
controller.pointer('down', 560, 330, 1, 0);
controller.pointer('up', 560, 330, 1, 0);
controller.pointer('down', 1250, 680, 1, 0);
controller.pointer('up', 1250, 680, 1, 0);
controller.undo();
releasePointer();
let timeout;
try {
  await Promise.race([finished, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('editor commands did not settle')), 3000); })]);
  await new Promise(resolve => setImmediate(resolve));
} finally { clearTimeout(timeout); }
assert.deepEqual(placements, [
  { brush: 'actor:mpspawn', x: 560, y: 330 },
  { brush: 'actor:mpspawn', x: 1250, y: 680 },
], 'both clicks after switching tools place starts, even while the old worker reply is delayed');
assert.equal(controller.state.error, '');
console.log('Delayed-worker editor tool switch preserves both start placements and subsequent commands.');
