import { browserExecutable, browserArgs } from './browser-launch.mjs';
import { chooseLobbyOption } from './lobby-picker.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
const base = process.env.RTSAI_TEST_URL || 'http://127.0.0.1:3505/';
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true, args: [...browserArgs(), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const contexts = await Promise.all([1, 2].map(() => browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'] })));
const pages = await Promise.all(contexts.map(c => c.newPage())), [host, guest] = pages;
const voiceLanguages = (process.env.RTSAI_TEST_VOICE_LANGUAGES || '').split(',');
for (const [index, context] of contexts.entries()) if (voiceLanguages[index]) await context.addInitScript(language => localStorage.setItem('rtsai.voiceLanguage.v1', language), voiceLanguages[index]);
const errors = []; let roomRequests = 0;
const receipt = { scope: 'Two independent same-Mac Chromium contexts, real OpenRA WASM and WebRTC data channels; synthetic media, host ICE routes only; not different devices/networks or Safari', checks: {}, errors };
fs.mkdirSync('artifacts/direct', { recursive: true });
for (const p of pages) {
  p.setDefaultTimeout(60000); p.on('pageerror', e => errors.push(String(e))); p.on('request', r => { if (r.url().includes('api/multiplayer')) roomRequests++; });
  await p.addInitScript(() => {
    window.worldStarts=[];window.addEventListener('rtsai:world-started',e=>window.worldStarts.push(e.detail));
    const Original = window.RTCPeerConnection;
    window.directConnections = [];
    window.RTCPeerConnection = class extends Original { constructor(config) { super({ ...config, iceServers: [] }); window.directConnections.push(this); } };
  });
}
async function exchange() {
  await host.getByRole('button', { name: 'Create offer', exact: true }).click();
  await host.getByLabel('Your connection code').waitFor();
  const offer = await host.getByLabel('Your connection code').inputValue();
  assert.equal(await host.getByRole('button', { name: 'Create offer', exact: true }).isEnabled(), false);
  await guest.getByLabel('Friend connection code').fill(offer);
  await guest.getByRole('button', { name: 'Answer friend offer', exact: true }).click();
  await guest.getByLabel('Your connection code').waitFor();
  assert.equal(await guest.getByRole('button', { name: 'Answer friend offer', exact: true }).isEnabled(), false);
  await host.getByLabel('Friend connection code').fill(await guest.getByLabel('Your connection code').inputValue());
  await host.getByRole('button', { name: 'Connect with friend answer', exact: true }).click();
  return offer;
}
async function reset() { for (const p of pages) await p.getByRole('button', { name: 'Start a new connection', exact: true }).click(); }
async function lobby() {
  await host.getByRole('button', { name: 'Start direct match', exact: true }).waitFor();
  await guest.getByRole('button', { name: 'Ready', exact: true }).waitFor();
  assert.equal(await host.getByRole('button', { name: 'Start direct match', exact: true }).isEnabled(), false);
}
async function ready() {
  for (const p of pages) await p.getByRole('button', { name: 'Ready', exact: true }).click();
  await host.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Start direct match' && !b.disabled));
}
async function inject(page, message, raw = false) {
  await page.evaluate(({ message, raw }) => {
    const channel = window.directConnections.at(-1).sctp.transport;
    if (!channel) throw Error('No direct transport');
    window.directTestChannel.send(raw ? message : JSON.stringify(message));
  }, { message, raw });
}
try {
  await Promise.all(pages.map(p => p.goto(`${base}?profile=${process.env.RTSAI_TEST_PROFILE || "public"}&runtime=${process.env.RTSAI_TEST_RUNTIME || 'aot'}&private=0`)));
  await Promise.all(pages.map(p => p.waitForFunction(() => ['setup', 'error'].includes(window.store?.getState().phase), null, { timeout: 240000 })));
  receipt.checks.cancelledLaunchLifecycle = await host.evaluate(async () => {
    const g = window.game, store = window.store, saved = store.getState();
    const staleTypes = ["started", "networkStatus", "peerOut", "snapshot", "ui", "shroud", "radar", "audio", "companion", "error", "texture", "modelbuffer", "reply", "stats"];
    const previousHandlers = new Map(g.client.handlers); let staleEvents = 0;
    for (const type of staleTypes) g.client.handlers.set(type, [() => staleEvents++]);
    try { for (const type of staleTypes) g.client.handle({ type, generation: -1 }); } finally { g.client.handlers = previousHandlers; }
    if (staleEvents) throw Error("Stale worker event escaped generation guard");
    const start = g.client.start, want = g.wantFactions, ensure = g.cc.ensureRunning, matchStarted = g.cc.matchStarted;
    const launches = []; let companionStarts = 0;
    g.client.start = (...args) => launches.push(args); g.wantFactions = () => {}; g.cc.matchStarted = () => companionStarts++;
    const map = saved.setup.maps.find(m => m.slots.length >= 2);
    const scenario = JSON.stringify({ map: map.id, seed: 101, players: [] });
    try {
      store.getState().set({ sheets: { total: 1, uploaded: 0 }, cc: { ...saved.cc, enabled: false } });
      g.start(scenario); g.quit();
      store.getState().set({ sheets: { total: 1, uploaded: 1 } });
      await new Promise(resolve => setTimeout(resolve, 250));
      if (launches.length || store.getState().phase !== 'setup') throw Error('Cancelled art wait launched a world');
      for (const rejects of [false, true]) {
        let settle;
        g.cc.ensureRunning = () => new Promise((resolve, reject) => { settle = rejects ? reject : resolve; });
        store.getState().set({ ccAvailable: true, cc: { ...saved.cc, enabled: true, error: '' } });
        g.start(scenario); g.quit();
        store.getState().set({ cc: { ...saved.cc, enabled: false, error: 'replacement-world' } });
        g.start(JSON.stringify({ map: map.id, seed: 202, players: [] }));
        const count = launches.length;
        settle(rejects ? Error('late companion response') : undefined);
        await new Promise(resolve => setTimeout(resolve, 0));
        if (launches.length !== count || companionStarts || store.getState().cc.error !== 'replacement-world' || store.getState().phase !== 'loading') throw Error('Late companion continuation mutated replacement world');
        g.quit();
      }
      return { artWaitCancelled: true, lateCompanionResolveIgnored: true, lateCompanionRejectIgnored: true, replacementLaunches: launches.length, staleWorkerEventTypesRejected: staleTypes };
    } finally {
      g.client.start = start; g.wantFactions = want; g.cc.ensureRunning = ensure; g.cc.matchStarted = matchStarted;
      store.getState().set({ sheets: saved.sheets, cc: saved.cc, ccAvailable: saved.ccAvailable, phase: 'setup' });
    }
  });
  for (const p of pages) {
    assert.equal(await p.evaluate(() => window.store.getState().phase), 'setup', await p.evaluate(() => window.store.getState().error));
    await p.evaluate(() => {
      window.peerFrames = []; window.peerErrors = []; window.peerHashes = {}; window.peerOrders = [];
      window.game.client.on('networkStatus', m => { window.peerFrames.push(m.frame); if (m.error) window.peerErrors.push(m.error); });
      window.game.client.on('peerOut', m => { for (const e of m.events) { if (e.kind === 'hash') window.peerHashes[e.frame] = e.hash + ':' + e.defeat; else window.peerOrders.push(e); } });
      const original = RTCPeerConnection.prototype.createDataChannel;
      RTCPeerConnection.prototype.createDataChannel = function (...args) { const channel = original.apply(this, args); window.directTestChannel = channel; return channel; };
    });
    await p.getByRole('button', { name: 'Direct peer-to-peer', exact: true }).click();
  }
  receipt.staticRoomEntryAbsent = await host.getByRole('button', { name: 'Private multiplayer', exact: true }).count() === 0;
  await host.setViewportSize({ width: 390, height: 844 });
  const mobile = await host.getByRole('dialog').evaluate(el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth }));
  assert.ok(mobile.scrollWidth <= mobile.width, JSON.stringify(mobile));
  await host.screenshot({ path: 'artifacts/direct/invite-mobile.png' });
  await host.setViewportSize({ width: 1440, height: 900 });
  receipt.checks.mobileInviteFits = true;
  await guest.getByLabel('Friend connection code').fill('not-an-invite');
  await guest.getByRole('button', { name: 'Answer friend offer', exact: true }).click();
  await guest.getByRole('alert').filter({ hasText: 'Invalid connection code' }).waitFor();
  await guest.getByRole('button', { name: 'Start a new connection', exact: true }).click();
  receipt.checks.malformedInvite = true; console.log('PASS malformedInvite');
  await guest.route('**/_framework/runtime-identity.json', r => r.fulfill({ status: 200, headers: { 'cache-control': 'no-store' }, body: 'different fingerprint' }));
  await exchange();
  await Promise.all(pages.map(p => p.getByRole('alert').waitFor()));
  assert.match(await pages[0].getByRole('alert').innerText(), /Different game builds|interrupted/);
  await guest.unroute('**/_framework/runtime-identity.json'); await reset();
  receipt.checks.mismatchedBuild = true; console.log('PASS mismatchedBuild');
  await exchange(); await lobby();
  await inject(host, { kind: 'map', map: 'missing-map', uid: 'wrong-map' });
  await guest.getByRole('alert').filter({ hasText: 'Different or unsupported maps' }).waitFor();
  await host.getByRole('alert').waitFor(); await reset();
  receipt.checks.mismatchedMap = true; console.log('PASS mismatchedMap');
  let finalOffer = await exchange(); await lobby();
  receipt.checks.repeatedJoinBlocked = true; console.log('PASS repeatedJoinBlocked');
  await ready();
  await chooseLobbyOption(guest, 'Direct faction', 'iran');
  await host.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Start direct match' && b.disabled));
  await Promise.all(pages.map(p => p.getByRole('button', { name: 'Ready', exact: true }).waitFor()));
  receipt.checks.factionChangeClearsReadiness = true; console.log('PASS factionChangeClearsReadiness');
  await ready();
  const maps = await host.evaluate(() => window.store.getState().setup.maps.filter(m => m.slots.length >= 2).map(m => m.id));
  if (maps.length > 1) {
    await chooseLobbyOption(host, 'Direct map', maps[1]);
    await Promise.all(pages.map(p => p.getByRole('button', { name: 'Ready', exact: true }).waitFor()));
    assert.equal(await host.getByRole('button', { name: 'Start direct match', exact: true }).isEnabled(), false);
    await ready(); receipt.checks.mapChangeClearsReadiness = true; console.log('PASS mapChangeClearsReadiness');
  }
  await guest.evaluate(() => window.store.getState().set({ phase: 'loading' }));
  await host.getByRole('button', { name: 'Start direct match', exact: true }).click();
  await guest.waitForFunction(() => window.directConnections.at(-1).connectionState === 'closed');
  assert.equal(await guest.evaluate(() => window.store.getState().phase), 'loading');
  await guest.evaluate(() => window.store.getState().set({ phase: 'setup' }));
  await guest.getByRole('alert').filter({ hasText: 'Another world is already open' }).waitFor();
  await host.getByRole('alert').waitFor();
  await reset();
  for (const p of pages) await p.evaluate(() => { window.peerFrames = []; window.peerErrors = []; window.peerHashes = {}; window.peerOrders = []; });
  finalOffer = await exchange(); await lobby(); await ready();
  receipt.checks.busyGamePhaseRejectsRemoteStart = true;
  await host.getByLabel('Direct chat message').fill('Friends connected without a room server');
  await host.getByRole('button', { name: 'Send', exact: true }).click();
  await guest.getByText('Friend: Friends connected without a room server', { exact: true }).waitFor();
  for (const p of pages) await p.getByRole('button', { name: 'Enable camera and microphone', exact: true }).click();
  for (const p of pages) await p.waitForFunction(() => { const v = document.querySelector('video[aria-label="Friend camera"]'); return v?.readyState >= 2 && v.videoWidth > 0 && v.srcObject?.getAudioTracks().length === 1; }, null, { timeout: 30000 });
  receipt.checks.bidirectionalSyntheticMedia = true; console.log('PASS bidirectionalSyntheticMedia');
  await host.screenshot({ path: 'artifacts/direct/call-lobby.png' });
  await host.getByRole('button', { name: 'Start direct match', exact: true }).click();
  await Promise.all(pages.map(p => p.waitForFunction(() => ['playing', 'error'].includes(window.store.getState().phase), null, { timeout: 240000 })));
  for (const p of pages) assert.equal(await p.evaluate(() => window.store.getState().phase), 'playing');
  await Promise.all(pages.map(p => p.waitForFunction(() => window.peerFrames.at(-1) >= 120 || window.peerErrors.length, null, { timeout: 120000 })));
  for (const p of pages) assert.deepEqual(await p.evaluate(() => window.peerErrors), []);
  for (const [i, p] of pages.entries()) {
    await p.locator('canvas.stage').focus(); await p.keyboard.press('Enter');
    const composer = p.getByLabel('Direct chat message'); await composer.waitFor();
    await composer.fill(`Commander ${i + 1} ready on the direct channel`); await p.keyboard.press('Enter');
    await composer.waitFor({ state: 'hidden' });
    await pages[1 - i].getByRole('log', { name: 'Chat messages' }).getByText(`Commander ${i + 1} ready on the direct channel`, { exact: true }).waitFor();
    await p.evaluate(async () => { const g = window.game, s = g.client.cur; const mcv = s.actors.find(a => a.owner === s.header.localPlayer && g.client.str(a.type).includes('mcv')); if (!mcv) throw Error('No local MCV'); await g.select([mcv.id]); await g.command({ cmd: 'deploy' }); });
  }
  await Promise.all(pages.map(p => p.waitForFunction(() => window.peerFrames.at(-1) >= 400 || window.peerErrors.length, null, { timeout: 120000 })));
  const states = await Promise.all(pages.map(p => p.evaluate(() => ({ hashes: window.peerHashes, errors: window.peerErrors, frame: window.peerFrames.at(-1), orders: window.peerOrders.length }))));
  const common = Object.keys(states[0].hashes).filter(k => k in states[1].hashes);
  assert.ok(common.length >= 350, 'Not enough independently matching hashes');
  for (const tick of common) assert.equal(states[0].hashes[tick], states[1].hashes[tick], `desync at ${tick}`);
  for (const s of states) assert.deepEqual(s.errors, []);
  for (const p of pages) await p.evaluate(() => {
    window.game.client.worker.postMessage({ type: "peerStop", generation: -1, error: "stale stop" });
    window.game.client.worker.postMessage({ type: "peerFrame", generation: -1, frame: -1, packets: [] });
    window.game.client.worker.postMessage({ type: "end", generation: -1 });
  });
  await Promise.all(pages.map((p, i) => p.waitForFunction(frame => window.peerFrames.at(-1) > frame + 5, states[i].frame, { timeout: 15000 })));
  receipt.checks.staleWorkerMutationsRejected = true;
  receipt.checks.matchingHashCount = common.length; receipt.checks.frames = states.map(s => s.frame); receipt.checks.bothDeployOrders = true; console.log('PASS bothDeployOrders'); receipt.checks.keyboardChat = true; console.log('PASS keyboardChat');
  await host.screenshot({ path: 'artifacts/direct/match-host.png' });
  await inject(host, '[]', true);
  await Promise.all(pages.map(p => p.getByRole('alert').waitFor()));
  await guest.getByRole('alert').filter({ hasText: 'Invalid peer message' }).waitFor();
  const stops = await Promise.all(pages.map(p => p.evaluate(() => window.peerFrames.at(-1))));
  await host.waitForTimeout(1600);
  assert.deepEqual(await Promise.all(pages.map(p => p.evaluate(() => window.peerFrames.at(-1)))), stops);
  receipt.checks.malformedLiveMessageStopsBothWorlds = true; console.log('PASS malformedLiveMessageStopsBothWorlds');
  await guest.screenshot({ path: 'artifacts/direct/stopped-malformed.png' });
  await reset();
  await Promise.all(pages.map(p => p.waitForFunction(() => window.store.getState().phase === 'setup')));
  for (const p of pages) await p.evaluate(() => { window.peerFrames = []; window.peerErrors = []; window.peerHashes = {}; });
  const restartOffer = await exchange(); assert.notEqual(restartOffer, finalOffer); await lobby(); await ready();
  await host.getByRole('button', { name: 'Start direct match', exact: true }).click();
  await Promise.all(pages.map(p => p.waitForFunction(() => window.store.getState().phase === 'playing' && window.peerFrames.at(-1) >= 80, null, { timeout: 120000 })));
  const restarted = await Promise.all(pages.map(p => p.evaluate(() => ({ hashes: window.peerHashes, errors: window.peerErrors }))));
  const commonRestart = Object.keys(restarted[0].hashes).filter(k => k in restarted[1].hashes);
  assert.ok(commonRestart.length >= 60);
  for (const tick of commonRestart) assert.equal(restarted[0].hashes[tick], restarted[1].hashes[tick]);
  for (const s of restarted) assert.deepEqual(s.errors, []);
  receipt.checks.freshSessionAfterFatalStop = { matchingHashCount: commonRestart.length, newOffer: true };
  await host.evaluate(() => {
    const channel = window.directTestChannel, original = channel.send.bind(channel);
    channel.send = data => {
      const message = JSON.parse(data), hash = message.kind === 'events' && message.events.find(e => e.kind === 'hash');
      if (hash) { hash.hash = hash.hash === 2147483647 ? hash.hash - 1 : hash.hash + 1; channel.send = original; }
      original(JSON.stringify(message));
    };
  });
  await guest.getByRole('alert').filter({ hasText: 'Synchronization mismatch' }).waitFor();
  await host.getByRole('alert').waitFor();
  const mismatchStops = await Promise.all(pages.map(p => p.evaluate(() => window.peerFrames.at(-1))));
  await host.waitForTimeout(1600);
  assert.deepEqual(await Promise.all(pages.map(p => p.evaluate(() => window.peerFrames.at(-1)))), mismatchStops);
  receipt.checks.liveHashMismatchStopsBothWorlds = true;
  await guest.screenshot({ path: 'artifacts/direct/stopped-hash-mismatch.png' });
  await reset();
  for (const p of pages) await p.evaluate(() => { window.peerFrames = []; window.peerErrors = []; window.peerHashes = {}; });
  await exchange(); await lobby(); await ready();
  await host.getByRole('button', { name: 'Start direct match', exact: true }).click();
  await Promise.all(pages.map(p => p.waitForFunction(() => window.store.getState().phase === 'playing' && window.peerFrames.at(-1) >= 80, null, { timeout: 120000 })));
  const afterMismatch = await Promise.all(pages.map(p => p.evaluate(() => ({ hashes: window.peerHashes, errors: window.peerErrors }))));
  const commonAfterMismatch = Object.keys(afterMismatch[0].hashes).filter(k => k in afterMismatch[1].hashes);
  assert.ok(commonAfterMismatch.length >= 60);
  for (const tick of commonAfterMismatch) assert.equal(afterMismatch[0].hashes[tick], afterMismatch[1].hashes[tick]);
  for (const s of afterMismatch) assert.deepEqual(s.errors, []);
  receipt.checks.freshSessionAfterHashMismatch = { matchingHashCount: commonAfterMismatch.length };
  if (voiceLanguages.length === 2 && voiceLanguages.every(Boolean)) {
    receipt.checks.localVoicePreferences = await Promise.all(pages.map(p => p.evaluate(() => window.game.client.voiceLanguage())));
    for (const [index, preference] of receipt.checks.localVoicePreferences.entries()) assert.equal(preference.language, voiceLanguages[index]);
  }
  receipt.checks.actualStartEvents=await Promise.all(pages.map(p=>p.evaluate(()=>window.worldStarts)));
  for(const events of receipt.checks.actualStartEvents)assert.ok(events.some(e=>e.event==='world-started'&&e.transport==='direct'&&e.mode===((process.env.RTSAI_TEST_PROFILE||'public')==='public-classic'?'classic':'isometric')));
  await contexts[1].close();
  await host.getByRole('alert').waitFor({ timeout: 30000 });
  const stop = await host.evaluate(() => window.peerFrames.at(-1)); await host.waitForTimeout(1600);
  assert.equal(await host.evaluate(() => window.peerFrames.at(-1)), stop);
  receipt.checks.disconnectStopsSimulation = true; console.log('PASS disconnectStopsSimulation');
  await host.getByRole('button', { name: 'Start a new connection', exact: true }).click();
  await host.waitForFunction(() => window.store.getState().phase === 'setup');
  receipt.checks.disconnectRestartToSetup = true; console.log('PASS disconnectRestartToSetup');
  receipt.roomRequests = roomRequests; assert.equal(roomRequests, 0); assert.deepEqual(errors, []);
  receipt.status = 'passed'; console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  receipt.status = 'failed'; receipt.error = String(error);
  for (const [i, p] of pages.entries()) if (!p.isClosed()) { receipt['endpoint' + i] = (await p.locator('body').innerText()).slice(-4500); receipt['runtime' + i] = await p.evaluate(() => ({ phase: window.store.getState().phase, errors: window.peerErrors, frames: window.peerFrames, connections: window.directConnections.map(p => ({ state: p.connectionState, signaling: p.signalingState })) })); await p.screenshot({ path: `artifacts/direct/failure-${i}.png` }); }
  console.log(JSON.stringify(receipt, null, 2)); throw error;
} finally { fs.writeFileSync('artifacts/direct/receipt.json', JSON.stringify(receipt, null, 2)); await browser.close(); }
