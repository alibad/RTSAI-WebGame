// The Battle simulator's replay timeline in a real browser, on the real engine (docs/EDITOR-SIMULATOR.md, "Replay"):
// a battle runs while a player looks around like the owner did (pauses, pans away, comes back); at five moments the
// live game's own truth is written down (every unit's id, type, side, cell and health from the engine, and the score).
// Then the timeline is dragged to each moment, backwards and forwards and after the fight has ended, and the field
// must show exactly that moment: the same units in the same places, the score of that moment, the camera on them,
// and a timeline that does not grow while you look. Finally playing on from a past moment must carry on into the live
// game, and "Play from here" (when the page has it) must start a new battle from that moment's units.
//   node tools/static-serve.mjs --dir <a built page> --port 3640   (or any server with the page, runtime and data)
//   RTSAI_TEST_URL=http://127.0.0.1:3640/ node tools/replay-seek-browser-test.mjs
// RTSAI_TEST_SPEED sets the game speed while recording (default 2).
import fs from 'node:fs';
import { browserExecutable, browserArgs } from './browser-launch.mjs';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';

const base = process.env.RTSAI_TEST_URL || 'http://127.0.0.1:3640/';
const out = process.env.RTSAI_TEST_OUT || 'artifacts/replay-seek';
const speed = Number(process.env.RTSAI_TEST_SPEED || 2);
fs.mkdirSync(out, { recursive: true });

// The owner's fight on 20 Nov 2026 (Review inbox clip battles-england-iraq-dugin): 8 dug-in G.I.s and 2 Snipers of
// England hold against 12 Conscripts and 3 Tesla Troopers of Iraq on the open arena. England falls at about 0:28; the
// Iraqi survivors then walk west, off the screen the battle started on.
const col = (id, side, cells, extra) => cells.map(([u, v]) => ({ id, side, u, v, facing: side === 0 ? 768 : 256, ...extra }));
const setup = {
  fa: 'england', fb: 'iraq', map: 'web-arena', skill: 'normal', money: 0, fog: false, level: 0, health: 100,
  placements: [
    ...col('e1', 0, [[58, 65], [58, 67], [58, 69], [58, 71], [58, 73], [58, 75], [57, 69], [57, 71]], { order: 'hold', deploy: true }),
    ...col('snipe', 0, [[55, 69], [55, 71]], { order: 'hold' }),
    ...col('e2', 1, [[70, 65], [70, 67], [70, 69], [70, 71], [70, 73], [70, 75], [71, 65], [71, 67], [71, 69], [71, 71], [71, 73], [71, 75]], { order: 'engage' }),
    ...col('shk', 1, [[73, 68], [73, 70], [73, 72]], { order: 'engage' }),
  ],
};
const s64 = Buffer.from(JSON.stringify(setup)).toString('base64url');
// The moments (game ticks, 25 a second) where the truth is taken, and what the player does with the camera there.
// Not on a whole second, so the clock's rounding cannot blur which second a moment belongs to.
const MOMENTS = [
  { tick: 160, camera: 'look around, then back' },
  { tick: 460, camera: 'pan far east and stay there' },
  { tick: 710, camera: 'back to the battle' },
  { tick: 1210, camera: 'stay' },
  { tick: 1610, camera: 'stay' },
];
const END = 1700;

const browser = await chromium.launch({ executablePath: browserExecutable(), headless: process.env.RTSAI_TEST_HEADED !== '1', args: browserArgs() });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
await page.addInitScript(() => { try { localStorage.setItem('rtsai.mouseLock', '0'); } catch { /* no storage */ } });
page.setDefaultTimeout(180000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };
const fmt = (tick) => { const s = Math.floor(tick * 0.04); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

try {
  await page.goto(`${base}?profile=public&mode=sandbox&s=${s64}`);
  await page.waitForFunction(() => window.store?.getState().sandbox?.mode === 'edit' && window.store.getState().phase === 'playing' && window.store.getState().sandbox.units.length > 0);
  await page.waitForFunction(() => window.game.command({ cmd: 'placements' }).then((r) => r.spawns?.length === 25));
  await page.click('[data-testid="sim-fight"]');
  await page.waitForFunction(() => window.store.getState().sandbox?.mode === 'run' && window.store.getState().phase === 'playing' && (window.store.getState().ui?.tick ?? 0) > 0);
  await page.evaluate((s) => window.game.sandbox.setSpeed(s), speed);
  const home = await page.evaluate(() => [window.game.cam.x, window.game.cam.y]);

  // ---- The live battle: the truth at each moment, while the camera wanders like a player's.
  const truth = [];
  for (const m of MOMENTS) {
    await page.waitForFunction((t) => (window.store.getState().ui?.tick ?? 0) >= t, m.tick, { timeout: 240000, polling: 20 });
    const t = await page.evaluate(async () => {
      const g = window.game;
      g.sandbox.setPaused(true);
      // The pause answers with a snapshot of the tick it stopped on.
      const want = await new Promise((resolve) => { const t0 = performance.now(); const wait = () => (g.client.cur && performance.now() - t0 > 250 ? resolve(g.client.cur.header.tick) : setTimeout(wait, 30)); wait(); });
      const placed = await g.command({ cmd: 'placements' });
      const ui = window.store.getState().ui;
      return { tick: want, uiTick: ui?.tick, units: placed.spawns, sides: ui?.sandbox?.sides?.map((s) => [s.alive, s.total]) };
    });
    truth.push({ ...t, camera: m.camera });
    if (m.camera === 'look around, then back') {
      for (const [x, y] of [[1200, 600], [6000, 1500], [3000, 1800]]) { await page.evaluate(([x, y]) => window.game.lookAt(x, y), [x, y]); await page.waitForTimeout(150); }
      await page.evaluate(([x, y]) => window.game.lookAt(x, y), home);
    } else if (m.camera === 'pan far east and stay there') {
      await page.evaluate(() => window.game.lookAt(6800, 1100));
    } else if (m.camera === 'back to the battle') {
      await page.evaluate(([x, y]) => window.game.lookAt(x, y), home);
    }
    await page.waitForTimeout(200);
    await page.evaluate(() => window.game.sandbox.setPaused(false));
    console.log(`truth at tick ${t.tick} (${fmt(t.tick)}): ${t.units.length} units, score ${t.sides?.map((s) => s.join('/')).join(' vs ')}`);
  }
  await page.waitForFunction((t) => (window.store.getState().ui?.tick ?? 0) >= t, END, { timeout: 240000, polling: 50 });
  // England has fallen: the result screen. "Look at the battle" goes back to the field with its timeline.
  if (await page.locator('[data-testid="oc-look"]').count()) await page.click('[data-testid="oc-look"]');
  await page.waitForSelector('.rp-range');

  // ---- Seeking: backwards and forwards, the field must show the moment the timeline says.
  const lenAtStart = await page.evaluate(() => window.store.getState().sandbox.recordLen);
  for (const k of [4, 0, 3, 1, 2]) {
    const t = truth[k];
    const r = await page.evaluate(async (want) => {
      const g = window.game, sb = g.sandbox;
      const i = sb.recording.findIndex((s) => s.header.tick === want);
      if (i < 0) return { missing: true };
      // Drag the knob there, as a hand would (React listens to the input event).
      const input = document.querySelector('.rp-range');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(i));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 600));
      const frame = sb.replayFrame()?.[0];
      if (!frame) return { noFrame: true };
      const sideOf = (a) => { const p = frame.players[a.owner]; return !p || !(p.flags & 4) ? -1 : p.flags & 1 ? 0 : 1; };
      const shown = [];
      for (const a of frame.actors) {
        const side = sideOf(a);
        if (side < 0 || a.maxHp <= 0 || a.flags & 16) continue;
        const c = await g.command({ cmd: 'cellat', x: Math.round(a.sx), y: Math.round(a.sy) });
        shown.push({ id: a.id, type: g.client.str(a.type), side, u: c.u, v: c.v, health: Math.floor((100 * a.hp) / a.maxHp), sx: a.sx, sy: a.sy });
      }
      const [x0, y0, x1, y1] = g.viewRect();
      const onScreen = shown.filter((a) => a.sx >= x0 && a.sx <= x1 && a.sy >= y0 && a.sy <= y1).length;
      const score = [...document.querySelectorAll('.sim-score-alive')].map((e) => e.textContent.replace(/\s/g, ''));
      return { tick: frame.header.tick, shown, onScreen, score, time: document.querySelector('.rp-time')?.textContent ?? '' };
    }, t.tick);
    const label = `seek to ${fmt(t.tick)} (tick ${t.tick}, camera then: ${t.camera})`;
    if (r.missing || r.noFrame) { check(false, `${label}: the timeline has no such moment`); continue; }
    check(r.tick === t.tick, `${label}: the field shows tick ${r.tick}`);
    check(r.time.trim().startsWith(fmt(t.tick)), `${label}: the clock reads "${r.time.trim()}"`);
    const want = new Map(t.units.map((u) => [u.id, u]));
    const missing = t.units.filter((u) => !r.shown.some((s) => s.id === u.id));
    const extra = r.shown.filter((s) => !want.has(s.id));
    const moved = r.shown.filter((s) => { const u = want.get(s.id); return u && (u.type !== s.type || u.player !== s.side || Math.abs(u.x - s.u) > 1 || Math.abs(u.y - s.v) > 2 || Math.abs(u.health - s.health) > 1); });
    const show = (s) => { const u = want.get(s.id); return `${s.type}#${s.id} shown ${s.u},${s.v} ${s.health}% / then ${u?.x},${u?.y} ${u?.health}%`; };
    check(!missing.length && !extra.length && !moved.length,
      `${label}: units on the field match the live game then (${r.shown.length} shown, ${t.units.length} alive; missing ${missing.length}, extra ${extra.length}, misplaced ${moved.length}${moved.length ? `: ${moved.map(show).join('; ')}` : ''})`);
    const score = (t.sides ?? []).map(([a, n]) => `${a}/${n}`);
    check(JSON.stringify(r.score) === JSON.stringify(score), `${label}: the score shows ${r.score.join(' vs ')} (then: ${score.join(' vs ')})`);
    check(t.units.length === 0 || 2 * r.onScreen >= r.shown.length, `${label}: the camera is on the action (${r.onScreen} of ${r.shown.length} units on screen)`);
  }
  // Looking around while the replay is stopped must not lengthen the battle.
  for (const [x, y] of [[1000, 500], [5000, 1600], [2500, 900], [6500, 400]]) { await page.evaluate(([x, y]) => window.game.lookAt(x, y), [x, y]); await page.waitForTimeout(120); }
  const lenAfter = await page.evaluate(() => window.store.getState().sandbox.recordLen);
  check(lenAfter === lenAtStart, `looking around while stopped keeps the timeline's length (${lenAtStart} -> ${lenAfter} ticks)`);
  await page.screenshot({ path: `${out}/seek.png` });

  // ---- Playing on from a past moment reaches the live game, which carries on.
  const live = await page.evaluate(async (want) => {
    const g = window.game, sb = g.sandbox;
    sb.setSpeed(8);
    sb.scrub(sb.recording.findIndex((s) => s.header.tick === want));
    const stopped = sb.recording.at(-1).header.tick;
    document.querySelector('.rp-play').click();
    const t0 = performance.now();
    while (performance.now() - t0 < 60000 && (sb.state.replay !== null || (window.store.getState().ui?.tick ?? 0) < stopped + 50)) await new Promise((r) => setTimeout(r, 200));
    return { replay: sb.state.replay, stopped, tick: window.store.getState().ui?.tick ?? 0 };
  }, truth[3].tick);
  check(live.replay === null && live.tick >= live.stopped + 50, `play from ${fmt(truth[3].tick)} runs into the live game and on (stopped at tick ${live.stopped}, now ${live.tick})`);

  // ---- Play from here (when the page has it): a new battle from the moment's units.
  const hasPlayFromHere = await page.locator('[data-testid="sim-play-from-here"]').count();
  if (hasPlayFromHere) {
    const t = truth[1];
    // Dug in at that moment: a G.I. whose body sequence is empty stands behind its sandbags (Snapshot.cs).
    const before = await page.evaluate((want) => {
      const g = window.game, sb = g.sandbox; sb.setPaused(true);
      // The new battle is looked at in its first ticks, at normal speed (the units fight from the first tick).
      sb.setSpeed(1);
      sb.scrub(sb.recording.findIndex((s) => s.header.tick === want));
      const f = sb.replayFrame()[0];
      window.oldBattle = sb.recording[0];
      return f.actors.filter((a) => g.client.str(a.type) === 'e1' && !(a.flags & 16) && a.hp > 0 && !g.client.str(a.sequence)).length;
    }, t.tick);
    await page.click('[data-testid="sim-play-from-here"]');
    // The new battle's own ticks (the old one's state lasts while the new one is being laid out).
    await page.waitForFunction(() => { const sb = window.game.sandbox; return sb.state.mode === 'run' && sb.recording.length >= 4 && sb.recording[0] !== window.oldBattle && window.game.client.cur; }, null, { timeout: 120000, polling: 10 });
    // The new battle's first tick (the fight resumes at once: a unit at 7% can fall in the next few).
    const next = await page.evaluate(async () => {
      const g = window.game, sb = g.sandbox; sb.setPaused(true);
      const first = sb.recording[0], third = sb.recording[2];
      const sideOf = (f, a) => { const p = f.players[a.owner]; return !p || !(p.flags & 4) ? -1 : p.flags & 1 ? 0 : 1; };
      const roster = (f) => f.actors.filter((a) => sideOf(f, a) >= 0 && a.maxHp > 0 && !(a.flags & 16)).map((a) => `${g.client.str(a.type)}/${sideOf(f, a)}`).sort();
      const deployed = third.actors.filter((a) => g.client.str(a.type) === 'e1' && !(a.flags & 16) && a.hp > 0 && !g.client.str(a.sequence)).length;
      const lostE1 = roster(first).filter((k) => k === 'e1/0').length - roster(third).filter((k) => k === 'e1/0').length;
      const s = new URL(location.href).searchParams.get('s');
      const link = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
      return { tick: first.header.tick, roster: roster(first), deployed, lostE1, linkDeployed: link.placements.filter((p) => p.id === 'e1' && p.deploy).length, href: location.href };
    });
    const want = t.units.map((u) => `${u.type}/${u.player}`).sort();
    check(JSON.stringify(next.roster) === JSON.stringify(want), `play from ${fmt(t.tick)}: the new battle starts (tick ${next.tick}) with that moment's ${want.length} units (${next.roster.length} there)`);
    check(next.linkDeployed === before && next.deployed + next.lostE1 >= before, `play from ${fmt(t.tick)}: the G.I.s dug in then are dug in again (${before} then; ${next.linkDeployed} in the setup, ${next.deployed} dug in at tick 3)`);
    check(/[?&]mode=sandbox/.test(next.href) && /[?&]s=/.test(next.href), 'play from here: the address is a link to the new battle');
    // The link, opened afresh, lays the battle out in a paused setup: every unit's cell, health and rank, exactly.
    const same = (a, b) => a.type === b.type && a.player === b.player && Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 2;
    await page.goto(next.href);
    await page.waitForFunction(() => window.store?.getState().sandbox?.mode === 'edit' && window.store.getState().phase === 'playing' && window.store.getState().sandbox.units.length > 0);
    await page.waitForTimeout(1500);
    const opened = await page.evaluate(() => window.game.command({ cmd: 'placements' }).then((r) => r.spawns));
    const left = [...opened];
    // Two infantrymen sharing a cell then: the engine places one per cell, so the second stands on the nearest free cell
    // (docs/EDITOR-SIMULATOR.md, "Not carried"): up to two cells off.
    const shared = (u) => t.units.some((o) => o !== u && o.x === u.x && o.y === u.y);
    const near = (u, n) => same(u, n) || (shared(u) && u.type === n.type && u.player === n.player && Math.abs(u.x - n.x) <= 2 && Math.abs(u.y - n.y) <= 4);
    // Exact matches first, so a unit that kept its cell is not taken by a moved neighbour.
    const gone = [...t.units].sort((a, b) => shared(a) - shared(b)).filter((u) => { const i = left.findIndex((n) => near(u, n) && Math.abs(u.health - n.health) <= 2 && u.level === n.level); if (i < 0) return true; left.splice(i, 1); return false; });
    check(opened.length === t.units.length && !gone.length, `play from here: its link lays out the same ${t.units.length} units with their cells, health and ranks (${opened.length} laid out, ${gone.length} not matched${gone.length ? `: ${gone.map((u) => `${u.type} ${u.x},${u.y} ${u.health}%`).join('; ')}` : ''})`);
  } else {
    check(false, 'play from here: no "Play from here" button on the timeline');
  }

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
}
if (failures.length) {
  console.log(`\n${failures.length} replay check(s) failed.`);
  process.exit(1);
}
console.log('\nReplay checks passed: every moment shows its own units, score and camera; the timeline keeps its length; playing on reaches the live game; play from here starts that moment.');
