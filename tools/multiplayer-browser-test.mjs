// Accounts and direct multiplayer, end to end in real browsers against the Firebase emulators: three independent
// Chromium contexts pass the sign-in gate, meet through the Firestore matchmaker, play one synchronized OpenRA match
// with an AI opponent, report events to the website (/api/event) and stop together when a player leaves.
//   firebase emulators:start --only auth,firestore --project demo-rtsai     (RTSAI-Web)
//   a game build with VITE_FIREBASE_EMULATORS=1 VITE_REQUIRE_SIGNIN=1, served with the website's /api on one origin
//   RTSAI_TEST_URL=http://127.0.0.1:3520/ node tools/multiplayer-browser-test.mjs
// Host ICE candidates only (no STUN): same-machine proof, not a cross-network certification.
import { browserExecutable, browserArgs } from './browser-launch.mjs';
import { chooseLobbyOption } from './lobby-picker.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
const base = process.env.RTSAI_TEST_URL || 'http://127.0.0.1:3520/';
const out = 'artifacts/multiplayer';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: process.env.RTSAI_TEST_HEADED !== '1', args: [...browserArgs(), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'] })));
const pages = await Promise.all(contexts.map(c => c.newPage())), [host, alpha, bravo] = pages;
const errors = [], firestoreWrites = [];
const receipt = { scope: 'Three independent same-machine Chromium contexts, real OpenRA WASM, WebRTC data channels through the matchmaker; host ICE routes only', checks: {}, errors };
for (const [i, p] of pages.entries()) {
  p.setDefaultTimeout(60000);
  p.on('pageerror', e => errors.push(`page ${i}: ${e}`));
  // Matchmaking writes (offers, answers, match docs) go through Firestore's Write channel.
  p.on('request', r => { if (r.url().includes('127.0.0.1:8085') && /Write\/channel/.test(r.url()) && r.method() === 'POST') firestoreWrites.push({ page: i, at: Date.now() }); });
  await p.addInitScript(() => {
    window.worldStarts = []; window.addEventListener('rtsai:world-started', e => window.worldStarts.push(e.detail));
    const Original = window.RTCPeerConnection;
    window.directConnections = [];
    window.RTCPeerConnection = class extends Original { constructor(config) { super({ ...config, iceServers: [] }); window.directConnections.push(this); } };
  });
}
const lobbyReady = p => p.getByRole('heading', { name: 'Match lobby' }).waitFor();
const uids = [];
// The emulator build exposes a test-only sign-in; real players sign in on the website.
async function signIn(p, i) {
  await p.getByRole('heading', { name: 'Sign in to play' }).waitFor();
  assert.equal(await p.evaluate(() => !!window.store), false, 'nothing boots before sign-in');
  await p.waitForFunction(() => !!window.rtsaiTestAccount);
  uids[i] = await p.evaluate(n => window.rtsaiTestAccount.signUp(`player${n}-${Date.now()}@test.dev`, 'test-password-1'), i);
}
const counters = uid => fetch(`http://127.0.0.1:8085/v1/projects/demo-rtsai/databases/(default)/documents/players/${uid}`, { headers: { Authorization: 'Bearer owner' } }).then(r => r.json()).then(d => Object.fromEntries(Object.entries(d.fields ?? {}).filter(([, v]) => 'integerValue' in v).map(([k, v]) => [k, Number(v.integerValue)])));
const alert = (p, text) => p.getByRole('alert').filter({ hasText: text }).waitFor();
try {
  await Promise.all(pages.map(p => p.goto(base)));
  await host.getByRole('heading', { name: 'Sign in to play' }).waitFor();
  await host.screenshot({ path: `${out}/0-sign-in-gate.png` });
  assert.match(await host.getByRole('link', { name: 'Sign in or create account' }).getAttribute('href'), /\/signin\?next=%2Fplay%2F/);
  await Promise.all(pages.map((p, i) => signIn(p, i)));
  receipt.checks.signInGate = true; console.log('PASS signInGate');
  await Promise.all(pages.map(p => p.waitForFunction(() => ['setup', 'error'].includes(window.store?.getState().phase), null, { timeout: 300000 })));
  for (const p of pages) {
    assert.equal(await p.evaluate(() => window.store.getState().phase), 'setup', await p.evaluate(() => window.store.getState().error));
    await p.evaluate(() => {
      window.peerFrames = []; window.peerErrors = []; window.peerHashes = {};
      window.game.client.on('networkStatus', m => { window.peerFrames.push(m.frame); if (m.error) window.peerErrors.push(m.error); });
      window.game.client.on('peerOut', m => { for (const e of m.events) if (e.kind === 'hash') window.peerHashes[e.frame] = e.hash + ':' + e.defeat; });
    });
  }
  assert.equal(await host.getByRole('button', { name: 'Private multiplayer' }).count(), 0);
  assert.equal(await host.getByRole('button', { name: 'Direct peer-to-peer' }).count(), 0);
  receipt.checks.singleEntry = true;

  // Host creates a match and shares the link.
  await host.getByRole('button', { name: 'Multiplayer', exact: true }).click();
  await host.screenshot({ path: `${out}/1-entry.png` });
  await host.getByRole('button', { name: 'Create match', exact: true }).click();
  await lobbyReady(host);
  const link = await host.getByLabel('Invite link').inputValue(), code = new URL(link).searchParams.get('join');
  assert.match(code, /^[A-Z2-9]{6}$/); receipt.checks.inviteLink = link.replace(code, 'XXXXXX');
  assert.equal(await host.getByRole('button', { name: 'Start match', exact: true }).isEnabled(), false);

  // A signed-out friend opening the invite sees the match waiting behind the sign-in.
  const stranger = await browser.newContext({ viewport: { width: 1440, height: 900 } }), visitor = await stranger.newPage();
  await visitor.goto(link);
  await visitor.getByText(code, { exact: true }).waitFor();
  await visitor.screenshot({ path: `${out}/0-invite-gate.png` });
  await stranger.close();
  receipt.checks.inviteBehindSignIn = true;
  // Alpha is already signed in on this browser: the invite goes straight to the lobby, no clicks.
  await alpha.goto(link);
  await alpha.waitForFunction(() => window.store?.getState().phase === 'setup', null, { timeout: 300000 });
  await lobbyReady(alpha);
  assert.equal(new URL(alpha.url()).searchParams.get('join'), null, 'invite code leaves the address bar');
  await alpha.evaluate(() => { window.peerFrames = []; window.peerErrors = []; window.peerHashes = {}; window.game.client.on('networkStatus', m => { window.peerFrames.push(m.frame); if (m.error) window.peerErrors.push(m.error); }); window.game.client.on('peerOut', m => { for (const e of m.events) if (e.kind === 'hash') window.peerHashes[e.frame] = e.hash + ':' + e.defeat; }); });
  receipt.checks.linkAutoJoin = true; console.log('PASS linkAutoJoin');

  // Bravo: a bad code, then a different build, then the real code typed in.
  await bravo.getByRole('button', { name: 'Multiplayer', exact: true }).click();
  await bravo.getByLabel('Invite link or code').fill('nope');
  await bravo.getByRole('button', { name: 'Join match', exact: true }).click();
  await alert(bravo, '6-character code');
  await bravo.getByLabel('Invite link or code').fill('ZZZZZZ');
  await bravo.getByRole('button', { name: 'Join match', exact: true }).click();
  await alert(bravo, 'expired');
  receipt.checks.badCodes = true; console.log('PASS badCodes');
  await bravo.route('**/_framework/runtime-identity.json', r => r.fulfill({ status: 200, headers: { 'cache-control': 'no-store' }, body: 'a different build' }));
  await bravo.getByLabel('Invite link or code').fill(code.toLowerCase());
  await bravo.getByRole('button', { name: 'Join match', exact: true }).click();
  await alert(bravo, 'different game versions');
  await bravo.unroute('**/_framework/runtime-identity.json');
  receipt.checks.versionMismatchRejected = true; console.log('PASS versionMismatchRejected');
  // The default two-player map is full: the third commander is told so right away.
  await bravo.getByLabel('Invite link or code').fill(code);
  await bravo.getByRole('button', { name: 'Join match', exact: true }).click();
  await alert(bravo, 'This match is full');
  receipt.checks.fullMatchExplained = true; console.log('PASS fullMatchExplained');
  const fourSlot = await host.evaluate(() => window.store.getState().setup.maps.find(m => m.slots.length >= 4).id);
  await chooseLobbyOption(host, 'Multiplayer map', fourSlot);
  await bravo.getByLabel('Invite link or code').fill(`  ${code.slice(0, 3)}-${code.slice(3)} `);
  await bravo.getByRole('button', { name: 'Join match', exact: true }).click();
  await lobbyReady(bravo);
  await host.getByLabel('Player 3 faction', { exact: true }).waitFor();
  receipt.checks.codeJoin = true; console.log('PASS codeJoin');

  // Settings: one AI and sides on the four-slot map. Any change clears readiness.
  await host.getByRole('button', { name: 'Add AI', exact: true }).click();
  await alpha.getByText('AI 1', { exact: true }).waitFor(); await bravo.getByText('AI 1', { exact: true }).waitFor();
  assert.equal(await host.getByRole('button', { name: 'Add AI', exact: true }).isEnabled(), false, 'map full');
  await chooseLobbyOption(alpha, 'Player 2 faction', 'iran');
  await chooseLobbyOption(bravo, 'Player 3 team', 2);
  await chooseLobbyOption(host, 'AI 1 team', 2);
  await host.waitForFunction(() => document.querySelector('[aria-label="Player 3 team"]')?.textContent.includes('Team 2'));
  for (const g of [alpha, bravo]) await g.getByRole('button', { name: 'Ready', exact: true }).click();
  await host.getByRole('button', { name: 'Start match', exact: true }).and(host.locator(':enabled')).waitFor();
  await chooseLobbyOption(alpha, 'Player 2 team', 1);
  await host.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Start match' && b.disabled));
  await alpha.getByRole('button', { name: 'Ready', exact: true }).waitFor(); await bravo.getByRole('button', { name: 'Ready', exact: true }).waitFor();
  receipt.checks.changeClearsReadiness = true; console.log('PASS changeClearsReadiness');

  // Lobby chat and camera.
  await host.getByRole('button', { name: /Lobby chat/ }).click();
  await host.getByLabel('Lobby chat message').fill('Welcome, commanders');
  await host.getByRole('button', { name: 'Send', exact: true }).click();
  for (const g of [alpha, bravo]) { await g.getByRole('button', { name: /Lobby chat/ }).click(); await g.getByText('Welcome, commanders').waitFor(); }
  await alpha.getByLabel('Lobby chat message').fill('Ready when you are');
  await alpha.getByRole('button', { name: 'Send', exact: true }).click();
  await bravo.getByText('Ready when you are').waitFor(); await host.getByText('Ready when you are').waitFor();
  receipt.checks.lobbyChatRelayed = true; console.log('PASS lobbyChatRelayed');
  await alpha.getByRole('button', { name: 'Camera and mic', exact: true }).click();
  await host.waitForFunction(() => { const v = document.querySelector('video[aria-label="Player 2 camera"]'); return v?.readyState >= 2 && v.videoWidth > 0; }, null, { timeout: 30000 });
  receipt.checks.cameraToHost = true; console.log('PASS cameraToHost');
  for (const g of [alpha, bravo]) await g.getByRole('button', { name: 'Ready', exact: true }).click();
  await host.getByRole('button', { name: 'Start match', exact: true }).and(host.locator(':enabled')).waitFor();
  await host.screenshot({ path: `${out}/2-host-lobby.png` });
  await bravo.screenshot({ path: `${out}/3-guest-lobby.png` });
  await host.setViewportSize({ width: 390, height: 844 });
  const mobile = await host.getByRole('dialog').evaluate(el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth }));
  assert.ok(mobile.scrollWidth <= mobile.width, JSON.stringify(mobile));
  await host.screenshot({ path: `${out}/4-host-lobby-mobile.png`, fullPage: true });
  await host.setViewportSize({ width: 1440, height: 900 });
  receipt.checks.mobileLobbyFits = true;

  // Play.
  const beforeStart = Date.now();
  await host.getByRole('button', { name: 'Start match', exact: true }).click();
  await Promise.all(pages.map(p => p.waitForFunction(() => ['playing', 'error'].includes(window.store.getState().phase), null, { timeout: 300000 })));
  for (const p of pages) assert.equal(await p.evaluate(() => window.store.getState().phase), 'playing', await p.evaluate(() => window.store.getState().error));
  await Promise.all(pages.map(p => p.waitForFunction(() => window.peerFrames.at(-1) >= 100 || window.peerErrors.length, null, { timeout: 180000 })));
  const mcvs = [];
  for (const [i, p] of pages.entries()) {
    mcvs.push(await p.evaluate(async () => { const g = window.game, s = g.client.cur; const mcv = s.actors.find(a => a.owner === s.header.localPlayer && g.client.str(a.type).includes('mcv')); if (!mcv) throw Error('No local MCV'); await g.select([mcv.id]); await g.command({ cmd: 'deploy' }); return mcv.id; }));
    await p.locator('canvas.stage').focus(); await p.keyboard.press('Enter');
    const composer = p.getByLabel('Room chat message'); await composer.waitFor();
    await composer.fill(`Commander ${i + 1} deployed`); await p.keyboard.press('Enter');
  }
  for (const p of pages) for (const i of [1, 2, 3]) await p.getByRole('log', { name: 'Chat messages' }).getByText(`Commander ${i} deployed`, { exact: true }).waitFor();
  receipt.checks.matchChatAllPlayers = true; console.log('PASS matchChatAllPlayers');
  await Promise.all(pages.map(p => p.waitForFunction(() => window.peerFrames.at(-1) >= 400 || window.peerErrors.length, null, { timeout: 240000 })));
  const states = await Promise.all(pages.map(p => p.evaluate(() => ({ hashes: window.peerHashes, errors: window.peerErrors, frame: window.peerFrames.at(-1) }))));
  for (const s of states) assert.deepEqual(s.errors, []);
  const common = Object.keys(states[0].hashes).filter(k => k in states[1].hashes && k in states[2].hashes);
  assert.ok(common.length >= 300, `only ${common.length} common hashes`);
  for (const f of common) { assert.equal(states[1].hashes[f], states[0].hashes[f], `desync at ${f}`); assert.equal(states[2].hashes[f], states[0].hashes[f], `desync at ${f}`); }
  // Every world applied every player's deploy order: none of the three MCVs is left anywhere.
  const remaining = await Promise.all(pages.map(p => p.evaluate(ids => window.game.client.cur.actors.filter(a => ids.includes(a.id)).length, mcvs)));
  assert.deepEqual(remaining, [0, 0, 0]); receipt.checks.allDeployOrdersApplied = true;
  // Events reached the website, which counted them in Firestore as each signed-in player.
  const tallies = await Promise.all(uids.map(counters));
  receipt.checks.playerCounters = tallies;
  for (const t of tallies) assert.ok(t.matches >= 1, `match counted: ${JSON.stringify(t)}`);
  assert.ok(tallies[0].multiplayer >= 1, 'the host counted the multiplayer start');
  console.log('PASS eventsCountedPerPlayer');
  // In-match feedback goes to the website's feedback API as the player. The test website has no GitHub or mail
  // configured, so it must answer with its "could not be saved" error, which the dialog shows while keeping the note.
  await alpha.getByRole('button', { name: 'Feedback', exact: true }).click();
  await alpha.getByLabel('Your feedback', { exact: true }).fill('The lobby flow is great; the AI took a while to expand.');
  await alpha.getByRole('radio', { name: '4 of 5' }).click();
  await alpha.screenshot({ path: `${out}/6b-feedback.png` });
  await alpha.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await alert(alpha, 'Feedback could not be saved');
  assert.equal(await alpha.getByLabel('Your feedback', { exact: true }).inputValue(), 'The lobby flow is great; the AI took a while to expand.');
  await alpha.getByRole('button', { name: 'Close feedback' }).click();
  receipt.checks.feedbackReachesWebsite = true; console.log('PASS feedbackReachesWebsite');
  receipt.checks.matchingHashCount = common.length; receipt.checks.frames = states.map(s => s.frame);
  // After the host closes the match (a few seconds after start), play never touches the matchmaker.
  receipt.checks.matchmakerWritesDuringPlay = firestoreWrites.filter(w => w.at > beforeStart + 10000).length;
  receipt.checks.worldStarts = await Promise.all(pages.map(p => p.evaluate(() => window.worldStarts.map(e => e.transport))));
  for (const t of receipt.checks.worldStarts) assert.deepEqual(t, ['direct']);
  console.log(`PASS synchronized three-player match with AI (${common.length} matching hashes)`);
  await host.screenshot({ path: `${out}/5-match-host.png` });
  await alpha.screenshot({ path: `${out}/6-match-guest.png` });

  // A guest leaves: everyone's world stops, with the reason on screen.
  await contexts[2].close();
  await alert(host, 'Player 3'); await alert(alpha, 'Player 3');
  const stops = await Promise.all([host, alpha].map(p => p.evaluate(() => window.peerFrames.at(-1))));
  await host.waitForTimeout(2000);
  assert.deepEqual(await Promise.all([host, alpha].map(p => p.evaluate(() => window.peerFrames.at(-1)))), stops);
  await alpha.screenshot({ path: `${out}/7-stopped.png` });
  receipt.checks.leaveStopsEveryone = true; console.log('PASS leaveStopsEveryone');
  for (const p of [host, alpha]) { await p.getByRole('button', { name: 'Return to menu', exact: true }).click(); await p.waitForFunction(() => window.store.getState().phase === 'setup'); }
  receipt.checks.returnToMenu = true;

  // A fresh two-player match right after.
  await host.getByRole('button', { name: 'Multiplayer', exact: true }).click();
  await host.getByRole('button', { name: 'Create match', exact: true }).click();
  await lobbyReady(host);
  const second = await host.getByLabel('Invite link').inputValue();
  await alpha.getByRole('button', { name: 'Multiplayer', exact: true }).click();
  await alpha.getByLabel('Invite link or code').fill(second);
  await alpha.getByRole('button', { name: 'Join match', exact: true }).click();
  await lobbyReady(alpha);
  await alpha.getByRole('button', { name: 'Ready', exact: true }).click();
  for (const p of [host, alpha]) await p.evaluate(() => { window.peerFrames = []; window.peerErrors = []; window.peerHashes = {}; });
  await host.getByRole('button', { name: 'Start match', exact: true }).and(host.locator(':enabled')).click();
  await Promise.all([host, alpha].map(p => p.waitForFunction(() => window.store.getState().phase === 'playing' && window.peerFrames.at(-1) >= 120, null, { timeout: 240000 })));
  const again = await Promise.all([host, alpha].map(p => p.evaluate(() => ({ hashes: window.peerHashes, errors: window.peerErrors }))));
  const both = Object.keys(again[0].hashes).filter(k => k in again[1].hashes);
  assert.ok(both.length >= 80); for (const f of both) assert.equal(again[0].hashes[f], again[1].hashes[f]);
  receipt.checks.secondMatch = { matchingHashCount: both.length }; console.log('PASS secondMatch');
  // The host quits from the game: the guest is told and stops.
  await host.evaluate(() => window.game.quit());
  await alert(alpha, 'host left');
  receipt.checks.hostQuitStopsGuest = true; console.log('PASS hostQuitStopsGuest');

  assert.deepEqual(errors, []);
  receipt.status = 'passed'; console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  receipt.status = 'failed'; receipt.error = String(error?.stack || error);
  for (const [i, p] of pages.entries()) if (!p.isClosed()) {
    receipt['page' + i] = (await p.locator('body').innerText().catch(() => '')).slice(-3000);
    receipt['runtime' + i] = await p.evaluate(() => ({ phase: window.store?.getState().phase, error: window.store?.getState().error, errors: window.peerErrors, frame: window.peerFrames?.at(-1), connections: window.directConnections?.map(c => c.connectionState) })).catch(e => String(e));
    await p.screenshot({ path: `${out}/failure-${i}.png` }).catch(() => {});
  }
  console.log(JSON.stringify(receipt, null, 2)); process.exitCode = 1;
} finally { fs.writeFileSync(`${out}/receipt.json`, JSON.stringify(receipt, null, 2)); await browser.close(); }
