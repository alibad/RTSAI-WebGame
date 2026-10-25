// Saved Earth maps, end to end on a local rtsai.net with the Firebase emulators: a player builds a battlefield from a
// real place in the website's Earth studio, plays it in the browser game ("Play in browser"), then hosts a multiplayer
// match on it. The guest's game fetches the host's map from Firestore before it can be ready, and both worlds agree.
//   firebase emulators:start --only auth,firestore --project demo-rtsai          (RTSAI-Web)
//   RTSAI-Web dev server on :3476 with the emulator .env.local (NEXT_PUBLIC_FIREBASE_EMULATORS=1)
//   a game build with VITE_FIREBASE_EMULATORS=1 VITE_REQUIRE_SIGNIN=1 and the website's Firebase web config
//   node tools/local-site-server.mjs <that build> 3530 3476
//   RTSAI_TEST_URL=http://127.0.0.1:3530/ node tools/saved-maps-browser-test.mjs
// The studio reads OpenStreetMap through the website; RTSAI_EARTH_FIXTURE=<features.json> answers from a file instead.
import { browserExecutable, browserArgs } from './browser-launch.mjs';
import { chooseLobbyOption } from './lobby-picker.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';

const base = process.env.RTSAI_TEST_URL || 'http://127.0.0.1:3530/';
const out = 'artifacts/saved-maps';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: process.env.RTSAI_TEST_HEADED !== '1', args: browserArgs() });
const contexts = await Promise.all([0, 1].map(() => browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })));
const [host, guest] = await Promise.all(contexts.map(c => c.newPage()));
const errors = [];
const receipt = { scope: 'Two same-machine Chromium contexts on one local origin (website + game), Firebase emulators, real OpenRA WASM, WebRTC host routes only', checks: {}, errors };
for (const [i, p] of [host, guest].entries()) {
  p.setDefaultTimeout(90000);
  p.on('pageerror', e => errors.push(`page ${i}: ${e}`));
  await p.addInitScript(() => {
    const Original = window.RTCPeerConnection;
    if (Original) window.RTCPeerConnection = class extends Original { constructor(config) { super({ ...config, iceServers: [] }); } };
  });
}
if (process.env.RTSAI_EARTH_FIXTURE) {
  const body = fs.readFileSync(process.env.RTSAI_EARTH_FIXTURE, 'utf8');
  await host.route('**/api/earth-features', r => r.fulfill({ status: 200, contentType: 'application/json', body }));
}
const phase = (p, want) => p.waitForFunction(w => w.includes(window.store?.getState().phase), want, { timeout: 300000 });
async function signIn(p, i) {
  await p.goto(new URL('play/', base).href);
  await p.getByRole('heading', { name: 'Sign in to play' }).waitFor();
  await p.waitForFunction(() => !!window.rtsaiTestAccount);
  await p.evaluate(n => window.rtsaiTestAccount.signUp(`mapper${n}-${Date.now()}@test.dev`, 'test-password-1'), i);
  await phase(p, ['setup', 'error']);
  assert.equal(await p.evaluate(() => window.store.getState().phase), 'setup', await p.evaluate(() => window.store.getState().error));
}

try {
  await Promise.all([host, guest].map(signIn));
  // The game's main menu (ui/MainMenu.tsx) opens in the Red Alert 2 game with its own map editor card; saved Earth maps
  // for Firestore are built in the website's Earth studio (RTSAI-Web app/studio), which hands one to the game at
  // play/?saved=<id> (App.tsx).
  await host.getByRole('button', { name: /^Map editor/ }).waitFor();
  assert.equal(await host.evaluate(() => window.store.getState().profile), 'public');
  const classicTile = host.locator('button.view-tile').filter({ has: host.locator('b', { hasText: /^Classic$/ }) });
  if (await classicTile.count()) assert.equal(await classicTile.getAttribute('aria-pressed'), 'false');
  receipt.checks.menu = true; console.log('PASS menu: Map editor card, Red Alert 2 selected');

  // Build a battlefield in the website's studio (signed in through the game: one session on the shared origin).
  await host.goto(new URL('studio', base).href);
  await host.waitForURL(/\/studio/);
  const build = host.getByRole('button', { name: 'Build battlefield' });
  await build.and(host.locator(':enabled')).waitFor();
  await build.click();
  await host.getByText('Ready to play').waitFor({ timeout: 120000 });
  const built = await host.locator('.mission-result h3').textContent();
  await host.screenshot({ path: `${out}/1-studio-built.png`, fullPage: true });
  receipt.checks.studioBuilds = built; console.log(`PASS studio built "${built}"`);

  // Play in browser: saved, then opened straight into skirmish on that map.
  await host.getByRole('button', { name: 'Play in browser' }).click();
  await host.waitForURL(/\/play\/\?saved=/);
  await phase(host, ['setup', 'error']);
  await host.waitForFunction(() => new URLSearchParams(location.search).get('map')?.startsWith('earth-'), null, { timeout: 60000 });
  const mapId = await host.evaluate(() => new URLSearchParams(location.search).get('map'));
  const saved = await host.evaluate(id => window.store.getState().setup.maps.find(m => m.id === id), mapId);
  assert.ok(saved?.saved, 'the saved map is in the game\'s map list');
  assert.equal(saved.title, built);
  await host.waitForFunction(id => window.store.getState().preparedMap === id && window.store.getState().sheets.uploaded >= window.store.getState().sheets.total, mapId, { timeout: 180000 });
  await host.screenshot({ path: `${out}/2-skirmish-setup.png` });
  await host.getByRole('button', { name: 'Start', exact: true }).click();
  await phase(host, ['playing', 'error']);
  assert.equal(await host.evaluate(() => window.store.getState().phase), 'playing', await host.evaluate(() => window.store.getState().error));
  await host.waitForFunction(() => (window.store.getState().ui?.tick ?? 0) > 40, null, { timeout: 120000 });
  const info = await host.evaluate(() => ({ grid: window.store.getState().info.gridType, size: window.store.getState().info.mapSize }));
  assert.equal(info.grid, 'RectangularIsometric');
  assert.equal(info.size[1], info.size[0] * 2, `an isometric S × 2S battlefield: ${info.size}`);
  await host.screenshot({ path: `${out}/3-skirmish-playing.png` });
  receipt.checks.playInBrowser = { mapId, size: info.size }; console.log(`PASS playInBrowser ${mapId} ${info.size.join('×')}`);

  // Multiplayer on the saved map: the host's own maps are in the lobby list; the guest has never seen this map.
  await host.goto(new URL('play/', base).href);
  await phase(host, ['setup', 'error']);
  await host.waitForFunction(id => window.store.getState().setup.maps.some(m => m.id === id), mapId, { timeout: 60000 });
  assert.equal(await guest.evaluate(id => window.store.getState().setup.maps.some(m => m.id === id), mapId), false, 'the guest starts without the map');
  for (const p of [host, guest]) await p.evaluate(() => {
    window.peerFrames = []; window.peerErrors = []; window.peerHashes = {};
    window.game.client.on('networkStatus', m => { window.peerFrames.push(m.frame); if (m.error) window.peerErrors.push(m.error); });
    window.game.client.on('peerOut', m => { for (const e of m.events) if (e.kind === 'hash') window.peerHashes[e.frame] = e.hash + ':' + e.defeat; });
  });
  await host.getByRole('button', { name: 'Multiplayer', exact: true }).click();
  await host.getByRole('button', { name: 'Create match', exact: true }).click();
  await host.getByRole('heading', { name: 'Match lobby' }).waitFor();
  await chooseLobbyOption(host, 'Multiplayer map', mapId);
  const link = await host.getByLabel('Invite link').inputValue();
  await guest.getByRole('button', { name: 'Multiplayer', exact: true }).click();
  await guest.getByLabel('Invite link or code').fill(link);
  await guest.getByRole('button', { name: 'Join match', exact: true }).click();
  await guest.getByRole('heading', { name: 'Match lobby' }).waitFor();
  await guest.waitForFunction(id => window.store.getState().setup.maps.some(m => m.id === id && m.saved), mapId, { timeout: 60000 });
  const ready = guest.getByRole('button', { name: 'Ready', exact: true });
  await ready.and(guest.locator(':enabled')).waitFor({ timeout: 60000 });
  await guest.screenshot({ path: `${out}/4-guest-lobby.png` });
  await ready.click();
  receipt.checks.guestFetchedHostMap = true; console.log('PASS guest fetched the host\'s saved map');
  await host.getByRole('button', { name: 'Start match', exact: true }).and(host.locator(':enabled')).waitFor();
  await host.getByRole('button', { name: 'Start match', exact: true }).click();
  await Promise.all([host, guest].map(p => phase(p, ['playing', 'error'])));
  for (const p of [host, guest]) assert.equal(await p.evaluate(() => window.store.getState().phase), 'playing', await p.evaluate(() => window.store.getState().error));
  await Promise.all([host, guest].map(p => p.waitForFunction(() => window.peerFrames.at(-1) >= 250 || window.peerErrors.length, null, { timeout: 240000 })));
  const states = await Promise.all([host, guest].map(p => p.evaluate(() => ({ hashes: window.peerHashes, errors: window.peerErrors, size: window.store.getState().info.mapSize }))));
  for (const s of states) assert.deepEqual(s.errors, []);
  assert.deepEqual(states[1].size, states[0].size);
  const common = Object.keys(states[0].hashes).filter(k => k in states[1].hashes);
  assert.ok(common.length >= 150, `only ${common.length} common hashes`);
  for (const f of common) assert.equal(states[1].hashes[f], states[0].hashes[f], `desync at ${f}`);
  await host.screenshot({ path: `${out}/5-match-host.png` });
  await guest.screenshot({ path: `${out}/6-match-guest.png` });
  receipt.checks.multiplayerOnSavedMap = { matchingHashes: common.length }; console.log(`PASS synchronized match on the saved map (${common.length} matching hashes)`);
  assert.deepEqual(errors, []);
  receipt.status = 'passed';
} catch (e) {
  receipt.status = 'failed'; receipt.error = String(e?.stack ?? e);
  await Promise.all([host, guest].map((p, i) => p.screenshot({ path: `${out}/failure-${i}.png` }).catch(() => {})));
  throw e;
} finally {
  fs.writeFileSync(`${out}/receipt.json`, JSON.stringify(receipt, null, 2) + '\n');
  await browser.close();
}
