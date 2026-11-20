// Multiplayer on film: each player's browser window recorded while a scripted commander plays, then cut side by side
// (two players) or as a grid (three or four) with a caption for every step. Slow stretches are shown sped up and say
// so. Real pages, the real engine and real WebRTC between browser contexts on this machine (tools/multiplayer-harness.mjs);
// `--ping` holds every message back by half that many milliseconds, as distance would.
//   RTSAI_TEST_URL=... RTSAI_FIRESTORE_EMULATOR=... node tools/multiplayer-film.mjs --scenario happy --clips <dir> --work <dir>
//     [--id <clip id>] [--ping 0] [--minutes 10] [--build "<which build>"] [--keep-raw]
// Each run writes <clips>/<id>.mp4 (H.264) and adds its entry to <clips>/../clips.json.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { chooseLobbyOption } from './lobby-picker.mjs';
import * as H from './multiplayer-harness.mjs';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const scenarioName = opt('scenario', 'happy'), id = opt('id', `multiplayer-${scenarioName}`), ping = Number(opt('ping', 0)), minutes = Number(opt('minutes', 10));
const clips = path.resolve(opt('clips', 'artifacts/multiplayer-film/clips')), work = path.resolve(opt('work', 'artifacts/multiplayer-film/work'), id);
const build = opt('build', 'local build');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(clips, { recursive: true });
const { sleep } = H;
const log = (...a) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const t0 = performance.now(), epoch0 = Date.now();

// ---------------------------------------------------------------------------------------------------- the cut list

/** A film is a list of cuts on one clock: each has a caption and a speed, and ends where the next begins. */
const cuts = [];
const now = () => (performance.now() - t0) / 1000;
function cut(caption, speed = 1) { stop(); cuts.push({ start: now(), end: 0, caption, speed }); log(`CUT x${speed}: ${caption}`); }
/** Ends the current cut without starting another: what follows is left out of the film until the next cut(). */
function stop() { const last = cuts.at(-1); if (last && !last.end) last.end = now(); }

// ------------------------------------------------------------------------------------------------------ rendering

const FONT = 'C:/Windows/Fonts/segoeui.ttf', FONT_BOLD = 'C:/Windows/Fonts/segoeuib.ttf', BAND = 84;

/**
 * Cuts every player's recording into the film. Two players sit side by side (960x720 each); three or four in a
 * 2x2 grid (800x450 each). A player whose window closed is a dark pane from then on.
 */
function render(players, file, title) {
  const two = players.length <= 2, [pw, ph] = two ? [960, 720] : [800, 450], cols = 2, rows = two ? 1 : 2;
  const width = pw * cols, height = ph * rows + BAND;
  fs.copyFileSync(FONT, path.join(work, 'font.ttf')); fs.copyFileSync(FONT_BOLD, path.join(work, 'fontb.ttf'));
  const text = (name, value) => { fs.writeFileSync(path.join(work, name), value.replace(/%/g, '\\%')); return name; };
  const parts = [];
  for (const [k, c] of cuts.entries()) {
    const length = c.end - c.start;
    if (length < 0.4) continue;
    const args = ['-y', '-v', 'error'], filters = [];
    const panes = Array.from({ length: cols * rows }, (_, i) => players[i]);
    for (const [i, p] of panes.entries()) {
      const at = p ? c.start - p.videoStart : 0, live = p && p.video && (!p.closedAt || c.start < p.closedAt - 0.05);
      if (live) args.push('-ss', Math.max(0, at).toFixed(3), '-t', length.toFixed(3), '-i', p.video);
      else args.push('-f', 'lavfi', '-t', (length / c.speed).toFixed(3), '-i', `color=c=0x07090c:s=${pw}x${ph}:r=20`);
      // A recording that ends early (the window closed inside this cut) holds its last frame, dimmed by the note below.
      filters.push(live ? `[${i}:v]setpts=(PTS-STARTPTS)/${c.speed},fps=20,scale=${pw}:${ph},tpad=stop_mode=clone:stop_duration=${(length / c.speed).toFixed(3)},trim=duration=${(length / c.speed).toFixed(3)}[v${i}]`
        : `[${i}:v]drawtext=fontfile=font.ttf:textfile=${text(`gone-${k}-${i}.txt`, p ? `${p.label}: window closed` : '')}:x=(w-text_w)/2:y=(h-text_h)/2:fontsize=26:fontcolor=0x7d8876[v${i}]`);
    }
    const layout = two ? 'hstack=inputs=2' : `xstack=inputs=4:layout=0_0|${pw}_0|0_${ph}|${pw}_${ph}`;
    let chain = `${panes.map((_, i) => `[v${i}]`).join('')}${layout},pad=${width}:${height}:0:${BAND}:color=0x0d1014`;
    // The band: who each pane is (two players), the step, and the speed when it isn't real time.
    if (two) for (const [i, p] of players.entries()) chain += `,drawtext=fontfile=fontb.ttf:textfile=${text(`who-${i}.txt`, p.label)}:x=${i * pw + 24}:y=12:fontsize=22:fontcolor=0xf0806c`;
    else chain += `,drawtext=fontfile=fontb.ttf:textfile=${text('who.txt', players.map(p => p.label).join('   ·   '))}:x=24:y=12:fontsize=22:fontcolor=0xf0806c`;
    chain += `,drawtext=fontfile=font.ttf:textfile=${text(`cap-${k}.txt`, c.caption)}:x=24:y=44:fontsize=27:fontcolor=white`;
    if (c.speed !== 1) chain += `,drawtext=fontfile=fontb.ttf:textfile=${text(`speed-${k}.txt`, `shown at ${c.speed}x`)}:x=w-text_w-24:y=12:fontsize=22:fontcolor=0xe7b42f`;
    const part = `part-${String(k).padStart(2, '0')}.mp4`;
    execFileSync('ffmpeg', [...args, '-filter_complex', `${filters.join(';')};${chain}[out]`, '-map', '[out]', '-an', '-r', '20', '-c:v', 'libx264', '-crf', '27', '-preset', 'medium', '-pix_fmt', 'yuv420p', part], { cwd: work, stdio: 'inherit' });
    parts.push(part);
  }
  fs.writeFileSync(path.join(work, 'parts.txt'), parts.map(p => `file '${p}'`).join('\n'));
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', 'parts.txt', '-c', 'copy', '-movflags', '+faststart', '-metadata', `title=${title}`, file], { cwd: work, stdio: 'inherit' });
  const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());
  return { seconds: Math.round(seconds), megabytes: +(fs.statSync(file).size / 1048576).toFixed(1), size: `${width}x${height}` };
}

// ------------------------------------------------------------------------------------------------------ the players

const FPS = 20;
/**
 * Records a page to H.264 on the film's clock. Chromium's screencast stamps every picture with the time it was taken,
 * and each output frame shows the latest picture at its time (Playwright's own recorder gives every picture one frame,
 * so 60 pictures a second of battle stretch a minute to two and the players' recordings drift apart). Other browsers
 * are photographed about eight times a second.
 */
async function record(p, viewport) {
  const file = path.join(work, 'raw', `${p.label.replace(/\W+/g, '-').toLowerCase()}.mp4`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const encoder = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-vf', `scale=${viewport.width}:${viewport.height}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', file], { stdio: ['pipe', 'inherit', 'inherit'] });
  encoder.stdin.on('error', () => {});
  let first = 0, last = null, written = 0, on = true;
  // Holds the previous picture up to `at` (ms since the epoch), then takes the new one.
  const picture = (jpeg, at) => {
    if (!on) return;
    if (!first) { first = at; p.videoStart = (at - epoch0) / 1000; }
    for (const due = Math.floor((at - first) / 1000 * FPS); written < due && last; written++) encoder.stdin.write(last);
    if (jpeg) last = jpeg;
  };
  let stopCapture;
  if (p.kind === 'chromium') {
    const cdp = await p.context.newCDPSession(p.page);
    cdp.on('Page.screencastFrame', f => { picture(Buffer.from(f.data, 'base64'), f.metadata.timestamp * 1000); cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 2 });
    stopCapture = () => cdp.send('Page.stopScreencast').catch(() => {});
  } else {
    let running = true;
    (async () => { while (running) { const shot = await p.page.screenshot({ type: 'jpeg', quality: 75 }).catch(() => null); if (shot) picture(shot, Date.now()); await sleep(60); } })();
    stopCapture = async () => { running = false; };
  }
  p.video = file;
  p.stopRecording = async () => {
    await stopCapture();
    picture(null, Date.now()); if (last) encoder.stdin.write(last);
    on = false;
    await new Promise(resolve => { encoder.on('close', resolve); encoder.stdin.end(); });
  };
}

const browsers = {};
const players = [];
async function player(label, { kind = 'chromium', four = false } = {}) {
  browsers[kind] ??= await H.launch(kind);
  const viewport = four ? { width: 1280, height: 720 } : { width: 1200, height: 900 };
  const p = await H.openPlayer(browsers[kind], { name: label, viewport, net: { delay: ping / 2 } });
  Object.assign(p, { label, kind, videoStart: now(), closedAt: 0, video: '' });
  await record(p, viewport);
  players.push(p);
  return p;
}
/** Closes a player's window (as a player would close the tab) and keeps its recording. */
async function closeWindow(p) {
  if (p.closedAt) return;
  p.closedAt = now();
  await p.stopRecording().catch(e => log('recording', String(e)));
  await p.context.close().catch(() => {});
}
const ready = async list => { await Promise.all(list.map(p => H.signIn(p))); await Promise.all(list.map(p => H.atMenu(p))); };
const pick = (p, label, value) => chooseLobbyOption(p.page, label, value);
const sync = async (list = players.filter(p => !p.closedAt)) => H.syncReport(list, { sinceMs: 20000 });
const facts = {};

// ------------------------------------------------------------------------------------------------------- scenarios

/** From the lobby to a running match: the guests press Ready, the host starts, every world loads. */
async function lobbyToMatch(host, guests, all) {
  cut(`${guests.length > 1 ? 'The guests press' : 'Player 2 presses'} Ready`);
  for (const g of guests) { await H.ready(g); await sleep(900); }
  await sleep(1500);
  cut('Player 1 (the host) presses Start match, and the match loads on every screen');
  await H.startMatch(host, all);
  await H.reachFrame(all, 50);
}

/** Host creates a match; the guests join with its link. Not the film's subject here: the caller sets the speed. */
async function gather(host, guests, { map } = {}) {
  await host.page.getByRole('button', { name: 'Multiplayer', exact: true }).click(); await sleep(800);
  await host.page.getByRole('button', { name: 'Create match', exact: true }).click(); await H.lobby(host);
  const link = await host.page.getByLabel('Invite link').inputValue();
  if (map) {
    const id = await host.page.evaluate(([title, slots]) => { const maps = window.store.getState().setup.maps.filter(m => m.slots.length === slots); return (maps.find(m => new RegExp(title, 'i').test(m.title)) ?? maps[0]).id; }, [map.title, map.slots]);
    await pick(host, 'Multiplayer map', id); await sleep(1200);
  }
  for (const g of guests) { await H.joinMatch(g, link); await sleep(1200); }
  return link;
}
const alerts = async p => (await p.page.getByRole('alert').allInnerTexts().catch(() => [])).map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
/** Seconds until the player's screen shows an alert containing `text` (null: never within `limit` seconds). */
async function secondsUntilAlert(p, text, limit = 30) {
  const from = now();
  for (; now() - from < limit; await sleep(200)) if ((await alerts(p)).some(a => a.includes(text))) return +(now() - from).toFixed(1);
  return null;
}
/** A small base for everyone: power and a barracks, then infantry. Runs while the film rolls. */
const smallBase = list => Promise.all(list.map(async p => { await H.construct(p, /powr|power/); await H.construct(p, /pile|hand|barracks/); await H.train(p, 'Infantry', /./, 5); }));
const hold = list => Promise.all(list.map(p => p.page.evaluate(() => { window.mp.net.hold = true; })));
const release = list => Promise.all(list.map(p => p.page.evaluate(() => window.mp.release())));

const SCENARIOS = {
  /** Two players, menu to result screen: invite link, countries, map, a full match that one of them wins. */
  async happy() {
    const host = await player('PLAYER 1 · HOST'), guest = await player('PLAYER 2 · GUEST');
    await ready([host, guest]);
    cut('Both players are signed in and at the main menu');
    await sleep(3000);
    cut('Player 1 opens Multiplayer and creates a match');
    await host.page.getByRole('button', { name: 'Multiplayer', exact: true }).click(); await sleep(2500);
    await host.page.getByRole('button', { name: 'Create match', exact: true }).click(); await H.lobby(host); await sleep(2500);
    const link = await host.page.getByLabel('Invite link').inputValue();
    cut('Player 1 copies the invite link and sends it to a friend');
    await host.page.getByRole('button', { name: 'Copy invite', exact: true }).click(); await sleep(2500);
    cut('Player 2 opens Multiplayer, pastes the link and joins');
    await guest.page.getByRole('button', { name: 'Multiplayer', exact: true }).click(); await sleep(2000);
    await guest.page.getByLabel('Invite link or code').fill(link); await sleep(1500);
    await guest.page.getByRole('button', { name: 'Join match', exact: true }).click(); await H.lobby(guest); await sleep(3000);
    cut('Each player picks a country; the host picks the map');
    await pick(host, 'Player 1 faction', 'saudi'); await sleep(1500);
    await pick(guest, 'Player 2 faction', 'lebanon'); await sleep(1500);
    const maps = await host.page.evaluate(() => window.store.getState().setup.maps.filter(m => m.slots.length === 2).map(m => ({ id: m.id, title: m.title })));
    const map = maps.find(m => !/harbor/i.test(m.title)) ?? maps[0];
    await pick(host, 'Multiplayer map', map.id); await sleep(3500);
    facts.map = map.title;
    await lobbyToMatch(host, [guest], [host, guest]);
    await sleep(2500);

    cut('Both deploy their base. Player 1 will build an army; Player 2 a small base', 2);
    for (const p of [host, guest]) await H.deployMcv(p);
    await sleep(9000);
    const matchStart = now();
    cut('The match, shown sped up: every order one player gives appears on the other screen', 12);
    // Player 2: a power plant and a barracks, then some infantry. Player 1: power, refinery, factory, tanks.
    const small = (async () => { await H.construct(guest, /powr|power/); await H.construct(guest, /pile|hand|barracks/); await H.train(guest, 'Infantry', /./, 6); })();
    const power = await H.construct(host, /powr|power/); log('host power', power);
    const refinery = await H.construct(host, /refn|refiner/); log('host refinery', refinery);
    const barracks = await H.construct(host, /pile|hand|barracks/); log('host barracks', barracks);
    const factory = await H.construct(host, /weap|factory/); log('host factory', factory);
    await small;
    const tank = await H.train(host, 'Vehicle', /tank/, 8) ?? await H.train(host, 'Vehicle', /./, 8); log('host tanks', tank);
    facts.buildOrder = { power, refinery, barracks, factory, tank };
    // Until the planned match length, or eight tanks, whichever is later for the fight to matter.
    const tanks = async () => (await H.army(host)).filter(a => a.type === tank).length;
    while (now() - matchStart < minutes * 60 - 90 || (tank && await tanks() < 6 && now() - matchStart < minutes * 60 + 240)) await sleep(2000);
    const enemy = (await H.army(guest)).filter(a => a.building);
    facts.atAttack = { ...await sync(), tanks: tank ? await tanks() : 0, enemyBuildings: enemy.length };
    cut(`Minute ${Math.round((now() - matchStart) / 60)}: Player 1 sends the tanks into Player 2's base`, 4);
    const target = enemy[0] ?? (await H.army(guest))[0];
    await host.page.evaluate(([x, y]) => window.game.lookAt(x, y), [target.x, target.y]);
    await guest.page.evaluate(([x, y]) => window.game.lookAt(x, y), [target.x, target.y]);
    for (let wave = 0; wave < 60 && await H.outcome(guest) === 'Undefined'; wave++) {
      const left = (await H.army(guest)).filter(a => a.building);
      if (left.length && tank) await H.attackMove(host, [tank], [left[0].x, left[0].y]);
      await sleep(5000);
    }
    facts.sync = await sync();
    facts.outcomes = [await H.outcome(host), await H.outcome(guest)];
    cut('The result screens: one Victory, one Defeat, with the same match statistics');
    await sleep(9000);
    cut('Player 2 presses Continue and is back at the menu. What Player 1 sees then');
    await guest.page.getByRole('button', { name: 'Continue', exact: true }).click().catch(() => {});
    await sleep(7000);
    facts.afterContinue = { host: (await host.page.getByRole('alert').allInnerTexts().catch(() => [])).join(' | ').slice(0, 300) };
    stop();
  },

  /** Four players in two teams; then one of them closes the tab. */
  async four() {
    const all = [];
    for (const n of [1, 2, 3, 4]) all.push(await player(`PLAYER ${n}${n === 1 ? ' (HOST)' : ''}`, { four: true }));
    const [host, ...guests] = all;
    await ready(all);
    cut('Four signed-in players. Player 1 creates a match on a four-player map; the others join with one link', 2);
    await gather(host, guests, { map: { title: 'valley', slots: 4 } });
    cut('Countries and teams: Players 1 and 2 against Players 3 and 4', 2);
    for (const [i, faction] of ['saudi', 'turkey', 'china', 'lebanon'].entries()) { await pick(all[i], `Player ${i + 1} faction`, faction); await pick(all[i], `Player ${i + 1} team`, i < 2 ? 1 : 2); }
    await sleep(2000);
    facts.map = await host.page.locator('.mp-map-caption b').innerText().catch(() => '');
    await lobbyToMatch(host, guests, all);
    cut('All four deploy and build', 2);
    for (const p of all) await H.deployMcv(p);
    await sleep(8000);
    const matchStart = now();
    cut('Three minutes of play, sped up: four games in step', 12);
    await smallBase(all);
    while (now() - matchStart < 180) await sleep(2000);
    facts.sync = await sync();
    cut('Player 4 closes the browser tab. What the other three see');
    const closing = closeWindow(all[3]);
    facts.secondsUntilTold = await secondsUntilAlert(host, 'Player 4', 40);
    await closing;
    await sleep(6000);
    facts.afterLeave = Object.fromEntries(await Promise.all(all.slice(0, 3).map(async p => [p.label, await alerts(p)])));
    cut('The match is over for all of them: the only button is Return to menu');
    await host.page.getByRole('button', { name: 'Return to menu', exact: true }).click().catch(() => {});
    await sleep(5000);
    stop();
  },

  /** Two players and two AI opponents chosen in the lobby. */
  async ai() {
    const host = await player('PLAYER 1 · HOST'), guest = await player('PLAYER 2 · GUEST');
    await ready([host, guest]);
    cut('Player 1 creates a match on a four-player map and adds two AI opponents');
    await gather(host, [], { map: { title: 'valley', slots: 4 } });
    await sleep(1500);
    await host.page.getByRole('button', { name: 'Add AI', exact: true }).click(); await sleep(1200);
    await host.page.getByRole('button', { name: 'Add AI', exact: true }).click(); await sleep(1500);
    cut('Player 1 picks each AI\u2019s country, difficulty and team');
    await pick(host, 'AI 1 faction', 'iran'); await sleep(900);
    await pick(host, 'AI 1 difficulty', 'rush'); await sleep(900);
    await pick(host, 'AI 2 faction', 'israel'); await sleep(900);
    await pick(host, 'AI 1 team', 2); await pick(host, 'AI 2 team', 2); await sleep(1500);
    cut('Player 2 joins; the two players team up against the two AIs');
    const link = await host.page.getByLabel('Invite link').inputValue();
    await H.joinMatch(guest, link); await sleep(1500);
    await pick(host, 'Player 1 faction', 'saudi'); await pick(host, 'Player 1 team', 1);
    await pick(guest, 'Player 2 faction', 'turkey'); await pick(guest, 'Player 2 team', 1); await sleep(2500);
    await lobbyToMatch(host, [guest], [host, guest]);
    cut('Both players deploy. The AIs play on Player 1\u2019s computer and everyone sees the same battle', 2);
    for (const p of [host, guest]) await H.deployMcv(p);
    await sleep(8000);
    const matchStart = now();
    cut('Six minutes against the AIs, sped up', 16);
    const building = Promise.all([host, guest].map(async p => {
      await H.construct(p, /powr|power/); await H.construct(p, /refn|refiner/); await H.construct(p, /pile|hand|barracks/);
      await H.construct(p, /weap|factory/); await H.train(p, 'Infantry', /./, 8); await H.train(p, 'Vehicle', /tank/, 5);
    }));
    while (now() - matchStart < 360 && (await sync()).errors.flat().length === 0 && await H.outcome(host) === 'Undefined') await sleep(3000);
    await Promise.race([building, sleep(1000)]);
    facts.sync = await sync();
    facts.outcomes = [await H.outcome(host), await H.outcome(guest)];
    // What each world holds: the same actors, counted per owner.
    facts.actors = await Promise.all([host, guest].map(p => p.page.evaluate(() => window.game.client.cur.actors.length)));
    cut('Minute 6: the same battle on both screens');
    await sleep(8000);
    stop();
  },

  /** Chromium hosts, Firefox joins: two different browser engines in one match. */
  async browsers() {
    const host = await player('PLAYER 1 · CHROME (HOST)'), guest = await player('PLAYER 2 · FIREFOX', { kind: 'firefox' });
    await ready([host, guest]);
    cut('Player 1 plays in Chrome, Player 2 in Firefox. Chrome creates the match; Firefox joins with the link', 2);
    await gather(host, [guest]);
    await pick(host, 'Player 1 faction', 'china'); await pick(guest, 'Player 2 faction', 'yemen'); await sleep(2000);
    await lobbyToMatch(host, [guest], [host, guest]);
    cut('Both deploy and build', 2);
    for (const p of [host, guest]) await H.deployMcv(p);
    await sleep(8000);
    const matchStart = now();
    cut('Three minutes of play, sped up: two browser engines, one match', 10);
    await smallBase([host, guest]);
    while (now() - matchStart < 180) await sleep(2000);
    facts.sync = await sync();
    facts.browsers = [browsers.chromium.version(), browsers.firefox.version()];
    cut('Minute 3: both browsers computed the same game');
    await sleep(6000);
    stop();
  },

  /** A player leaves mid-match: first the guest reloads the page, then (in a second match) the host closes the tab. */
  async leave() {
    const host = await player('PLAYER 1 · HOST'), guest = await player('PLAYER 2 · GUEST');
    await ready([host, guest]);
    cut('A match between two players is running', 3);
    const link = await gather(host, [guest]);
    await H.ready(guest); await H.startMatch(host, [host, guest]); await H.reachFrame([host, guest], 50);
    for (const p of [host, guest]) await H.deployMcv(p);
    await sleep(12000);
    cut('Player 2 reloads the page by accident (F5). What each player sees');
    const reloading = guest.page.reload();
    facts.secondsUntilHostTold = await secondsUntilAlert(host, 'Player 2', 40);
    await reloading.catch(() => {});
    await H.atMenu(guest).catch(() => {});
    await sleep(4000);
    facts.hostAfterGuestLeft = await alerts(host);
    cut('Player 2 is back at the menu and tries the same invite again');
    await H.joinMatch(guest, link, { wait: false });
    facts.rejoin = (await secondsUntilAlert(guest, 'invite', 20)) === null ? [] : await alerts(guest);
    await sleep(5000);
    cut('They start over: a new match', 3);
    await host.page.getByRole('button', { name: 'Return to menu', exact: true }).click(); await host.page.waitForFunction(() => window.store.getState().phase === 'setup');
    await guest.page.getByRole('button', { name: 'Close multiplayer' }).click().catch(() => {});
    await gather(host, [guest]);
    await H.ready(guest); await H.startMatch(host, [host, guest]);
    await guest.page.evaluate(() => { window.mp.frames = []; });
    await H.reachFrame([guest], 50);
    for (const p of [host, guest]) await H.deployMcv(p);
    await sleep(12000);
    cut('This time Player 1, the host, closes the browser tab. What Player 2 sees');
    const closing = closeWindow(host);
    facts.secondsUntilGuestTold = await secondsUntilAlert(guest, 'host', 40);
    await closing;
    await sleep(6000);
    facts.guestAfterHostLeft = await alerts(guest);
    stop();
  },

  /** The line between the players drops: for 8 seconds, then for good; then it returns. */
  async drop() {
    const host = await player('PLAYER 1 · HOST'), guest = await player('PLAYER 2 · GUEST');
    const both = [host, guest];
    await ready(both);
    cut('A match between two players is running', 3);
    const link = await gather(host, [guest]);
    await H.ready(guest); await H.startMatch(host, both); await H.reachFrame(both, 50);
    for (const p of both) await H.deployMcv(p);
    await smallBase(both);
    await sleep(3000);
    cut('The connection between the players drops for 8 seconds. Nothing reaches the other side');
    await hold(both);
    const frozenAt = (await sync()).frames;
    await sleep(8000);
    facts.duringShortDrop = { frames: [frozenAt, (await sync()).frames], host: await alerts(host), guest: await alerts(guest),
      status: await Promise.all(both.map(p => p.page.getByRole('region', { name: 'Multiplayer controls' }).innerText().catch(() => ''))) };
    cut('The connection returns: the match goes on from where it stood');
    await release(both);
    await sleep(8000);
    facts.afterShortDrop = await sync();
    cut('It drops again and stays down. The game waits 15 seconds, then gives up');
    await hold(both);
    facts.secondsUntilStopped = await secondsUntilAlert(guest, 'onnection', 40);
    await sleep(5000);
    facts.afterLongDrop = { host: await alerts(host), guest: await alerts(guest) };
    cut('The connection is back. Player 2 tries to return to the match with the same invite');
    await release(both).catch(() => {});
    for (const p of both) { await p.page.getByRole('button', { name: 'Return to menu', exact: true }).click().catch(() => {}); await p.page.waitForFunction(() => window.store.getState().phase === 'setup').catch(() => {}); }
    await sleep(1500);
    await H.joinMatch(guest, link, { wait: false });
    facts.rejoin = (await secondsUntilAlert(guest, 'invite', 20)) === null ? [] : await alerts(guest);
    await sleep(6000);
    stop();
  },

  /** Two networks that cannot reach each other directly (no relay exists): what each player is told. */
  async blocked() {
    const host = await player('PLAYER 1 · HOST'), guest = await player('PLAYER 2 · GUEST');
    const both = [host, guest];
    await ready(both);
    cut('Player 1 creates a match and sends the invite', 2);
    await host.page.getByRole('button', { name: 'Multiplayer', exact: true }).click(); await sleep(800);
    await host.page.getByRole('button', { name: 'Create match', exact: true }).click(); await H.lobby(host);
    const link = await host.page.getByLabel('Invite link').inputValue();
    await sleep(2000);
    // From here neither browser can reach the other's addresses: what a strict network pair looks like to WebRTC.
    for (const p of both) await p.page.evaluate(() => { window.mp.net.blocked = true; });
    cut('Player 2 is on a network that cannot reach Player 1 directly, and joins');
    const from = now();
    await H.joinMatch(guest, link, { wait: false });
    await sleep(6000);
    cut('The game tries every route for 20 seconds', 3);
    facts.secondsUntilTold = await secondsUntilAlert(guest, 'onnect', 80);
    facts.waited = +(now() - from).toFixed(1);
    cut('Player 2 is told why. Player 1 is told nothing: the lobby still waits for friends');
    await sleep(9000);
    facts.guest = await alerts(guest);
    facts.host = (await host.page.getByRole('dialog').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400);
    stop();
  },

  /** Thirty seconds of real-speed play at --ping, for a before/after pair (see --compare). */
  async speed() {
    const host = await player('PLAYER 1 · HOST'), guest = await player('PLAYER 2 · GUEST');
    const both = [host, guest];
    await ready(both);
    await gather(host, [guest]);
    await pick(host, 'Player 1 faction', 'saudi'); await pick(guest, 'Player 2 faction', 'lebanon');
    await H.ready(guest); await H.startMatch(host, both); await H.reachFrame(both, 30);
    for (const p of both) await H.deployMcv(p);
    await sleep(6000);
    const order = H.construct(host, /powr|power/);
    cut(`The players are ${ping} ms apart. Player 1 builds a power plant: 40 seconds at real speed`);
    await sleep(40000);
    facts.sync = await H.syncReport(both, { sinceMs: 38000 });
    stop();
    await Promise.race([order, sleep(500)]);
  },
};

// ------------------------------------------------------------------------------------------------------------- run

let failure = null;
try {
  await SCENARIOS[scenarioName]();
} catch (error) {
  failure = String(error?.stack || error);
  log('FAILED', failure);
  facts.failure = failure.split('\n')[0];
  facts.pages = await H.diagnose(players.filter(p => !p.closedAt), work).catch(() => ({}));
} finally {
  stop();
  for (const p of players) facts.pageErrors = [...(facts.pageErrors ?? []), ...p.pageErrors];
  for (const p of players) await closeWindow(p).catch(e => log('close', String(e)));
  for (const b of Object.values(browsers)) await b.close().catch(() => {});
}
fs.writeFileSync(path.join(work, 'cuts.json'), JSON.stringify({ id, scenario: scenarioName, ping, cuts, facts, players: players.map(p => ({ label: p.label, video: p.video, videoStart: p.videoStart, closedAt: p.closedAt })) }, null, 1));
const file = path.join(clips, `${id}.mp4`);
const rendered = render(players, file, id);
log('rendered', file, JSON.stringify(rendered));
console.log(JSON.stringify({ id, file, ...rendered, ping, build, facts }, null, 1));
if (failure) process.exitCode = 1;
