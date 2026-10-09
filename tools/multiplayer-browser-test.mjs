import {chooseLobbyOption} from './lobby-picker.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from '../web/node_modules/playwright-core/index.mjs';
const base=process.env.RTSAI_TEST_URL||'http://127.0.0.1:3491/';
const exe=path.join(process.env.LOCALAPPDATA,'ms-playwright','chromium-1228','chrome-win64','chrome.exe');
const browser=await chromium.launch({executablePath:exe,headless:process.env.RTSAI_TEST_HEADED!=='1',args:['--use-angle=d3d11','--enable-gpu','--ignore-gpu-blocklist']});
const contexts=await Promise.all([browser.newContext({viewport:{width:1440,height:900}}),browser.newContext({viewport:{width:1440,height:900}})]);
const pages=await Promise.all(contexts.map(c=>c.newPage()));
let credentials;let hostOrderPackets=0;const errors=[];
for(const [i,p] of pages.entries()) {p.on('request',r=>{if(i===0&&r.url().endsWith('/api/multiplayer')){try{const b=r.postDataJSON();hostOrderPackets+=(b.events||[]).filter(e=>e.kind==='orders'&&e.data.length>0).length;}catch{}}});p.on('pageerror',e=>errors.push(`client ${i+1}: ${e}`));p.on('response',async r=>{if(r.url().endsWith('/api/multiplayer')){try{const b=await r.json();if(b.token&&i===0)credentials={room:b.id,token:b.token};}catch{}}});}
try{
 await Promise.all(pages.map(p=>p.goto(`${base}?profile=public&runtime=interp&private=0`)));
 await Promise.all(pages.map(p=>p.waitForFunction(()=>window.store?.getState().phase==='setup'||window.store?.getState().phase==='error',null,{timeout:240000})));
 for(const p of pages){assert.equal(await p.evaluate(()=>window.store.getState().phase),'setup',await p.evaluate(()=>window.store.getState().error));await p.evaluate(()=>{window.networkErrors=[];window.networkLast=null;window.game.client.on('networkStatus',m=>{window.networkLast={...m,at:Date.now()};if(m.error)window.networkErrors.push(m.error);});});}
 await pages[0].getByRole('button',{name:'Private multiplayer',exact:true}).click();await pages[0].getByRole('button',{name:'Create private room',exact:true}).click();
 await pages[0].getByLabel('Room invite').waitFor({timeout:60000});const invite=await pages[0].getByLabel('Room invite').inputValue();console.log('Private room created');
 await pages[1].getByRole('button',{name:'Private multiplayer',exact:true}).click();await pages[1].getByLabel('Invite link or room code').fill(invite);await pages[1].route('**/_framework/dotnet.js',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text())+'\n// incompatible test build'});});await pages[1].getByRole('button',{name:'Join room',exact:true}).click();await pages[1].getByRole('alert').filter({hasText:'Incompatible game version'}).waitFor({timeout:60000});await pages[1].unroute('**/_framework/dotnet.js');await pages[1].getByRole('button',{name:'Join room',exact:true}).click();console.log('Browser rejected incompatible game build');
 await pages[1].getByLabel('Player 2 faction').waitFor({timeout:60000});
 const map=await pages[0].evaluate(()=>window.store.getState().setup.maps.find(m=>m.slots.length>=3)?.id);
 assert.ok(map,'No map supports optional AI');
 if(map){await chooseLobbyOption(pages[0],'Multiplayer map',map);await pages[0].getByRole('button',{name:'Add AI',exact:true}).click();await chooseLobbyOption(pages[0],'AI 1 team','2');}
 await chooseLobbyOption(pages[1],'Player 2 faction','iran');await chooseLobbyOption(pages[1],'Player 2 team','2');
 fs.mkdirSync('artifacts/multiplayer',{recursive:true});await pages[0].screenshot({path:'artifacts/multiplayer/lobby.png'});
 await pages[0].getByRole('button',{name:'Ready',exact:true}).click();await pages[1].getByRole('button',{name:'Ready',exact:true}).click();await pages[0].getByRole('button',{name:'Start synchronized match'}).click();
 await Promise.all(pages.map(p=>p.waitForFunction(()=>['playing','error'].includes(window.store.getState().phase),null,{timeout:240000})));
 for(const p of pages)assert.equal(await p.evaluate(()=>window.store.getState().phase),'playing',await p.evaluate(()=>window.store.getState().error));
 console.log('Both independent browser worlds started');
 await pages[0].evaluate(()=>window.game.setPaused(true));assert.equal(await pages[0].evaluate(()=>window.store.getState().paused),false);
 const poll=async()=>{const r=await fetch(new URL('api/multiplayer',base),{method:'POST',body:JSON.stringify({op:'poll',...credentials})});return r.json();};
 const config=await poll();assert.equal(config.scenario.players.length,3);assert.ok(config.scenario.players[2].bot);console.log('Actual browser match includes AI opponent controlled by host');
 const deadline=Date.now()+120000;let r;
 while(Date.now()<deadline){r=await poll();if(r.error)throw Error(r.error+' pageErrors='+JSON.stringify(errors)+' '+JSON.stringify(await Promise.all(pages.map(p=>p.evaluate(()=>({network:window.networkErrors,last:window.networkLast,visibility:document.visibilityState,phase:window.store.getState().phase,perf:window.store.getState().perf,error:window.store.getState().error}))))));if(r.verifiedFrame>=240)break;await new Promise(r=>setTimeout(r,500));}
 assert.ok(r.verifiedFrame>=240,JSON.stringify(r));console.log(`Verified matching OpenRA hashes through frame ${r.verifiedFrame}`);
 const strip=pages[0].getByRole('region',{name:'Multiplayer controls'});
 const bar=strip.locator('.mp-match-bar');const quietText=await bar.innerText();const quietBox=await bar.boundingBox();await pages[0].waitForTimeout(1200);
 assert.equal(await bar.innerText(),quietText,'Connection bar text flickers during healthy play');assert.deepEqual(await bar.boundingBox(),quietBox,'Connection bar changes size');
 assert.ok(!quietText.includes('ms')&&!quietText.includes('frame'),'Timing should stay behind details');
 await pages[0].screenshot({path:'artifacts/multiplayer/connection-bar.png'});
 await pages[0].getByRole('button',{name:'Connection details',exact:true}).click();await pages[0].getByText('Average request time',{exact:true}).waitFor();
 await pages[0].screenshot({path:'artifacts/multiplayer/connection-details.png'});await pages[0].getByRole('button',{name:'Close details',exact:true}).click();
 await strip.getByRole('button',{name:'Chat',exact:true}).click();await pages[0].getByLabel('Room chat message').fill('Holding the north flank.');await strip.getByRole('button',{name:'Send',exact:true}).click();
 await pages[0].getByText('Holding the north flank.',{exact:false}).waitFor();await pages[0].screenshot({path:'artifacts/multiplayer/connection-chat.png'});await strip.getByRole('button',{name:'Close room chat',exact:true}).click();
 console.log('Stable connection bar, optional timing details and room chat passed');
 assert.ok(hostOrderPackets>0,'AI never submitted any engine orders before human input');console.log(`AI submitted ${hostOrderPackets} nonempty host packets before human input`);
 for(const p of pages){await p.evaluate(async()=>{const g=window.game,s=g.client.cur;const mcv=s.actors.find(a=>a.owner===s.header.localPlayer&&g.client.str(a.type).includes('mcv'));if(!mcv)throw Error('No local MCV');await g.select([mcv.id]);});await p.waitForTimeout(200);await p.evaluate(()=>window.game.command({cmd:'deploy'}));}
 console.log('Both players issued serialized deploy orders');
 await pages[1].route('**/api/multiplayer',async route=>{await new Promise(r=>setTimeout(r,120));await route.continue();});
 const before=r.frame;await new Promise(r=>setTimeout(r,5000));r=await poll();assert.ok(r.frame>before);assert.equal(r.error,undefined);assert.ok(r.verifiedFrame>=before);console.log(`120 ms client latency: progressed ${r.frame-before} frames without desync`);
 fs.mkdirSync('artifacts/multiplayer',{recursive:true});await pages[0].screenshot({path:'artifacts/multiplayer/match-host.png'});await pages[1].screenshot({path:'artifacts/multiplayer/match-guest.png'});
 await contexts[1].close();await new Promise(r=>setTimeout(r,14000));r=await poll();assert.equal(r.state,'playing');assert.equal(r.players[1].connected,false);console.log('Disconnected guest detected; match waits during reconnect grace');
 const disconnectDeadline=Date.now()+55000;
 while(Date.now()<disconnectDeadline){r=await poll();if(r.state==='ended')break;await new Promise(r=>setTimeout(r,1000));}
 assert.equal(r.state,'ended');assert.match(r.error,/did not reconnect/);await pages[0].getByRole('alert').waitFor();console.log('Abrupt browser disconnect stopped match after grace and displayed reason');
 assert.deepEqual(errors,[]);console.log('Two-browser multiplayer test passed.');
}finally{await browser.close();}
