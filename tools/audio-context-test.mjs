// Browser audio capability regression: missing / rejected / prefixed contexts, plus ordinary PCM playback.
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "../web/node_modules/typescript/lib/typescript.js";
const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText).toString("base64")}`;
const helperUrl = moduleUrl(fs.readFileSync("web/src/audio-context.ts", "utf8"));
const { createAudioContext } = await import(helperUrl);
globalThis.window = new EventTarget();
globalThis.AudioContext = undefined; globalThis.webkitAudioContext = undefined;
assert.equal(createAudioContext(), null);
const { AudioEngine } = await import(moduleUrl(fs.readFileSync("web/src/audio.ts", "utf8")
  .replace('import { store } from "./store";', 'const store = { get: () => ({ phase: "setup", paused: false }) };')
  .replace('import { preferences } from "./preferences";', "const preferences = { master: 1, effects: 1, voice: 1, music: 1 };")
  .replace('import { createAudioContext } from "./audio-context";', `import { createAudioContext } from ${JSON.stringify(helperUrl)};`)));
const silent = new AudioEngine();
silent.source(1, 1, 16, 24000, new ArrayBuffer(6));
silent.play(1, 1, false, true, 0, 0, 1, false);
silent.stream(1, 1, 16, 24000, new ArrayBuffer(6), true, 1);
await silent.voice(new ArrayBuffer(6));
assert.equal(await silent.radio(new ArrayBuffer(6), () => true), 0);
assert.equal(silent.context(), null);
globalThis.AudioContext = class { constructor() { throw new Error("Browser disabled audio"); } };
assert.equal(createAudioContext(), null);
delete globalThis.AudioContext;
const started = [];
class FakeContext {
  constructor(options) { this.options = options; this.state = "running"; this.destination = {}; this.currentTime = 0; }
  createGain() { return { gain: { value: 1 }, connect() {} }; }
  createStereoPanner() { return { pan: { value: 0 }, connect(node) { return node; } }; }
  createBuffer(channels, frames, rate) { const data = Array.from({ length: channels }, () => new Float32Array(frames)); return { getChannelData: n => data[n], duration: frames / rate }; }
  createBufferSource() { return { buffer: null, connect(node) { return { connect: next => ({ connect: () => next }) }; }, start() { started.push(this.buffer); }, stop() {} }; }
}
globalThis.webkitAudioContext = FakeContext;
assert.ok(createAudioContext({ latencyHint: "interactive" }) instanceof FakeContext, "Prefixed Safari constructor is supported");
globalThis.AudioContext = FakeContext;
const audio = new AudioEngine();
audio.source(1, 1, 16, 24000, new Int16Array([0, 16384, -32768]).buffer);
audio.play(1, 1, false, true, 0, 0, 1, false);
assert.equal(started.length, 1);
assert.deepEqual([...started[0].getChannelData(0)], [0, .5, -1], "PCM reaches normal playback unchanged");
delete globalThis.AudioContext; delete globalThis.webkitAudioContext;
console.log("Audio capability checks passed: optional and prefixed Web Audio, blocked contexts, normal PCM playback.");
