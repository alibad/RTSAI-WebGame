// Random maps in multiplayer, end to end in real browsers against the Firebase emulators: the host makes a random map
// in the lobby; the guest's browser makes the same map from the host's request (the generator is deterministic), can
// only be ready once it has, and both play one synchronized match on it.
//   firebase emulators:start --only auth,firestore --project demo-rtsai          (RTSAI-Web)
//   a game build with VITE_FIREBASE_EMULATORS=1 VITE_REQUIRE_SIGNIN=1 and the website's Firebase web config, served
//   with its runtime and data (server/serve.mjs)
//   RTSAI_TEST_URL=http://127.0.0.1:3499/?profile=public node tools/random-map-multiplayer-test.mjs
import { browserExecutable, browserArgs } from './browser-launch.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';

const base = process.env.RTSAI_TEST_URL || 'http://127.0.0.1:3499/?profile=public';
const out = 'artifacts/random-map-multiplayer';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: process.env.RTSAI_TEST_HEADED !== '1', args: browserArgs() });
const contexts = await Promise.all([0, 1].map(() => browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })));
const [host, guest] = await Promise.all(contexts.map(c => c.newPage()));
const errors = [];
const receipt = { scope: 'Two same-machine Chromium contexts, Firebase emulators, real OpenRA WASM, WebRTC host routes only', checks: {}, errors };
for (const [i, p] of [host, guest].entries()) {
  p.setDefaultTimeout(120000);
  p.on('pageerror', e => errors.push(`page ${i}: ${e}`));
  await p.addInitScript(() => {
    const Original = window.RTCPeerConnection;
    if (Original) window.RTCPeerConnection = class extends Original { constructor(config) { super({ ...config, iceServers: [] }); } };
  });
}
const lobbyReady = p => p.getByRole('heading', { name: 'Match lobby' }).waitFor();
const generatedMap = (p, id) => p.evaluate(id => window.store.getState().setup.maps.find(m => m.id === id && m.generated) ?? null, id);
try {
  await Promise.all([host, guest].map(p => p.goto(base)));
  for (const [i, p] of [host, guest].entries()) {
    await p.getByRole('heading', { name: 'Sign in to play' }).waitFor();
    await p.waitForFunction(() => !!window.rtsaiTestAccount);
    await p.evaluate(n => window.rtsaiTestAccount.signUp(`random-map-${n}-${Date.now()}@test.dev`, 'test-password-1'), i);
  }
  await Promise.all([host, guest].map(p => p.waitForFunction(() => window.store?.getState().phase === 'setup', null, { timeout: 300000 })));
  const watch = p => p.evaluate(() => {
    window.peerFrames = []; window.peerErrors = []; window.peerHashes = {};
    window.game.client.on('networkStatus', m => { window.peerFrames.push(m.frame); if (m.error) window.peerErrors.push(m.error); });
    window.game.client.on('peerOut', m => { for (const e of m.events) if (e.kind === 'hash') window.peerHashes[e.frame] = e.hash + ':' + e.defeat; });
  });
  await watch(host);

  // The host opens a lobby and makes a random map there.
  await host.getByRole('button', { name: 'Multiplayer', exact: true }).click();
  await host.getByRole('button', { name: 'Create match', exact: true }).click();
  await lobbyReady(host);
  const link = await host.getByLabel('Invite link').inputValue();
  const made = Date.now();
  if (process.env.RTSAI_TEST_FIXED_MAP === '1') {
    // Control run: the same flow on the lobby's default (bundled) map.
    await guest.goto(link);
    await guest.waitForFunction(() => window.store?.getState().phase === 'setup', null, { timeout: 300000 });
    await watch(guest); await lobbyReady(guest);
    await guest.getByRole('button', { name: 'Ready', exact: true }).click();
    await host.getByRole('button', { name: 'Start match', exact: true }).and(host.locator(':enabled')).click();
    await Promise.all([host, guest].map(p => p.waitForFunction(() => ['playing', 'error'].includes(window.store.getState().phase), null, { timeout: 300000 })));
    for (const p of [host, guest]) assert.equal(await p.evaluate(() => window.store.getState().phase), 'playing', await p.evaluate(() => window.store.getState().error));
    console.log('PASS fixedMapMatchStarts'); receipt.passed = true;
    process.exit(0);
  }
  await host.getByTestId('mp-random-map').click();
  await host.waitForFunction(() => document.querySelector('[data-testid="mp-random-map"]')?.textContent === 'New random map'
    && document.querySelector('.mp-map-caption b')?.textContent !== '', null, { timeout: 120000 });
  const title = await host.locator('.mp-map-caption b').textContent();
  const hostMap = await host.evaluate(t => window.store.getState().setup.maps.find(m => m.generated && m.title === t), title);
  assert.ok(hostMap?.gen, `the host's lobby is on a random map with its request: ${title}`);
  receipt.checks.hostMadeMap = { title, id: hostMap.id, ms: Date.now() - made, request: JSON.parse(hostMap.gen) };
  console.log('PASS hostMadeMap', title, hostMap.id);

  // The guest joins; its browser makes the same map before it may be ready.
  await guest.goto(link);
  await guest.waitForFunction(() => window.store?.getState().phase === 'setup', null, { timeout: 300000 });
  await watch(guest);   // the invite link loaded a fresh page
  await lobbyReady(guest);
  await guest.getByText(title, { exact: true }).first().waitFor();
  receipt.checks.readyWaitsForMap = await guest.getByRole('button', { name: 'Ready', exact: true }).isDisabled()
    || !!(await generatedMap(guest, hostMap.id));
  assert.ok(receipt.checks.readyWaitsForMap, 'Ready is off while the guest makes the map');
  await guest.waitForFunction(id => window.store.getState().setup.maps.some(m => m.id === id && m.generated), hostMap.id, { timeout: 120000 });
  await guest.getByRole('button', { name: 'Ready', exact: true }).and(guest.locator(':enabled')).waitFor({ timeout: 120000 });
  const guestMap = await generatedMap(guest, hostMap.id);
  assert.ok(guestMap, 'the guest made the host\'s map (same id, so the same content)');
  assert.equal(guestMap.title, hostMap.title);
  receipt.checks.guestMadeSameMap = { id: guestMap.id };
  console.log('PASS guestMadeSameMap');
  await host.screenshot({ path: `${out}/1-host-lobby.png` });
  await guest.screenshot({ path: `${out}/2-guest-lobby.png` });

  // Play one synchronized match on it.
  await guest.getByRole('button', { name: 'Ready', exact: true }).click();
  await host.getByRole('button', { name: 'Start match', exact: true }).and(host.locator(':enabled')).waitFor();
  await host.getByRole('button', { name: 'Start match', exact: true }).click();
  await Promise.all([host, guest].map(p => p.waitForFunction(() => ['playing', 'error'].includes(window.store.getState().phase), null, { timeout: 300000 })));
  for (const p of [host, guest]) assert.equal(await p.evaluate(() => window.store.getState().phase), 'playing', await p.evaluate(() => window.store.getState().error));
  await Promise.all([host, guest].map(p => p.waitForFunction(() => window.peerFrames.at(-1) >= 300 || window.peerErrors.length, null, { timeout: 300000 })));
  const states = await Promise.all([host, guest].map(p => p.evaluate(() => ({ hashes: window.peerHashes, errors: window.peerErrors, frame: window.peerFrames.at(-1) }))));
  for (const s of states) assert.deepEqual(s.errors, []);
  const common = Object.keys(states[0].hashes).filter(k => k in states[1].hashes);
  assert.ok(common.length >= 200, `only ${common.length} common hashes`);
  for (const f of common) assert.equal(states[1].hashes[f], states[0].hashes[f], `desync at ${f}`);
  receipt.checks.synchronizedMatch = { frames: states.map(s => s.frame), commonHashes: common.length };
  console.log('PASS synchronizedMatch', common.length, 'hashes agree');
  await host.screenshot({ path: `${out}/3-host-match.png` });
  await guest.screenshot({ path: `${out}/4-guest-match.png` });
  assert.deepEqual(errors, []);
  receipt.passed = true;
} catch (e) {
  receipt.failure = String(e?.stack ?? e);
  for (const [i, p] of [host, guest].entries()) await p.screenshot({ path: `${out}/failure-${i}.png` }).catch(() => undefined);
  throw e;
} finally {
  fs.writeFileSync(`${out}/receipt.json`, JSON.stringify(receipt, null, 2));
  await browser.close();
}
