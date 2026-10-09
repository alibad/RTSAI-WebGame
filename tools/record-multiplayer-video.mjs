// Real two-client footage. Raw recordings and an editable shot list stay local.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from '../web/node_modules/playwright-core/index.mjs';
const out=path.resolve('artifacts/videos/multiplayer');
fs.mkdirSync(path.join(out,'raw'),{recursive:true});
const browser=await chromium.launch({executablePath:path.join(process.env.LOCALAPPDATA,'ms-playwright','chromium-1228','chrome-win64','chrome.exe'),headless:true,args:['--use-angle=d3d11','--enable-gpu','--ignore-gpu-blocklist']});
const contexts=[],pages=[],origins=[],shots=[];let credentials;
const base=process.env.RTSAI_TEST_URL||'http://127.0.0.1:3491/';
const hold=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const errors=[];
async function shot(client,id,title,caption,action,after=3200){const start=(performance.now()-origins[client])/1000;await hold(700);await action?.();await hold(after);const end=(performance.now()-origins[client])/1000;shots.push({id,client,start,end,title,caption});await pages[client].screenshot({path:path.join(out,`${id}.png`)});console.log(`Captured ${id}`);}
try{
 for(let i=0;i<2;i++){const c=await browser.newContext({viewport:{width:1280,height:800},recordVideo:{dir:path.join(out,'raw'),size:{width:1280,height:800}},permissions:['clipboard-write']});contexts.push(c);origins.push(performance.now());const p=await c.newPage();pages.push(p);p.on('pageerror',e=>errors.push(String(e)));}
 pages[0].on('response',async r=>{if(r.url().endsWith('/api/multiplayer')){try{const d=await r.json();if(d.token)credentials={room:d.id,token:d.token};}catch{}}});
 await Promise.all(pages.map(p=>p.goto(`${base}?profile=public&runtime=interp&private=0`)));
 await Promise.all(pages.map(p=>p.getByRole('button',{name:'Private multiplayer',exact:true}).waitFor({timeout:240000})));
 await pages[0].getByRole('button',{name:'Private multiplayer',exact:true}).click();
 await shot(0,'01-create','PLAYER 1 / HOST A MATCH','Create a private room. You will choose the battlefield.',()=>pages[0].getByRole('button',{name:'Create private room',exact:true}).click(),4200);
 await pages[0].getByLabel('Room invite').waitFor();const invite=await pages[0].getByLabel('Room invite').inputValue();
 await shot(0,'02-invite','PLAYER 1 / SHARE THE INVITE','Copy the invite and give it to the other commander.',()=>pages[0].getByRole('button',{name:'Copy invite',exact:true}).click(),2400);
 await pages[1].getByRole('button',{name:'Private multiplayer',exact:true}).click();
 await shot(1,'03-join','PLAYER 2 / JOIN THE ROOM','Open the invite, or paste it here and choose Join room.',async()=>{await pages[1].getByLabel('Invite link or room code').fill(invite);await hold(1700);await pages[1].getByRole('button',{name:'Join room',exact:true}).click();await pages[1].getByLabel('Player 2 faction').waitFor();},3500);
 const map=await pages[0].evaluate(()=>window.store.getState().setup.maps.find(m=>m.slots.length>=3)?.id);assert.ok(map);
 await shot(0,'04-map-ai','PLAYER 1 / SET UP THE BATTLEFIELD','Choose Four Fronts and add an optional AI opponent.',async()=>{await pages[0].getByLabel('Multiplayer map').selectOption(map);await pages[0].getByRole('button',{name:'Add AI',exact:true}).click();await pages[0].getByLabel('Player 1 faction').selectOption('saudi');},3500);
 await shot(1,'05-faction','PLAYER 2 / CHOOSE YOUR SIDE','Each commander picks a faction and team. Matching teams are allies.',async()=>{await pages[1].getByLabel('Player 2 faction').selectOption('iran');await pages[1].getByLabel('Player 2 team').selectOption('2');},3300);
 await pages[0].getByLabel('AI 1 team').selectOption('2');
 await shot(1,'06-ready','BOTH PLAYERS / READY UP','When you are happy with your choices, press Ready.',()=>pages[1].getByRole('button',{name:'Ready',exact:true}).click(),2200);
 await pages[0].getByRole('button',{name:'Ready',exact:true}).click();
 await shot(0,'07-start','PLAYER 1 / START THE MATCH','The host can start once both commanders are ready.',async()=>{await pages[0].getByRole('button',{name:'Start synchronized match',exact:true}).click();await Promise.all(pages.map(p=>p.waitForFunction(()=>window.store.getState().phase==='playing',null,{timeout:240000})));},1800);
 // The loading interval stays in the raw recording; the edit uses the playable portion.
 const matchStart=pages.map((_,i)=>(performance.now()-origins[i])/1000);
 for(const p of pages){await p.evaluate(async()=>{const g=window.game,s=g.client.cur;const a=s.actors.find(a=>a.owner===s.header.localPlayer&&g.client.str(a.type).includes('mcv'));assertMCV(a);function assertMCV(a){if(!a)throw Error('No local MCV');}await g.select([a.id]);});}
 await hold(1400);for(const p of pages)await p.evaluate(()=>window.game.command({cmd:'deploy'}));
 await hold(6000);
 await pages[0].getByRole('region',{name:'Multiplayer controls'}).getByRole('button',{name:'Chat',exact:true}).click();await pages[0].getByLabel('Room chat message').fill('Ready. Moving out!');await pages[0].getByRole('region',{name:'Multiplayer controls'}).getByRole('button',{name:'Send',exact:true}).click();await hold(2400);await pages[0].getByRole('button',{name:'Close room chat',exact:true}).click();
 await hold(3500);
 shots.push({id:'08-match',client:0,start:matchStart[0],end:(performance.now()-origins[0])/1000,title:'TWO COMMANDERS / ONE SYNCHRONIZED MATCH',caption:'Deploy your bases and coordinate in room chat.',peerStart:matchStart[1]});
 await pages[0].screenshot({path:path.join(out,'08-match-host.png')});await pages[1].screenshot({path:path.join(out,'08-match-guest.png')});
 const response=await fetch(new URL('api/multiplayer',base),{method:'POST',body:JSON.stringify({op:'poll',...credentials})});const state=await response.json();assert.equal(state.state,'playing');assert.ok(state.verifiedFrame>200);assert.deepEqual(errors,[]);
 const videos=pages.map(p=>p.video());await Promise.all(contexts.map(c=>c.close()));
 const files=[];for(let i=0;i<2;i++){const file=path.join(out,'raw',i?'player-2.webm':'player-1.webm');await videos[i].saveAs(file);files.push(file);}
 fs.writeFileSync(path.join(out,'shots.json'),JSON.stringify({recordedAt:new Date().toISOString(),scope:'Actual localhost private-room desktop flow. Not an internet-play or mobile demonstration.',verifiedFrame:state.verifiedFrame,files,shots},null,2));
 console.log(`Two real clients recorded; hashes verified through ${state.verifiedFrame}.`);
}finally{await browser.close();}
