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
await assert.rejects(silent.radio(new ArrayBuffer(6), () => true), /no Web Audio/);
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
  createBufferSource() { return { buffer: null, connect(node) { return { connect: next => ({ connect: () => next }) }; }, start(at, offset = 0) { started.push(this.buffer); this.at = at; this.offset = offset; }, stop() {}, disconnect() {} }; }
}
globalThis.webkitAudioContext = FakeContext;
assert.ok(createAudioContext({ latencyHint: "interactive" }) instanceof FakeContext, "Prefixed Safari constructor is supported");
globalThis.AudioContext = FakeContext;
const audio = new AudioEngine();
audio.source(1, 1, 16, 24000, new Int16Array([0, 16384, -32768]).buffer);
audio.play(1, 1, false, true, 0, 0, 1, false);
assert.equal(started.length, 1);
assert.deepEqual([...started[0].getChannelData(0)], [0, .5, -1], "PCM reaches normal playback unchanged");
// A music pause retains queued PCM and resumes from the same sample without suspending game effects.
const ctx = audio.context();
ctx.createGain = () => ({ gain: { value: 1 }, connect() {}, disconnect() {} });
audio.stream(5, 1, 16, 100, new Int16Array(150).buffer, false, 1);
audio.stream(5, 1, 16, 100, new Int16Array(150).buffer, true, 1);
ctx.currentTime = 1.05;
audio.pause(5, true);
assert.equal(audio.musicPlayback().elapsed, 1);
ctx.currentTime = 20;
assert.equal(audio.musicPlayback().elapsed, 1, "Music clock stays frozen while effects context advances");
assert.equal(ctx.state, "running", "Music pause never suspends effects");
audio.pause(5, false);
ctx.currentTime = 20.5;
assert.equal(audio.musicPlayback().elapsed, 1.5, "Music resumes without a skipped queue or elapsed jump");
audio.pause(5, true);
audio.stop(5);
assert.equal(audio.musicPlayback().active, false, "Switching tracks clears even a paused final chunk");
audio.seekStart(6, 40);
audio.stream(6, 1, 16, 100, new Int16Array(150).buffer, false, 1);
assert.equal(audio.musicPlayback().elapsed, 40, "A seeked stream reports the absolute song position");
ctx.currentTime += .55;
assert(Math.abs(audio.musicPlayback().elapsed - 40.5) < .001);
audio.pause(6, true);
ctx.currentTime += 10;
assert(Math.abs(audio.musicPlayback().elapsed - 40.5) < .001, "Paused seeked music keeps its absolute position");
audio.stop(6);
delete globalThis.AudioContext; delete globalThis.webkitAudioContext;
console.log("Audio capability checks passed: optional and prefixed Web Audio, blocked contexts, normal PCM playback.");
