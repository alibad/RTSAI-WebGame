import { useEffect, useState } from 'react';
import { useStore } from '../store';
import type { Game } from '../game';
import { Button } from '../components/ui/button';
import { OptionSelect } from '../components/ui/fields';

type Selection = {latitude:number;longitude:number;radius:number;size:number;players:number;seed:number;title:string};
type Feature = {kind:string;points:number[][];closed:boolean};
type Evidence = Selection & {features:Feature[];sourceStatus:string};
type Result = Selection & {id:string;features:Record<string,number>;paths:Feature[];adaptations:string[];validation:{reachableCells:number;homeMines:number}};
type Entry = {id:string;folder:string;title:string;author:string;players:number;source:string;copies:string[];status:string;reason:string;mod:string};
const places = [
  {name:'Riyadh · desert city',lat:24.7136,lon:46.6753},
  {name:'Cairo · river crossing',lat:30.045,lon:31.23},
  {name:'Istanbul · strait',lat:41.025,lon:29.00},
  {name:'Kyoto · green foothills',lat:35.025,lon:135.76},
];
const color:Record<string,string>={water:'#4babc0',river:'#4babc0',coastline:'#68d5e4',road:'#edc47e','local-road':'#a78b63',building:'#b49c89',urban:'#a78b63',forest:'#668d55',rough:'#8c8675',sand:'#ccb276'};
const endpoint=(name:string)=>new URL(`api/maps/${name}`,new URL('./',location.href)).href;
async function request<T>(name:string,body?:Selection):Promise<T>{
  const r=await fetch(endpoint(name),body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
  if(!r.headers.get('content-type')?.includes('application/json'))throw new Error('Map studio needs the updated local game server. Restart the local game launcher.');
  const data=await r.json();if(!r.ok)throw new Error(data.error??`Map service returned HTTP ${r.status}`);return data;
}
function Geography({features,selection}:{features:Feature[];selection:Selection}) {
  const scale=(p:number[])=>[(.5+(p[1]-selection.longitude)*111320*Math.cos(selection.latitude*Math.PI/180)/(2*selection.radius))*600,
    (.5-(p[0]-selection.latitude)*111320/(2*selection.radius))*600];
  return <svg viewBox="0 0 600 600" className="h-full w-full" role="img" aria-label="Geographic roads, waterways and land cover of the selected area">
    <defs><clipPath id="earth-clip"><rect width="600" height="600"/></clipPath><pattern id="earth-grid" width="60" height="60" patternUnits="userSpaceOnUse"><path d="M60 0H0V60" fill="none" stroke="#ffffff10"/></pattern></defs>
    <rect width="600" height="600" fill="#18251e"/><rect width="600" height="600" fill="url(#earth-grid)"/>
    <g clipPath="url(#earth-clip)">{features.map((f,i)=><path key={i} d={f.points.map((p,k)=>`${k?'L':'M'}${scale(p).join(',')}`).join(' ')+(f.closed?'Z':'')} fill={f.closed?color[f.kind]??'#887960':'none'} fillOpacity=".35" stroke={color[f.kind]??'#887960'} strokeWidth={f.kind==='road'?2:1}/>)}</g>
    <path d="M285 300h30M300 285v30" stroke="#f1d28b"/><circle cx="300" cy="300" r="5" fill="none" stroke="#f1d28b"/>
    <text x="580" y="28" textAnchor="end" fill="#f1d28b" fontSize="16">N ↑</text>
  </svg>;
}
export function MapWorkshop({game,close}:{game:Game;close:()=>void}) {
  const setup=useStore(s=>s.setup)!;
  const previews=useStore(s=>s.previews);
  const [tab,setTab]=useState<'earth'|'library'>('earth');
  const [selection,setSelection]=useState<Selection>({latitude:30.045,longitude:31.23,radius:1000,size:64,players:2,seed:42,title:'Cairo Crossing'});
  const [evidence,setEvidence]=useState<Evidence|null>(null);
  const [result,setResult]=useState<Result|null>(null);
  const [busy,setBusy]=useState('');const [error,setError]=useState('');
  const [library,setLibrary]=useState<Entry[]>([]);const [sourceCopies,setSourceCopies]=useState(0);
  const [query,setQuery]=useState('');const [filter,setFilter]=useState('playable');
  useEffect(()=>{let live=true;request<{maps:Entry[];sourceCopies:number}>('library').then(data=>{if(live){setLibrary(data.maps);setSourceCopies(data.sourceCopies)}}).catch(e=>{if(live)setError(e.message)});return()=>{live=false}},[]);
  useEffect(()=>{if(tab==='library')for(const map of setup.maps)game.preview(map.id)},[game,setup.maps,tab]);
  const change=(s:Partial<Selection>)=>{setSelection({...selection,...s});setEvidence(null);setResult(null);setError('')};
  const inspect=async()=>{setBusy('Reading roads, water and land cover…');setError('');setResult(null);try{setEvidence(await request<Evidence>('evidence',selection))}catch(e){setError(String((e as Error).message))}finally{setBusy('')}};
  const generate=async()=>{setBusy('Compiling terrain, base zones and connected routes…');setError('');try{setResult(await request<Result>('generate',selection));const data=await request<{maps:Entry[];sourceCopies:number}>('library');setLibrary(data.maps);setSourceCopies(data.sourceCopies)}catch(e){setError(String((e as Error).message))}finally{setBusy('')}};
  const openMap=(id:string)=>{
    const url=new URL(location.href);url.searchParams.delete('scenario');url.searchParams.set('mode','skirmish');url.searchParams.set('map',id);url.searchParams.set('profile','public');location.assign(url.href);
  };
  const runtimeId=(entry:Entry)=>entry.status==='compatible'?setup.maps.find(m=>m.id===entry.folder)?.id??(/^earth-[a-f0-9]{16}$/.test(entry.folder)?entry.folder:null):entry.status==='ported'?setup.maps.find(m=>m.id===`port-${entry.folder}`)?.id??null:null;
  const shown=library.filter(e=>(filter==='all'||(filter==='playable'?!!runtimeId(e):!runtimeId(e)))&&`${e.title} ${e.mod} ${e.author} ${e.source}`.toLowerCase().includes(query.toLowerCase()));
  return <div role="dialog" aria-modal="true" aria-label="Map studio" className="map-workshop absolute inset-0 z-[100] overflow-auto bg-[#080d0b] text-[#e4e8dc]" onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape'&&!busy)close()}}>
    <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-4 border-b border-white/10 bg-[#080d0b]/95 px-6 py-5">
      <div><p className="text-xs uppercase tracking-[.25em] text-[var(--hud-gold)]">RTS AI · Map studio</p><h1 className="mt-1 text-3xl font-bold">A place becomes a battlefield</h1></div>
      <Button variant="outline" onClick={close} disabled={!!busy}>← Back to game</Button>
    </header>
    <nav aria-label="Map studio sections" className="flex gap-2 px-6 pt-5"><Button variant={tab==='earth'?'default':'outline'} onClick={()=>setTab('earth')}>Earth workshop</Button><Button variant={tab==='library'?'default':'outline'} onClick={()=>setTab('library')}>Map library · {library.length}</Button></nav>
    {error&&<p role="alert" className="mx-6 mt-4 rounded border border-red-400/30 bg-red-950/30 p-3 text-sm text-red-200">{error}</p>}
    {tab==='earth'?<main className="mx-auto grid max-w-[1440px] gap-6 p-6 lg:grid-cols-[340px_minmax(0,1fr)]">
      <section className="flex flex-col gap-5">
        <div><h2 className="text-lg font-semibold text-[var(--hud-gold)]">1 · Choose your inspiration</h2><p className="mt-2 text-sm text-[#9cae9e]">Find a familiar place. Keep its waterways and roads, then shape room for a fair match.</p></div>
        <div className="grid grid-cols-2 gap-2">{places.map(p=><button disabled={!!busy} key={p.name} className="rounded border border-white/10 bg-white/5 p-3 text-left text-xs hover:border-[#d8ba78]" onClick={()=>change({latitude:p.lat,longitude:p.lon,title:p.name.split(' · ')[0]+' Battlefield'})}>{p.name}</button>)}</div>
        <fieldset disabled={!!busy} className="flex flex-col gap-3"><legend className="mb-2 text-sm">Or choose any coordinates</legend>
          <div className="grid grid-cols-2 gap-3">{(['latitude','longitude'] as const).map(key=><label className="text-xs" key={key}>{key==='latitude'?'Latitude':'Longitude'}<input aria-label={key==='latitude'?'Latitude':'Longitude'} className="mt-1 w-full rounded border border-white/15 bg-black/30 p-2 text-sm" type="number" step=".0001" value={selection[key]} onChange={e=>change({[key]:Number(e.target.value)})}/></label>)}</div>
          <label className="text-xs">Battlefield name<input className="mt-1 w-full rounded border border-white/15 bg-black/30 p-2 text-sm" maxLength={80} value={selection.title} onChange={e=>change({title:e.target.value})}/></label>
          <label className="text-xs">Area radius · {(selection.radius/1000).toFixed(1)} km<input aria-label="Area radius" className="mt-2 w-full" type="range" min="500" max="10000" step="500" value={selection.radius} onChange={e=>change({radius:Number(e.target.value)})}/></label>
          <div className="grid grid-cols-2 gap-3"><label className="text-xs">Map size<OptionSelect aria-label="Generated map size" value={String(selection.size)} onValueChange={v=>change({size:Number(v)})} options={[48,64,80].map(v=>({value:String(v),label:v===48?'Compact':v===64?'Standard':'Expansive'}))}/></label><label className="text-xs">Commanders<OptionSelect aria-label="Generated map players" value={String(selection.players)} onValueChange={v=>change({players:Number(v)})} options={[2,4].map(v=>({value:String(v),label:`${v} players`}))}/></label></div>
          <label className="text-xs">Variation seed<input aria-label="Variation seed" type="number" min="0" max="2147483647" className="ml-3 w-28 rounded border border-white/15 bg-black/30 p-2" value={selection.seed} onChange={e=>change({seed:Number(e.target.value)})}/></label>
        </fieldset>
        <Button onClick={inspect} disabled={!!busy}>Read this area</Button>
        <a className="text-xs text-[var(--hud-gold)] underline" href={`https://www.openstreetmap.org/#map=14/${selection.latitude}/${selection.longitude}`} target="_blank" rel="noreferrer">Explore this place on OpenStreetMap ↗</a>
        <p className="text-xs text-[#9cae9e]">Reading an area sends the selected coordinates to OpenStreetMap’s public geographic service. No account or satellite imagery is required.</p>
      </section>
      <section className="min-w-0">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="overflow-hidden rounded-lg border border-white/10"><div className="border-b border-white/10 p-3 text-sm font-semibold">2 · Geographic evidence</div><div className="aspect-square">{evidence?<Geography features={evidence.features} selection={evidence}/>:<div className="grid h-full place-items-center bg-[radial-gradient(ellipse,#22362b,#111b16)] p-8 text-center"><div><div className="mb-4 text-6xl text-[#b9a36c]">◎</div><p className="text-[#bbc8b9]">Choose a place, then read the area.</p><p className="mt-2 text-xs text-[#829383]">Roads · rivers · forests · built areas</p></div></div>}</div></div>
          <div className="overflow-hidden rounded-lg border border-white/10"><div className="border-b border-white/10 p-3 text-sm font-semibold">3 · Playable interpretation</div><div className="aspect-square bg-[#142016]">{result?<img className="h-full w-full object-contain [image-rendering:pixelated]" src={endpoint(`file/${result.id}/map.png`)} alt={`${result.title} generated game terrain preview`}/>:<div className="grid h-full place-items-center p-8 text-center text-sm text-[#829383]">Your game map appears here.<br/>Clear bases, connected ground routes,<br/>and renewable home resources.</div>}</div></div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">{evidence&&Object.entries(evidence.features.reduce<Record<string,number>>((a,f)=>({...a,[f.kind]:(a[f.kind]??0)+1}),{})).map(([k,v])=><span key={k} className="rounded bg-white/5 px-3 py-1 text-xs"><span style={{color:color[k]}}>●</span> {v} {k}</span>)}</div>
        {evidence&&<p className="mt-3 text-xs text-[#829383]">{evidence.sourceStatus}</p>}
        <div className="mt-5 flex flex-wrap items-center gap-3"><Button size="lg" disabled={!evidence||!!busy} onClick={generate}>Generate battlefield</Button>{result&&<><Button size="lg" onClick={()=>openMap(result.id)}>Use this map →</Button><a className="text-sm text-[var(--hud-gold)] underline" href={endpoint(`file/${result.id}/map.oramap`)} download={`${result.id}.oramap`}>Download map</a></>}{busy&&<p role="status" className="text-sm text-[var(--hud-gold)]">{busy}</p>}</div>
        {result&&<div className="mt-5 rounded border border-[#8caf65]/30 bg-[#8caf65]/5 p-4"><h3 className="font-semibold text-[#bcd49b]">Connected bases checked · {result.players} commanders · {result.validation.homeMines} renewable mines</h3><ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-[#aab6a3]">{result.adaptations.map(t=><li key={t}>{t}</li>)}</ul><p className="mt-3 text-xs">Saved to your local map library. “Use this map” opens skirmish setup with this battlefield selected.</p></div>}
        <p className="mt-5 text-xs text-[#829383]">Geography <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="underline">© OpenStreetMap contributors · ODbL</a>. This is a terrain-inspired strategy map, with explicit gameplay edits.</p>
      </section>
    </main>:<main className="p-6"><div className="mb-5 flex flex-wrap items-center gap-4"><input aria-label="Search local maps" placeholder="Search title, mod, creator or source…" className="w-[min(460px,100%)] rounded border border-white/15 bg-black/30 p-3" value={query} onChange={e=>setQuery(e.target.value)}/><OptionSelect aria-label="Map library filter" value={filter} onValueChange={setFilter} options={[{value:'all',label:'All preserved maps'},{value:'playable',label:'Available in this web engine'},{value:'review',label:'Needs a port or review'}]}/><span className="text-xs text-[#9cae9e]">{library.length} unique maps · {sourceCopies} preserved source copies</span></div><p className="mb-5 text-sm text-[#9cae9e]">Classic, isometric and other mod sources are indexed together. Only compatible, reviewed content appears as playable. Original source layouts stay preserved when adapted.</p><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{shown.map(e=>{const id=runtimeId(e);return <article key={e.id} className="rounded border border-white/10 bg-white/[.025] p-4">{id && previews[id] && <img src={previews[id]} alt={`${e.title} terrain preview`} className="mb-4 h-40 w-full rounded bg-black/30 object-contain [image-rendering:pixelated]"/>}<div className="flex items-start justify-between gap-3"><h2 className="font-semibold text-[var(--hud-gold)]">{e.title}</h2><span className="shrink-0 text-xs text-[#9cae9e]">{e.players} players</span></div><p className="mt-2 text-xs text-[#9cae9e]">{e.author} · {e.mod}</p><p className="mt-3 text-xs">{id?'Available · '+(e.status==='ported'?'isometric adaptation':'compatible web map'):e.reason}</p><details className="mt-3 break-all text-xs text-[#829383]"><summary>{e.copies.length} preserved source{e.copies.length===1?'':'s'}</summary>{e.copies.map(p=><p className="mt-2" key={p}>{p}</p>)}</details>{id&&<Button size="sm" className="mt-4" onClick={()=>openMap(id)}>Use map →</Button>}</article>})}</div>{!shown.length&&<p className="p-10 text-center text-[#9cae9e]">No maps match this search.</p>}</main>}
  </div>;
}
