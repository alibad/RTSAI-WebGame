// What the game reports to the website (web/src/net/track.ts, telemetry.ts), without a browser or Firebase:
//  - game_loaded, match_started, match_ended, multiplayer_created, multiplayer_joined, multiplayer_started, ai_assist and
//    game_error go to the site's POST /api/event (its weekly digest rolls them up); feedback goes through /api/feedback;
//  - match_ended carries the same map and faction as match_started (a mission's id, else the map);
//  - nothing is sent without a configured account, and a failing analytics call never throws into the game.
//   node tools/telemetry-unit-test.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from '../web/node_modules/typescript/lib/typescript.js';

const moduleUrl = (file, replace) => {
  const code = ts.transpileModule(replace(fs.readFileSync(file, 'utf8')), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
};

// track.ts with the account stubbed: siteApi records its calls; GA is off (no measurement id).
globalThis.__site = [];
globalThis.__account = { configured: true, failing: false };
const trackUrl = moduleUrl('web/src/net/track.ts', (s) => s
  .replace(/import \{[^}]*\} from "\.\/account";/, `const accountsConfigured = globalThis.__account.configured;
const currentUser = async () => null, firebaseApp = async () => ({});
const siteApi = (path, body) => { if (globalThis.__account.failing) return Promise.reject(new Error('offline')); globalThis.__site.push({ path, ...body }); return Promise.resolve(null); };`)
  .replaceAll('import.meta.env', '({})'));
const { track, SERVER_EVENTS } = await import(trackUrl);
const settle = () => new Promise((r) => setTimeout(r, 0));

for (const name of ['game_loaded', 'match_started', 'match_ended', 'multiplayer_created', 'multiplayer_joined', 'multiplayer_started', 'ai_assist', 'game_error'])
  assert(SERVER_EVENTS.has(name), `${name} goes to /api/event`);
assert(!SERVER_EVENTS.has('feedback_sent'), 'feedback reaches the site through /api/feedback');
track('match_ended', { kind: 'skirmish', map: 'twin-fords', faction: 'saudi' });
track('multiplayer_created'); track('multiplayer_joined'); track('game_loaded', { mode: 'isometric' }); track('feedback_sent', { category: 'bug' });
await settle();
assert.deepEqual(globalThis.__site.map((c) => c.name), ['match_ended', 'multiplayer_created', 'multiplayer_joined', 'game_loaded']);
assert(globalThis.__site.every((c) => c.path === '/api/event'));
assert.deepEqual(globalThis.__site[0].props, { kind: 'skirmish', map: 'twin-fords', faction: 'saudi' });

// A failing site call is swallowed (fire and forget).
globalThis.__account.failing = true;
assert.doesNotThrow(() => track('match_ended', { kind: 'skirmish' }));
await settle();
globalThis.__account.failing = false;

// telemetry.ts: match_ended repeats match_started's map and faction.
const calls = [];
globalThis.__track = (name, props) => calls.push({ name, props });
const listeners = [];
const state = { profile: 'public', phase: 'setup', ui: null, info: { localPlayer: 'Me', players: [{ name: 'Me', faction: 'russia' }, { name: 'Bot', faction: 'america' }] } };
globalThis.__store = { getState: () => state, subscribe: (f) => listeners.push(f) };
globalThis.window = new EventTarget();
const telemetryUrl = moduleUrl('web/src/net/telemetry.ts', (s) => s
  .replace('import { useStore } from "../store";', 'const useStore = globalThis.__store;')
  .replace('import { track } from "./track";', 'const track = (...a) => globalThis.__track(...a);')
  .replace('import { gpuInfo } from "../gpu";', 'const gpuInfo = () => ({ software: false });')
  .replace(/import type [^;]*;/, ''));
const { installTelemetry } = await import(telemetryUrl);
const game = { scenarioJson: JSON.stringify({ map: 'thunderpeak-ridge', players: [{ client: 0 }, { bot: 'normal' }] }) };
installTelemetry(game);
const set = (patch) => { const prev = { ...state }; Object.assign(state, patch); for (const f of listeners) f(state, prev); };
set({ phase: 'setup' });
set({ phase: 'playing' });
window.dispatchEvent(new Event('rtsai:world-started'));
set({ ui: { win: 'Won' } });
const started = calls.find((c) => c.name === 'match_started'), ended = calls.find((c) => c.name === 'match_ended');
assert.equal(started.props.map, 'thunderpeak-ridge'); assert.equal(started.props.faction, 'russia');
assert.equal(ended.props.result, 'won');
assert.deepEqual([ended.props.kind, ended.props.map, ended.props.faction], ['skirmish', 'thunderpeak-ridge', 'russia'], 'match_ended carries match_started\'s map and faction');
// A mission reports its id as the map, at the start and at the end.
calls.length = 0;
game.scenarioJson = JSON.stringify({ map: 'glass-island', mission: 'glass-island-mission' });
set({ ui: null });
window.dispatchEvent(new Event('rtsai:world-started'));
set({ phase: 'setup' });
const missionEnd = calls.find((c) => c.name === 'match_ended');
assert.deepEqual([missionEnd.props.kind, missionEnd.props.result, missionEnd.props.map, missionEnd.props.faction], ['campaign', 'left', 'glass-island-mission', 'russia']);
assert.equal(calls.filter((c) => c.name === 'game_loaded').length, 0, 'game_loaded is reported once');

// Without a configured account nothing is sent.
globalThis.__account.configured = false;
globalThis.__site.length = 0;
const { track: offline } = await import(moduleUrl('web/src/net/track.ts', (s) => s
  .replace(/import \{[^}]*\} from "\.\/account";/, `const accountsConfigured = globalThis.__account.configured;
const currentUser = async () => null, firebaseApp = async () => ({});
const siteApi = (path, body) => { globalThis.__site.push({ path, ...body }); return Promise.resolve(null); }; // ${Date.now()}`)
  .replaceAll('import.meta.env', '({})')));
offline('match_ended', { kind: 'skirmish' });
await settle();
assert.equal(globalThis.__site.length, 0);
console.log('Telemetry checks passed: the digest\'s game events go to /api/event, match_ended carries map and faction, failures stay silent.');
