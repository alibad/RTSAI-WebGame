// Packaged real Natural Earth Hormuz geography; unavailable optional sources; real native WASM map editor.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
import { browserExecutable, browserArgs } from './browser-launch.mjs';
const base = process.env.RTSAI_TEST_URL ?? 'http://127.0.0.1:38669/';
const out = process.env.RTSAI_TEST_OUT ?? 'artifacts/earth-region';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: browserExecutable(), args: browserArgs(), headless: true });
const receipt = { scope: 'Real packaged Natural Earth v5.1.2 Hormuz coastlines, unavailable live site/terrain services, native WASM editor', checks: [], passed: false };
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 390, height: 844, rtl: true }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage(); page.setDefaultTimeout(30000);
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/overpass') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"elements":[]}' });
      if (['127.0.0.1', 'localhost', 'server.arcgisonline.com'].includes(url.hostname) || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
      return route.abort();
    });
    await page.goto(`${base}?profile=public&mode=editor`);
    await page.getByTestId('ed-earth').waitFor({ timeout: 180000 });
    if (viewport.rtl) await page.evaluate(() => { document.documentElement.dir = 'rtl'; document.documentElement.lang = 'ar'; });
    await page.getByTestId('ed-earth').click();
    const destination = page.locator('[data-place="Strait of Hormuz"]');
    await destination.and(page.locator(':enabled')).waitFor(); await destination.click();
    await page.getByRole('radio', { name: '120 km', exact: true }).waitFor();
    assert.equal(await page.getByRole('radio', { name: '120 km', exact: true }).getAttribute('aria-checked'), 'true');
    await page.waitForTimeout(1600);
    await page.screenshot({ path: `${out}/${viewport.width}${viewport.rtl ? '-rtl' : ''}-area.png` });
    const initial = await page.locator('.es-coords').innerText();
    const canvas = page.locator('.es-map canvas');
    await canvas.click({ position: viewport.width > 700 ? { x: 350, y: 330 } : { x: 125, y: 210 } });
    assert.notEqual(await page.locator('.es-coords').innerText(), initial, 'map click relocates the selection');
    const clicked = await page.locator('.es-coords').innerText();
    const pin = page.locator('.es-center-pin'), bounds = await pin.boundingBox();
    assert.ok(bounds);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 35, bounds.y + bounds.height / 2 + 20, { steps: 8 }); await page.mouse.up();
    assert.notEqual(await page.locator('.es-coords').innerText(), clicked, 'dragging the marker relocates the selection');
    await page.getByRole('button', { name: 'Use view center', exact: true }).click();
    receipt.checks.push(`${viewport.width}${viewport.rtl ? ' RTL' : ''}: regional preset, visible footprint and movable selection`);
    await page.getByRole('button', { name: 'Back to the globe', exact: true }).click();
    await page.locator('[data-place="Strait of Hormuz"]').click();
    if (viewport.width > 700) {
      await page.getByRole('radio', { name: '3 km', exact: true }).click();
      await page.getByTestId('es-build').click();
      await page.getByText(/too little usable land/).waitFor({ timeout: 90000 });
      await page.getByRole('radio', { name: '120 km', exact: true }).click();
      await page.getByTestId('es-build').click();
      await page.getByTestId('es-edit').waitFor({ timeout: 120000 });
      assert.equal(await page.getByRole('button', { name: /Khasab Airport/ }).count(), 1);
      assert.equal(await page.getByRole('button', { name: /Qeshm International Airport/ }).count(), 1);
      assert.equal(await page.getByTestId('es-mission').count(), 0, 'coastal terrain does not offer an invalid land-attack mission');
      assert.equal(await page.locator('.es-intel .ed-error').count(), 0);
      await page.screenshot({ path: `${out}/regional-built.png` });
      await page.getByTestId('es-edit').click();
      await page.waitForFunction(() => window.store.getState().phase === 'playing' && window.store.getState().editor?.map, null, { timeout: 120000 });
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${out}/native-hormuz-editor.png` });
      receipt.checks.push('Real Hormuz coastlines compile and open in the native WASM editor with zero live features; offshore small selection has actionable guidance');
    } else {
      const build = await page.getByTestId('es-build').boundingBox();
      assert.ok(build && build.x >= 0 && build.y + build.height <= viewport.height);
      const metrics = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(metrics.scroll <= metrics.width, 'no horizontal overflow');
      await page.getByRole('radio', { name: '60 km', exact: true }).click();
      assert.equal(await page.getByRole('radio', { name: '60 km', exact: true }).getAttribute('aria-checked'), 'true');
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  receipt.passed = true; console.log('PASS real Hormuz geography, movable regional selection, native editor and phone/RTL layout');
} finally { await browser.close(); fs.writeFileSync(`${out}/receipt.json`, JSON.stringify(receipt, null, 2)); }
