// Synthetic geography and delayed public-source responses; real compiler, editor validation and WASM map opening.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
import { browserExecutable, browserArgs } from './browser-launch.mjs';
const base = process.env.RTSAI_TEST_URL ?? 'http://127.0.0.1:38669/';
const out = process.env.RTSAI_TEST_OUT ?? 'artifacts/earth-async';
fs.mkdirSync(out, { recursive: true });
const tile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const browser = await chromium.launch({ executablePath: browserExecutable(), args: browserArgs(), headless: true });
const receipt = { scope: 'Local synthetic geography, held Wikipedia responses, real map compiler and native WASM editor; no public requests', checks: [], passed: false };
try {
  for (const scenario of ['held-geosearch', 'parallel-summaries', 'research-timeout']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(); page.setDefaultTimeout(30000);
    const errors = [], held = [], summaries = [];
    let geoStarted = false, terrainStarted = false, location = 0;
    const articles = title => ({ query: { geosearch: [{ pageid: 1, title, lat: 26.5667, lon: 56.25, dist: 50 }, { pageid: 2, title: 'Second Air Base', lat: 26.567, lon: 56.251, dist: 100 }] } });
    const json = (route, data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'server.arcgisonline.com') return route.fulfill({ status: 200, contentType: 'image/png', body: tile });
      if (url.hostname === 'tiles.mapterhorn.com') return route.abort();
      if (url.hostname === 'nominatim.openstreetmap.org') return json(route, { address: { country_code: 'om' } });
      if (url.hostname === 'en.wikipedia.org') {
        if (url.pathname.includes('/w/api.php')) {
          geoStarted = true;
          if (scenario !== 'parallel-summaries') { held.push(route); return; }
          return json(route, articles(location ? 'Riyadh Fort' : 'Old Fort'));
        }
        summaries.push(route);
        if (location) return json(route, { extract: 'Context for the new place.' });
        return; // Keep both old-place summary requests pending simultaneously.
      }
      if (url.pathname === '/api/overpass') {
        const query = decodeURIComponent((route.request().postData() ?? '').replace(/^data=/, ''));
        if (!query.includes('out tags geom')) {
          if (scenario === 'research-timeout') { held.push(route); return; }
          return json(route, { elements: [{ type: 'node', id: 7, lat: 26.568, lon: 56.253, tags: { military: 'airfield', name: 'Mapped Air Base' } }] });
        }
        terrainStarted = true;
        return json(route, { elements: [{ type: 'way', id: 8, tags: { highway: 'primary' }, geometry: [{ lat: 26.5667, lon: 56.23 }, { lat: 26.5667, lon: 56.27 }] }] });
      }
      if (['127.0.0.1', 'localhost'].includes(url.hostname) || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
      return route.abort();
    });
    await page.goto(`${base}?profile=public&mode=editor`);
    await page.getByTestId('ed-earth').waitFor({ timeout: 180000 }); await page.getByTestId('ed-earth').click();
    const destination = page.locator('[data-place="Strait of Hormuz"]');
    await destination.and(page.locator(':enabled')).waitFor(); await destination.click();
    const build = page.getByTestId('es-build');
    await build.and(page.locator(':enabled')).waitFor();
    if (scenario !== 'research-timeout') await page.getByRole('button', { name: scenario === 'held-geosearch' ? /Mapped Air Base/ : /Old Fort/ }).waitFor();
    else await page.waitForTimeout(150);
    assert.equal(geoStarted, true);
    await page.waitForTimeout(450);
    await page.screenshot({ path: `${out}/${scenario}-research.png` });
    if (scenario === 'research-timeout') {
      await build.click();
      await page.getByTestId('es-edit').waitFor({ timeout: 120000 });
      await page.getByText('No nearby site information is available. You can still build the battlefield.', { exact: true }).waitFor({ timeout: 23000 });
      assert.equal(await page.locator('.es-intel .ed-error').count(), 0);
      receipt.checks.push('Both optional sources time out without blocking a real battlefield build or leaving an endless research spinner');
      await page.screenshot({ path: `${out}/${scenario}-built.png` });
    } else if (scenario === 'held-geosearch') {
      assert.equal(held.length, 1);
      await build.click();
      await page.waitForFunction(() => document.querySelector('[data-testid="es-edit"]') || document.querySelector('.es-intel .ed-error'), null, { timeout: 120000 });
      assert.equal(await page.locator('.es-intel .ed-error').count(), 0, await page.locator('.es-intel .ed-error').allTextContents());
      assert.equal(terrainStarted, true);
      assert.ok(await page.evaluate(() => window.store.getState().setup.maps.some(m => m.title === 'Strait of Hormuz')));
      receipt.checks.push('Terrain compiled and registered while Wikipedia geosearch was still held');
      await page.getByRole('combobox', { name: 'Your nation', exact: true }).click();
      await page.getByRole('option', { name: 'America', exact: true }).click();
      await json(held.pop(), articles('US Naval Base')).catch(() => {});
      await page.getByRole('button', { name: /US Naval Base/ }).waitFor();
      assert.match(await page.getByRole('combobox', { name: 'Your nation', exact: true }).innerText(), /America/);
      receipt.checks.push('Article titles appear before summaries; manual nation choice survives late research');
      await page.waitForTimeout(450);
      await page.screenshot({ path: `${out}/${scenario}-built.png` });
      await page.getByTestId('es-edit').click();
      await page.waitForFunction(() => window.store.getState().phase === 'playing' && window.store.getState().editor?.map, null, { timeout: 120000 });
      receipt.checks.push('Generated map opens in the real WASM editor without waiting for article summaries');
    } else {
      await page.waitForFunction(() => document.querySelectorAll('.es-site').length >= 2);
      await page.waitForTimeout(350);
      assert.equal(summaries.length, 2, 'both summaries requested before either has finished');
      receipt.checks.push('Wikipedia summaries requested concurrently, with partial site results already visible');
      location = 1;
      await page.getByRole('button', { name: 'Back to the globe', exact: true }).click();
      await page.locator('[data-place="Riyadh"]').click();
      await page.getByRole('button', { name: /Riyadh Fort/ }).waitFor();
      for (const route of summaries.slice(0, 2)) await json(route, { extract: 'Stale article for the old place.' }).catch(() => {});
      await page.waitForTimeout(350);
      assert.equal(await page.getByText('Stale article for the old place.', { exact: true }).count(), 0);
      await build.and(page.locator(':enabled')).waitFor();
      receipt.checks.push('Changing place cancels old research and rejects late results');
      await page.screenshot({ path: `${out}/${scenario}-new-place.png` });
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  receipt.passed = true; console.log('PASS background research, partial sites, concurrent summaries, real terrain build/open, stale lookup cancellation and manual nation choices');
} finally { await browser.close(); fs.writeFileSync(`${out}/receipt.json`, JSON.stringify(receipt, null, 2)); }
