// Real browser/WASM acceptance: all Studio bindings, stock/custom Classic production, RA2 regression.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
import { browserExecutable, browserArgs } from './browser-launch.mjs';

const base = process.env.RTSAI_TEST_URL;
if (!base) throw Error('RTSAI_TEST_URL must identify the local unit preview');
const out = path.resolve(process.env.RTSAI_TEST_OUT ?? '../artifacts/classic-web-support-20261016');
const mod = path.resolve('../RTSAI-Mod');
const manifest = JSON.parse(fs.readFileSync(path.join(mod, 'mods/rtsai/unit-overrides/manifest.json')));
const registry = JSON.parse(fs.readFileSync(path.join(mod, 'content/unit-bindings.json'))).units;
const pilot = JSON.parse(fs.readFileSync(path.join(mod, 'mods/rtsai/shared-content/manifest.json')));
const expected = (key, target) => {
  const unit = registry[key], b = unit.bindings[target], stats = { ...b.baseline };
  for (const [field, parents] of Object.entries(b.inheritance ?? {})) {
    for (const parent of parents) {
      const value = manifest.units[`${unit.mode}:${parent}`]?.[field];
      if (value !== undefined) { stats[field] = value; break; }
    }
  }
  const inherited = pilot.targets[target === 'classic-web' ? 'classic-desktop' : target];
  if (inherited.actor.toLowerCase() === b.actor.toLowerCase()) stats.cost = inherited.cost;
  return { ...stats, ...manifest.units[key] };
};
fs.mkdirSync(out, { recursive: true });
const receipt = { revision: manifest.revision, passed: false, targets: [], production: [] };
function parseRules(text) {
  const root = [], stack = [{ depth: -1, rows: root }];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(?<!\\)#.*$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const depth = line.length - line.trimStart().length;
    const at = line.indexOf(':');
    assert(at >= 0, 'A rule needs a colon');
    const key = line.slice(0, at).trim(), value = line.slice(at + 1).trim().replaceAll('\\#', '#') || null;
    while (stack.at(-1).depth >= depth) stack.pop();
    const node = { key, value, children: [] }; stack.at(-1).rows.push(node); stack.push({ depth, rows: node.children });
  }
  return root;
}
function compareRules(expected, actual, path = '') {
  for (const node of expected) {
    if (node.key.startsWith('-')) { assert(!actual.some(n => n.key === node.key.slice(1)), `${path}/${node.key} must be removed`); continue; }
    const match = actual.find(n => n.key === node.key);
    assert(match, `Missing ${path}/${node.key}`);
    if (node.value !== null) assert.equal(match.value, node.value, `${path}/${node.key}`);
    compareRules(node.children, match.children, `${path}/${node.key}`);
  }
}
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true, args: browserArgs() });
try {
  for (const mode of ['classic', 'ra2']) {
    const profile = mode === 'classic' ? 'public-classic' : 'public';
    const content = await (await fetch(new URL(`data/${profile}/content-profile.json`, base))).json();
    assert.equal(content.unitRevision, manifest.revision);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`${base}?profile=${profile}&runtime=interp&private=0`);
    await page.waitForFunction(() => ['setup', 'error'].includes(window.store?.getState().phase), null, { timeout: 240000 });
    assert.equal(await page.evaluate(() => window.store.getState().phase), 'setup', await page.evaluate(() => window.store.getState().error));
    const setup = await page.evaluate(() => window.store.getState().setup);
    assert.equal(setup.modId, mode === 'classic' ? 'rtsai-classic-core' : 'rtsai');
    const requiredFactions = new Set(Object.values(registry).filter(u => u.mode === mode).flatMap(u => u.factions.map(f => f.id)));
    for (const id of requiredFactions) assert(setup.factions.some(f => f.id === id), `Missing ${mode} faction ${id}`);
    const tests = mode === 'classic' ? [['england', 'e1'], ['china', 'cnrifle']] : [['america', 'engineer']];
    for (const [faction, type] of tests) {
      const classic = mode === 'classic';
      const barracks = classic ? 'tent' : 'gapile';
      const scenario = { map: 'web-arena', seed: 20261016, bare: true,
        players: [{ slot: 'Multi0', faction, color: '2A6FDB' }, { slot: 'Multi1', faction: classic ? 'russia' : 'russia', bot: 'webidle' }],
        options: { startingcash: '10000', fog: 'False', explored: 'True', crates: 'False' },
        // Classic uses the map's real western spawn clearing; arbitrary coordinates can block a barracks exit.
        spawns: [{ type: classic ? 'fact' : 'gacnst', player: 0, x: classic ? 8 : 20, y: classic ? 45 : 20 },
          { type: classic ? 'powr' : 'gapowr', player: 0, x: classic ? 14 : 25, y: classic ? 45 : 20 },
          { type: barracks, player: 0, x: classic ? 11 : 20, y: classic ? 49 : 25 },
          { type: classic ? 'mcv' : 'smcv', player: 1, x: classic ? 90 : 65, y: classic ? 24 : 45 }],
      };
      await page.evaluate(s => window.game.start(JSON.stringify(s)), scenario);
      await page.waitForFunction(() => ['playing', 'error'].includes(window.store.getState().phase), null, { timeout: 240000 });
      assert.equal(await page.evaluate(() => window.store.getState().phase), 'playing', await page.evaluate(() => window.store.getState().error));
      await page.waitForFunction(() => window.store.getState().ui?.tick >= 30, null, { timeout: 60000 });
      await page.waitForFunction(() => window.game.client.cur?.actors?.length > 0, null, { timeout: 60000 });
      if (type === tests[0][1]) {
        const rows = [];
        for (const [key, unit] of Object.entries(registry).filter(([, unit]) => unit.mode === mode)) {
          const actual = await page.evaluate(type => window.game.client.command({ cmd: 'unitinfo', type }), unit.actor);
          const values = expected(key, `${mode}-web`);
          for (const [field, value] of Object.entries(values)) if (value !== null)
            assert.equal(actual[field === 'health' ? 'hp' : field], value, `${key} ${field}`);
          rows.push({ key, cost: actual.cost, health: actual.hp, speed: actual.speed });
        }
        receipt.targets.push({ mode, units: rows, factions: [...requiredFactions], grid: await page.evaluate(() => window.store.getState().info.gridType) });
        console.log(`PASS ${mode}: ${rows.length} actual WASM unit bindings and ${requiredFactions.size} factions`);
        for (const [key, detail] of Object.entries(manifest.details ?? {}).filter(([key]) => key.startsWith(mode + ':'))) {
          const actor = registry[key].bindings[`${mode}-web`].actor;
          const actual = await page.evaluate(type => window.game.client.command({ cmd: 'unitrules', type }), actor);
          const live = await page.evaluate(type => window.game.client.command({ cmd: 'unitinfo', type }), actor);
          assert(!actual.error, actual.error);
          compareRules(parseRules(detail.actor), parseRules(actual.actor), key);
          const actorRules = parseRules(detail.actor);
          const armor = actorRules.find(n => n.key === 'Armor')?.children.find(n => n.key === 'Type')?.value;
          if (armor) assert.equal(live.armor, armor, `${key} hydrated armor`);
          for (const [arm, w] of Object.entries(detail.weapons)) {
            const suffix = crypto.createHash('sha256').update(key + '/' + arm).digest('hex').slice(0, 10);
            const alias = 'studio_' + (key + '_' + arm).toLowerCase().replaceAll(/[^a-z0-9_]/g, '_') + '_' + suffix;
            compareRules([{ key: arm, value: null, children: [{ key: 'Weapon', value: alias, children: [] }] }], parseRules(actual.actor), key);
            assert(actual.weapons[alias], `Private weapon missing: ${alias}`);
            compareRules(parseRules(w.rules), parseRules(actual.weapons[alias]), alias);
            const typed = live.weapons.find(w => w.name.toLowerCase() === alias);
            assert(typed, `${key} hydrated private weapon`);
            for (const node of parseRules(w.rules)) {
              if (node.key === 'ReloadDelay') assert.equal(typed.reload, Number(node.value), `${key} hydrated reload`);
              if (node.key === 'Range') {
                const parts = /^(?:(-?\d+)c)?(-?\d+)$/.exec(node.value);
                assert(parts, 'Expected OpenRA distance');
                assert.equal(typed.range, Math.round((Number(parts[1] ?? 0) + Number(parts[2]) / 1024) * 100) / 100, `${key} hydrated range`);
              }
            }
          }
          (receipt.unitRules ??= []).push({ unit: key, target: `${mode}-web`, passed: true, engineValues: live });
          console.log(`PASS full unit rules in actual WASM: ${key}`);
        }
      }
      await page.evaluate(type => {
        const g = window.game, s = g.client.cur;
        const building = s.actors.find(a => a.owner === s.header.localPlayer && g.client.str(a.type) === type);
        if (!building) throw Error('Missing production building');
        g.lookAt(building.sx, building.sy);
      }, barracks);
      await page.waitForFunction(type => window.store.getState().catalog.find(q => q.type === 'Infantry')?.items.some(i => i.name === type && i.buildable), type, { timeout: 60000 });
      const before = await page.evaluate(type => ({ cash: window.store.getState().ui.cash,
        item: window.store.getState().catalog.find(q => q.type === 'Infantry')?.items.find(i => i.name === type) }), type);
      assert.equal(before.item?.buildable, true, `${type} must be available in its own faction's real queue`);
      assert.equal(before.item.cost, expected(`${mode}:${type}`, `${mode}-web`).cost);
      await page.locator('button[title="Infantry"]').click();
      const button = page.getByRole('button', { name: before.item.label, exact: true });
      await button.hover();
      await page.screenshot({ path: path.join(out, `${mode}-${type}-cost.png`) });
      await button.click();
      await page.waitForFunction(type => {
        const g = window.game, s = g.client.cur;
        return s?.actors.some(a => a.owner === s.header.localPlayer && g.client.str(a.type) === type);
      }, type, { timeout: 180000 });
      const after = await page.evaluate(type => {
        const g = window.game, s = g.client.cur;
        const actor = s.actors.find(a => a.owner === s.header.localPlayer && g.client.str(a.type) === type);
        return { cash: window.store.getState().ui.cash, tick: window.store.getState().ui.tick, hp: actor.hp, maxHp: actor.maxHp };
      }, type);
      assert.equal(before.cash - after.cash, before.item.cost);
      assert.equal(after.hp, expected(`${mode}:${type}`, `${mode}-web`).health);
      assert.equal(after.maxHp, after.hp);
      receipt.production.push({ mode, faction, type, cost: before.item.cost, cashBefore: before.cash, cashAfter: after.cash, ...after });
      await page.screenshot({ path: path.join(out, `${mode}-${type}-trained.png`) });
      console.log(`PASS ${mode}/${faction}: trained ${type}, charged exactly ${before.item.cost}`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  receipt.passed = true;
} finally {
  fs.writeFileSync(path.join(out, 'browser-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  await browser.close();
}
