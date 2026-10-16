// Exercise whole player screens. Footer checks intentionally include its parent and siblings, not just a card crop.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
import { browserExecutable, browserArgs } from './browser-launch.mjs';
const base = process.env.RTSAI_TEST_URL ?? 'http://127.0.0.1:38669/';
const out = process.env.RTSAI_TEST_OUT ?? 'artifacts/menu-ux';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: browserExecutable(), args: browserArgs(), headless: true });
const results = [];
try {
  for (const [name, viewport, rtl] of [
    ['desktop', { width: 1440, height: 1000 }, false],
    ['laptop', { width: 1280, height: 720 }, false],
    ['phone', { width: 390, height: 844 }, false],
    ['phone-rtl', { width: 390, height: 844 }, true],
    ['landscape', { width: 844, height: 390 }, false],
  ]) {
    const context = await browser.newContext({ viewport, hasTouch: name.includes('phone') || name === 'landscape' });
    if (rtl) await context.addInitScript(() => document.addEventListener('DOMContentLoaded', () => document.documentElement.dir = 'rtl'));
    const page = await context.newPage();
    const errors = [], companionRequests = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('request', r => { if (/\/api\/companion|\/companion\//.test(r.url())) companionRequests.push(r.url()); });
    const capture = async label => { await page.waitForTimeout(350); await page.screenshot({ path: `${out}/${name}-${label}.png` }); };
    const fits = async selector => {
      const rect = await page.locator(selector).boundingBox();
      assert.ok(rect && rect.x >= -1 && rect.y >= -1 && rect.x + rect.width <= viewport.width + 1 && rect.y + rect.height <= viewport.height + 1, `${name}: ${selector} must fit viewport: ${JSON.stringify(rect)}`);
      return rect;
    };
    await page.goto(`${base}?profile=public`);
    await page.getByRole('button', { name: /Skirmish Pick a nation/ }).waitFor({ timeout: 180000 });
    await capture('01-home');
    await page.getByRole('button', { name: 'Multiplayer', exact: true }).click();
    await page.getByRole('heading', { name: 'Have an invite?', exact: true }).waitFor();
    await capture('01-multiplayer');
    await page.getByRole('button', { name: 'Close multiplayer', exact: true }).click();
    await page.getByRole('button', { name: 'Saves & replays', exact: true }).click();
    await page.getByText('No saved matches yet', { exact: true }).waitFor();
    await fits('.gd-panel'); await capture('02-saves');
    await page.getByRole('button', { name: 'Close saves & replays', exact: true }).click();
    await page.getByRole('button', { name: /Skirmish Pick a nation/ }).click();
    await page.getByRole('button', { name: 'Start match', exact: true }).waitFor();
    const footer = await fits('.sk-footer');
    const action = await fits('.sk-footer .scr-cta');
    assert.ok(action.height >= 44, 'primary action must retain a full touch target');
    const utilities = await fits('.sk-footer .menu-utility');
    assert.ok(action.y >= footer.y && action.y + action.height <= footer.y + footer.height, 'primary action belongs inside footer');
    assert.ok(utilities.y >= footer.y && utilities.y + utilities.height <= footer.y + footer.height, 'utilities belong inside footer');
    assert.ok(action.x + action.width <= utilities.x + 1 || utilities.x + utilities.width <= action.x + 1 || action.y + action.height <= utilities.y + 1 || utilities.y + utilities.height <= action.y + 1, 'footer controls never overlap');
    await capture('03-skirmish-top');
    const adviser = page.getByRole('switch', { name: 'Built-in adviser', exact: true });
    await page.locator('.sk-cc').scrollIntoViewIfNeeded();
    const adviserBox = await page.locator('.sk-cc').boundingBox();
    assert.ok(adviserBox.y + adviserBox.height <= footer.y + 1, 'adviser remains in content above footer');
    const content = await page.locator('.sk-layout').boundingBox();
    assert.ok(content.y + content.height <= footer.y + 1, 'content viewport ends before footer');
    await capture('04-skirmish-bottom');
    const overlapping = await page.locator('.sk-layout').evaluate(el => {
      const items = [...el.querySelectorAll('.sk-hero, .sk-group, .sk-rules, .sk-map, .sk-opponents, .sk-cc')].filter(n => getComputedStyle(n).display !== 'contents');
      return items.flatMap((a, i) => items.slice(i + 1).filter(b => !a.contains(b) && !b.contains(a)).filter(b => {
        const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
        return Math.min(x.right, y.right) - Math.max(x.left, y.left) > 2 && Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 2;
      }).map(b => [a.className, b.className]));
    });
    assert.deepEqual(overlapping, [], 'setup panels never overlap');
    await page.getByRole('button', { name: /More options/ }).click();
    assert.equal(await page.getByRole('switch', { name: /Cheats|AI co-commander/ }).count(), 0, 'engine-only lobby flags are not player settings');
    await page.getByRole('switch', { name: /Base destruction victory/ }).scrollIntoViewIfNeeded();
    await capture('04-advanced-rules');
    await page.getByRole('button', { name: 'Fewer options', exact: true }).click();
    await page.getByRole('combobox', { name: 'Opponent 1 tactics', exact: true }).click();
    await page.getByRole('option', { name: /Raider/ }).waitFor();
    await capture('05-tactics-expanded');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await fits('.gd-panel');
    assert.ok(await page.locator('.gd-header h2').evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), 'settings title is above page navigation');
    await page.getByRole('combobox', { name: 'Unit voice language', exact: true }).click();
    await page.getByRole('option', { name: 'English', exact: true }).waitFor();
    await capture('06-voice-picker-expanded');
    await page.keyboard.press('Escape');
    const orders = page.getByRole('radiogroup', { name: 'Adviser orders', exact: true });
    await orders.scrollIntoViewIfNeeded();
    for (const label of ['Off', 'Suggest orders', 'Apply automatically']) await orders.getByRole('radio', { name: label, exact: true }).click();
    await orders.getByRole('radio', { name: 'Suggest orders', exact: true }).click();
    await capture('07-settings-controls');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    if (name === 'desktop') fs.writeFileSync(`${out}/match-options.json`, JSON.stringify(await page.evaluate(() => window.store.getState().setup.options), null, 2));
    if (name === 'desktop') {
      await page.getByRole('button', { name: 'Start match', exact: true }).click();
      await page.waitForFunction(() => window.store.getState().phase === 'playing', null, { timeout: 180000 });
      assert.equal(await page.evaluate(() => JSON.parse(window.game.scenarioJson).options.cheats), 'False');
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await capture('07-match-menu');
      await page.getByRole('button', { name: 'Save or load', exact: true }).click();
      await page.getByRole('button', { name: 'Save current match', exact: true }).click();
      await page.getByText('Match saved on this device.', { exact: true }).waitFor();
      await capture('07-saved-match');
      await page.getByRole('button', { name: 'Close saves & replays', exact: true }).click();
      await page.getByRole('button', { name: /^Controls/ }).click();
      await page.getByRole('heading', { name: 'Getting started', exact: true }).waitFor();
      await capture('07-controls-help');
      await page.getByRole('button', { name: 'Close controls', exact: true }).click();
      await page.getByRole('button', { name: 'Leave game', exact: true }).click();
      await page.getByRole('alertdialog', { name: 'Leave this match?', exact: true }).getByRole('button', { name: 'Leave game', exact: true }).click();
      await page.getByRole('button', { name: 'Saves & replays', exact: true }).click();
      await page.getByRole('button', { name: 'Replay', exact: true }).click();
      await page.waitForFunction(() => window.store.getState().phase === 'playing', null, { timeout: 180000 });
      await capture('07-replay');
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.getByRole('dialog', { name: 'Game menu', exact: true }).getByRole('button', { name: 'Exit replay', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Campaign', exact: true }).click();
    await page.locator('.cp-detail').waitFor(); await capture('08-campaign');
    await page.getByRole('button', { name: 'Main menu', exact: true }).click();
    await page.getByRole('button', { name: /Map editor Open, paint/ }).click();
    await page.getByTestId('ed-blank').waitFor(); await capture('09-editor-menu');
    await page.getByRole('button', { name: 'Main menu', exact: true }).click();
    await page.getByRole('button', { name: /Battle simulator Any map/ }).click();
    await page.getByRole('combobox', { name: 'Nation', exact: true }).waitFor({ timeout: 180000 });
    await capture('10-simulator');
    if (name.includes('phone')) {
      await page.getByRole('region', { name: 'Landscape view needed', exact: true }).waitFor();
      await page.setViewportSize({ width: 844, height: 390 });
      await page.getByRole('region', { name: 'Landscape view needed', exact: true }).waitFor({ state: 'detached' });
      await capture('10-simulator-landscape');
    }
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('dialog', { name: 'Game menu', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Engine stats', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Verify', exact: true }).count(), 0);
    await capture('11-pause-menu');
    assert.equal(await page.locator('select:visible').count(), 0, 'no visible native select');
    assert.deepEqual(companionRequests, [], 'normal menus never start or probe model services');
    assert.deepEqual(errors, []);
    results.push({ name, viewport, rtl, screenshots: 11, footerContained: true, noDeveloperControls: true, noCompanionRequests: true, passed: true });
    console.log(`PASS ${name}: whole menus, footer, expanded pickers and player settings`);
    await context.close();
  }
} finally { await browser.close(); fs.writeFileSync(`${out}/receipt.json`, JSON.stringify(results, null, 2)); }
