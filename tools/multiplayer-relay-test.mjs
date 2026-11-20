// The multiplayer relay, end to end: a guest whose network lets nothing through but the relay (the harness's
// relayOnly: its browser may use relay routes only) joins a host, the line opens through Cloudflare's TURN relay with
// credentials from the website's relay function, and the match runs in step at full speed. Both players' connection
// details say the line is relayed. Then the same with both players behind relay-only networks.
// Needs the Firebase emulators WITH functions (RTSAI-Web functions/, its TURN_KEY_API_TOKEN in functions/.secret.local
// and TURN_KEY_ID in functions/.env.local, or the key id written into index.js), and a game build whose
// VITE_FIREBASE_EMULATOR_PORTS names the functions port ("<auth>,<firestore>,<functions>"):
//   RTSAI_TEST_URL=http://127.0.0.1:3607/play/ RTSAI_FIRESTORE_EMULATOR=127.0.0.1:3602 RTSAI_AUTH_EMULATOR=127.0.0.1:3601 \
//   RTSAI_RELAY_FUNCTION=http://127.0.0.1:3608/demo-rtsai/europe-west1/relay node tools/multiplayer-relay-test.mjs [--seconds 30]
// This crosses the real internet (this PC to Cloudflare and back): a real relay, not a simulated one. Without relay
// credentials it stops at the first check and says why.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as H from './multiplayer-harness.mjs';

const out = 'artifacts/multiplayer-relay';
fs.mkdirSync(out, { recursive: true });
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const seconds = Number(arg('seconds', 30));
const auth = process.env.RTSAI_AUTH_EMULATOR || '127.0.0.1:9099';
const relayFunction = process.env.RTSAI_RELAY_FUNCTION || 'http://127.0.0.1:5001/demo-rtsai/europe-west1/relay';
const receipt = { scope: 'Two same-machine Chromium contexts; the guest (then both) may use relay routes only, so every message crosses Cloudflare TURN', checks: {}, errors: [] };
const pass = (name, value = true) => { receipt.checks[name] = value; console.log(`PASS ${name}${value === true ? '' : ' ' + JSON.stringify(value)}`); };

// 1. The relay function hands a signed-in player credentials (the same call the page makes).
const signedIn = await fetch(`http://${auth}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: `relay-check-${Date.now()}@test.dev`, password: 'test-password-1', returnSecureToken: true }) }).then(r => r.json());
const answer = await fetch(relayFunction, { method: 'POST', headers: { Authorization: `Bearer ${signedIn.idToken}` } });
const body = await answer.json().catch(() => ({}));
if (answer.status !== 200) {
  console.log(`The relay function answered ${answer.status} ${JSON.stringify(body)}: it has no relay key here, so there is nothing to test.`);
  process.exitCode = 2;
} else await run();

async function run() {
  const relayUrls = body.iceServers.filter(s => s.credential).flatMap(s => s.urls);
  assert.ok(relayUrls.length && relayUrls.every(u => /^turns?:/.test(u) && !/:53(\?|$)/.test(u)), 'relay addresses a browser can use');
  assert.ok(body.expires > Date.now() + 3 * 3600_000, 'credentials last hours');
  pass('relayFunctionGivesCredentials', { urls: relayUrls.length, hoursLeft: +((body.expires - Date.now()) / 3600_000).toFixed(1) });

  const browser = await H.launch();
  const players = [];
  async function match(name, hostNet, guestNet) {
    const host = await H.openPlayer(browser, { name: `${name}Host`, hostRoutesOnly: false, net: hostNet });
    const guest = await H.openPlayer(browser, { name: `${name}Guest`, hostRoutesOnly: false, net: guestNet });
    players.push(host, guest);
    await Promise.all([H.signIn(host), H.signIn(guest)]);
    await Promise.all([H.atMenu(host), H.atMenu(guest)]);
    const invite = await H.createMatch(host);
    const asked = Date.now();
    await H.joinMatch(guest, invite.link);
    const joinedIn = Date.now() - asked;
    await H.ready(guest);
    await H.startMatch(host, [host, guest]);
    await H.reachFrame([host, guest], 50);
    const started = Date.now(), before = await Promise.all([host, guest].map(H.lineBytes));
    await H.sleep(seconds * 1000);
    const report = await H.syncReport([host, guest], { sinceMs: (seconds - 5) * 1000 });
    const after = await Promise.all([host, guest].map(H.lineBytes)), took = (Date.now() - started) / 1000;
    const routes = await Promise.all([host, guest].map(H.lineRoutes));
    assert.deepEqual(report.errors.flat(), []); assert.equal(report.mismatch, null);
    assert.ok(Math.min(...report.speed) >= 22, `the relayed match runs at ${report.speed} frames a second`);
    // The players' own screens: Connection details names the relayed line.
    for (const [p, other] of [[host, 'Player 2'], [guest, 'Player 1']]) {
      const bar = p.page.getByRole('region', { name: 'Multiplayer controls' });
      await bar.getByRole('button', { name: 'Connection details' }).click();
      await bar.getByText(other, { exact: true }).waitFor({ timeout: 10000 });
      await bar.getByText('goes through a relay server').waitFor();
      await p.page.screenshot({ path: `${out}/${name}-${p === host ? 'host' : 'guest'}-details.png` });
    }
    return {
      joinSeconds: +(joinedIn / 1000).toFixed(1), framesPerSecond: report.speed, compared: report.compared,
      routes: routes.map(r => r.map(x => `${x.local}->${x.remote}${x.relayProtocol ? ` (${x.relayProtocol})` : ''}`)),
      kBps: after.map((a, i) => ({ sent: +((a.sent - before[i].sent) / took / 1000).toFixed(1), received: +((a.received - before[i].received) / took / 1000).toFixed(1) })),
      host, guest,
    };
  }

  try {
    // 2. The guest's network lets only the relay through; the host's is an ordinary one.
    const one = await match('oneSide', {}, { relayOnly: true });
    assert.ok(one.routes[1].some(r => r.startsWith('relay->')), `the guest's line goes through the relay: ${one.routes[1]}`);
    assert.ok(one.routes[0].some(r => r.endsWith('->relay') || r.includes('->relay ')), `the host sees the guest's relay address: ${one.routes[0]}`);
    const { host: h1, guest: g1, ...oneFacts } = one;
    pass('guestBehindRelayOnlyNetworkPlays', oneFacts);
    for (const p of [h1, g1]) await p.context.close();

    // 3. Both networks let only the relay through: relay to relay.
    const both = await match('bothSides', { relayOnly: true }, { relayOnly: true });
    assert.ok(both.routes.every(side => side.some(r => r.startsWith('relay->relay'))), `relay to relay on both sides: ${both.routes}`);
    const { host: _h, guest: _g, ...bothFacts } = both;
    pass('bothBehindRelayOnlyNetworksPlay', bothFacts);

    assert.deepEqual(players.flatMap(p => p.pageErrors), []);
    receipt.status = 'passed';
  } catch (error) {
    receipt.status = 'failed'; receipt.error = String(error?.stack || error);
    receipt.pages = await H.diagnose(players.filter(p => !p.page.isClosed()), out).catch(e => String(e));
    process.exitCode = 1;
  } finally {
    receipt.errors = players.flatMap(p => p.pageErrors);
    console.log(JSON.stringify(receipt, null, 2));
    fs.writeFileSync(`${out}/receipt.json`, JSON.stringify(receipt, null, 2));
    await browser.close();
  }
}
