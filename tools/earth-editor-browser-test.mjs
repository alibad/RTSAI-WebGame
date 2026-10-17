// Actual globe -> area selection -> native map editing; responsive layout and recoverable renderer failure.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';
import { browserExecutable, browserArgs } from './browser-launch.mjs';
const base = process.env.RTSAI_TEST_URL ?? 'http://127.0.0.1:38669/';
const out = process.env.RTSAI_TEST_OUT ?? 'artifacts/earth-editor';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: browserExecutable(), args: browserArgs(), headless: true });
const receipt = { base, cases: [], passed: false };
try {
  for (const spec of [{width:1440,height:1000}, {width:390,height:844}, {width:390,height:844,rtl:true}, {width:844,height:390}]) {
    const context = await browser.newContext({ viewport: spec, hasTouch: spec.width === 390 });
    if (spec.rtl) await context.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir='rtl'; document.documentElement.lang='ar'; }); });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith('/api/overpass')) return route.fulfill({status:200,contentType:'application/json',body:'{"elements":[]}'});
      if (['127.0.0.1','localhost','server.arcgisonline.com','tile.openstreetmap.org'].includes(u.hostname) || ['blob:','data:'].includes(u.protocol)) return route.continue();
      return route.abort();
    });
    await page.goto(`${base}?profile=public&mode=editor`);
    await page.getByTestId('ed-earth').waitFor({timeout:180000});
    await page.getByTestId('ed-earth').click();
    const region=page.getByRole('region',{name:'Map editor · real-world area',exact:true});
    await region.getByRole('button',{name:'3D view',exact:true}).and(page.locator(':enabled')).waitFor({timeout:60000});
    assert.equal(await region.getByRole('button',{name:'3D view',exact:true}).getAttribute('aria-pressed'),'true');
    assert.equal(await page.getByText('Download site dataset',{exact:true}).count(),0);
    assert.equal(await page.getByText('Play a real place',{exact:true}).count(),0);
    assert.equal(await page.locator('select:visible').count(),0);
    const name=`${spec.width}${spec.rtl?'-rtl':''}`;
    await page.waitForTimeout(1200);
    await page.screenshot({path:`${out}/${name}-globe.png`});
    await region.getByRole('button',{name:'Overhead',exact:true}).click();
    assert.equal(await region.getByRole('button',{name:'Overhead',exact:true}).getAttribute('aria-pressed'),'true');
    await region.getByRole('button',{name:'3D view',exact:true}).click();
    const suggest=page.locator('[data-place="Strait of Hormuz"]');
    await suggest.click();
    await page.getByRole('radio',{name:'120 km',exact:true}).waitFor();
    await page.waitForTimeout(1200);
    const canvas=page.locator('.es-map canvas');
    const canvasBox=await canvas.boundingBox(); assert.ok(canvasBox && canvasBox.width > 200 && canvasBox.height > 150);
    const coords=await page.locator('.es-coords').innerText();
    await canvas.click({position:{x:canvasBox.width*.32,y:canvasBox.height*.32}});
    assert.notEqual(await page.locator('.es-coords').innerText(),coords,'Click changes the battlefield location');
    await page.getByRole('button',{name:'Show whole area',exact:true}).click();
    const create=await page.getByTestId('es-build').boundingBox();
    assert.ok(create && create.x >= 0 && create.y >= 0 && create.x+create.width <= spec.width+1 && create.y+create.height <= spec.height+1,'Creation action stays visible');
    const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
    assert.ok(overflow.scroll <= overflow.width,'No horizontal overflow');
    assert.equal(await page.getByRole('button',{name:'Download sites',exact:true}).count(),0);
    await page.screenshot({path:`${out}/${name}-area.png`});
    if(spec.width===1440 && process.env.RTSAI_TEST_LAYOUT_ONLY !== '1') {
      await page.getByRole('button',{name:'Back to the globe',exact:true}).click();
      await suggest.click();
      await page.getByTestId('es-build').click();
      await page.waitForFunction(()=>window.store.getState().phase==='playing' && !!window.store.getState().editor?.map,null,{timeout:180000});
      assert.equal(await page.getByRole('region',{name:'Map editor · real-world area',exact:true}).count(),0,'Generated map opens directly for editing');
      await page.getByTestId('ed-title').waitFor();
      const state=await page.evaluate(()=>({map:window.store.getState().editor.map,title:window.store.getState().editor.title,catalog:!!window.store.getState().editor.catalog}));
      assert.ok(state.catalog); assert.match(state.title,/Hormuz/);
      await page.screenshot({path:`${out}/native-generated-map.png`});
      receipt.cases.push({nativeGeneration:state,optionalOnlineResearchUnavailable:true});
    }
    assert.deepEqual(errors,[]);
    receipt.cases.push({viewport:spec,globe:true,perspectiveSwitch:true,movableSelection:true,visibleCreationAction:true,noDeveloperExports:true,overflow,errors});
    await context.close(); console.log(`PASS editor globe and area ${name}`);
  }
  // Fail only MapLibre's first WebGL creation; the game's own canvas and the retry use the real renderer.
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  await context.addInitScript(()=>{
    const original=HTMLCanvasElement.prototype.getContext; let failed=false;
    HTMLCanvasElement.prototype.getContext=function(...args){
      if(!failed && this.classList.contains('maplibregl-canvas') && String(args[0]).startsWith('webgl')) {failed=true;throw Error('Injected one-time map renderer failure');}
      return original.apply(this,args);
    };
  });
  const page=await context.newPage();
  await page.goto(`${base}?profile=public&mode=map-studio`);
  await page.getByText('Globe unavailable',{exact:true}).waitFor({timeout:180000});
  await page.getByRole('button',{name:'Retry globe',exact:true}).click();
  await page.getByRole('button',{name:'3D view',exact:true}).and(page.locator(':enabled')).waitFor({timeout:60000});
  assert.equal(await page.getByText('Globe unavailable',{exact:true}).count(),0);
  await page.screenshot({path:`${out}/recovered-renderer.png`});
  receipt.cases.push({rendererFailureRecovery:true}); await context.close();
  receipt.passed=true;
} finally { fs.writeFileSync(`${out}/receipt.json`,JSON.stringify(receipt,null,2)+'\n'); await browser.close(); }
