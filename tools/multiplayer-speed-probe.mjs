// How fast a multiplayer match really runs when the players are a given ping apart. Two (or more) browser contexts
// play one match on this machine; every message a page sends on the direct line is held back by half the ping (the
// harness's network shim), which is what distance does to a reliable ordered channel. The game's own speed is 25
// frames a second: the probe reports what the match reached, and that every frame's SyncHash agreed.
//   RTSAI_TEST_URL=... RTSAI_FIRESTORE_EMULATOR=... node tools/multiplayer-speed-probe.mjs [--pings 0,60,120,200] [--players 2] [--seconds 40] [--jitter 0]
import fs from 'node:fs';
import { launch, openPlayer, signIn, atMenu, createMatch, joinMatch, ready, startMatch, syncReport, deployMcv, diagnose, lineBytes, sleep } from './multiplayer-harness.mjs';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const pings = opt('pings', '0,60,120,200').split(',').map(Number), count = Number(opt('players', 2)), seconds = Number(opt('seconds', 40)), jitter = Number(opt('jitter', 0));
const browser = await launch();
const rows = [], players = [], out = 'artifacts/multiplayer-speed';
fs.mkdirSync(out, { recursive: true });
try {
  for (let i = 0; i < count; i++) players.push(await openPlayer(browser, { name: `Player ${i + 1}`, viewport: { width: 1280, height: 720 } }));
  await Promise.all(players.map(p => signIn(p)));
  await Promise.all(players.map(p => atMenu(p)));
  const [host, ...guests] = players;
  for (const ping of pings) {
    for (const p of players) await p.page.evaluate(([delay, jitter]) => { Object.assign(window.mp.net, { delay, jitter }); window.mp.frames = []; window.mp.errors = []; window.mp.hashes = {}; }, [ping / 2, jitter]);
    const { link } = await createMatch(host);
    if (count > 2) await host.page.evaluate(() => { const s = window.store.getState().setup; return s.maps.find(m => m.slots.length >= 4).id; }).then(async id => { const { chooseLobbyOption } = await import('./lobby-picker.mjs'); await chooseLobbyOption(host.page, 'Multiplayer map', id); });
    for (const g of guests) { await joinMatch(g, link); }
    for (const g of guests) await ready(g);
    await startMatch(host, players);
    await sleep(4000);
    for (const p of players) await deployMcv(p);
    const before = await Promise.all(players.map(lineBytes));
    await sleep(seconds * 1000);
    const report = await syncReport(players, { sinceMs: (seconds - 2) * 1000 });
    // What the direct line carried per player, in kilobytes a second (sent, received): what a relay would have to pass on.
    const after = await Promise.all(players.map(lineBytes));
    const line = after.map((a, i) => [+((a.sent - before[i].sent) / seconds / 1000).toFixed(1), +((a.received - before[i].received) / seconds / 1000).toFixed(1)]);
    rows.push({ ping, jitter, speed: report.speed, percent: report.speed.map(s => Math.round(s / 25 * 100)), frames: report.frames, compared: report.compared, mismatch: report.mismatch, errors: report.errors.flat(), kilobytesPerSecond: line });
    console.log(JSON.stringify(rows.at(-1)));
    // Back to the menu for the next round.
    await host.page.evaluate(() => window.game.quit());
    for (const p of players) {
      await p.page.getByRole('button', { name: 'Return to menu', exact: true }).click({ timeout: 15000 }).catch(() => {});
      await p.page.waitForFunction(() => window.store.getState().phase === 'setup');
    }
    await sleep(1500);
  }
  console.log(JSON.stringify({ players: count, seconds, rows }, null, 1));
} catch (error) {
  console.log(JSON.stringify({ error: String(error?.stack || error), rows, pages: await diagnose(players, out) }, null, 1)); process.exitCode = 1;
} finally { await browser.close(); }
