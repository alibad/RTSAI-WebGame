// Local map adapter. Generators and authored ports live in canonical RTSAI-Mod.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export function createMapWorkshop(repo) {
  const classicMod = process.env.RTSAI_WEB_CLASSIC_MOD ?? 'rtsai-topdown';
  const matchesProfile = (pkg, profile) => {
    const required = /^RequiresMod:\s*(\S+)/m.exec(fs.readFileSync(path.join(pkg.dir, 'map.yaml'), 'utf8'))?.[1];
    return profile === 'public-classic' ? required === classicMod : !['rtsai-topdown', 'rtsai-classic-core'].includes(required);
  };
  const mod = path.resolve(process.env.RTSAI_MAP_MOD_ROOT ?? path.join(repo, '.inputs/mod'));
  const earth = path.resolve(process.env.RTSAI_MAP_OUTPUT_ROOT ?? path.join(repo, 'build/local-maps'));
  const cache = new Map();
  let generating = false;
  const headers = { 'User-Agent': 'RTSAI-local-map-workshop/1.0 (+https://github.com/alibad/RTSAI-Mod)' };
  const json = (res, value, status=200) => {res.writeHead(status, {'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  const roots = () => [path.join(mod,'resources/web-maps'), path.join(mod,'resources/earth-maps'), earth];
  const packages = () => roots().flatMap(root => fs.existsSync(root) ? fs.readdirSync(root).filter(id => /^(port-classic-(coast|frontier)|earth-[a-f0-9]{16})$/.test(id)).map(id=>({id,dir:path.join(root,id)})) : [])
    .filter(p=>['map.yaml','map.bin','map.png'].every(f=>fs.existsSync(path.join(p.dir,f))) && (!p.id.startsWith('earth-') || fs.existsSync(path.join(p.dir,'earth.json'))));
  function selection(b) {
    const s={latitude:Number(b.latitude),longitude:Number(b.longitude),radius:Number(b.radius??2500),seed:Number(b.seed??42),size:Number(b.size??64),players:Number(b.players??2),title:String(b.title??'Earth Battlefield').slice(0,80),gameMode:b.gameMode==='classic'?'classic':'isometric'};
    if(!Number.isFinite(s.latitude)||!Number.isFinite(s.longitude)||Math.abs(s.latitude)>85||Math.abs(s.longitude)>180||!Number.isInteger(s.radius)||s.radius<500||s.radius>10000||![48,64,80].includes(s.size)||![2,4].includes(s.players)||!Number.isInteger(s.seed)||s.seed<0||s.seed>2147483647) throw new Error('Choose valid coordinates, a 0.5–10 km radius, and supported map settings.');
    return s;
  }
  function classify(t) {
    if(t.natural==='water'||t.natural==='bay')return 'water';
    if(t.natural==='coastline')return 'coastline';
    if(t.waterway)return t.intermittent==='yes'?'dry-river':'river';
    if(t.highway)return ['motorway','trunk','primary','secondary'].includes(t.highway)?'road':'local-road';
    if(t.building)return 'building';
    if(t.railway)return 'rail';
    if(['wood','scrub','grassland'].includes(t.natural)||['forest','meadow','orchard'].includes(t.landuse)||t.leisure)return 'forest';
    if(['sand','beach','dune'].includes(t.natural))return 'sand';
    if(['bare_rock','scree','cliff'].includes(t.natural)||t.landuse==='quarry')return 'rough';
    if(t.landuse)return 'urban';
    return null;
  }
  async function acquire(s) {
    const key=`${s.latitude}|${s.longitude}|${s.radius}`;
    if(cache.has(key))return cache.get(key);
    // Reuse the preserved evidence of an existing local map, including after server restart.
    for(const pkg of packages().filter(p=>p.id.startsWith('earth-'))) {
      const file=path.join(pkg.dir,'request.json');
      if(!fs.existsSync(file))continue;
      const previous=JSON.parse(fs.readFileSync(file,'utf8'));
      if(previous.latitude===s.latitude&&previous.longitude===s.longitude&&previous.radius===s.radius&&previous.features?.length) {
        const evidence={features:previous.features,sourceStatus:'Preserved OpenStreetMap evidence from a previous local generation'};
        cache.set(key,evidence);return evidence;
      }
    }
    const dy=s.radius/111320, dx=dy/Math.max(.15,Math.cos(s.latitude*Math.PI/180));
    const box=[s.latitude-dy,s.longitude-dx,s.latitude+dy,s.longitude+dx].join(',');
    const q=`[out:json][timeout:20];(way(${box})[natural~"water|bay|coastline|wood|scrub|sand|beach|bare_rock|cliff"];way(${box})[waterway];way(${box})[highway~"motorway|trunk|primary|secondary|tertiary|residential"];way(${box})[building];way(${box})[landuse];way(${box})[leisure~"park|garden|nature_reserve"];);out tags geom;`;
    const endpoints=process.env.RTSAI_OVERPASS_URL?[process.env.RTSAI_OVERPASS_URL]:['https://overpass.private.coffee/api/interpreter','https://overpass-api.de/api/interpreter'];
    let payload;
    for(const endpoint of endpoints) {
      try {
        const r=await fetch(endpoint,{method:'POST',headers:{...headers,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({data:q}),signal:AbortSignal.timeout(25000)});
        if(!r.ok)continue;
        const text=await r.text();if(text.length>20000000)throw new Error('Area too dense; choose a smaller radius.');
        payload=JSON.parse(text);break;
      } catch(e) { if(e.message.startsWith('Area too dense'))throw e; }
    }
    if(!payload)throw new Error('Geographic services are unavailable right now. Your selection is preserved; retry or choose a smaller area.');
    const features=(payload.elements??[]).filter(e=>e.geometry?.length>1).map(e=>({kind:classify(e.tags??{}),closed: e.geometry.length>3&&e.geometry[0].lat===e.geometry.at(-1).lat&&e.geometry[0].lon===e.geometry.at(-1).lon,points:e.geometry.map(p=>[p.lat,p.lon])})).filter(f=>f.kind);
    if(!features.length)throw new Error('No geographic features found here. Try a nearby area or a larger radius.');
    if(features.length>12000)throw new Error('Area too dense; choose a smaller radius.');
    const evidence={features,sourceStatus:`OpenStreetMap evidence acquired ${new Date().toISOString()}`};
    cache.set(key,evidence);if(cache.size>20)cache.delete(cache.keys().next().value);
    return evidence;
  }
  async function compile(s,evidence) {
    const compiler=crypto.createHash('sha256');
    for(const file of ['tools/earth-battlefield.py','tools/standalone-maps.py','mods/rtsai/standalone/tilesets/temperat.yaml'])compiler.update(fs.readFileSync(path.join(mod,file)));
    const identity={...s,classicMod:s.gameMode==='classic'?classicMod:undefined,features:evidence.features,compiler:compiler.update(fs.readFileSync(path.join(repo,'tools/adapt-topdown-map.py'))).digest('hex')};
    const request={...identity,sourceStatus:evidence.sourceStatus};
    const id='earth-'+crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,16);
    const output=path.join(earth,id);fs.mkdirSync(output,{recursive:true});
    const input=path.join(output,'request.json');fs.writeFileSync(input,JSON.stringify(request));
    const bundled=path.join(process.env.USERPROFILE??'', '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
    const python=process.env.RTSAI_MAP_PYTHON??(fs.existsSync(bundled)?bundled:'python');
    await new Promise((resolve,reject)=>{
      const p=spawn(python,[path.join(mod,'tools/earth-battlefield.py'),'--request',input,'--output',output],{windowsHide:true,cwd:mod});
      let log='';p.stdout.on('data',d=>log=(log+d).slice(-6000));p.stderr.on('data',d=>log=(log+d).slice(-6000));
      const t=setTimeout(()=>{p.kill();reject(new Error('Map compilation timed out.'));},60000);
      p.on('error',e=>{clearTimeout(t);reject(e);});p.on('close',code=>{clearTimeout(t);code===0?resolve():reject(new Error('Map compiler could not create a connected battlefield. '+log.slice(-800)));});
    });
    if (s.gameMode === 'classic') await new Promise((resolve,reject) => { const p=spawn(python,[path.join(repo,'tools/adapt-topdown-map.py'),'--directory',output,...(classicMod==='rtsai-classic-core'?['--classic-core']:[])],{windowsHide:true,cwd:repo,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});p.on('error',reject);p.on('close',code=>code===0?resolve():reject(new Error('Classic map adaptation failed'))); });
    return JSON.parse(fs.readFileSync(path.join(output,'earth.json'),'utf8'));
  }
  const handle = async function(req,res,url) {
    const p=url.pathname.replace(/^\/play/,'');
    try {
      if(p==='/api/maps/library') {
        const file=path.join(mod,'resources/map-library.json');
        const library=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{maps:[],sourceCopies:0,note:'Run RTSAI-Mod/tools/catalog-web-maps.py to index local sources.'};
        for(const pkg of packages().filter(m=>m.id.startsWith('earth-'))) {
          const report=JSON.parse(fs.readFileSync(path.join(pkg.dir,'earth.json'),'utf8'));
          const source=`RTSAI-Mod/resources/earth-maps/${pkg.id}/map.yaml`;
          const required = /^RequiresMod:\s*(\S+)/m.exec(fs.readFileSync(path.join(pkg.dir,'map.yaml'),'utf8'))?.[1];
          library.maps.unshift({id:pkg.id,folder:pkg.id,title:report.title,players:report.players,author:'RTS AI · Earth workshop',mod:required,source,copies:[source],status:'compatible',reason:'Generated from attributed geographic evidence with project terrain'});
          library.sourceCopies++;
        }
        return json(res,library);
      }
      if(p==='/api/maps/packages') return json(res,{maps:packages().filter(m => matchesProfile(m,url.searchParams.get('profile'))).map(({id})=>({id,files:['map.yaml','map.bin','map.png'].map(name=>({name,url:`api/maps/file/${id}/${name}`}))}))});
      const file=p.match(/^\/api\/maps\/file\/([a-z0-9-]+)\/(map\.yaml|map\.bin|map\.png|map\.oramap|earth\.json|provenance\.json)$/);
      if(file){const pkg=packages().find(m=>m.id===file[1]);if(!pkg)return json(res,{error:'Map not found'},404);const target=path.join(pkg.dir,file[2]);if(!fs.existsSync(target))return json(res,{error:'File not found'},404);res.writeHead(200,{'content-type':file[2].endsWith('.png')?'image/png':'application/octet-stream','cache-control':'no-cache'});return res.end(fs.readFileSync(target));}
      if((p==='/api/maps/evidence'||p==='/api/maps/generate')&&req.method==='POST') {
        if(generating)return json(res,{error:'A battlefield is already being generated. Please wait.'},409);
        let body='';for await(const c of req){body+=c;if(body.length>4096)throw new Error('Request too large');}
        const s=selection(JSON.parse(body));generating=true;
        try {const evidence=await acquire(s); if(p.endsWith('evidence'))return json(res,{...s,...evidence,attribution:'© OpenStreetMap contributors',source:'OpenStreetMap'});return json(res,await compile(s,evidence));}
        finally {generating=false;}
      }
      return json(res,{error:'Unknown map operation'},404);
    } catch(e){return json(res,{error:e.message??String(e)},400);}
  };
  handle.syncNative = (root, profile) => {

    const destination=path.join(root,'mods/rtsai/web/content/maps');
    fs.mkdirSync(destination,{recursive:true});
    for(const pkg of packages().filter(m => matchesProfile(m,profile))) {
      const target=path.join(destination,pkg.id);fs.mkdirSync(target,{recursive:true});
      for(const name of ['map.yaml','map.bin','map.png'])fs.copyFileSync(path.join(pkg.dir,name),path.join(target,name));
    }
  };
  return handle;
}
