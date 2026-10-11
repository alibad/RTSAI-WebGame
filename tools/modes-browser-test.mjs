import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {chromium} from '../web/node_modules/playwright-core/index.mjs';
import {browserExecutable,browserArgs} from './browser-launch.mjs';
const base=process.env.RTSAI_TEST_URL||'http://127.0.0.1:3507/';
const out=path.resolve(process.env.RTSAI_TEST_OUT||'artifacts/modes');fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({executablePath:browserExecutable(),headless:true,args:browserArgs()});
const receipt={scope:'Actual local browser OpenRA runtime, standalone project packs, no provider calls or external event delivery',modes:[],errors:[]};
try { for (const [mode,profile,grid] of [['classic','public-classic','Rectangular'],['isometric','public','RectangularIsometric']]) {
 const context=await browser.newContext({viewport:{width:1440,height:900}});const page=await context.newPage();page.on('pageerror',e=>receipt.errors.push(String(e)));await page.addInitScript(()=>{window.worldStarts=[];window.addEventListener('rtsai:world-started',e=>window.worldStarts.push(e.detail));});
 await page.goto(`${base}?profile=${profile}&runtime=aot&private=0`);await page.waitForFunction(()=>['setup','error'].includes(window.store?.getState().phase),null,{timeout:240000});assert.equal(await page.evaluate(()=>window.store.getState().phase),'setup');
 const info=await page.evaluate(()=>({missions:window.store.getState().setup.missions,maps:window.store.getState().setup.maps}));assert.ok(info.maps.some(m=>m.slots.length===4));
 const mission=info.missions[0];await page.evaluate(m=>{window.game.start(JSON.stringify({map:m.id,mission:m.id,seed:2026,players:[{slot:m.slot,faction:m.faction,color:'2A6FDB'}],options:{difficulty:'normal',startingcash:'10000',fog:'True',explored:'False'}}));},mission);
 await page.waitForFunction(()=>['playing','error'].includes(window.store.getState().phase),null,{timeout:180000});assert.equal(await page.evaluate(()=>window.store.getState().phase),'playing');await page.waitForFunction(()=>window.store.getState().ui?.tick>=30,null,{timeout:30000});
 const state=await page.evaluate(()=>{const g=window.game,s=window.store.getState(),gl=g.renderer.gl;const current=g.client.cur;g.renderer.render(current,current,g.cam,g.overlay,current.receivedAt+40);const w=gl.drawingBufferWidth,h=gl.drawingBufferHeight;const pixels=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,pixels);let painted=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]+pixels[i+1]+pixels[i+2]>50)painted++;return {grid:s.info.gridType,tileSize:s.info.tileSize,mapSize:s.info.mapSize,radarWidth:g.radar.width,draws:g.client.cur?.header?.drawCount,painted,tick:s.ui.tick,events:window.worldStarts};});assert.equal(state.grid,grid);assert.ok(state.painted>10000);assert.equal(state.radarWidth,grid==='Rectangular'?state.mapSize[0]:state.mapSize[0]*2+1);assert.deepEqual(state.events,[{version:1,event:'world-started',mode,transport:'singleplayer'}]);
 await page.screenshot({path:path.join(out,`${mode}-mission.png`)});
 const video=path.join(out,`${mode}-actual-runtime.mp4`);const encoder=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','image2pipe','-framerate','2','-i','pipe:0','-c:v','libx264','-pix_fmt','yuv420p',video]);const done=new Promise((resolve,reject)=>{encoder.on('error',reject);encoder.on('close',code=>code===0?resolve():reject(Error('capture encoding failed')));});
 const ticks=[];for(let i=0;i<12;i++){ticks.push(await page.evaluate(()=>window.store.getState().ui.tick));encoder.stdin.write(await page.screenshot({type:'png'}));await page.waitForTimeout(500);}encoder.stdin.end();await done;
 const sha256=crypto.createHash('sha256').update(fs.readFileSync(video)).digest('hex');receipt.modes.push({mode,profile,mission:mission.id,...state,capture:{path:video,sha256,frames:12,captureRate:2,ticks,recipe:'Playwright screenshot of accepted real world every500ms; original PNG frames piped to local ffmpeg libx264; six-second silent QA clip'}});
 await page.evaluate(()=>window.game.quit());await context.close();console.log(`PASS actual ${mode} rendering and capture`);
 } assert.deepEqual(receipt.errors,[]);receipt.passed=true; } finally {fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');await browser.close();}
