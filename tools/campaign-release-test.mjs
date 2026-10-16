// Release acceptance on the release tool's smoke twin (same page/runtime/data, sign-in gate disabled).
// Native short-operation fixtures test progress plumbing; they are NOT full campaign playthroughs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from '../web/node_modules/playwright-core/index.mjs';
import {browserArgs,browserExecutable} from './browser-launch.mjs';
const base=process.argv[2];
const progressOnly=process.argv.includes('--progress-only');
if(!base)throw Error('usage: node tools/campaign-release-test.mjs <smoke-page-url> [output-dir]');
const out=process.argv[3]??'artifacts/campaign-live-20261016';fs.mkdirSync(out,{recursive:true});
const catalog=JSON.parse(fs.readFileSync('content/missions.json','utf8'));
const story=JSON.parse(fs.readFileSync('../RTSAI-Mod/resources/campaign-story.json','utf8'));
const browser=await chromium.launch({executablePath:browserExecutable(),headless:true,args:browserArgs()});
const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];const films=[];const launches=[];
page.on('pageerror',e=>errors.push(String(e)));
await page.addInitScript(()=>localStorage.setItem('rtsai.cocommander',JSON.stringify({enabled:false,mode:'browser',muted:true,auto:false,browserVersion:1})));
const state=()=>page.evaluate(()=>{const s=window.store.getState();return {phase:s.phase,error:s.error,id:s.ui?.mission?.id,tick:s.ui?.tick,win:s.ui?.win};});
const setup=async()=>{await page.waitForFunction(()=>['setup','error'].includes(window.store?.getState().phase),null,{timeout:600000});assert.equal((await state()).phase,'setup',JSON.stringify(await state()));};
const playing=async(id)=>{await page.waitForFunction(id=>window.store.getState().phase==='error'||window.store.getState().ui?.mission?.id===id,id,{timeout:600000});assert.equal((await state()).phase,'playing',JSON.stringify(await state()));};
const movie=async(id)=>{
 await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2,null,{timeout:120000});
 const video=page.locator('video');
 await video.evaluate(async v=>{v.muted=true;await v.play();});
 await page.waitForFunction(()=>document.querySelector('video')?.currentTime>0.15,null,{timeout:30000});
 const r=await video.evaluate(async v=>{v.pause();const end=new Promise(r=>v.addEventListener('seeked',r,{once:true}));v.currentTime=5;await end;return {duration:v.duration,time:v.currentTime,ready:v.readyState};});
 await page.waitForFunction(()=>document.querySelector('track')?.readyState===2,null,{timeout:30000});
 assert(r.duration>15&&Math.abs(r.time-5)<0.1,JSON.stringify(r));films.push({id,...r,captions:true});console.log('Film passed:',id);
};
try{
 await page.goto(new URL('?mode=missions',base).href);await setup();
 assert.equal(await page.locator('select:visible').count(),0,'native campaign picker');
 // All 13 operation films, plus the prologue and epilogue.
 for(const part of (progressOnly?[]:[story.prologue,story.epilogue].filter(Boolean))){
  await page.getByRole('button',{name:`${part.eyebrow}: ${part.title}`,exact:true}).click();await movie(part.id);
 }
 for(const def of (progressOnly?[]:catalog)){
  await page.locator(`button[data-chapter="${def.id}"]`).click();
  await page.getByRole('button',{name:'Watch story introduction',exact:true}).click();await movie(def.id);
  if(def.id==='sweet-water')await page.screenshot({path:path.join(out,'campaign.png')});
 }
 // Every real catalog mission launches through the player UI and advances native ticks.
 for(const def of (progressOnly?[]:catalog)){
  await page.locator(`button[data-chapter="${def.id}"]`).click();
  const start=page.getByRole('button',{name:'Start mission',exact:true});
  await start.click({timeout:600000});await playing(def.id);
  await page.waitForFunction(()=>window.store.getState().ui.tick>25,null,{timeout:60000});
  const s=await page.evaluate(()=>window.store.getState().ui.mission);
  assert.deepEqual(s.objectives.map(o=>o.text),def.objectives.map(o=>o.text));
  launches.push({id:def.id,tick:(await state()).tick,objectives:s.objectives.length});console.log('Mission launched:',def.id);
  if(def.id==='jizan-corridor')await page.screenshot({path:path.join(out,'mission.png')});
  await page.evaluate(()=>window.game.quit());await setup();
 }
 // Native victory, not a forged UI Won state: a three-second controlled objective on the real map.
 await page.reload();await setup();
 const def=catalog.find(m=>m.id==='jizan-corridor');
 await page.locator(`button[data-chapter="${def.id}"]`).click();
 console.log('Preparing native progress fixture.');
 await page.waitForFunction(id=>{const s=window.store.getState();return s.preparedMap===id&&s.sheets.uploaded>=s.sheets.total;},def.id,{timeout:120000});
 await page.evaluate(m=>window.game.start(JSON.stringify({map:m.id,seed:2026,players:[{slot:m.slot,faction:m.faction,color:'2A6FDB'}],options:{difficulty:'normal',fog:'True',explored:'False'},operation:{id:m.id,title:m.title,faction:m.faction,slot:m.slot,enemy:m.enemy,objectives:[{text:'Controlled acceptance: survive three seconds',kind:'survive',seconds:3}]}})),def);
 await playing(def.id);
 console.log('Native progress fixture launched.');
 await page.waitForFunction(()=>window.store.getState().ui?.win==='Won',null,{timeout:60000});
 await page.getByRole('heading',{name:'Operation complete',exact:true}).waitFor();
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('rtsai.missions.completed')??'{}')['jizan-corridor']==='normal');
 await page.screenshot({path:path.join(out,'native-progress.png')});
 await page.getByRole('button',{name:'Continue to next chapter',exact:true}).click();
 await page.getByRole('heading',{name:'Hodeidah Lifeline',exact:true}).waitFor();
 assert.match(await page.locator('button[data-chapter="jizan-corridor"]').innerText(),/Completed/);
 await page.getByRole('button',{name:'Start mission',exact:true}).click({timeout:120000});await playing('hodeidah-lifeline');
 await page.evaluate(()=>window.game.quit());await setup();
 await page.reload();await setup();
 await page.getByRole('heading',{name:'Hodeidah Lifeline',exact:true}).waitFor();
 assert.equal(await page.locator('button[data-chapter="hodeidah-lifeline"]').getAttribute('aria-pressed'),'true');
 assert.match(await page.locator('button[data-chapter="jizan-corridor"]').innerText(),/Completed/);
 assert.equal(errors.length,0,JSON.stringify(errors));
 const report={passed:true,url:base,checkedAt:new Date().toISOString(),films,launches,nativeProgressFixture:{objective:'survive three seconds',outcome:'Won',storage:true,nextChapter:true,reload:true,fullCampaignPlaythrough:false},errors};
 fs.writeFileSync(path.join(out,'release-acceptance.json'),JSON.stringify(report,null,2));console.log('PASS:',films.length,'films,',launches.length,'mission launches; native progress fixture and reload.');
}catch(e){fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({error:String(e),state:await state().catch(()=>null),loading:await page.evaluate(()=>({prepared:window.store.getState().preparedMap,sheets:window.store.getState().sheets,stage:window.store.getState().stage})).catch(()=>null),films,launches,errors},null,2));await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw e;}
finally{await browser.close();}
