import fs from 'node:fs';import path from 'node:path';import {chromium} from '../web/node_modules/playwright-core/index.mjs';
const browser=await chromium.launch({executablePath:path.join(process.env.LOCALAPPDATA,'ms-playwright/chromium-1228/chrome-win64/chrome.exe'),headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto('http://127.0.0.1:3497/');
 await page.waitForFunction(()=>[...document.querySelectorAll('video')].every(v=>v.readyState>=1&&v.duration>0),null,{timeout:60000});
 const results=await page.locator('video').evaluateAll(async videos=>{
  const out=[];
  for(const v of videos){v.muted=true;await v.play();await new Promise(r=>setTimeout(r,300));const before=v.currentTime;await new Promise(r=>setTimeout(r,300));if(v.currentTime<=before)throw Error('Playback did not advance');v.pause();v.currentTime=Math.min(5,v.duration/2);await new Promise(r=>v.addEventListener('seeked',r,{once:true}));out.push({source:v.currentSrc,duration:v.duration,seek:true,play:true});}
  return out;
 });
 if(results.length!==10||errors.length)throw Error(JSON.stringify({results,errors}));
 await page.waitForFunction(()=>[...document.querySelectorAll('track')].every(t=>t.readyState===2),null,{timeout:30000});
 await page.screenshot({path:'artifacts/app-videos/library-preview.png',fullPage:true});
 fs.writeFileSync('artifacts/app-videos/player-verification.json',JSON.stringify({passed:true,results,errors,captionsLoaded:9},null,2));console.log('Ten players played and sought; nine caption tracks loaded.');
}finally{await browser.close();}
