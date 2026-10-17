import assert from 'node:assert/strict';
import { build } from '../web/node_modules/esbuild/lib/main.js';
const result = await build({ entryPoints: ['web/src/touch.ts'], bundle: true, format: 'esm', write: false });
const { TouchControls } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const handlers = {}, events = [];
const element = { style: {}, addEventListener: (name, handler) => handlers[name] = handler, setPointerCapture() {} };
let mode = 'edit';
new TouchControls(element, {
  toWorld: (x,y) => [x*2,y*2], editor: () => mode,
  editorPointer: (...args) => events.push(args), pan: (...args) => events.push(['pan',...args]),
  zoomAt: () => events.push(['zoom']), clear: () => events.push(['clear']),
  setBox: () => assert.fail('Editor gestures must not enter game selection'),
  select: () => assert.fail('Editor taps must use the native editor'),
});
const send = (kind,id,x,y) => handlers['pointer'+kind]({ pointerType:'touch', pointerId:id, clientX:x, clientY:y, preventDefault() {} });
send('down',1,10,20); assert.equal(events.length,0, 'Finger down alone must not paint');
send('up',1,10,20); assert.deepEqual(events.splice(0),[['down',20,40],['up',20,40]]);
send('down',1,10,20); send('move',1,30,40); send('up',1,35,45);
assert.deepEqual(events.splice(0),[['down',20,40],['move',60,80],['up',70,90]], 'Drag completes exactly one native stroke');
mode='pan'; send('down',1,10,20); send('move',1,30,40); send('up',1,30,40);
assert.deepEqual(events.splice(0),[['pan',20,20]], 'Hand tool pans without editing');
mode='edit'; send('down',1,10,20); send('down',2,30,20); send('move',2,50,20); send('up',2,50,20); send('up',1,10,20);
assert.ok(events.every(e=>['pan','zoom'].includes(e[0])), 'Two-finger navigation never starts a stroke or clears the brush'); events.length=0;
send('down',1,10,20); send('move',1,30,40); send('cancel',1,30,40);
assert.deepEqual(events.splice(0),[['down',20,40],['move',60,80],['up',60,80]], 'Cancelled pointer releases the native brush');
console.log('Editor touch tap, paint drag, Hand pan, multi-touch navigation and cancellation passed.');
