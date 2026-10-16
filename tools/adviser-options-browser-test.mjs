import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
import { browserExecutable, browserArgs } from './browser-launch.mjs';
const base = process.env.RTSAI_TEST_URL ?? 'http://127.0.0.1:38669/';
const out = process.env.RTSAI_TEST_OUT ?? 'artifacts/adviser-options';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: browserExecutable(), args: browserArgs(), headless: true });
const results = [];
try {
  for (const [name, viewport, savedMode, rtl, savedEnabled = true] of [['desktop', { width: 1440, height: 1000 }, 'local', false], ['phone', { width: 390, height: 844 }, 'mock', false], ['rtl', { width: 390, height: 844 }, 'local', true], ['saved-off', { width: 1440, height: 1000 }, 'local', false, false]]) {
    const context = await browser.newContext({ viewport, isMobile: name === 'phone', hasTouch: name === 'phone' });
    await context.addInitScript(({ savedMode, rtl, savedEnabled }) => {
      localStorage.setItem('rtsai.cocommander', JSON.stringify({ enabled: savedEnabled, mode: savedMode, auto: false }));
      if (rtl) document.addEventListener('DOMContentLoaded', () => document.documentElement.dir = 'rtl');
    }, { savedMode, rtl, savedEnabled });
    const page = await context.newPage(); const errors = [], companionRequests = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => { if (/\/api\/companion|\/companion\//.test(request.url())) companionRequests.push(request.url()); });
    await page.goto(`${base}?profile=public&mode=skirmish`);
    const toggle = page.getByRole('switch', { name: 'Built-in adviser', exact: true });
    await toggle.waitFor({ timeout: 180000 }); await toggle.scrollIntoViewIfNeeded();
    assert.equal(await page.locator('.sk-cc button').count(), 1);
    assert.equal(await toggle.getAttribute('aria-checked'), String(savedEnabled));
    if (!savedEnabled) await toggle.click();
    await page.getByText('Get battlefield tips and recommended orders. No setup needed.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.store.getState().cc.mode), 'browser');
    await page.evaluate(() => { window.game.cc.setMode('local'); window.game.cc.setMode('mock'); });
    assert.equal(await page.evaluate(() => window.store.getState().cc.mode), 'browser');
    assert.deepEqual(companionRequests, []);
    const box = await page.locator('.sk-cc').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1, 'adviser control must fit the screen');
    await page.locator('.sk-cc').screenshot({ path: `${out}/${name}-on.png` });
    await toggle.focus(); await page.keyboard.press('Space');
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await page.locator('.sk-cc').screenshot({ path: `${out}/${name}-off.png` });
    await toggle.click(); assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    assert.deepEqual(errors, []);
    results.push({ name, savedMode, mode: 'browser', companionRequests: 0, keyboardSwitch: true, fitsViewport: true, passed: true });
    await context.close();
  }
} finally { await browser.close(); fs.writeFileSync(`${out}/receipt.json`, JSON.stringify(results, null, 2)); }
console.log('PASS clear built-in adviser, hidden local/scripted options, stale preferences, keyboard, phone and RTL');
