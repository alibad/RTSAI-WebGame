import { useEffect, useRef, useState } from 'react';
import type { Game } from '../game';
import { useStore } from '../store';
import { Button } from '../components/ui/button';
type AI={faction:string;bot:string;team:number};
type Room={id:string;state:string;players:{id:number;faction:string;team:number;ready:boolean;connected:boolean}[];chat?:{id:string;player:number;text:string}[];settings:{map:string;ai:AI[]};scenario?:object;error?:string;token?:string;client?:number;observer?:boolean};
type Credentials={room:string;token:string;client:number;observer?:boolean};
const endpoint=new URL('api/multiplayer',new URL('./',location.href));
async function rpc(body:object):Promise<Room>{const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error);return d;}
function RoomChat({room,send}:{room:Room;send:(text:string)=>Promise<void>}) {
 const [text,setText]=useState(''),[open,setOpen]=useState(false);
 return <div className="hud-panel p-2 text-xs"><Button size="sm" onClick={()=>setOpen(!open)}>Room chat ({room.chat?.length||0})</Button>{open&&<>
  <div aria-live="polite" className="my-2 max-h-40 w-72 max-w-full overflow-auto">{room.chat?.map(m=><p key={m.id}><strong>Player {m.player}: </strong>{m.text}</p>)}</div>
  <form className="flex gap-1" onSubmit={e=>{e.preventDefault();if(text.trim()){void send(text.trim());setText('');}}}><input aria-label="Room chat message" maxLength={500} value={text} onChange={e=>setText(e.target.value)} className="hud-inset min-w-0 flex-1 p-1"/><Button size="sm" type="submit">Send</Button></form>
 </>}</div>;
}
export function Multiplayer({game}:{game:Game}){
 const setup=useStore(s=>s.setup),phase=useStore(s=>s.phase);
 const [open,setOpen]=useState(!!new URLSearchParams(location.search).get('room'));
 const [room,setRoom]=useState<Room|null>(null),[credentials,setCredentials]=useState<Credentials|null>(null);
 const [error,setError]=useState(''),[invite,setInvite]=useState(new URLSearchParams(location.search).get('room')||'');
 const [status,setStatus]=useState({frame:0,latency:0});const launched=useRef(false);
 useEffect(()=>{game.client.on('networkStatus',m=>{setStatus(m);setError(m.error||'');});},[game]);
 useEffect(()=>{if(phase==='setup'&&launched.current){launched.current=false;setRoom(null);setCredentials(null);setOpen(false);setError('');setStatus({frame:0,latency:0});}},[phase]);
 async function act(op:string,extra:object={}){try{const r=await rpc({op,...credentials,...extra});setRoom(r);}catch(e){setError((e as Error).message);}}
 async function enter(create:boolean,observe=false){try{
  if(!setup?.multiplayer)throw Error('This runtime predates multiplayer. Open the updated interpreter build.');
  const profile=useStore.getState().profile,runtime=new URLSearchParams(location.search).get('runtime')||'aot';
  const hash=async(url:string)=>{const r=await fetch(new URL(url,new URL('./',location.href)));if(!r.ok)throw Error('Cannot fingerprint game build');const b=await crypto.subtle.digest('SHA-256',await r.arrayBuffer());return Array.from(new Uint8Array(b),v=>v.toString(16).padStart(2,'0')).join('');};
  const version='lockstep-1:'+await hash(`${import.meta.env.VITE_RT_BASE??'rt/'}${profile?profile+'/':''}${runtime}/_framework/dotnet.js`)+':'+await hash(`${import.meta.env.VITE_DATA_BASE??'data/'}${profile?profile+'/':''}web-bundle.pack`);
  const r=await rpc({op:create?'create':observe?'spectate':'join',room:invite.includes('://')?new URL(invite).searchParams.get('room'):invite,version,catalog:setup});setRoom(r);setCredentials({room:r.id,token:r.token!,client:r.client!,observer:r.observer});setError('');
 }catch(e){setError((e as Error).message);}}
 useEffect(()=>{if(!credentials)return;let active=true;const t=setInterval(()=>rpc({op:'poll',...credentials}).then(r=>{if(active)setRoom(r);}).catch(e=>{if(active)setError(e.message);}),500);return()=>{active=false;clearInterval(t);};},[credentials]);
 useEffect(()=>{if(room?.state==='playing'&&room.scenario&&credentials&&!launched.current){launched.current=true;setOpen(false);useStore.getState().set({cc:{...useStore.getState().cc,enabled:false}});game.start(JSON.stringify({...room.scenario,localClient:credentials.client,network:credentials}));}},[room,credentials,game]);
 if(!setup)return null;
 if(launched.current)return <div className="fixed left-1/2 -translate-x-1/2 top-3 z-[100] hud-panel p-2 text-xs">{credentials?.observer?'Spectating Commander 1':'Multiplayer'} · frame {status.frame} · {Math.round(status.latency)} ms{room&&!credentials?.observer&&<RoomChat room={room} send={text=>act('chat',{text})}/>} {(error||room?.error)&&<div role="alert" className="text-red-400">{error||room?.error}<Button onClick={()=>location.reload()}>Return to setup</Button></div>}</div>;
 if(phase!=='setup')return null;
 if(credentials?.observer&&room)return <div className="fixed inset-0 z-[100] grid place-items-center bg-black/90"><div className="hud-panel p-6"><h1>Watching the private room</h1><p className="my-3 text-sm">Waiting for the host to start. This view follows Commander 1 and cannot issue orders.</p><Button onClick={()=>void act('leave').then(()=>location.reload())}>Leave spectator view</Button>{error&&<p role="alert">{error}</p>}</div></div>;
 if(!open)return <Button className="fixed right-4 top-4 z-[100]" onClick={()=>setOpen(true)}>Private multiplayer</Button>;
 const mine=room?.players.find(p=>p.id===credentials?.client),map=setup.maps.find(m=>m.id===room?.settings.map),url=new URL(location.href);if(room)url.searchParams.set('room',room.id);
 const setAI=(i:number,patch:Partial<AI>)=>void act('configure',{settings:{...room!.settings,ai:room!.settings.ai.map((a,j)=>j===i?{...a,...patch}:a)}});
 const factions=setup.factions.map(f=><option key={f.id} value={f.id}>{f.name}</option>),teams=[0,1,2,3,4].map(t=><option key={t} value={t}>{t?`Team ${t}`:'No team'}</option>);
 return <div className="fixed inset-0 z-[100] bg-black/90 grid place-items-center p-4"><div className="hud-panel p-6 w-[min(720px,100%)] max-h-full overflow-auto space-y-4">
 <h1 className="text-xl">Private multiplayer</h1>{!setup.multiplayer&&<p role="alert">This runtime predates multiplayer. <a className="underline" href={(() => {const u=new URL(location.href);u.searchParams.set('runtime','interp');return u.href;})()}>Open the updated interpreter build</a>.</p>}<p>Two or more human commanders, up to the map capacity. Interrupted connections retry for 60 seconds.</p>
 {!room?<><Button onClick={()=>void enter(true)}>Create private room</Button><label className="block">Invite link or room code<input aria-label="Invite link or room code" className="block w-full bg-black border p-2" value={invite} onChange={e=>setInvite(e.target.value)}/></label><Button onClick={()=>void enter(false)}>Join room</Button><Button onClick={()=>void enter(false,true)}>Watch as spectator</Button><Button onClick={()=>setOpen(false)}>Back</Button></>:<>
 <label className="block">Invite link<input readOnly aria-label="Room invite" className="block w-full bg-black border p-2" value={url.href}/></label><Button onClick={()=>void navigator.clipboard.writeText(url.href).catch(()=>setError('Could not copy. Select the invite link above and copy it manually.'))}>Copy invite</Button>
 <label className="block">Map<select aria-label="Multiplayer map" disabled={mine?.id!==1} value={room.settings.map} onChange={e=>void act('configure',{settings:{map:e.target.value,ai:[]}})}>{setup.maps.map(m=><option key={m.id} value={m.id}>{m.title} ({m.players} players)</option>)}</select></label>
 {room.players.map(p=><div key={p.id} className="flex gap-3"><span>Player {p.id} {p.connected?'':'disconnected'}</span><select aria-label={`Player ${p.id} faction`} disabled={p.id!==mine?.id} value={p.faction} onChange={e=>void act('configure',{faction:e.target.value})}>{factions}</select><select aria-label={`Player ${p.id} team`} disabled={p.id!==mine?.id} value={p.team} onChange={e=>void act('configure',{team:Number(e.target.value)})}>{teams}</select><span>{p.ready?'Ready':'Not ready'}</span></div>)}
 {room.players.length<2&&<p>Waiting for second commander…</p>}
 {room.settings.ai.map((a,i)=><div key={i} className="flex gap-2">AI {i+1}<select aria-label={`AI ${i+1} faction`} disabled={mine?.id!==1} value={a.faction} onChange={e=>setAI(i,{faction:e.target.value})}>{factions}</select><select aria-label={`AI ${i+1} difficulty`} disabled={mine?.id!==1} value={a.bot} onChange={e=>setAI(i,{bot:e.target.value})}>{setup.bots.map(b=><option key={b.type} value={b.type}>{b.name}</option>)}</select><select aria-label={`AI ${i+1} team`} disabled={mine?.id!==1} value={a.team} onChange={e=>setAI(i,{team:Number(e.target.value)})}>{teams}</select></div>)}
 {mine?.id===1&&<><Button disabled={room.settings.ai.length+Math.max(2,room.players.length)>=(map?.slots.length||0)} onClick={()=>void act('configure',{settings:{...room.settings,ai:[...room.settings.ai,{faction:setup.factions.find(f=>!f.random)!.id,bot:setup.bots[0].type,team:0}]}})}>Add AI</Button><Button disabled={!room.settings.ai.length} onClick={()=>void act('configure',{settings:{...room.settings,ai:room.settings.ai.slice(0,-1)}})}>Remove AI</Button></>}
 <div className="flex gap-3"><Button disabled={room.state!=='lobby'} onClick={()=>void act('ready',{ready:!mine?.ready})}>{mine?.ready?'Unready':'Ready'}</Button>{mine?.id===1&&<Button disabled={room.players.length<2||!room.players.every(p=>p.ready&&p.connected)} onClick={()=>void act('start')}>Start synchronized match</Button>}<Button onClick={()=>void act('leave').then(()=>location.reload())}>Leave room</Button></div></>}
 {room&&!credentials?.observer&&<RoomChat room={room} send={text=>act('chat',{text})}/>}
 {(error||room?.error)&&<p role="alert" className="text-red-400">{error||room?.error}</p>}
 </div></div>;
}
