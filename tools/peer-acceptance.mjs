// Actual-browser acceptance. Cross-browser runs on this host are not cross-device/network proof.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from '../web/node_modules/playwright-core/index.mjs';
const args = process.argv.slice(2), opt = (key, fallback) => { const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1]; };
const base = opt('url', 'https://rtsai.net/play/');
const output = path.resolve(opt('output', 'D:/rtsai-release/peer-acceptance-20261009'));
const pairs = opt('pairs', 'chrome:edge,chrome:firefox,chrome:webkit').split(',').map(x => x.split(':'));
fs.mkdirSync(output, { recursive: true });
const results = [];
async function launch(name) {
  if (name === 'firefox') return firefox.launch({ headless: true, firefoxUserPrefs: {
    'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true } });
  if (name === 'webkit') return webkit.launch({ headless: true });
  return chromium.launch({ channel: name === 'edge' ? 'msedge' : 'chrome', headless: true,
    args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
}
async function routeStats(page) {
  return page.evaluate(async () => {
    const rows = [];
    for (const pc of window.acceptancePeers || []) {
      const stats = await pc.getStats();
      const transport = [...stats.values()].find(r => r.type === 'transport' && r.selectedCandidatePairId);
      const pair = transport ? stats.get(transport.selectedCandidatePairId) : [...stats.values()].find(r => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded');
      const local = pair && stats.get(pair.localCandidateId), remote = pair && stats.get(pair.remoteCandidateId);
      rows.push({ connectionState: pc.connectionState, iceState: pc.iceConnectionState,
        localCandidateType: local?.candidateType, remoteCandidateType: remote?.candidateType,
        protocol: local?.protocol, currentRoundTripTime: pair?.currentRoundTripTime,
        bytesSent: pair?.bytesSent, bytesReceived: pair?.bytesReceived,
        remoteVideoFrames: [...stats.values()].filter(s => s.type === 'inbound-rtp' && s.kind === 'video').map(s => s.framesDecoded),
        remoteAudioBytes: [...stats.values()].filter(s => s.type === 'inbound-rtp' && s.kind === 'audio').map(s => s.bytesReceived) });
    }
    return rows;
  });
}
for (const [hostName, guestName] of pairs) {
  const label = hostName + '-' + guestName, browsers = [], contexts = [], pages = [];
  const result = { pair: label, url: base, scope: 'same Windows device/network; separate browser processes',
    syntheticMedia: true, started: new Date().toISOString(), pageErrors: [], roomRequests: 0 };
  let stage = 'launch';
  try {
    for (const name of [hostName, guestName]) {
      const browser = await launch(name); browsers.push(browser);
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); contexts.push(context);
      if (name !== 'webkit' && name !== 'firefox') await context.grantPermissions(['camera', 'microphone'], { origin: new URL(base).origin });
      await context.addInitScript(() => {
        window.acceptancePeers = [];
        const Original = window.RTCPeerConnection;
        if (typeof Original !== 'function') return;
        window.RTCPeerConnection = class extends Original { constructor(config) { super(config); window.acceptancePeers.push(this); } };
      });
      const page = await context.newPage(); pages.push(page);
      page.on('pageerror', e => result.pageErrors.push(String(e)));
      page.on('request', r => { if (r.url().includes('/api/multiplayer')) result.roomRequests++; });
    }
    result.browserVersions = browsers.map(b => b.version());
    stage = 'runtime-load';
    await Promise.all(pages.map(p => p.goto(base)));
    await Promise.all(pages.map(p => p.waitForFunction(() => ['setup', 'error'].includes(window.store?.getState().phase), null, { timeout: 120000 })));
    result.runtime = await Promise.all(pages.map(p => p.evaluate(() => ({ phase: window.store.getState().phase,
      error: window.store.getState().error, crossOriginIsolated, userAgent: navigator.userAgent,
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined', webRTC: typeof RTCPeerConnection !== 'undefined' }))));
    for (const runtime of result.runtime) { assert.equal(runtime.phase, 'setup', runtime.error); assert.equal(runtime.crossOriginIsolated, true); }
    if (result.runtime.some(r => !r.webRTC)) {
      result.status = 'unsupported-test-runtime';
      result.reason = 'This browser test build has no RTCPeerConnection. Real Safari/device acceptance remains pending.';
      continue;
    }
    for (const p of pages) {
      await p.evaluate(() => {
        window.acceptanceHashes = {}; window.acceptanceErrors = []; window.acceptanceFrame = 0;
        window.game.client.on('peerOut', m => { for (const e of m.events) if (e.kind === 'hash') window.acceptanceHashes[e.frame] = e.hash + ':' + e.defeat; });
        window.game.client.on('networkStatus', m => { window.acceptanceFrame = m.frame; if (m.error) window.acceptanceErrors.push(m.error); });
      });
      await p.getByRole('button', { name: 'Direct peer-to-peer', exact: true }).click();
    }
    const [host, guest] = pages;
    stage = 'signaling';
    await host.getByLabel('Direct faction').selectOption('china');
    await guest.getByLabel('Direct faction').selectOption('iran');
    await host.getByRole('button', { name: 'Create offer', exact: true }).click();
    await host.getByLabel('Your connection code').waitFor({ timeout: 60000 });
    const offer = await host.getByLabel('Your connection code').inputValue();
    result.offerCandidateTypes = [...new Set(atob(offer).match(/typ (host|srflx|relay|prflx)/g) || [])];
    await guest.getByLabel('Friend connection code').fill(offer);
    await guest.getByRole('button', { name: 'Answer friend offer', exact: true }).click();
    await guest.getByLabel('Your connection code').waitFor({ timeout: 60000 });
    await host.getByLabel('Friend connection code').fill(await guest.getByLabel('Your connection code').inputValue());
    await host.getByRole('button', { name: 'Connect with friend answer', exact: true }).click();
    await host.getByRole('button', { name: 'Start direct match', exact: true }).waitFor({ timeout: 60000 });
    result.connected = true;
    stage = 'chat';
    for (const [sender, receiver, message] of [[host, guest, 'Host cross-browser test'], [guest, host, 'Guest cross-browser test']]) {
      await sender.getByLabel('Direct chat message').fill(message);
      await sender.getByRole('button', { name: 'Send', exact: true }).click();
      await receiver.getByText('Friend: ' + message, { exact: true }).waitFor();
    }
    result.bidirectionalChat = true;
    stage = 'media';
    if (guestName !== 'webkit' && hostName !== 'webkit') {
      for (const p of pages) await p.getByRole('button', { name: 'Enable camera and microphone', exact: true }).click();
      await Promise.all(pages.map(p => p.waitForFunction(() => {
        const v = document.querySelector('video[aria-label="Friend camera"]');
        return v?.readyState >= 2 && v.videoWidth > 0 && v.srcObject?.getAudioTracks().length === 1;
      }, null, { timeout: 45000 })));
      result.bidirectionalSyntheticMedia = true;
    } else result.mediaSkipped = 'Windows WebKit test runtime has no configured synthetic media devices; not real Safari acceptance.';
    result.routes = await Promise.all(pages.map(routeStats));
    stage = 'match';
    await host.getByRole('button', { name: 'Start direct match', exact: true }).click();
    await Promise.all(pages.map(p => p.waitForFunction(() => ['playing', 'error'].includes(window.store.getState().phase), null, { timeout: 120000 })));
    for (const p of pages) {
      assert.equal(await p.evaluate(() => window.store.getState().phase), 'playing');
      await p.waitForFunction(() => window.game.client.cur?.actors?.some(a => a.owner === window.game.client.cur.header.localPlayer && window.game.client.str(a.type).includes('mcv')), null, { timeout: 60000 });
      await p.evaluate(async () => { const g = window.game, s = g.client.cur, actor = s.actors.find(a => a.owner === s.header.localPlayer && g.client.str(a.type).includes('mcv')); await g.select([actor.id]); });
      await p.waitForTimeout(200);
      await p.evaluate(() => window.game.command({ cmd: 'deploy' }));
    }
    await Promise.all(pages.map(p => p.waitForFunction(() => window.acceptanceFrame >= 400 || window.acceptanceErrors.length, null, { timeout: 90000 })));
    const states = await Promise.all(pages.map(p => p.evaluate(() => ({ hashes: window.acceptanceHashes, errors: window.acceptanceErrors, frame: window.acceptanceFrame }))));
    const common = Object.keys(states[0].hashes).filter(k => k in states[1].hashes);
    assert.ok(common.length >= 350, 'Not enough matching frames');
    for (const frame of common) assert.equal(states[0].hashes[frame], states[1].hashes[frame], 'desync at frame ' + frame);
    for (const state of states) assert.deepEqual(state.errors, []);
    result.matchingFrames = common.length; result.frames = states.map(s => s.frame); result.bothDeployOrders = true;
    await host.screenshot({ path: path.join(output, label + '.png') });
    stage = 'disconnect';
    await contexts[1].close();
    await host.getByRole('button', { name: /^Direct match/ }).click();
    await host.getByRole('alert').waitFor({ timeout: 30000 });
    const frame = await host.evaluate(() => window.acceptanceFrame);
    await host.waitForTimeout(1500);
    assert.equal(await host.evaluate(() => window.acceptanceFrame), frame);
    result.disconnectStopsSimulation = true;
    assert.equal(result.roomRequests, 0); assert.deepEqual(result.pageErrors, []);
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed'; result.failedStage = stage; result.error = String(error);
    for (let i = 0; i < pages.length; i++) {
      try { result['endpoint' + i] = await pages[i].evaluate(() => ({ phase: window.store?.getState().phase, error: window.store?.getState().error,
        directErrors: window.acceptanceErrors, crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined' })); } catch {}
      try { await pages[i].screenshot({ path: path.join(output, label + '-failure-' + i + '.png') }); } catch {}
    }
  } finally {
    for (const browser of browsers) await browser.close();
    results.push(result);
    fs.writeFileSync(path.join(output, 'browser-matrix.json'), JSON.stringify({ scope: 'Same-device/same-network cross-browser acceptance only', results }, null, 2));
    console.log(label + ': ' + result.status + (result.failedStage ? ' at ' + result.failedStage + ': ' + result.error : ' · ' + result.matchingFrames + ' matching frames'));
  }
}
process.exitCode = results.every(r => ['passed', 'unsupported-test-runtime'].includes(r.status)) ? 0 : 1;
