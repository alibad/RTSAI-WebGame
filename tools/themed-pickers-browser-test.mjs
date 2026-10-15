// Expanded product pickers, including keyboard dismissal, touch layout and RTL.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
import { browserExecutable, browserArgs } from './browser-launch.mjs';
const base = process.env.RTSAI_TEST_URL || 'http://127.0.0.1:3490/';
const out = process.env.RTSAI_TEST_OUT || 'artifacts/themed-pickers';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: browserExecutable(), args: browserArgs(), headless: true });
try {
  for (const [name, viewport, touch] of [['desktop', { width: 1440, height: 1000 }, false], ['phone', { width: 844, height: 390 }, true]]) {
    const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch });
    const page = await context.newPage();
    page.setDefaultTimeout(180000);
    await context.route('**/*', route => {
      const u = new URL(route.request().url());
      return ['127.0.0.1', 'localhost'].includes(u.hostname) || ['blob:', 'data:'].includes(u.protocol) ? route.continue() : route.abort();
    });
    await page.goto(`${base}?profile=public&mode=skirmish`);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const voice = page.getByLabel('Unit voice language');
    for (const dir of ['ltr', 'rtl']) {
      await page.evaluate(d => { document.documentElement.dir = d; }, dir);
      await voice.click();
      const popup = page.getByRole('listbox').last();
      await popup.waitFor();
      await popup.evaluate(n => Promise.all(n.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {}))));
      assert.equal(await page.locator('select:visible').count(), 0);
      const r = await popup.boundingBox();
      assert.ok(r && r.x >= -1 && r.y >= -1 && r.x + r.width <= viewport.width + 1 && r.y + r.height <= viewport.height + 1);
      await page.screenshot({ path: `${out}/${name}-voice-${dir}.png` });
      await page.keyboard.press('Escape');
      await popup.waitFor({ state: 'hidden' });
      assert.equal(await voice.evaluate(n => n === document.activeElement), true);
    }
    await voice.click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.waitForFunction(() => localStorage.getItem('rtsai.voiceLanguage.v1') === 'en');
    await page.goto(`${base}?profile=public&mode=editor`);
    await page.getByTestId('ed-blank').click();
    await page.locator('[data-tool="actor"]').click();
    const owner = page.getByLabel('Actor owner');
    await owner.click();
    await page.getByRole('listbox').last().waitFor();
    await page.getByRole('listbox').last().evaluate(n => Promise.all(n.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {}))));
    assert.equal(await page.locator('select:visible').count(), 0);
    await page.screenshot({ path: `${out}/${name}-owner.png` });
    const option = page.getByRole('option').last();
    const selected = await option.innerText();
    await option.click();
    assert.ok((await owner.innerText()).includes(selected));
    await context.close();
    console.log(`PASS ${name}: expanded themed voice/owner pickers, selection, Escape/focus, RTL bounds`);
  }
} finally { await browser.close(); }
