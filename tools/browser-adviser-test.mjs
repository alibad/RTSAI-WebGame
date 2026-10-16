// Public co-commander acceptance against the actual native AOT game, with no companion server or model calls.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {browserExecutable,browserArgs} from './browser-launch.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),opt=(key,fallback)=>{const i=args.indexOf('--'+key);return i<0?fallback:args[i+1];};
const base=opt('url','http://127.0.0.1:39818/'),out=path.resolve(opt('out','artifacts/browser-adviser'));
assert(!fs.existsSync(out),'Choose a fresh output directory to preserve receipts');fs.mkdirSync(out,{recursive:true});
const module=process.env.RTSAI_PLAYWRIGHT_MODULE??path.join(repo,'web/node_modules/playwright-core/index.mjs');
const {chromium}=await import(pathToFileURL(module).href);
const browser=await chromium.launch({executablePath:browserExecutable(),headless:true,args:browserArgs()});
const receipt={scope:'Real native Observe, proposal confirmation and native order receipts in both public modes; mouse and emulated touch, no physical-device acceptance',modes:[],errors:[],localServiceRequests:[]};let page;
try {
 for(const profile of ['public','public-classic']){
  const context=await browser.newContext({viewport:{width:1440,height:900},hasTouch:true});page=await context.newPage();
  await context.addInitScript(()=>{if(!localStorage.getItem('rtsai.cocommander'))localStorage.setItem('rtsai.cocommander',JSON.stringify({enabled:true,mode:'local',muted:true}));});
  await context.route('**/*',r=>{const u=new URL(r.request().url());if(/\/(companion\/|api\/companion)/.test(u.pathname))receipt.localServiceRequests.push(u.pathname);return u.origin===new URL(base).origin&&r.request().method()==='GET'?r.continue():r.abort();});
  page.on('pageerror',e=>receipt.errors.push(String(e)));
  await page.goto(`${base}?profile=${profile}&private=0&mode=skirmish`);await page.waitForFunction(()=>['setup','error'].includes(window.store?.getState().phase),null,{timeout:180000});
  assert.equal(await page.evaluate(()=>window.store.getState().phase),'setup');
  assert.deepEqual(await page.evaluate(()=>{const s=window.store.getState();return {enabled:s.cc.enabled,mode:s.cc.mode,available:s.ccAvailable};}),{enabled:true,mode:'browser',available:true});
  assert(await page.getByRole('switch',{name:'Built-in adviser',exact:true}).isVisible());
  const mode={profile,checks:['Legacy disabled local preference migrates once to visible browser adviser'],receipts:[]};receipt.modes.push(mode);
  const start=async()=>{await page.evaluate(()=>{const s=window.store.getState(),m=s.setup.maps.find(m=>m.id==='web-arena-four')??s.setup.maps[0];window.game.start(JSON.stringify({map:m.id,seed:777,players:[{slot:m.slots[0],faction:'america',color:'2A6FDB'},{slot:m.slots[1],faction:'iran',bot:'normal',color:'A62121'}],options:{startingunits:'none',startingcash:'10000',fog:'True',explored:'False',shortgame:'False'}}));});await page.waitForFunction(()=>window.store.getState().phase==='playing'&&window.game.cc.pending(),null,{timeout:120000});};
  const pending=()=>page.evaluate(()=>window.game.cc.pending());
  const native=()=>page.evaluate(()=>window.game.client.adviserObserve());
  const apply=async(key='j')=>{const p=await pending();assert(p?.proposalId);await page.locator('canvas.stage').focus();await page.keyboard.press(key);await page.waitForFunction(id=>window.game.cc.receipts.has(id),p.proposalId,{timeout:15000});const r=await page.evaluate(id=>window.game.cc.receipts.get(id),p.proposalId);assert.equal(r.accepted,true,r.detail);mode.receipts.push({proposalId:p.proposalId,...r});return p;};
  const capture=async(name)=>{await page.waitForFunction(()=>window.game.renderer.stats.draws>0&&window.game.renderer.stats.skipped===0,null,{timeout:15000});await page.screenshot({path:path.join(out,name)});};
  await start();assert.equal((await pending()).commands[0].action,'deploy');
  await page.getByRole('button',{name:'Apply recommendation (J)',exact:true}).waitFor();
  let observation=await native();assert.equal(observation.buildings.length,0);assert.equal(observation.visibleEnemies.length,0);assert.equal(observation.visibleEnemyBuildings.length,0);
  await page.waitForTimeout(1300);assert.equal((await native()).buildings.length,0);mode.checks.push('Automatic suggestion is visible; no order executes before confirmation; hidden enemy units/buildings absent');
  await capture(`${profile}-deploy-suggestion.png`);await apply('j');await page.waitForFunction(()=>window.game.client.cur.actors.some(a=>window.game.client.str(a.type)==='gacnst'));
  mode.checks.push('J applies actual native MCV deploy; accepted receipt and Construction Yard');
  assert(await page.evaluate(()=>{const cc=window.game.cc,before=JSON.stringify(window.store.getState().cc.feed),receipt=[...cc.receipts.keys()][0];cc.onEngine({kind:'executed',id:'browser-unrelated-old-world',accepted:true,detail:'late fixture'});cc.onEngine({kind:'executed',id:receipt,accepted:true,detail:'duplicate fixture'});return JSON.stringify(window.store.getState().cc.feed)===before;}));mode.checks.push('Unrelated and duplicate engine events do not create phantom results');
  await page.waitForFunction(()=>window.game.cc.pending()?.commands[0].action==='build',null,{timeout:15000});
  const building=await pending();const power=building.commands[0].item_type;
  await page.evaluate(()=>window.game.setPaused(true));await page.waitForFunction(()=>window.store.getState().paused);
  assert(await page.getByRole('button',{name:'Apply recommendation (J)',exact:true}).isDisabled());await page.keyboard.press('j');assert.equal(await page.evaluate(id=>window.game.cc.receipts.has(id),building.proposalId),false);mode.checks.push('Pause blocks Apply and confirmation hotkey');
  await page.evaluate(()=>window.game.setPaused(false));await page.waitForFunction(()=>!window.store.getState().paused);
  await page.evaluate(()=>{window.__adviserDispatches=0;const c=window.game.client,original=c.adviserExecute.bind(c);c.adviserExecute=(...args)=>{window.__adviserDispatches++;return original(...args);};});
  await page.locator('canvas.stage').focus();await page.keyboard.down('j');await page.keyboard.down('j');await page.keyboard.up('j');await page.waitForFunction(id=>window.game.cc.receipts.has(id),building.proposalId,{timeout:15000});
  assert.equal(await page.evaluate(()=>window.__adviserDispatches),1);assert.equal(await page.evaluate(id=>window.game.cc.receipts.get(id).accepted,building.proposalId),true);mode.checks.push('G builds through native queue; held/repeated key dispatches once');
  await page.waitForFunction(()=>window.game.cc.pending()?.commands[0].action==='place_building',null,{timeout:90000});
  const ready=await pending();assert.equal(ready.commands[0].item_type,power);await capture(`${profile}-ready-building-suggestion.png`);
  const before=await page.evaluate(()=>window.__adviserDispatches);await page.evaluate(old=>window.game.cc.decide(old,true),building);assert.equal(await page.evaluate(()=>window.__adviserDispatches),before);mode.checks.push('Old displayed recommendation cannot apply after production state changes');
  await page.setViewportSize({width:844,height:390});await page.getByRole('button',{name:'Apply recommendation (J)',exact:true}).tap();await page.waitForFunction(id=>window.game.cc.receipts.has(id),ready.proposalId,{timeout:15000});
  assert.equal(await page.evaluate(id=>window.game.cc.receipts.get(id).accepted,ready.proposalId),true);await page.waitForFunction(type=>window.game.client.cur.actors.some(a=>window.game.client.str(a.type)===type),power);mode.checks.push('Touch Apply places finished building using native legal-cell search');
  await page.waitForFunction(()=>!!window.game.cc.pending(),null,{timeout:15000});const cancelled=await pending();await page.getByTitle('Cancel',{exact:true}).tap();await page.waitForTimeout(2300);assert.equal(await pending(),undefined);assert.equal(await page.evaluate(id=>window.game.cc.receipts.has(id),cancelled.proposalId),false);mode.checks.push('Cancel suppresses unchanged suggestion and sends no native orders');
  await page.getByRole('button',{name:'Show feed',exact:true}).tap();await page.getByRole('button',{name:'Next suggestion',exact:true}).tap();await page.waitForFunction(()=>!!window.game.cc.pending(),null,{timeout:15000});assert.notEqual((await pending()).proposalId,cancelled.proposalId);mode.checks.push('Next suggestion explicitly reoffers a cancelled step with a fresh ID');
  await capture(`${profile}-co-commander-touch.png`);
  // No stale advice or requests survive a world replacement.
  const previous=await pending();await page.evaluate(()=>window.game.quit());await page.waitForFunction(()=>window.store.getState().phase==='setup');await start();const beforeRestart=await page.evaluate(()=>window.__adviserDispatches);await page.evaluate(old=>window.game.cc.decide(old,true),previous);assert.equal(await page.evaluate(()=>window.__adviserDispatches),beforeRestart);mode.checks.push('New world rejects old proposal IDs');
  await page.evaluate(()=>window.game.quit());await page.waitForFunction(()=>window.store.getState().phase==='setup');await page.getByRole('switch',{name:'Built-in adviser',exact:true}).tap();assert.equal(await page.evaluate(()=>window.store.getState().cc.enabled),false);
  await page.reload();await page.waitForFunction(()=>window.store?.getState().phase==='setup',null,{timeout:180000});assert.equal(await page.evaluate(()=>window.store.getState().cc.enabled),false);mode.checks.push('Explicit new browser opt-out persists across reload');
  console.log(profile,mode.checks);await context.close();
 }
 assert.deepEqual(receipt.errors,[]);assert.deepEqual(receipt.localServiceRequests,[]);receipt.passed=true;
}catch(error){receipt.passed=false;receipt.error=String(error);console.error(error);if(page){receipt.state=await page.evaluate(()=>({phase:window.store.getState().phase,cc:window.store.getState().cc})).catch(()=>null);await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}process.exitCode=1;}
finally{await browser.close();fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');}
