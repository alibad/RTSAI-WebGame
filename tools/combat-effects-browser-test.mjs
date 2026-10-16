// Real combat in the simulator and skirmish, through the same WASM snapshots and WebGL renderer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
import { browserExecutable, browserArgs } from './browser-launch.mjs';
const root=process.env.RTSAI_EFFECTS_BUILD??'D:/rtsai-release/combat-effects-20261016';
const base=process.env.RTSAI_TEST_URL??'http://127.0.0.1:38669/';
const out=process.env.RTSAI_TEST_OUT??`${root}/browser-effects`; fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({executablePath:browserExecutable(),args:browserArgs(),headless:true});
const receipt={passed:false,cases:[]};
try {
 for(const [profile,mode,map] of [['public','isometric','twin-fords'],['public-classic','classic','classic-coast']]) {
  const fixtures=JSON.parse(fs.readFileSync(`${root}/effects-${mode}.log`,'utf8').trim()).cases;
  for(const simulator of [true,false]) {
   const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
   page.on('pageerror',e=>errors.push(String(e)));
   await page.route('**/*',r=>{const u=new URL(r.request().url());return ['127.0.0.1','localhost'].includes(u.hostname)||['blob:','data:'].includes(u.protocol)?r.continue():r.abort();});
   await page.goto(`${base}?profile=${profile}${simulator?'&mode=simulator':''}`);
   await page.waitForFunction(sim=>sim?window.store?.getState().sandbox?.units?.length>0:window.store?.getState().phase==='setup',simulator,{timeout:240000});
   await page.evaluate(m=>window.game.prepare(m),map);
   await page.waitForFunction(m=>window.store.getState().preparedMap===m,map,{timeout:180000});
   for(const unit of ['r2basij','r2ah64sa']) {
    const air=unit==='r2ah64sa',f=fixtures.find(c=>c.unit===unit&&c.water===air);
    const placements=[{id:unit,side:1,u:f.u,v:f.v,health:1,order:air?'engage':'hold'},{id:air?'r2sads':'r2sang',side:0,u:f.shooterU,v:f.shooterV,order:'hold'}];
    if(simulator) {
     await page.evaluate(async({map,placements})=>{window.game.sandbox.configure({map});await window.game.sandbox.plan('saudi','iran',placements);},{map,placements});
    }else {
     const scenario={map,bare:false,players:[{slot:'Multi0',faction:'saudi'},{slot:'Multi1',faction:'iran',bot:'webidle'}],options:{fog:'False',explored:'True',crates:'False'},spawns:placements.map(p=>({type:p.id,player:p.side,x:p.u,y:p.v,health:p.health??100,order:p.order}))};
     await page.evaluate(s=>window.game.start(JSON.stringify(s),true),scenario);
    }
    await page.waitForFunction(unit=>window.store.getState().phase==='playing'&&window.game.client.cur?.actors.some(a=>window.game.client.str(a.type)===unit),unit,{timeout:120000});
    await page.waitForFunction(()=>{const c=window.game.client;return c.sheetList.filter(s=>s.group==='fx'||s.group===''||s.group.split('+').some(g=>['saudi','iran'].includes(g))).every(s=>window.game.renderer.hasTexture(s.id));},null,{timeout:60000});
    await page.evaluate(({unit,air})=>{
     const game=window.game,c=game.client;
     const old=c.onSnapshot;
     window.effectProbe={frames:[],husk:false,done:false,removed:false,last:null};
     c.onSnapshot=s=>{
      old?.(s);const p=window.effectProbe;
      const actor=s.actors.find(a=>c.str(a.type)===unit),husk=s.actors.find(a=>c.str(a.type)===unit+'husk');
      if(actor||husk){const a=husk??actor;p.last=[a.sx,a.sy];game.lookAt(a.sx,a.sy);game.cam.zoom=2;}
      if(husk)p.husk=true;
      if(!actor)p.removed=true;
      const draws=[];
      for(let i=0;i<s.header.drawCount;i++){const o=i*48,key=s.draws.getUint32(o,true),x=s.draws.getFloat32(o+8,true),y=s.draws.getFloat32(o+12,true);if(key>=0x80000000&&p.last&&Math.hypot(x-p.last[0],y-p.last[1])<120)draws.push(s.draws.getInt32(o+4,true));}
      if(p.removed&&(!air||(p.husk&&!husk))&&draws.length){p.frames.push({tick:s.header.tick,sprites:draws});if(p.frames.length===7){p.done=true;game.client.send({type:'pause',paused:true});}}
     };
     window.restoreEffectProbe=()=>{c.onSnapshot=old;};
    },{unit,air});
    if(simulator)await page.evaluate(()=>window.game.sandbox.run());else await page.evaluate(()=>window.game.setPaused(false));
    try { await page.waitForFunction(()=>window.effectProbe?.done,null,{timeout:45000}); }
    catch(e){console.log(await page.evaluate(()=>({probe:window.effectProbe,actors:window.game.client.cur?.actors.map(a=>({name:window.game.client.str(a.type),hp:a.hp,z:a.worldZ})),error:window.store.getState().error})));throw e;}
    await page.waitForFunction(()=>window.game.renderer.stats.skipped===0,null,{timeout:30000});
    await page.waitForTimeout(100);
    const name=`${profile}-${simulator?'simulator':'skirmish'}-${unit}`;
    await page.screenshot({path:`${out}/${name}.png`});
    const result=await page.evaluate(()=>{const p=window.effectProbe;window.restoreEffectProbe();return {removed:p.removed,husk:p.husk,frames:p.frames,draws:window.game.renderer.stats.draws,skipped:window.game.renderer.stats.skipped};});
    assert(result.removed&&result.frames.length>=7);assert(new Set(result.frames.flatMap(f=>f.sprites)).size>1,'effect animation advances through different sprites');
    if(air)assert(result.husk,'aircraft visibly falls before its impact');
    receipt.cases.push({profile,simulator,unit,...result});console.log(`PASS ${name}`);
   }
   assert.deepEqual(errors,[]);await page.close();
  }
 }
 receipt.passed=true;
}finally{await browser.close();fs.writeFileSync(`${out}/receipt.json`,JSON.stringify(receipt,null,2));}
