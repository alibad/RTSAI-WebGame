// Campaign UI and media acceptance. Synthetic outcome states test UI only, not mission victory logic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
const url = process.env.CAMPAIGN_TEST_URL ?? 'http://127.0.0.1:3489/?mode=missions&profile=public';
const story = JSON.parse(fs.readFileSync('../RTSAI-Mod/resources/campaign-story.json','utf8'));
const missions = JSON.parse(fs.readFileSync('content/missions.json','utf8'));
assert.deepEqual(Object.keys(story.chapters).sort(), missions.map(m=>m.id).sort());
assert.equal(new Set(story.arcs.flatMap(a=>a.missions)).size,6);
const out='artifacts/campaign-story';fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({executablePath:path.join(process.env.LOCALAPPDATA,'ms-playwright/chromium-1228/chrome-win64/chrome.exe'),headless:true,args:['--use-angle=d3d11','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];const media=[];
page.on('pageerror',e=>errors.push(String(e)));
page.on('requestfailed',r=>console.log('Request failed:',r.url(),r.failure()?.errorText));
page.on('console',m=>{if(['error','warning'].includes(m.type()))console.log('Browser:',m.text());});
try {
  await page.goto(url);
  await page.waitForFunction(()=>['setup','error'].includes(window.store?.getState().phase),null,{timeout:600000});
  assert.equal(await page.evaluate(()=>window.store.getState().phase),'setup',JSON.stringify(await page.evaluate(()=>({error:window.store.getState().error,stage:window.store.getState().stage}))));
  console.log('Campaign setup loaded.');
  await page.getByRole('heading',{name:story.title,exact:true}).waitFor();
  for(const arc of story.arcs)for(const id of arc.missions){
    const m=missions.find(m=>m.id===id);
    await page.getByRole('button',{name:new RegExp(m.title)}).click();
    await page.getByRole('button',{name:'Watch story introduction',exact:true}).click();
    const video=page.locator('video');
    await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2,null,{timeout:60000});
    const result=await video.evaluate(async v=>{v.muted=true;await v.play();await new Promise(r=>setTimeout(r,600));const t=v.currentTime;v.pause();v.currentTime=5;await new Promise(r=>v.addEventListener('seeked',r,{once:true}));return {duration:v.duration,advanced:t>0,seek:v.currentTime,source:v.currentSrc};});
    assert(result.advanced && result.duration>15 && Math.abs(result.seek-5)<0.1,JSON.stringify(result));
    await page.waitForFunction(()=>document.querySelector('track')?.readyState===2,null,{timeout:30000});
    media.push({id,...result,captions:true});
    console.log('Media passed:',id);
    if(id==='jizan-corridor')await page.screenshot({path:`${out}/campaign-preview.png`,fullPage:true});
  }
  // A missing movie must not block the written briefing or playable mission.
  await page.getByRole('button',{name:/Jizan Corridor/}).click();
  await page.route('**/campaign-video/jizan-corridor.mp4',route=>route.abort());
  await page.getByRole('button',{name:'Watch story introduction',exact:true}).click();
  await page.getByRole('status').filter({hasText:'video could not load'}).waitFor({timeout:30000});
  console.log('Missing-video fallback passed.',await page.evaluate(()=>({phase:window.store.getState().phase,prepared:window.store.getState().preparedMap,sheets:window.store.getState().sheets,error:window.store.getState().error})));
  await page.unroute('**/campaign-video/jizan-corridor.mp4');
  // Launch the actual mission through the player UI.
  await page.getByRole('button',{name:'Start mission',exact:true}).waitFor({timeout:600000});
  await page.getByRole('button',{name:'Play briefing & deploy',exact:true}).click();
  console.log('Playing deploy briefing.');
  await page.waitForFunction(()=>document.querySelector('video')?.currentTime>0,null,{timeout:30000});
  await page.locator('video').evaluate(v=>{v.muted=true;v.currentTime=v.duration-0.2;});
  await page.waitForFunction(()=>window.store.getState().phase==='playing',null,{timeout:600000});
  console.log('Native mission launched.');
  await page.waitForFunction(()=>window.store.getState().ui?.mission?.id==='jizan-corridor',null,{timeout:60000});
  // Pause native play; inject outcomes solely to verify progress/debrief/navigation.
  await page.evaluate(()=>{window.game.setPaused(true);window.game.onUi=()=>{};});
  await page.evaluate(()=>{const s=window.store.getState();s.set({ui:{...s.ui,win:'Lost'}});});
  await page.getByRole('heading',{name:'Regroup and retry'}).waitFor();
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('rtsai.missions.completed')??'{}')['jizan-corridor']),undefined);
  await page.evaluate(()=>{const s=window.store.getState();s.set({ui:{...s.ui,win:'Won'}});});
  await page.getByRole('heading',{name:'Operation complete'}).waitFor();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('rtsai.missions.completed')??'{}')['jizan-corridor']==='normal');
  await page.getByRole('button',{name:'Continue to next chapter'}).click();
  await page.getByRole('heading',{name:'Hodeidah Lifeline',exact:true}).waitFor();
  await page.reload();
  await page.getByRole('heading',{name:'Hodeidah Lifeline',exact:true}).waitFor({timeout:600000});
  assert.equal(await page.getByRole('button',{name:/Jizan Corridor/}).getAttribute('aria-pressed'),'false');
  assert.equal(errors.length,0,JSON.stringify(errors));
  fs.writeFileSync(`${out}/acceptance.json`,JSON.stringify({passed:true,media,realMissionLaunch:'jizan-corridor',launchAfterVideo:true,syntheticOutcomeUi:['loss-does-not-complete','victory-saves','next-chapter','reload-persists'],videoFailureFallback:true,errors},null,2));
  console.log('Six movies played and sought with captions; real mission launched; synthetic debrief/navigation and reload checks passed.');
}finally{await browser.close();}
