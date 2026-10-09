import fs from 'node:fs';import path from 'node:path';import {chromium} from '../web/node_modules/playwright-core/index.mjs';
const out=path.resolve('artifacts/app-videos/sources');
const browser=await chromium.launch({executablePath:path.join(process.env.LOCALAPPDATA,'ms-playwright/chromium-1228/chrome-win64/chrome.exe'),headless:true,args:['--use-angle=d3d11','--enable-gpu','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1600,height:900}});
try{
await page.goto('http://127.0.0.1:3490/?profile=public');
await page.waitForFunction(()=>window.store?.getState().phase==='setup',null,{timeout:180000});
await page.getByRole('button',{name:'Direct peer-to-peer',exact:true}).click();
await page.screenshot({path:out+'/direct.png'});console.log('Direct screenshot');
await page.goto('http://127.0.0.1:3490/?profile=public&mode=sandbox');
await page.waitForFunction(()=>window.game?.sandbox?.state?.mode==='edit'||document.querySelector('[data-sandbox]'),null,{timeout:180000}).catch(async()=>{await page.waitForFunction(()=>window.store?.getState().phase==='playing',null,{timeout:180000});});
await page.screenshot({path:out+'/sandbox.png'});console.log('Sandbox screenshot');
}finally{await browser.close();}
