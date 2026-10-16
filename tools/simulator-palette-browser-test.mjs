// Real simulator cards: full cameo labels, separate costs, and native drag placement.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
import { browserExecutable, browserArgs } from './browser-launch.mjs';

const base = process.env.RTSAI_TEST_URL || 'http://127.0.0.1:3490/';
const out = process.env.RTSAI_TEST_OUT || 'artifacts/simulator-palette';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: browserExecutable(), args: browserArgs(), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(180000);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${base}?profile=public&mode=simulator`);
  await page.waitForFunction(() => document.querySelectorAll('.sim-unit').length > 0
    && [...document.querySelectorAll('.sim-unit')].every(card => { const i = card.querySelector('img'); return i?.complete && i.naturalWidth > 0; }));
  // Includes an enlarged sidebar, matching the owner's zoomed screenshot.
  for (const width of [260, 340, 500]) {
    await page.evaluate(w => document.documentElement.style.setProperty('--sidebar-w', `${w}px`), width);
    const cards = await page.locator('.sim-unit').evaluateAll(nodes => nodes.map(node => {
      const r = node.getBoundingClientRect();
      const i = node.querySelector('img').getBoundingClientRect();
      const c = node.querySelector('.sim-cost').getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right,
        imageBottom: i.bottom, imageHeight: i.height, imageWidth: i.width, costTop: c.top, costBottom: c.bottom };
    }));
    for (const card of cards) {
      assert.ok(card.imageBottom <= card.costTop + .5, 'price does not cover the name strip');
      assert.ok(card.costBottom <= card.bottom + .5, 'the whole price fits inside its card');
      assert.ok(Math.abs(card.imageWidth / card.imageHeight - 60 / 48) < .01, 'the full cameo aspect ratio is preserved');
      for (const other of cards) if (other.top > card.top + 1) assert.ok(other.top >= card.bottom, 'rows never cover the preceding labels');
    }
  }
  await page.evaluate(() => document.documentElement.style.setProperty('--sidebar-w', '340px'));
  const source = page.locator('.sim-unit').first();
  await source.hover();
  assert.equal(await source.evaluate(n => getComputedStyle(n).cursor), 'grab');
  await page.mouse.down();
  assert.equal(await source.evaluate(n => getComputedStyle(n).cursor), 'grabbing');
  await page.mouse.up();
  const before = await page.evaluate(async () => (await window.game.command({ cmd: 'placements' })).spawns.length);
  await source.dragTo(page.locator('canvas').first(), { targetPosition: { x: 500, y: 650 } });
  await page.waitForFunction(async count => (await window.game.command({ cmd: 'placements' })).spawns.length > count, before);
  await page.mouse.move(800, 800);
  await page.screenshot({ path: `${out}/simulator.png` });
  // A selected Saudi unit must not stay armed or pinned when switching to America.
  await page.evaluate(() => window.game.sandbox.setFaction(0, 'america'));
  await page.waitForFunction(() => window.store.getState().phase === 'playing'
    && window.store.getState().info?.players?.some(p => p.faction === 'america'));
  assert.equal(await page.evaluate(() => window.store.getState().sandbox.brush), null);
  await page.waitForSelector('[data-testid="sim-card"]', { state: 'detached' });
  assert.deepEqual(await page.locator('.sim-unit').evaluateAll(nodes => nodes.map(n => n.dataset.unit).sort()),
    await page.evaluate(() => { const s = window.store.getState().sandbox; return s.units.filter(u => u.kind === 'vehicle'
      && s.rosters.america.includes(u.name)).map(u => u.name).sort(); }), 'America shows its engine roster');
  await page.locator('.sim-unit').first().click();
  await page.getByTestId('sim-side-1').click();
  assert.equal(await page.evaluate(() => window.store.getState().sandbox.brush), null);
  await page.waitForSelector('[data-testid="sim-card"]', { state: 'detached' });
  assert.deepEqual(errors, []);
  console.log('PASS: full labels and separate prices at 260/340/500px, grab/grabbing cursors, real drag places a unit, faction/side changes clear stale selections.');
} finally {
  await browser.close();
}
