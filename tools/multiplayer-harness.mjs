// Shared by the multiplayer browser test and the multiplayer films: real browsers, the Firebase emulators, the real
// engine, WebRTC between browser contexts on this machine. What each player's page gets before anything loads:
//   - the engine's own synchronization reports, kept per frame (window.mp.hashes), and every frame's arrival time;
//   - a network shim on the direct line (window.mp.net): `delay`/`jitter` ms added to every message this page sends
//     (order kept), and `hold`, which keeps messages back until it is cleared (a connection that drops and returns);
//   - host ICE routes only by default (no STUN): players on one machine, not a cross-network certification.
//   RTSAI_TEST_URL            the page, default http://127.0.0.1:3520/
//   RTSAI_FIRESTORE_EMULATOR  host:port of the Firestore emulator, default 127.0.0.1:8085
import path from 'node:path';
import { browserExecutable, browserArgs } from './browser-launch.mjs';
import { chromium, firefox } from '../web/node_modules/playwright-core/index.mjs';

export const BASE = process.env.RTSAI_TEST_URL || 'http://127.0.0.1:3520/';
export const FIRESTORE = `http://${process.env.RTSAI_FIRESTORE_EMULATOR || '127.0.0.1:8085'}/v1/projects/demo-rtsai/databases/(default)/documents`;
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function launch(kind = 'chromium', { headed = process.env.RTSAI_TEST_HEADED === '1', args = [] } = {}) {
  if (kind === 'firefox') return firefox.launch({ headless: !headed, firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true } });
  return chromium.launch({ executablePath: browserExecutable(), headless: !headed, args: [...browserArgs(), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ...args] });
}

/** Runs in the page before its own scripts. */
function instrument({ hostRoutesOnly, net }) {
  const mp = window.mp = { frames: [], errors: [], hashes: {}, connections: [], worldStarts: [], net: { delay: 0, jitter: 0, hold: false, ...net }, held: [] };
  window.addEventListener('rtsai:world-started', e => mp.worldStarts.push(e.detail));
  const Original = window.RTCPeerConnection;
  if (!Original) return;
  window.RTCPeerConnection = class extends Original {
    constructor(config) { super(hostRoutesOnly ? { ...config, iceServers: [] } : config); mp.connections.push(this); }
  };
  const send = RTCDataChannel.prototype.send;
  const deliver = (channel, data) => { try { send.call(channel, data); } catch { /* the channel closed meanwhile */ } };
  RTCDataChannel.prototype.send = function (data) {
    const n = mp.net;
    if (n.hold) { mp.held.push([this, data]); return; }
    const wait = n.delay + Math.random() * n.jitter;
    if (wait <= 0 && !this.__due) return send.call(this, data);
    // Never overtake an earlier message: a reliable ordered channel doesn't.
    const due = this.__due = Math.max(performance.now() + wait, this.__due ?? 0);
    setTimeout(() => deliver(this, data), due - performance.now());
  };
  mp.release = () => { mp.net.hold = false; for (const [channel, data] of mp.held.splice(0)) deliver(channel, data); };
}

/**
 * One player: an independent browser context (its own sign-in and storage) and its page.
 * `video`: a folder for the context's recording; `net`: { delay, jitter } ms on what this page sends.
 */
export async function openPlayer(browser, { name, viewport = { width: 1440, height: 900 }, video, hostRoutesOnly = true, net = {}, timeout = 60000 } = {}) {
  const chromiumOnly = browser.browserType().name() === 'chromium' ? { permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'] } : {};
  const context = await browser.newContext({ viewport, ...chromiumOnly, ...(video ? { recordVideo: { dir: video, size: viewport } } : {}) });
  await context.addInitScript(instrument, { hostRoutesOnly, net });
  const opened = performance.now(), page = await context.newPage();
  const player = { name, context, page, opened, pageErrors: [], uid: '' };
  page.setDefaultTimeout(timeout);
  page.on('pageerror', e => player.pageErrors.push(`${name}: ${e}`));
  return player;
}

/** The emulator build's test-only sign-in (real players sign in on the website), then the game's menu. */
export async function signIn(player, { url = BASE, email = `${player.name.replace(/\W/g, '').toLowerCase()}-${Date.now()}@test.dev` } = {}) {
  const { page } = player;
  if (url) await page.goto(url);
  await page.getByRole('heading', { name: 'Sign in to play' }).waitFor();
  await page.waitForFunction(() => !!window.rtsaiTestAccount);
  player.uid = await page.evaluate(e => window.rtsaiTestAccount.signUp(e, 'test-password-1'), email);
  return player.uid;
}

/** The game loaded and showing its menu; from here the page keeps every frame's time and synchronization report. */
export async function atMenu(player, timeout = 300000) {
  const { page } = player;
  await page.waitForFunction(() => ['setup', 'error'].includes(window.store?.getState().phase), null, { timeout });
  const state = await page.evaluate(() => ({ phase: window.store.getState().phase, error: window.store.getState().error }));
  if (state.phase !== 'setup') throw Error(`${player.name}: the game did not reach its menu: ${state.error}`);
  await page.evaluate(() => {
    if (window.mp.watching) return;
    window.mp.watching = true;
    window.game.client.on('networkStatus', m => { window.mp.frames.push([m.frame, Math.round(performance.now())]); if (m.error) window.mp.errors.push(m.error); });
    window.game.client.on('peerOut', m => { for (const e of m.events) if (e.kind === 'hash') window.mp.hashes[e.frame] = e.hash + ':' + e.defeat; });
  });
}

export const lobby = player => player.page.getByRole('heading', { name: 'Match lobby' }).waitFor();

/** Host: Multiplayer, Create match. Returns the invite link and its code. */
export async function createMatch(host) {
  const { page } = host;
  await page.getByRole('button', { name: 'Multiplayer', exact: true }).click();
  await page.getByRole('button', { name: 'Create match', exact: true }).click();
  await lobby(host);
  const link = await page.getByLabel('Invite link').inputValue();
  return { link, code: new URL(link).searchParams.get('join') };
}

/** Guest: Multiplayer, the link or code pasted under "Have an invite?", Join match. */
export async function joinMatch(guest, invite, { wait = true } = {}) {
  const { page } = guest;
  if (!await page.getByLabel('Invite link or code').count()) await page.getByRole('button', { name: 'Multiplayer', exact: true }).click();
  await page.getByLabel('Invite link or code').fill(invite);
  await page.getByRole('button', { name: 'Join match', exact: true }).click();
  if (wait) await lobby(guest);
}

export const ready = guest => guest.page.getByRole('button', { name: 'Ready', exact: true }).click();

/** Host: Start match, once every guest is ready; resolves when every player's world runs. */
export async function startMatch(host, players, timeout = 300000) {
  await host.page.getByRole('button', { name: 'Start match', exact: true }).and(host.page.locator(':enabled')).click();
  await Promise.all(players.map(p => p.page.waitForFunction(() => ['playing', 'error'].includes(window.store.getState().phase), null, { timeout })));
  for (const p of players) {
    const state = await p.page.evaluate(() => ({ phase: window.store.getState().phase, error: window.store.getState().error }));
    if (state.phase !== 'playing') throw Error(`${p.name}: the match did not start: ${state.error}`);
  }
}

/** Waits until every player's world reached `frame` (or one of them reported an error). */
export function reachFrame(players, frame, timeout = 240000) {
  return Promise.all(players.map(p => p.page.waitForFunction(f => (window.mp.frames.at(-1)?.[0] ?? 0) >= f || window.mp.errors.length > 0, frame, { timeout })));
}

/**
 * What the players' engines reported: the last frame each reached, every error, how many frames all of them hashed,
 * the first frame whose SyncHash or defeat state differs (null: none), and the simulation speed since `sinceMs` ago
 * (frames per second; the game's own speed is 25).
 */
export async function syncReport(players, { sinceMs = 0 } = {}) {
  const states = await Promise.all(players.map(p => p.page.evaluate(() => ({ hashes: window.mp.hashes, errors: window.mp.errors, frames: window.mp.frames, now: Math.round(performance.now()) }))));
  const common = Object.keys(states[0].hashes).filter(f => states.every(s => f in s.hashes)).map(Number).sort((a, b) => a - b);
  const mismatch = common.find(f => states.some(s => s.hashes[f] !== states[0].hashes[f])) ?? null;
  const speed = states.map(s => {
    const from = sinceMs ? s.now - sinceMs : s.frames[0]?.[1] ?? 0, window = s.frames.filter(([, t]) => t >= from);
    if (window.length < 2) return 0;
    return +((window.at(-1)[0] - window[0][0]) * 1000 / (window.at(-1)[1] - window[0][1])).toFixed(1);
  });
  return { frames: states.map(s => s.frames.at(-1)?.[0] ?? 0), errors: states.map(s => s.errors), compared: common.length, mismatch,
    mismatchHashes: mismatch === null ? null : states.map(s => s.hashes[mismatch]), speed };
}

/** The local player's actors of a kind, through the page's own game API. */
export const own = (player, match) => player.page.evaluate(m => {
  const g = window.game, s = g.client.cur;
  return s.actors.filter(a => a.owner === s.header.localPlayer && g.client.str(a.type).includes(m)).map(a => ({ id: a.id, type: g.client.str(a.type), x: a.sx, y: a.sy }));
}, match);

/** Deploys the local player's MCV. Returns its actor id. */
export async function deployMcv(player) {
  return player.page.evaluate(async () => {
    const g = window.game, s = g.client.cur;
    const mcv = s.actors.find(a => a.owner === s.header.localPlayer && g.client.str(a.type).includes('mcv'));
    if (!mcv) throw Error('No local MCV');
    await g.select([mcv.id]); await g.command({ cmd: 'deploy' });
    return mcv.id;
  });
}

/** A Firestore emulator document as the owner (rules bypassed): { status, fields }. */
export async function firestoreDoc(docPath) {
  const r = await fetch(`${FIRESTORE}/${docPath}`, { headers: { Authorization: 'Bearer owner' } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/** When a run fails: what each player's page shows and what its engine and connections say. Screenshots go to `dir`. */
export async function diagnose(players, dir) {
  const report = {};
  for (const p of players) if (!p.page.isClosed()) {
    const key = p.name.replace(/\W+/g, '-').toLowerCase();
    await p.page.screenshot({ path: path.join(dir, `failure-${key}.png`) }).catch(() => {});
    report[p.name] = {
      text: (await p.page.locator('body').innerText().catch(() => '')).replace(/\n+/g, ' | ').slice(-1200),
      runtime: await p.page.evaluate(() => ({ phase: window.store?.getState().phase, error: window.store?.getState().error, errors: window.mp?.errors,
        frame: window.mp?.frames.at(-1)?.[0], connections: window.mp?.connections.map(c => c.connectionState) })).catch(e => String(e)),
      pageErrors: p.pageErrors,
    };
  }
  return report;
}

// ---------------------------------------------------------------------------------------------------------------
// A scripted commander: what a player does through the HUD, issued through the same page API (tools/playtest.mjs).

const until = async (page, fn, arg, ms = 120000, every = 400) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) { const v = await page.evaluate(fn, arg); if (v) return v; }
  return null;
};

/** Names of what a production tab offers now: [{ name, cost, buildable }]. */
export const offered = (player, queue) => player.page.evaluate(q => (window.store.getState().catalog.find(c => c.type === q)?.items ?? []).map(i => ({ name: i.name, cost: i.cost, buildable: i.buildable })), queue);

/** The local player's actors: [{ id, type, x, y, building }]. */
export const army = player => player.page.evaluate(() => {
  const g = window.game, s = g.client.cur;
  return s.actors.filter(a => a.owner === s.header.localPlayer).map(a => ({ id: a.id, type: g.client.str(a.type), x: a.sx, y: a.sy, building: !!(a.flags & 8) }));
});

/**
 * Builds the first offered building whose name matches `pattern` and places it near the construction yard.
 * Returns its name, or null when nothing matches, it never finished or no spot took it.
 */
export async function construct(player, pattern, { wait = 240000 } = {}) {
  const { page } = player;
  const item = await until(page, p => window.store.getState().catalog.find(c => c.type === 'Building')?.items.find(i => i.buildable && new RegExp(p, 'i').test(i.name))?.name, pattern.source ?? pattern, 20000);
  if (!item) return null;
  const count = name => page.evaluate(n => { const g = window.game, s = g.client.cur; return s.actors.filter(a => a.owner === s.header.localPlayer && g.client.str(a.type) === n).length; }, name);
  const before = await count(item);
  await page.evaluate(i => window.game.command({ cmd: 'produce', queue: 'Building', item: i }), item);
  if (!await until(page, i => window.store.getState().ui?.queues.find(q => q.type === 'Building')?.items.find(x => x.name === i && x.done), item, wait)) return null;
  const yard = await page.evaluate(() => { const g = window.game, s = g.client.cur; const a = s.actors.find(a => a.owner === s.header.localPlayer && (a.flags & 8)); return a && { x: a.sx, y: a.sy }; });
  if (!yard) return null;
  // Rings of spots around the yard, nearest first.
  const spots = [];
  for (const r of [1, 2, 3]) for (const [dx, dy] of [[150, 60], [-150, 60], [150, -60], [-150, -60], [0, 140], [0, -140], [220, 0], [-220, 0]]) spots.push([dx * r, dy * r]);
  for (const [dx, dy] of spots) {
    if (!await page.evaluate(() => window.store.getState().ui?.mode)) await page.evaluate(i => window.game.command({ cmd: 'produce', queue: 'Building', item: i }), item);
    await sleep(150);
    await page.evaluate(([x, y]) => window.game.click(x, y, 1, 0), [yard.x + dx, yard.y + dy]);
    await sleep(450);
    if (await count(item) > before) return item;
  }
  await page.evaluate(() => window.game.command({ cmd: 'mode', mode: 'none' }));
  return null;
}

/** Queues `count` of the first offered unit of a tab ("Infantry", "Vehicle") whose name matches. Returns its name. */
export async function train(player, queue, pattern, count = 1) {
  const item = await until(player.page, ([q, p]) => window.store.getState().catalog.find(c => c.type === q)?.items.find(i => i.buildable && new RegExp(p, 'i').test(i.name))?.name, [queue, pattern.source ?? pattern], 30000);
  if (item) await player.page.evaluate(([q, i, n]) => window.game.command({ cmd: 'produce', queue: q, item: i, count: n }), [queue, item, count]);
  return item;
}

/** Selects the local player's actors of the given types and attack-moves them to a world position. */
export async function attackMove(player, types, [x, y]) {
  return player.page.evaluate(async ([types, x, y]) => {
    const g = window.game, s = g.client.cur;
    const ids = s.actors.filter(a => a.owner === s.header.localPlayer && types.includes(g.client.str(a.type))).map(a => a.id);
    if (!ids.length) return 0;
    await g.select(ids);
    await g.command({ cmd: 'mode', mode: 'attackmove' });
    g.click(x, y, 1, 0);
    return ids.length;
  }, [types, x, y]);
}

/** "Won", "Lost" or "Undefined": the local player's result as the engine reports it. */
export const outcome = player => player.page.evaluate(() => window.store.getState().ui?.win ?? 'Undefined');
