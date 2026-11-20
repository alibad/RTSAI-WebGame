// Accounts and direct multiplayer, end to end in real browsers against the Firebase emulators: three independent
// Chromium contexts pass the sign-in gate, meet through the Firestore matchmaker, play one synchronized OpenRA match
// with an AI opponent and stop together when a player leaves; then two of them play again 100 ms apart, sit through a
// short loss of the line, and a friend on an unreachable network is told what to try.
//   firebase emulators:start --only auth,firestore --project demo-rtsai     (RTSAI-Web's firebase.json, or your own ports)
//   a game build with VITE_FIREBASE_EMULATORS=1 VITE_REQUIRE_SIGNIN=1 (and VITE_FIREBASE_EMULATOR_PORTS for other
//   ports), served with its runtime and data on one origin (tools/local-site-server.mjs)
//   RTSAI_TEST_URL=http://127.0.0.1:3520/play/ [RTSAI_FIRESTORE_EMULATOR=127.0.0.1:8085] node tools/multiplayer-browser-test.mjs
//   RTSAI_TEST_WEBSITE=1: the website (RTSAI-Web on the same emulators) answers on that origin too; then the test also
//   checks that each player's match is counted by /api/event and that in-match feedback reaches /api/feedback.
// Host ICE candidates only (no STUN): same-machine proof, not a cross-network certification. The ping is the
// harness's shim (tools/multiplayer-harness.mjs): every message held back by half of it.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chooseLobbyOption } from './lobby-picker.mjs';
import * as H from './multiplayer-harness.mjs';

const out = 'artifacts/multiplayer';
fs.mkdirSync(out, { recursive: true });
const website = process.env.RTSAI_TEST_WEBSITE === '1';
const browser = await H.launch();
const players = [];
for (const name of ['Host', 'Alpha', 'Bravo']) players.push(await H.openPlayer(browser, { name }));
const [host, alpha, bravo] = players, pages = players.map(p => p.page);
const firestoreWrites = [];
const receipt = { scope: 'Three independent same-machine Chromium contexts, real OpenRA WASM, WebRTC data channels through the matchmaker; host ICE routes only; ping simulated by holding messages back', checks: {}, errors: [] };
const pass = (name, value = true) => { receipt.checks[name] = value; console.log(`PASS ${name}${value === true ? '' : ' ' + JSON.stringify(value)}`); };
// Matchmaking writes (offers, answers, match docs) go through Firestore's Write channel.
for (const [i, p] of pages.entries()) p.on('request', r => { if (r.url().includes(H.FIRESTORE.split('/v1/')[0].replace('http://', '')) && /Write\/channel/.test(r.url()) && r.method() === 'POST') firestoreWrites.push({ page: i, at: Date.now() }); });
const alert = (p, text, timeout = 60000) => p.page.getByRole('alert').filter({ hasText: text }).waitFor({ timeout });
const counters = uid => H.firestoreDoc(`players/${uid}`).then(d => Object.fromEntries(Object.entries(d.body.fields ?? {}).filter(([, v]) => 'integerValue' in v).map(([k, v]) => [k, Number(v.integerValue)])));
const resetWatch = list => Promise.all(list.map(p => p.page.evaluate(() => { window.mp.frames = []; window.mp.errors = []; window.mp.hashes = {}; })));
const toMenu = async list => { for (const p of list) { await p.page.getByRole('button', { name: 'Return to menu', exact: true }).click(); await p.page.waitForFunction(() => window.store.getState().phase === 'setup'); } };
const matchBar = p => p.page.getByRole('region', { name: 'Multiplayer controls' });

try {
  // ---------------------------------------------------------------------------------------------- the sign-in gate
  await Promise.all(pages.map(p => p.goto(H.BASE)));
  await host.page.getByRole('heading', { name: 'Sign in to play' }).waitFor();
  await host.page.screenshot({ path: `${out}/0-sign-in-gate.png` });
  assert.match(await host.page.getByRole('link', { name: 'Sign in or create account' }).getAttribute('href'), /\/signin\?next=%2Fplay%2F/);
  for (const p of pages) assert.equal(await p.evaluate(() => !!window.store), false, 'nothing boots before sign-in');
  await Promise.all(players.map(p => H.signIn(p, { url: '' })));
  await Promise.all(players.map(p => H.atMenu(p)));
  pass('signInGate');
  assert.equal(await host.page.getByRole('button', { name: 'Private multiplayer' }).count(), 0);
  assert.equal(await host.page.getByRole('button', { name: 'Direct peer-to-peer' }).count(), 0);
  pass('singleEntry');

  // ------------------------------------------------------------------------------------------------------ the lobby
  await host.page.getByRole('button', { name: 'Multiplayer', exact: true }).click();
  await host.page.screenshot({ path: `${out}/1-entry.png` });
  await host.page.getByRole('button', { name: 'Create match', exact: true }).click();
  await H.lobby(host);
  const link = await host.page.getByLabel('Invite link').inputValue(), code = new URL(link).searchParams.get('join');
  assert.match(code, /^[A-Z2-9]{6}$/); receipt.checks.inviteLink = link.replace(code, 'XXXXXX');
  assert.equal(await host.page.getByRole('button', { name: 'Start match', exact: true }).isEnabled(), false);

  // A signed-out friend opening the invite sees the match waiting behind the sign-in.
  const stranger = await browser.newContext({ viewport: { width: 1440, height: 900 } }), visitor = await stranger.newPage();
  await visitor.goto(link);
  await visitor.getByText(code, { exact: true }).waitFor();
  await visitor.screenshot({ path: `${out}/0-invite-gate.png` });
  await stranger.close();
  pass('inviteBehindSignIn');
  // Alpha is already signed in on this browser: the invite goes straight to the lobby, no clicks.
  await alpha.page.goto(link);
  await H.atMenu(alpha);
  await H.lobby(alpha);
  assert.equal(new URL(alpha.page.url()).searchParams.get('join'), null, 'invite code leaves the address bar');
  pass('linkAutoJoin');

  // Bravo: a bad code, then a different build, then the real code typed in.
  await bravo.page.getByRole('button', { name: 'Multiplayer', exact: true }).click();
  await H.joinMatch(bravo, 'nope', { wait: false }); await alert(bravo, '6-character code');
  await H.joinMatch(bravo, 'ZZZZZZ', { wait: false }); await alert(bravo, 'expired');
  pass('badCodes');
  await bravo.page.route('**/_framework/runtime-identity.json', r => r.fulfill({ status: 200, headers: { 'cache-control': 'no-store' }, body: 'a different build' }));
  await H.joinMatch(bravo, code.toLowerCase(), { wait: false }); await alert(bravo, 'different game versions');
  await bravo.page.unroute('**/_framework/runtime-identity.json');
  pass('versionMismatchRejected');
  // The default two-player map is full: the third commander is told so right away.
  await H.joinMatch(bravo, code, { wait: false }); await alert(bravo, 'This match is full');
  pass('fullMatchExplained');
  const fourSlot = await host.page.evaluate(() => window.store.getState().setup.maps.find(m => m.slots.length >= 4).id);
  await chooseLobbyOption(host.page, 'Multiplayer map', fourSlot);
  await H.joinMatch(bravo, `  ${code.slice(0, 3)}-${code.slice(3)} `);
  await host.page.getByLabel('Player 3 faction', { exact: true }).waitFor();
  pass('codeJoin');

  // Settings: one AI and sides on the four-slot map. Any change clears readiness.
  await host.page.getByRole('button', { name: 'Add AI', exact: true }).click();
  for (const g of [alpha, bravo]) await g.page.getByText('AI 1', { exact: true }).waitFor();
  assert.equal(await host.page.getByRole('button', { name: 'Add AI', exact: true }).isEnabled(), false, 'map full');
  await chooseLobbyOption(alpha.page, 'Player 2 faction', 'iran');
  await chooseLobbyOption(bravo.page, 'Player 3 team', 2);
  await chooseLobbyOption(host.page, 'AI 1 team', 2);
  await host.page.waitForFunction(() => document.querySelector('[aria-label="Player 3 team"]')?.textContent.includes('Team 2'));
  for (const g of [alpha, bravo]) await H.ready(g);
  await host.page.getByRole('button', { name: 'Start match', exact: true }).and(host.page.locator(':enabled')).waitFor();
  await chooseLobbyOption(alpha.page, 'Player 2 team', 1);
  await host.page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Start match' && b.disabled));
  for (const g of [alpha, bravo]) await g.page.getByRole('button', { name: 'Ready', exact: true }).waitFor();
  pass('changeClearsReadiness');

  // Lobby chat and camera.
  await host.page.getByRole('button', { name: /Lobby chat/ }).click();
  await host.page.getByLabel('Lobby chat message').fill('Welcome, commanders');
  await host.page.getByRole('button', { name: 'Send', exact: true }).click();
  for (const g of [alpha, bravo]) { await g.page.getByRole('button', { name: /Lobby chat/ }).click(); await g.page.getByText('Welcome, commanders').waitFor(); }
  await alpha.page.getByLabel('Lobby chat message').fill('Ready when you are');
  await alpha.page.getByRole('button', { name: 'Send', exact: true }).click();
  await bravo.page.getByText('Ready when you are').waitFor(); await host.page.getByText('Ready when you are').waitFor();
  pass('lobbyChatRelayed');
  await alpha.page.getByRole('button', { name: 'Camera and mic', exact: true }).click();
  await host.page.waitForFunction(() => { const v = document.querySelector('video[aria-label="Player 2 camera"]'); return v?.readyState >= 2 && v.videoWidth > 0; }, null, { timeout: 30000 });
  pass('cameraToHost');
  for (const g of [alpha, bravo]) await H.ready(g);
  await host.page.getByRole('button', { name: 'Start match', exact: true }).and(host.page.locator(':enabled')).waitFor();
  await host.page.screenshot({ path: `${out}/2-host-lobby.png` });
  await bravo.page.screenshot({ path: `${out}/3-guest-lobby.png` });
  await host.page.setViewportSize({ width: 390, height: 844 });
  const mobile = await host.page.getByRole('dialog').evaluate(el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth }));
  assert.ok(mobile.scrollWidth <= mobile.width, JSON.stringify(mobile));
  await host.page.screenshot({ path: `${out}/4-host-lobby-mobile.png`, fullPage: true });
  await host.page.setViewportSize({ width: 1440, height: 900 });
  pass('mobileLobbyFits');

  // ---------------------------------------------------------------------------- a three-player match with an AI
  const beforeStart = Date.now();
  await H.startMatch(host, players);
  // Nothing of the introduction is left in Firestore once the match runs.
  await H.sleep(3000);
  assert.deepEqual((await H.firestoreDoc(`p2pMatches/${code}/joins`)).body.documents ?? [], [], 'join offers removed once players are seated');
  assert.equal((await H.firestoreDoc(`p2pMatches/${code}`)).status, 404, 'match removed when it starts');
  pass('matchmakingCleanedUp');
  await H.reachFrame(players, 100, 180000);
  const mcvs = [];
  for (const [i, p] of players.entries()) {
    mcvs.push(await H.deployMcv(p));
    await p.page.locator('canvas.stage').focus(); await p.page.keyboard.press('Enter');
    const composer = p.page.getByLabel('Room chat message'); await composer.waitFor();
    await composer.fill(`Commander ${i + 1} deployed`); await p.page.keyboard.press('Enter');
  }
  for (const p of pages) for (const i of [1, 2, 3]) await p.getByRole('log', { name: 'Chat messages' }).getByText(`Commander ${i} deployed`, { exact: true }).waitFor();
  pass('matchChatAllPlayers');
  await H.reachFrame(players, 400);
  let report = await H.syncReport(players);
  assert.deepEqual(report.errors.flat(), []);
  assert.equal(report.mismatch, null, `desync at frame ${report.mismatch}: ${JSON.stringify(report.mismatchHashes)}`);
  assert.ok(report.compared >= 300, `only ${report.compared} frames compared`);
  // Every world applied every player's deploy order: none of the three MCVs is left anywhere.
  assert.deepEqual(await Promise.all(pages.map(p => p.evaluate(ids => window.game.client.cur.actors.filter(a => ids.includes(a.id)).length, mcvs))), [0, 0, 0]);
  pass('allDeployOrdersApplied');
  // The match plays with an input delay the host chose from the pings; every player reads the same one.
  await matchBar(host).getByRole('button', { name: 'Connection details' }).click();
  const delay = await matchBar(host).locator('dt', { hasText: 'Orders run after' }).locator('xpath=following-sibling::dd').innerText();
  assert.match(delay, /^(80|120) ms$/, `players on one machine get the shortest delays: ${delay}`);
  await matchBar(host).getByRole('button', { name: 'Close details' }).click();
  pass('inputDelay', delay);
  pass('threePlayerSync', { frames: report.frames, compared: report.compared });
  receipt.checks.matchmakerWritesDuringPlay = firestoreWrites.filter(w => w.at > beforeStart + 10000).length;
  receipt.checks.worldStarts = await Promise.all(pages.map(p => p.evaluate(() => window.mp.worldStarts.map(e => e.transport))));
  for (const t of receipt.checks.worldStarts) assert.deepEqual(t, ['direct']);
  await host.page.screenshot({ path: `${out}/5-match-host.png` });
  await alpha.page.screenshot({ path: `${out}/6-match-guest.png` });

  if (website) {
    // Events reached the website, which counted them in Firestore as each signed-in player.
    const tallies = await Promise.all(players.map(p => counters(p.uid)));
    for (const t of tallies) assert.ok(t.matches >= 1, `match counted: ${JSON.stringify(t)}`);
    assert.ok(tallies[0].multiplayer >= 1, 'the host counted the multiplayer start');
    pass('eventsCountedPerPlayer', tallies);
    // In-match feedback goes to the website's feedback API as the player. The test website has no GitHub or mail
    // configured, so it must answer with its "could not be saved" error, which the dialog shows while keeping the note.
    await alpha.page.getByRole('button', { name: 'Feedback', exact: true }).click();
    await alpha.page.getByLabel('Your feedback', { exact: true }).fill('The lobby flow is great; the AI took a while to expand.');
    await alpha.page.getByRole('radio', { name: '4 of 5' }).click();
    await alpha.page.screenshot({ path: `${out}/6b-feedback.png` });
    await alpha.page.getByRole('button', { name: 'Send feedback', exact: true }).click();
    await alert(alpha, 'Feedback could not be saved');
    assert.equal(await alpha.page.getByLabel('Your feedback', { exact: true }).inputValue(), 'The lobby flow is great; the AI took a while to expand.');
    await alpha.page.getByRole('button', { name: 'Close feedback' }).click();
    pass('feedbackReachesWebsite');
  } else receipt.checks.website = 'not checked: set RTSAI_TEST_WEBSITE=1 with the website on this origin (events counted, feedback delivered)';

  // A guest closes the tab: the others are told at once that the player left, and every world stops.
  const closedAt = Date.now();
  await bravo.page.close();
  await alert(host, 'Player 3 left the match'); await alert(alpha, 'Player 3 left the match');
  assert.ok(Date.now() - closedAt < 8000, `told ${Date.now() - closedAt} ms after the tab closed: sooner than the 15 s silence check`);
  const stops = (await H.syncReport([host, alpha])).frames;
  await H.sleep(2000);
  assert.deepEqual((await H.syncReport([host, alpha])).frames, stops);
  await alpha.page.screenshot({ path: `${out}/7-stopped.png` });
  pass('leaveStopsEveryone');
  await toMenu([host, alpha]);
  pass('returnToMenu');

  // ------------------------------------------------------- a second match, the two players 100 ms apart
  for (const p of [host, alpha]) await p.page.evaluate(() => { window.mp.net.delay = 50; });
  const second = (await H.createMatch(host)).link;
  await H.joinMatch(alpha, second);
  await H.sleep(2500);   // the lobby measures the distance
  await H.ready(alpha);
  await resetWatch([host, alpha]);
  await H.startMatch(host, [host, alpha]);
  await H.reachFrame([host, alpha], 150);
  for (const p of [host, alpha]) await H.deployMcv(p);
  await H.sleep(12000);
  report = await H.syncReport([host, alpha], { sinceMs: 10000 });
  assert.deepEqual(report.errors.flat(), []); assert.equal(report.mismatch, null);
  // The game's speed is 25 frames a second. Waiting a round trip per frame gave 14.7 here; the input delay keeps it.
  assert.ok(Math.min(...report.speed) >= 19, `the match runs at ${report.speed} frames a second with a 100 ms ping`);
  pass('keepsSpeedAt100msPing', { framesPerSecond: report.speed, compared: report.compared });

  // The line is lost for four seconds: both players read whom the match waits for, then it goes on, still in step.
  for (const p of [host, alpha]) await p.page.evaluate(() => { window.mp.net.hold = true; });
  await matchBar(host).getByRole('status').filter({ hasText: 'Waiting for Player 2' }).waitFor({ timeout: 8000 });
  await matchBar(alpha).getByRole('status').filter({ hasText: 'Waiting for Player 1' }).waitFor({ timeout: 8000 });
  await alpha.page.screenshot({ path: `${out}/8-waiting.png` });
  const held = (await H.syncReport([host, alpha])).frames;
  for (const p of [host, alpha]) await p.page.evaluate(() => window.mp.release());
  await H.reachFrame([host, alpha], Math.max(...held) + 100);
  assert.equal(await matchBar(host).getByRole('status').count(), 0, 'the notice leaves when the match moves again');
  report = await H.syncReport([host, alpha]);
  assert.deepEqual(report.errors.flat(), []); assert.equal(report.mismatch, null);
  pass('shortDropSaysWhoAndRecovers', { heldAt: held, compared: report.compared });

  // The host quits from the game: the guest is told and stops. (Without the shim's ping: it holds the farewell back
  // in the page, past the moment the line closes, which no real network does to a message already sent.)
  for (const p of [host, alpha]) await p.page.evaluate(() => { window.mp.net.delay = 0; });
  await H.sleep(300);
  await host.page.evaluate(() => window.game.quit());
  await alert(alpha, 'host left');
  pass('hostQuitStopsGuest');
  await toMenu([alpha]);

  // ------------------------------------- a friend whose network can't reach the host directly (no relay exists)
  const third = (await H.createMatch(host)).link;
  for (const p of [host, alpha]) await p.page.evaluate(() => { window.mp.net.blocked = true; });
  await H.joinMatch(alpha, third, { wait: false });
  await alert(alpha, 'try another network', 60000);
  await alpha.page.screenshot({ path: `${out}/9-blocked-guest.png` });
  // The host's lobby says a friend did not get through, instead of only "Waiting for friends…".
  await host.page.getByRole('status').filter({ hasText: 'didn’t get through' }).waitFor({ timeout: 60000 });
  await host.page.screenshot({ path: `${out}/9-blocked-host.png` });
  pass('blockedNetworkExplainedToBoth');

  assert.deepEqual(players.flatMap(p => p.pageErrors), []);
  receipt.status = 'passed'; console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  receipt.status = 'failed'; receipt.error = String(error?.stack || error);
  receipt.pages = await H.diagnose(players, out);
  console.log(JSON.stringify(receipt, null, 2)); process.exitCode = 1;
} finally {
  receipt.errors = players.flatMap(p => p.pageErrors);
  fs.writeFileSync(`${out}/receipt.json`, JSON.stringify(receipt, null, 2)); await browser.close();
}
