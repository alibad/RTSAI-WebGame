// Inspect the actual engine-selected image and rendered pixels across country changes in a spectator simulator.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
import { browserExecutable, browserArgs } from './browser-launch.mjs';
const base = process.env.RTSAI_TEST_URL || 'http://127.0.0.1:3490/';
const out = process.env.RTSAI_TEST_OUT || 'artifacts/faction-icons';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: browserExecutable(), args: browserArgs(), headless: true });
const rows = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(180000);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${base}?profile=public&mode=simulator`);
  await page.waitForSelector('.sim-unit');
  for (const [faction, actor, original] of [['saudi', 'r2m1a2s', false], ['america', 'mtnk', true], ['russia', 'htnk', true], ['america', 'mtnk', true]]) {
    await page.evaluate(f => window.game.sandbox.setFaction(0, f), faction);
    await page.waitForFunction(([f, a]) => window.store.getState().phase === 'playing'
      && window.store.getState().info.players.some(p => p.faction === f)
      && !!window.store.getState().icons[`${f}:${a}`], [faction, actor]);
    const evidence = await page.evaluate(async ([faction, actor]) => {
      const sprite = await window.game.command({ cmd: 'icon', type: actor, faction });
      return { image: sprite.image, samePixels: window.game.renderer.renderIcon(sprite) === window.store.getState().icons[`${faction}:${actor}`],
        cardPixels: document.querySelector(`[data-unit="${actor}"] img`)?.getAttribute('src') === window.store.getState().icons[`${faction}:${actor}`] };
    }, [faction, actor]);
    assert.equal(evidence.image.startsWith('ea-'), original, `${faction}: ${evidence.image}`);
    assert.ok(evidence.samePixels && evidence.cardPixels, 'the displayed card must show the faction-specific engine cameo');
    rows.push({ faction, actor, ...evidence });
    await page.locator('.sim-roster').screenshot({ path: `${out}/${faction}-${rows.length}.png` });
  }
  assert.deepEqual(errors, []);
  console.log('PASS faction-specific engine icons and displayed pixels: Saudi → America → Russia → America');
} finally {
  fs.writeFileSync(`${out}/receipt.json`, JSON.stringify(rows, null, 2));
  await browser.close();
}
