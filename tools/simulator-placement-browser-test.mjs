// Real public rules, paused actor rendering, category search and edit/run/edit restoration in both modes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
import { browserExecutable, browserArgs } from './browser-launch.mjs';
const base=process.env.RTSAI_TEST_URL??'http://127.0.0.1:38669/';
const out=process.env.RTSAI_TEST_OUT??'artifacts/simulator-placement'; fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({executablePath:browserExecutable(),args:browserArgs(),headless:true});
const receipt={scope:'Real native WASM actor placement and movement categories; buildings completed before ticking; both modes',modes:[],passed:false};
try {
 for(const profile of ['public','public-classic']) {
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.route('**/*',r=>{const u=new URL(r.request().url());return ['127.0.0.1','localhost'].includes(u.hostname)||['blob:','data:'].includes(u.protocol)?r.continue():r.abort();});
  await page.goto(`${base}?profile=${profile}&mode=simulator`);
  await page.waitForFunction(()=>window.store.getState().sandbox?.units?.length>0,null,{timeout:180000});
  const catalog=await page.evaluate(()=>window.store.getState().sandbox.units);
  assert.equal(catalog.find(u=>u.name==='r2ah64sa').kind,'aircraft','Apache is an aircraft even when built by a vehicle factory');
  assert.equal(catalog.find(u=>u.name==='r2bradley').kind,'vehicle');
  await page.getByRole('tab',{name:'Aircraft',exact:true}).click();
  await page.locator('[data-unit="r2ah64sa"]').waitFor();
  assert.equal(await page.locator('[data-unit="r2bradley"]').count(),0);
  await page.locator('[data-unit="r2ah64sa"]').click();
  await page.getByRole('tab',{name:'Vehicles',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.store.getState().sandbox.brush),null,'switching category disarms the previous brush');
  assert.equal(await page.locator('[data-unit="r2ah64sa"]').count(),0);
  await page.getByRole('tab',{name:'Aircraft',exact:true}).click();
  await page.getByRole('textbox',{name:'Search this category'}).fill('Bradley');
  assert.equal(await page.locator('.sim-unit').count(),0,'search does not silently include ground vehicles under Aircraft');
  assert.equal(await page.getByRole('tab',{name:'Aircraft',exact:true}).getAttribute('aria-selected'),'true');
  await page.getByText('No aircraft match your search.',{exact:true}).waitFor();
  await page.getByRole('textbox',{name:'Search this category'}).fill('');
  await page.getByRole('tab',{name:'Buildings',exact:true}).click();
  await page.locator('[data-unit="gapowr"]').click();
  await page.locator('canvas.stage').click({position:{x:520,y:400}});
  await page.waitForFunction(()=>window.game.client.cur.actors.some(a=>window.game.client.str(a.type)==='gapowr'));
  const placed=await page.evaluate(async()=>{
   const c=window.game.client,actor=c.cur.actors.find(a=>c.str(a.type)==='gapowr');
   window.game.lookAt(actor.sx,actor.sy);window.game.cam.zoom=1.5;
   return {sequence:c.str(actor.sequence),tick:c.cur.header.tick,placement:(await window.game.command({cmd:'placements'})).spawns.find(a=>a.type==='gapowr')};
  });
  assert.notEqual(placed.sequence,'make','the paused building displays its completed body immediately');
  await page.mouse.move(1050,900); await page.waitForTimeout(800);
  await page.screenshot({path:`${out}/${profile}-completed-power.png`});
  // The scenario created when Fight starts must not reintroduce construction frames or move the footprint.
  await page.getByTestId('sim-fight').click();
  await page.waitForFunction(()=>window.store.getState().sandbox?.mode==='run'&&window.store.getState().phase==='playing',null,{timeout:120000});
  const run=await page.evaluate(async()=>{
   window.game.setPaused(true); const c=window.game.client,a=c.cur.actors.find(a=>c.str(a.type)==='gapowr');
   return {sequence:c.str(a.sequence),placement:(await window.game.command({cmd:'placements'})).spawns.find(a=>a.type==='gapowr')};
  });
  assert.notEqual(run.sequence,'make');
  assert.deepEqual([run.placement.x,run.placement.y],[placed.placement.x,placed.placement.y]);
  await page.evaluate(()=>window.game.sandbox.backToEdit());
  await page.waitForFunction(()=>window.store.getState().sandbox?.mode==='edit'&&window.store.getState().phase==='playing'&&window.game.client.cur.actors.some(a=>window.game.client.str(a.type)==='gapowr'),null,{timeout:120000});
  const restored=await page.evaluate(()=>{const c=window.game.client,a=c.cur.actors.find(a=>c.str(a.type)==='gapowr');return c.str(a.sequence);});
  assert.notEqual(restored,'make'); assert.deepEqual(errors,[]);
  receipt.modes.push({profile,completed:placed,run,restored,checks:['movement categories','category-scoped search','stale placement cleared','completed paused building','same footprint after Fight','completed after Edit']});
  await page.close();
 }
 receipt.passed=true; console.log('PASS simulator categories, scoped search, completed buildings and edit/run/edit preservation in both modes');
}finally{await browser.close();fs.writeFileSync(`${out}/receipt.json`,JSON.stringify(receipt,null,2));}
