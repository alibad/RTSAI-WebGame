// Random maps and local saves in both games, in a real browser against a static page (tools/static-serve.mjs or the
// public build): the engine's own map generator makes a map in the page (game.generateMap, as the map editor and the
// multiplayer lobby make theirs; no map service), a match on it is saved on this device, resumed and replayed, and a
// save from the other game is listed under that game's name and reopens in it (ui/MatchLibrary.tsx openInGame: the
// page reloads into the save's profile, as the main menu's game tiles do, and App.tsx resumes the match there).
//   RTSAI_TEST_URL=http://127.0.0.1:3507/ RTSAI_TEST_OUT=artifacts/map-modes node tools/map-modes-browser-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
import { browserExecutable, browserArgs } from './browser-launch.mjs';
const base = process.env.RTSAI_TEST_URL || 'http://127.0.0.1:3507/';
const out = path.resolve(process.env.RTSAI_TEST_OUT || 'artifacts/map-modes');
fs.mkdirSync(out, { recursive: true });
/** The games as players know them (MatchLibrary.tsx gameName) and their `game` query value (MainMenu.tsx chooseMode). */
const GAME = { public: { name: 'Red Alert 2', query: 'isometric' }, 'public-classic': { name: 'Classic', query: 'classic' } };
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true, args: browserArgs() });
const receipt = { source: "The engine's own map generator in the page (no map service); saves in this browser's localStorage", modes: [] };
try {
  for (const [mode, profile] of [['classic', 'public-classic'], ['isometric', 'public']]) {
    const other = profile === 'public' ? 'public-classic' : 'public';
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`${base}?profile=${profile}&runtime=aot&private=0`);
    await page.waitForFunction(() => ['setup', 'error'].includes(window.store?.getState().phase), null, { timeout: 240000 });
    assert.equal(await page.evaluate(() => window.store.getState().phase), 'setup', await page.evaluate(() => window.store.getState().error));
    // A random map from the engine's generator joins this game's map list (game.ts mapGenerated) with the request that
    // made it: the generator's own size for two players, as the editor and the lobby ask for it (a 48-cell map, its
    // smallest, cannot always seat two players in its eight attempts).
    const generated = await page.evaluate(async () => {
      const id = await window.game.generateMap({ seed: 606, players: 2, terrain: 'random' });
      const m = window.store.getState().setup.maps.find(x => x.id === id);
      return m ? { id, title: m.title, landscape: m.landscape, players: m.players, generated: m.generated, slots: m.slots, gen: m.gen } : { id };
    });
    assert.ok(generated.generated && generated.slots?.length === 2 && generated.gen, `generated map mounted: ${JSON.stringify(generated)}`);
    const scenario = await page.evaluate(id => {
      const s = window.store.getState().setup, map = s.maps.find(m => m.id === id);
      return { map: id, seed: 606, players: [{ slot: map.slots[0], faction: s.factions.find(f => !f.random).id, color: '2A6FDB' }], options: { startingcash: '10000', fog: 'True', explored: 'False' } };
    }, generated.id);
    await page.evaluate(s => window.game.start(JSON.stringify(s)), scenario);
    await page.waitForFunction(() => window.store.getState().phase === 'playing' && window.store.getState().ui?.tick > 30, null, { timeout: 180000 });
    // Deploy the MCV so the save holds orders (Red Alert 2's construction yard is gacnst, Classic's is fact).
    await page.evaluate(() => { const g = window.game, c = g.client.cur, m = c.actors.find(a => a.owner === c.header.localPlayer && g.client.str(a.type).includes('mcv')); if (!m) throw Error('Generated map has no local MCV'); g.select([m.id]); });
    await page.waitForTimeout(200); await page.evaluate(() => window.game.command({ cmd: 'deploy' }));
    await page.waitForFunction(() => window.game.client.cur.actors.some(a => ['gacnst', 'fact'].includes(window.game.client.str(a.type))), null, { timeout: 30000 });
    await page.getByRole('button', { name: 'Saves & replays', exact: true }).click();
    await page.getByRole('button', { name: 'Save current match', exact: true }).click();
    await page.getByText('Match saved on this device.', { exact: true }).waitFor();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('rtsai.local-matches.v1'))[0]);
    assert.equal(saved.profile, profile); assert.ok(saved.tick > 0 && saved.identity && saved.log); assert.ok(Object.keys(saved.log.packets).length > 0); assert.ok(saved.log.hashes.some(h => h !== 0));
    // A save on a random map carries the map's files (sim/worker.ts record), so it opens again after a reload or in the other game.
    assert.ok(saved.mapFiles?.['map.yaml'] && saved.mapFiles?.['map.bin'], 'the save carries the generated map');
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForFunction(tick => window.store.getState().phase === 'playing' && window.store.getState().ui?.tick >= tick, saved.tick, { timeout: 180000 });
    await page.getByRole('button', { name: 'Saves & replays', exact: true }).click();
    await page.getByRole('button', { name: 'Replay', exact: true }).click();
    await page.waitForFunction(() => window.store.getState().phase === 'playing' && JSON.parse(window.game.scenarioJson).webReplay?.readonly, null, { timeout: 180000 });
    await page.getByRole('button', { name: 'Play', exact: true }).click(); await page.waitForFunction(tick => window.store.getState().ui?.tick >= Math.min(tick, 20), saved.tick, { timeout: 30000 });
    const replayTick = await page.evaluate(() => window.store.getState().ui?.tick);
    await page.screenshot({ path: path.join(out, `${mode}-generated-replay.png`) });
    await page.evaluate(() => window.game.quit());
    await page.waitForFunction(() => window.store.getState().phase === 'setup');
    // The other game: the random map is not in its list, and the save is listed under its own game's name. Resume
    // reopens it there: the page reloads into the save's profile and resumes the match where it was saved.
    await page.goto(`${base}?profile=${other}&runtime=aot&private=0`);
    await page.waitForFunction(() => window.store.getState().phase === 'setup', null, { timeout: 240000 });
    assert.equal(await page.evaluate(id => window.store.getState().setup.maps.some(m => m.id === id), generated.id), false, 'a random map belongs to the game that made it');
    await page.getByRole('button', { name: 'Saves & replays', exact: true }).click();
    const tag = page.locator('.lib-card .lib-tag');
    await tag.waitFor();
    assert.equal(await tag.textContent(), GAME[profile].name);
    assert.equal(await tag.getAttribute('title'), `Resume and Replay switch to ${GAME[profile].name}`);
    await page.screenshot({ path: path.join(out, `${mode}-save-listed-in-${other}.png`) });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForURL(u => u.searchParams.get('profile') === profile && u.searchParams.get('game') === GAME[profile].query, { timeout: 120000 });
    await page.waitForFunction(({ profile, tick }) => { const s = window.store?.getState(); return !!s && (s.phase === 'error' || (s.phase === 'playing' && s.profile === profile && (s.ui?.tick ?? 0) >= tick)); }, { profile, tick: saved.tick }, { timeout: 300000 });
    const resumed = await page.evaluate(() => { const s = window.store.getState(), sc = JSON.parse(window.game.scenarioJson || '{}'); return { phase: s.phase, error: s.error, profile: s.profile, tick: s.ui?.tick, map: sc.map, readonly: sc.webReplay?.readonly }; });
    assert.equal(resumed.phase, 'playing', resumed.error);
    assert.equal(resumed.profile, profile); assert.equal(resumed.map, generated.id); assert.equal(resumed.readonly, false);
    await page.screenshot({ path: path.join(out, `${mode}-resumed-from-${other}.png`) });
    await page.evaluate(() => window.game.quit());
    assert.deepEqual(errors, []);
    receipt.modes.push({ mode, profile, generated, savedTick: saved.tick, recordedOrderFrames: Object.keys(saved.log.packets).length, recordedHashes: saved.log.hashes.length, saveIdentity: saved.identity, replayTick,
      crossGame: { listedAs: GAME[profile].name, resumedIn: resumed.profile, tick: resumed.tick }, errors });
    await context.close();
  }
  receipt.passed = true; console.log('PASS both games: random map made in the page, local save/resume/replay, and a save reopening in its own game from the other');
} catch(error) { receipt.error=String(error); throw error; } finally { fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); await browser.close(); }
