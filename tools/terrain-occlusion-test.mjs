import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
const browser=await chromium.launch({executablePath:path.join(process.env.LOCALAPPDATA,'ms-playwright/chromium-1228/chrome-win64/chrome.exe'),headless:true,args:['--use-angle=d3d11','--enable-gpu','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1400,height:900}});
const errors=[];page.on('pageerror',e=>errors.push(String(e)));
const unit=process.env.RTSAI_TEST_UNIT||'dog';
fs.mkdirSync('artifacts/terrain-occlusion',{recursive:true});
try {
  await page.goto(process.env.RTSAI_TEST_URL||'http://127.0.0.1:3520/?profile=public');
  await page.waitForFunction(()=>['setup','error'].includes(window.store?.getState().phase),null,{timeout:180000});
  assert.equal(await page.evaluate(()=>window.store.getState().phase),'setup');
  const scenario=JSON.parse(fs.readFileSync('scenarios/production-ui.json','utf8'));
  if(unit!=='dog'){
    scenario.spawns=scenario.spawns.filter(a=>a.type!==unit);
    scenario.spawns.find(a=>a.type==='dog').type=unit;
  }
  await page.evaluate(s=>window.game.start(JSON.stringify(s),true),scenario);
  await page.waitForFunction(unit=>window.store.getState().phase==='playing'&&window.game.client.cur?.actors.some(a=>window.game.client.str(a.type)===unit),unit,{timeout:120000});
  await page.waitForTimeout(2000);
  const results=await page.evaluate(unit=>{
    const g=window.game,r=g.renderer,cur=g.client.cur;
    const dog=cur.actors.find(a=>g.client.str(a.type)===unit);
    g.cam.zoom=3;g.lookAt(dog.sx,dog.sy);
    const gl=r.gl,w=gl.drawingBufferWidth,h=gl.drawingBufferHeight;
    const originalClear=gl.clear.bind(gl), originalOverlay=r.drawOverlay;
    r.drawOverlay=()=>{};
    const rows=[];
    const render=mode=>{
      r.actorFilter=mode==='reference'?(type=>g.client.str(type)===unit):null;
      gl.clear=bits=>{if(mode==='old'&&bits===gl.DEPTH_BUFFER_BIT)return;originalClear(bits);};
      r.render(cur,cur,g.cam,g.overlay,cur.receivedAt+40);
      const pixels=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return pixels;
    };
    // Sweep the same real engine sprite through a tile's full depth interval.
    // Move its draw records and actor origin together; simulation state is paused.
    const draws=[];for(let i=0;i<cur.header.drawCount;i++){const o=i*48;if(cur.draws.getUint32(o,true)===dog.id)draws.push(o);}
    const initial=draws.map(o=>[cur.draws.getFloat32(o+12,true),cur.draws.getFloat32(o+16,true)]);
    const initialX=draws.map(o=>cur.draws.getFloat32(o+8,true));
    const sy=dog.sy,sz=dog.sz;
    for(let delta=0;delta<=30;delta+=2){
      dog.sy=sy+delta;dog.sz=sz+delta;
      draws.forEach((o,i)=>{cur.draws.setFloat32(o+12,initial[i][0]+delta,true);cur.draws.setFloat32(o+16,initial[i][1]+delta,true);});
      const reference=render('reference'),old=render('old'),fixed=render('fixed');
      let body=0,oldMissing=0,fixedMissing=0;
      for(let p=0;p<reference.length;p+=4){
        const [red,green,blue]=reference.subarray(p,p+3);
        if(Math.max(red,green,blue)-Math.min(red,green,blue)<30||red+green+blue<100)continue;
        body++;if(old[p]!==red||old[p+1]!==green||old[p+2]!==blue)oldMissing++;
        if(fixed[p]!==red||fixed[p+1]!==green||fixed[p+2]!==blue)fixedMissing++;
      }
      rows.push({delta,body,oldMissing,fixedMissing});
    }
    dog.sy=sy;dog.sz=sz;draws.forEach((o,i)=>{cur.draws.setFloat32(o+12,initial[i][0],true);cur.draws.setFloat32(o+16,initial[i][1],true);});
    const building=cur.actors.find(a=>g.client.str(a.type)==='gaweap');
    const sx=dog.sx,dx=building.sx-sx,dy=building.sy-8-sy,dz=building.sz-8-sz;
    dog.sx=sx+dx;dog.sy=sy+dy;dog.sz=sz+dz;g.lookAt(building.sx,building.sy);
    draws.forEach((o,i)=>{cur.draws.setFloat32(o+8,initialX[i]+dx,true);cur.draws.setFloat32(o+12,initial[i][0]+dy,true);cur.draws.setFloat32(o+16,initial[i][1]+dz,true);});
    const solo=render('reference'),behind=render('fixed');let buildingOccluded=0;
    for(let p=0;p<solo.length;p+=4){
      const [red,green,blue]=solo.subarray(p,p+3);
      if(Math.max(red,green,blue)-Math.min(red,green,blue)<30||red+green+blue<100)continue;
      if(behind[p]!==red||behind[p+1]!==green||behind[p+2]!==blue)buildingOccluded++;
    }
    dog.sx=sx;dog.sy=sy;dog.sz=sz;g.lookAt(sx,sy);
    draws.forEach((o,i)=>{cur.draws.setFloat32(o+8,initialX[i],true);cur.draws.setFloat32(o+12,initial[i][0],true);cur.draws.setFloat32(o+16,initial[i][1],true);});
    gl.clear=originalClear;r.actorFilter=null;r.drawOverlay=originalOverlay;
    return {rows,buildingOccluded};
  },unit);
  console.log(JSON.stringify(results));
  if(unit==='dog')assert.ok(results.rows.some(r=>r.oldMissing>0),'Original clipping must reproduce');
  assert.ok(results.rows.every(r=>r.body>0&&r.fixedMissing===0),'Ground must not erase any colored body pixels');
  assert.ok(results.buildingOccluded>0,'Buildings must still occlude units behind them');
  assert.deepEqual(errors,[]);
  await page.screenshot({path:`artifacts/terrain-occlusion/${unit}-fixed.png`});
  await page.evaluate(()=>{
    const gl=window.game.renderer.gl;window.restoreDepthClear=gl.clear.bind(gl);
    gl.clear=bits=>{if(bits!==gl.DEPTH_BUFFER_BIT)window.restoreDepthClear(bits);};
  });
  await page.waitForTimeout(100);
  await page.screenshot({path:`artifacts/terrain-occlusion/${unit}-before.png`});
  await page.evaluate(()=>{window.game.renderer.gl.clear=window.restoreDepthClear;});
  const start=await page.evaluate(unit=>{
    const g=window.game,a=g.client.cur.actors.find(a=>g.client.str(a.type)===unit);
    g.select([a.id]);g.setPaused(false);g.click(a.sx-180,a.sy+60,2,0);return {id:a.id,x:a.sx,y:a.sy};
  },unit);
  await page.waitForFunction(start=>{
    const a=window.game.client.cur.actorById.get(start.id);
    return a&&Math.hypot(a.sx-start.x,a.sy-start.y)>40;
  },start,{timeout:30000});
  await page.screenshot({path:`artifacts/terrain-occlusion/${unit}-moving.png`});
  assert.deepEqual(errors,[]);
  console.log(`PASS: complete ${unit} silhouette at16tile-depth positions and actual movement.`);
}finally{await browser.close();}
