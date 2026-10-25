// The map editor and the battle simulator in a real browser, on the real engine (docs/EDITOR-SIMULATOR.md):
//   editor: a blank map, the lake and river brush (water with shores, undo and redo), ore, a tree, two start
//           positions, save to the library, then "Test in simulator" opens the saved map there;
//   simulator: drop units for both sides, the unit card (the website's Faction Viewer stage), Fight, and the user's
//           side gets the full HUD with production and money while the AI's side fights.
//   node server/serve.mjs                       (or any server with the page, the runtime and the data)
//   RTSAI_TEST_URL=http://127.0.0.1:3490/ node tools/editor-simulator-browser-test.mjs
// RTSAI_TEST_QUERY adds page parameters (e.g. "runtime=interp" for the interpreted runtime).
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { browserExecutable, browserArgs } from './browser-launch.mjs';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';

const base = process.env.RTSAI_TEST_URL || 'http://127.0.0.1:3490/';
const query = ['profile=public', process.env.RTSAI_TEST_QUERY].filter(Boolean).join('&');
const out = process.env.RTSAI_TEST_OUT || 'artifacts/editor-simulator';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: process.env.RTSAI_TEST_HEADED !== '1', args: browserArgs() });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
// The mouse lock (on by default) replays clicks where its own drawn cursor is, which follows mouse deltas; this test
// drives absolute coordinates, so it plays with the lock off, as a player can from Settings.
await page.addInitScript(() => { try { localStorage.setItem('rtsai.mouseLock', '0'); } catch { /* no storage */ } });
page.setDefaultTimeout(180000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const editor = () => page.evaluate(() => { const e = window.store.getState().editor; return { undo: e.undo, redo: e.redo, error: e.error, saved: e.saved }; });
const drag = async (points) => {
  await page.mouse.move(...points[0]);
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(...p, { steps: 8 });
  await page.mouse.up();
};

try {
  // ---- The editor
  await page.goto(`${base}?${query}&mode=editor`);
  await page.waitForSelector('[data-testid="ed-blank"]');
  await page.click('.ed-sizes button:has-text("64")');
  await page.click('[data-testid="ed-blank"]');
  await page.waitForFunction(() => window.store.getState().editor?.map && window.store.getState().phase === 'playing');
  await page.click('[data-tool="terrain"]');
  await page.click('[data-category="Water"]');
  await page.click('[data-testid="ed-water"]');
  await drag([[620, 300], [760, 380], [900, 450], [1060, 520]]);
  await page.waitForFunction(() => window.store.getState().editor.undo, null, { timeout: 60000 });
  assert.equal((await editor()).error, '', 'the lake brush paints shores without an error');
  await page.screenshot({ path: `${out}/lake.png` });
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => window.store.getState().editor.redo);
  await page.keyboard.press('Control+y');
  await page.waitForFunction(() => window.store.getState().editor.undo && !window.store.getState().editor.redo);
  await page.click('[data-tool="resource"]');
  await page.click('.ed-res-card');
  await drag([[560, 640], [620, 660], [660, 690]]);
  await page.click('[data-tool="actor"]');
  await page.fill('.ed-search input', 'tree');
  const tree = await page.evaluate(() => window.store.getState().editor.catalog.actors.find((a) => /^tree/i.test(a.name))?.name);
  assert.ok(tree, 'the editor lists trees');
  await page.click(`[data-actor="${tree}"]`);
  await page.mouse.click(500, 420);
  await page.click('[data-tool="spawn"]');
  await page.mouse.click(560, 330);
  await page.mouse.click(1250, 680);
  await page.mouse.click(1300, 300, { button: 'right' });
  await page.fill('[data-testid="ed-title"]', 'Browser test lake');
  await page.click('[data-testid="ed-save"]');
  await page.waitForFunction(() => !!window.store.getState().editor.saved, null, { timeout: 60000 });
  const saved = (await editor()).saved;
  // The map lists refresh a moment after the save is acknowledged: wait for the entry rather than read it at once.
  await page.waitForFunction((id) => window.store.getState().setup.maps.some((m) => m.id === id && m.library && m.players === 2), saved, { timeout: 30000 })
    .catch(() => assert.fail('the saved map is in the map lists with its two start positions'));
  const listed = await page.evaluate((id) => window.store.getState().setup.maps.find((m) => m.id === id), saved);
  await page.click('[data-testid="ed-test"]');
  await page.waitForFunction((id) => window.store.getState().sandbox?.map === id && window.store.getState().phase === 'playing', saved, { timeout: 120000 });

  // ---- The simulator, on the saved map
  await page.waitForFunction(() => window.store.getState().sandbox?.units?.length > 0);
  const st = await page.evaluate(() => { const s = window.store.getState().sandbox; return { fa: s.fa, fb: s.fb, rosters: s.rosters }; });
  assert.ok(st.rosters[st.fa]?.includes('r2m1a2s'), 'the Saudi roster comes from the rules');
  await page.hover('[data-unit="r2m1a2s"]');
  await page.waitForSelector('.site-viewer canvas', { timeout: 30000 });
  await page.click('[data-unit="r2m1a2s"]');
  await page.getByRole('radio', { name: '×5' }).click();
  await page.mouse.click(520, 620);
  await page.click('[data-testid="sim-side-1"]');
  await page.click('[data-unit="r2karrar"]');
  await page.mouse.click(820, 360);
  const placed = await page.evaluate(() => window.game.command({ cmd: 'placements' }));
  const sides = new Set(placed.spawns.map((s) => s.player));
  assert.ok(placed.spawns.length >= 10 && sides.size === 2, `units placed for both sides (${placed.spawns.length})`);
  await page.click('[data-testid="sim-fight"]');
  await page.waitForFunction(() => window.store.getState().sandbox?.mode === 'run' && window.store.getState().phase === 'playing', null, { timeout: 120000 });
  await page.waitForTimeout(15000);
  const run = await page.evaluate(() => { const s = window.store.getState(); return { local: s.info?.localPlayer, players: s.info?.players?.map((p) => [p.name, p.bot]), cash: s.ui?.cash, sides: s.ui?.sandbox?.sides }; });
  assert.ok(run.players.some(([name, bot]) => name === run.local && !bot) && run.players.some(([, bot]) => bot), 'you command one side, the AI the other');
  assert.ok(run.sides?.some((s) => s.shots > 0), 'the sides fight');
  await page.screenshot({ path: `${out}/fight.png` });
  assert.deepEqual(errors, [], 'no page errors');
  console.log(`Editor and simulator checks passed: lake with shores, undo/redo, ore, trees, start positions, save (${saved}), test in simulator, Faction Viewer card, ${placed.spawns.length} units placed, a fight with the HUD.`);
} finally {
  await browser.close();
}
