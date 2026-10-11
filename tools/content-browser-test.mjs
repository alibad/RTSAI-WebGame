import {browserExecutable, browserArgs} from './browser-launch.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
const browser = await chromium.launch({executablePath:browserExecutable(),headless:true,args:browserArgs()});
const page = await browser.newPage({viewport:{width:1600,height:1000}});
page.setDefaultTimeout(60000);
const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
const out=path.resolve(process.env.RTSAI_TEST_OUT||'artifacts/content');fs.mkdirSync(out,{recursive:true});
try {
  await page.goto(process.env.RTSAI_TEST_URL || `http://127.0.0.1:3505/?profile=${process.env.RTSAI_TEST_PROFILE || "public"}&runtime=interp`);
  await page.waitForFunction(()=>['setup','error'].includes(window.store?.getState().phase),null,{timeout:180000});
  assert.equal(await page.evaluate(()=>window.store.getState().phase),'setup');
  const catalog=await page.evaluate(()=>window.store.getState().setup);
  assert.equal(catalog.factions.filter(f=>!f.random).length,16);assert.equal(catalog.missions.length,6);
  await page.screenshot({path:path.join(out,'main-menu.png')});
  await page.getByRole('button',{name:'Skirmish',exact:false}).first().click();
  await page.getByRole('button',{name:'America',exact:false}).first().waitFor({timeout:30000});
  await page.screenshot({path:path.join(out,'factions.png')});
  await page.getByRole('button',{name:'Campaign',exact:true}).click();
  await page.getByRole('button',{name:'Start mission',exact:true}).waitFor({timeout:120000});
  await page.screenshot({path:path.join(out,'missions.png')});
  for(const mission of catalog.missions) {
    await page.getByRole('button',{name:mission.title,exact:false}).first().click();
    await page.getByRole('button',{name:'Start mission',exact:true}).waitFor({timeout:120000});
    await page.getByRole('button',{name:'Start mission',exact:true}).click();
    await page.waitForFunction(()=>['playing','error'].includes(window.store.getState().phase),null,{timeout:120000});
    assert.equal(await page.evaluate(()=>window.store.getState().phase),'playing');
    await page.waitForFunction(id=>window.store.getState().ui?.mission?.id===id,mission.id,{timeout:30000});
    await page.waitForTimeout(1200);
    assert.ok(await page.evaluate(()=>window.store.getState().ui.mission.objectives.length));
    await page.screenshot({path:path.join(out,`${mission.id}.png`)});
    console.log(`PASS browser mission ${mission.id}`);
    await page.evaluate(()=>window.game.quit());
    await page.waitForFunction(()=>window.store.getState().phase==='setup',null,{timeout:30000});
  }
  assert.deepEqual(errors,[]);console.log('PASS16 factions,6 mission launches, no browser errors');
} finally {await browser.close();}
