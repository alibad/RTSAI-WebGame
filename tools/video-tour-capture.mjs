import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
const out=path.resolve('artifacts/app-videos'); fs.mkdirSync(out+'/sources',{recursive:true});
const browser=await chromium.launch({executablePath:path.join(process.env.LOCALAPPDATA,'ms-playwright/chromium-1228/chrome-win64/chrome.exe'),headless:true,args:['--use-angle=d3d11','--enable-gpu','--ignore-gpu-blocklist']});
const context=await browser.newContext({viewport:{width:1600,height:900},recordVideo:{dir:out+'/sources',size:{width:1600,height:900}}});
const page=await context.newPage(); const shots=[];
const shot=async name=>{await page.screenshot({path:out+'/sources/'+name+'.png'}); shots.push({name,url:page.url(),time:Date.now()}); console.log('Captured',name);};
try {
 await page.goto('http://127.0.0.1:3490/?profile=public');
 await page.waitForFunction(()=>['setup','error'].includes(window.store?.getState().phase),null,{timeout:600000});
 if(await page.evaluate(()=>window.store.getState().phase)==='error')throw Error('Game failed to boot');
 await shot('home');
 await page.getByRole('button',{name:/^Skirmish/}).first().click(); await shot('setup');
 await page.getByRole('button',{name:/Main menu/}).evaluate(b=>b.click());
 await page.getByRole('button',{name:/^Missions/}).first().click(); await shot('missions');
 await page.getByRole('button',{name:/Main menu/}).evaluate(b=>b.click());
 await page.getByRole('button',{name:'Private multiplayer',exact:true}).click(); await shot('multiplayer');
 await page.getByRole('button',{name:'Back',exact:true}).click();
 console.log('Menu buttons',await page.getByRole('button').allTextContents());
 for(const [pattern,name] of [[/^Settings$/i,'settings'],[/Saves & replays/i,'library']]){
  const button=page.getByRole('button',{name:pattern}).first();
  if(await button.count()){await button.click();await shot(name);await page.keyboard.press('Escape'); const close=page.getByRole('button',{name:/Close/i}).first();if(await close.isVisible().catch(()=>false))await close.click();}
 }
 await page.evaluate(s=>window.game.start(s),fs.readFileSync('scenarios/skirmish-public.json','utf8'));
 await page.waitForFunction(()=>['playing','error'].includes(window.store.getState().phase),null,{timeout:180000});
 if(await page.evaluate(()=>window.store.getState().phase)!=='playing')throw Error('Skirmish failed');
 await shot('gameplay');
 await page.keyboard.press('?');await shot('hotkeys');await page.keyboard.press('Escape');
 const start=Date.now();await new Promise(r=>setTimeout(r,18000));
 await shot('gameplay-end');
 fs.writeFileSync(out+'/sources/capture.json',JSON.stringify({shots,combatStart:start,combatEnd:Date.now()},null,2));
}finally{await context.close();await browser.close();}
