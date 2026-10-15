import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from '../web/node_modules/playwright-core/index.mjs';
import {browserExecutable,browserArgs} from './browser-launch.mjs';
const base=process.env.RTSAI_TEST_URL||'http://127.0.0.1:3518/';
const runtime=process.env.RTSAI_TEST_RUNTIME||'aot';
const out=path.resolve(process.env.RTSAI_TEST_OUT||'artifacts/voice');fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({executablePath:browserExecutable(),headless:true,args:browserArgs()});
const receipt={scope:'Actual local browser engine voice-family resolution, audio fetch/PCM, persistence and simulation invariance; not human audio audition',runtime,modes:[],errors:[]};
try {for(const [mode,profile] of [['classic','public-classic'],['isometric','public']]) {
 const context=await browser.newContext({viewport:{width:1440,height:900}});const page=await context.newPage();const audioRequests=[];
 page.on('pageerror',e=>receipt.errors.push(String(e)));page.on('request',r=>{if(/rcn-infantry-select-(zh|en)/.test(r.url()))audioRequests.push(r.url());});
 await page.goto(`${base}?profile=${profile}&runtime=${runtime}&private=0`);
 async function setup(){await page.waitForFunction(()=>['setup','error'].includes(window.store?.getState().phase),null,{timeout:240000});assert.equal(await page.evaluate(()=>window.store.getState().phase),'setup');}
 await setup();console.log(`READY ${mode} ${runtime}`);
 const initial=await page.evaluate(()=>window.game.client.voiceLanguage());assert.equal(initial.language,'faction');
 const scenario=await page.evaluate(()=>{const map=window.store.getState().setup.maps.find(m=>m.slots.length>=2&&!m.id.startsWith('mission-'));return{map:map.id,seed:303,players:[{slot:map.slots[0],faction:'china',color:'2A6FDB'}],options:{fog:'False',explored:'True',startingunits:'none'},spawns:[{type:'r2cnrifle',player:0,x:20,y:20}]};});
 async function start(){await page.evaluate(s=>{window.game.start(JSON.stringify(s),true);},scenario);await page.waitForFunction(()=>['playing','error'].includes(window.store.getState().phase),null,{timeout:180000});assert.equal(await page.evaluate(()=>window.store.getState().phase),'playing');await page.evaluate(()=>{window.game.client.send({type:'view',x0:-100000,y0:-100000,x1:100000,y1:100000});});await page.waitForFunction(()=>window.game.client.cur?.actors.some(a=>window.game.client.strings[a.type]==='r2cnrifle'),null,{timeout:60000});await page.evaluate(async()=>{const g=window.game,a=g.client.cur.actors.find(a=>g.client.strings[a.type]==='r2cnrifle');g.lookAt(a.sx,a.sy-a.sz);await g.client.request({type:'select',ids:[a.id],additive:false});window.voiceEvents=[];g.client.on('audio',m=>{if(m.op==='source')window.voiceEvents.push({op:m.op,id:m.id,bytes:m.data.byteLength,rate:m.rate});if(m.op==='play')window.voiceEvents.push({op:m.op,source:m.source});});});}
 await start();console.log(`STARTED ${mode}`);
 await page.getByRole('button',{name:'Settings',exact:true}).click();const selector=page.getByLabel('Unit voice language');assert.match(await selector.innerText(),/Faction language/);
 const before=await page.evaluate(()=>window.game.client.voiceLanguage());
 async function preview(language,suffix){await selector.click();await page.getByRole('option',{name:language==='en'?'English':'Faction language',exact:true}).click();await page.waitForFunction(l=>localStorage.getItem('rtsai.voiceLanguage.v1')===l,language);let result;for(let i=0;i<12;i++){result=await page.evaluate(()=>window.game.client.previewVoice());if(result.played)break;await page.waitForTimeout(250);}assert.equal(result.language,language);assert.equal(result.family,`r2chinainfantryvoice__${language}`);assert.ok(result.files.some(f=>f.endsWith(`rcn-infantry-select-${suffix}.wav`)),JSON.stringify(result));assert.equal(result.played,true);assert.equal(result.syncHash,before.syncHash);assert.equal(result.tick,before.tick);return result;}
 const faction=await preview('faction','zh'),english=await preview('en','en');
 await page.screenshot({path:path.join(out,`${mode}-voice-settings.png`)});
 const stale=await page.evaluate(async()=>{const g=window.game;g.client.worker.postMessage({type:'voiceLanguage',value:'faction',req:-7,generation:g.client.generation-1});await new Promise(r=>setTimeout(r,100));return g.client.voiceLanguage();});assert.equal(stale.language,'en');assert.equal(stale.syncHash,before.syncHash);
 const events=await page.evaluate(()=>window.voiceEvents);assert.ok(events.some(e=>e.op==='source'&&e.bytes>1000));assert.ok(events.some(e=>e.op==='play'));
 await page.reload();await setup();assert.equal((await page.evaluate(()=>window.game.client.voiceLanguage())).language,'en');await start();const fresh=await page.evaluate(()=>window.game.client.previewVoice());assert.equal(fresh.family,'r2chinainfantryvoice__en');
 await page.evaluate(()=>localStorage.setItem('rtsai.voiceLanguage.v1','unexpected'));await page.reload();await setup();assert.equal((await page.evaluate(()=>window.game.client.voiceLanguage())).language,'faction');await start();assert.equal((await page.evaluate(()=>window.game.client.previewVoice())).family,'r2chinainfantryvoice__faction');
 await page.getByRole('button',{name:'Settings',exact:true}).click();assert.match(await page.getByLabel('Unit voice language').innerText(),/Faction language/);await page.getByLabel('Unit voice language').click();await page.getByRole('option',{name:'English',exact:true}).click();await page.getByRole('button',{name:'Reset settings',exact:true}).click();await page.waitForFunction(()=>localStorage.getItem('rtsai.voiceLanguage.v1')==='faction');
 receipt.modes.push({mode,profile,initial,before,faction,english,stale,persistenceReload:true,freshWorld:true,invalidFallback:true,reset:true,pcmEvents:events,audioRequests});
 await page.evaluate(()=>window.game.quit());await context.close();console.log(`PASS ${mode} voice language/audio/persistence/hash/generation`);
 }assert.deepEqual(receipt.errors,[]);receipt.passed=true;}finally{fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');await browser.close();}
