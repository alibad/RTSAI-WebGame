import { buildIdentity } from "../sim/build-identity";
import { useEffect, useRef, useState } from 'react';
import type { Game } from '../game';
import { useStore } from '../store';
import { Button } from '../components/ui/button';
import { Flag } from './Flag';
import { OptionSelect, SearchSelect, Swatch, type Option } from '../components/ui/fields';
import { MatchChat } from './MatchChat';
import { MessageSquare, ChevronDown } from 'lucide-react';
type AI={faction:string;bot:string;team:number};
type Room={id:string;state:string;players:{id:number;faction:string;team:number;ready:boolean;connected:boolean}[];chat?:{id:string;player:number;text:string}[];settings:{map:string;ai:AI[]};scenario?:object;error?:string;token?:string;client?:number;observer?:boolean};
type Credentials={room:string;token:string;client:number;observer?:boolean};
const endpoint=new URL('api/multiplayer',new URL('./',location.href));
const connectionMessage='Cannot reach the local game server. Start launch-multiplayer.cmd in RTSAI-WebGame, keep its window open, then check the connection again. This works in the in-app browser and Chrome.';
async function rpc(body:object):Promise<Room>{
 let r:Response;
 try{r=await fetch(endpoint,{method:'POST',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}catch{throw Error(connectionMessage);}
 let d:Room;try{d=await r.json();}catch{throw Error('The server did not return a room response. Restart launch-multiplayer.cmd and reload this page.');}
 if(!r.ok)throw Error(d.error||'The room request could not be completed.');return d;
}
function RoomChat({room,send,compact=false}:{room:Room;send:(text:string)=>Promise<void>;compact?:boolean}) {
 const [text,setText]=useState(''),[open,setOpen]=useState(false);
 const [seen,setSeen]=useState(room.chat?.length||0);
 useEffect(()=>{if(open)setSeen(room.chat?.length||0);},[open,room.chat?.length]);
 const unread=Math.max(0,(room.chat?.length||0)-seen);
 return <div className={compact?'mp-match-chat':'hud-panel p-2 text-xs'}><Button variant="ghost" size="sm" aria-expanded={open} onClick={()=>setOpen(!open)}><MessageSquare size={14}/> {compact?'Chat':'Room chat'}{unread>0&&<span className="mp-unread">{unread}</span>}</Button>{open&&<div className={compact?'hud-panel mp-chat-popover':'mt-2'}>
  <div className="mp-chat-heading"><strong>Room chat</strong><Button variant="ghost" size="sm" aria-label="Close room chat" onClick={()=>setOpen(false)}>Close</Button></div>
  <div aria-live="polite" className="mp-chat-messages">{room.chat?.length?room.chat.map(m=><p key={m.id}><strong>Player {m.player}: </strong>{m.text}</p>):<p className="mp-note">No messages yet. Coordinate with your commanders here.</p>}</div>
  <form className="flex gap-2" onSubmit={e=>{e.preventDefault();if(text.trim()){void send(text.trim());setText('');}}}><input aria-label="Room chat message" placeholder="Message your commanders…" maxLength={500} value={text} onChange={e=>setText(e.target.value)} className="hud-inset min-w-0 flex-1 p-2 rounded-md text-xs"/><Button size="sm" type="submit" disabled={!text.trim()}>Send</Button></form>
 </div>}</div>;
}
function MatchConnection({game,room,observer,error,send}:{game:Game;room:Room|null;observer?:boolean;error:string;send:(text:string)=>Promise<void>}) {
 const [details,setDetails]=useState(false),[networkError,setNetworkError]=useState('');
 const [stats,setStats]=useState({frame:0,latency:0});
 const sample=useRef({frame:0,total:0,count:0,latency:0,healthySince:0});
 useEffect(()=>{let active=true;game.client.on('networkStatus',m=>{if(!active)return;const s=sample.current;s.frame=m.frame;
  if(m.error){s.healthySince=0;setNetworkError(m.error);}else{if(!s.healthySince)s.healthySince=performance.now();if(performance.now()-s.healthySince>=2000)setNetworkError('');s.total+=m.latency;s.count++;}
 });return()=>{active=false;};},[game]);
 useEffect(()=>{const t=setInterval(()=>{const s=sample.current;if(s.count){s.latency=Math.round(s.total/s.count/5)*5;s.total=0;s.count=0;}if(details)setStats({frame:s.frame,latency:s.latency});},2000);return()=>clearInterval(t);},[details]);
 const stopped=room?.state==='ended',problem=room?.error||networkError||error;
 const waiting=room?.players.some(p=>!p.connected);
 const label=stopped?'Match stopped':problem?'Retrying local requests':waiting?'Waiting for player':'Connected';
 return <><section aria-label="Multiplayer controls" className="mp-match">
  <div className="hud-panel mp-match-bar"><span className="mp-match-name">{observer?'Spectating':'Multiplayer'}</span><Button variant="ghost" size="sm" className="mp-match-connection" aria-label="Connection details" aria-expanded={details} onClick={()=>{setStats({frame:sample.current.frame,latency:sample.current.latency});setDetails(!details);}}><span className={`mp-dot ${problem||waiting?'offline':'online'}`}/><span>{label}</span><ChevronDown size={12}/></Button></div>
  {details&&<div className="hud-panel mp-network-details"><h2>Connection details</h2><dl><div><dt>Average request time</dt><dd>{stats.latency<5?'< 5':stats.latency} ms</dd></div><div><dt>Simulation frame</dt><dd>{stats.frame}</dd></div></dl><p>Timing is averaged and refreshed every two seconds.</p><Button variant="ghost" size="sm" onClick={()=>setDetails(false)}>Close details</Button></div>}
  {problem&&<div role="alert" className="hud-panel mp-match-error"><strong>{stopped?'Match stopped':'Connection interrupted'}</strong><p>{problem}</p>{stopped?<Button variant="outline" size="sm" onClick={()=>location.reload()}>Return to setup</Button>:<p className="mp-note">This open browser retains its pending orders while retrying the local server. Closing, reloading or rejoining cannot restore this world. Return to setup to start a new match.</p>}</div>}
 </section>{room&&!observer&&<MatchChat messages={(room.chat||[]).map(m=>({id:m.id,author:`Player ${m.player}`,text:m.text}))} send={send}/>}</>;
}
export function Multiplayer({game}:{game:Game}){
 const setup=useStore(s=>s.setup),phase=useStore(s=>s.phase);
 const [open,setOpen]=useState(!!new URLSearchParams(location.search).get('room'));
 const [room,setRoom]=useState<Room|null>(null),[credentials,setCredentials]=useState<Credentials|null>(null);
 const [error,setError]=useState(''),[invite,setInvite]=useState(new URLSearchParams(location.search).get('room')||'');
 const [busy,setBusy]=useState(''),[connection,setConnection]=useState<'checking'|'online'|'offline'>('checking'),[copied,setCopied]=useState(false);
 const previews=useStore(s=>s.previews);
 const launched=useRef(false);
 async function checkConnection(){setConnection('checking');try{const r=await fetch(new URL('api/health',new URL('./',location.href)),{signal:AbortSignal.timeout(4000),cache:'no-store'});const d=await r.json();setConnection(r.ok&&d.ok?'online':'offline');}catch{setConnection('offline');}}
 useEffect(()=>{if(!open&&!credentials)return;void checkConnection();const t=setInterval(()=>void checkConnection(),10000);return()=>clearInterval(t);},[open,credentials]);
 useEffect(()=>{if(open&&room?.settings.map)game.preview(room.settings.map);},[open,room?.settings.map,game]);
 useEffect(()=>{if(phase==='setup'&&launched.current){launched.current=false;setRoom(null);setCredentials(null);setOpen(false);setError('');}},[phase]);
 async function act(op:string,extra:object={}){if(busy)return;setBusy(op);setError('');try{const r=await rpc({op,...credentials,...extra});setRoom(r);}catch(e){setError((e as Error).message);}finally{setBusy('');}}
 async function enter(create:boolean,observe=false){if(busy)return;setBusy(create?'create':'join');setError('');try{
  if(!setup?.multiplayer)throw Error('This runtime predates multiplayer. Open the updated interpreter build.');
  let roomCode=invite.trim();
  if(!create){if(roomCode.includes('://')){try{roomCode=new URL(roomCode).searchParams.get('room')||'';}catch{throw Error('Paste a valid invite link or the room code from your host.');}}if(!roomCode)throw Error('Paste the invite link or room code your host shared first.');}
  const profile=useStore.getState().profile,runtime=new URLSearchParams(location.search).get('runtime')||'aot';
  const version='lockstep-3:'+await buildIdentity(profile,runtime);
  const r=await rpc({op:create?'create':observe?'spectate':'join',room:roomCode,version,catalog:setup});setRoom(r);setCredentials({room:r.id,token:r.token!,client:r.client!,observer:r.observer});setError('');
 }catch(e){setError((e as Error).message);}finally{setBusy('');}}
 useEffect(()=>{if(!credentials)return;let active=true;const t=setInterval(()=>rpc({op:'poll',...credentials}).then(r=>{if(active){setRoom(r);setError(previous=>previous===connectionMessage?'':previous);}}).catch(e=>{if(active)setError(e.message);}),500);return()=>{active=false;clearInterval(t);};},[credentials]);
 useEffect(()=>{if(room?.state==='playing'&&room.scenario&&credentials&&!launched.current){launched.current=true;setOpen(false);useStore.getState().set({cc:{...useStore.getState().cc,enabled:false}});game.start(JSON.stringify({...room.scenario,localClient:credentials.client,network:credentials}));}},[room,credentials,game]);
 if(!setup)return null;
 if(launched.current)return <MatchConnection game={game} room={room} observer={credentials?.observer} error={error} send={async text=>{const r=await rpc({op:'chat',...credentials,text});setRoom(r);}}/>;
 if(phase!=='setup')return null;
 if(credentials?.observer&&room)return <div className="fixed inset-0 z-[100] grid place-items-center bg-black/90"><div className="hud-panel p-6"><h1>Watching the private room</h1><p className="my-3 text-sm">Waiting for the host to start. This view follows Commander 1 and cannot issue orders.</p><Button onClick={()=>void act('leave').then(()=>location.reload())}>Leave spectator view</Button>{error&&<p role="alert">{error}</p>}</div></div>;
 if(!open)return <Button className="fixed right-4 top-4 z-[100]" onClick={()=>setOpen(true)}>Private multiplayer</Button>;
 const mine=room?.players.find(p=>p.id===credentials?.client),map=setup.maps.find(m=>m.id===room?.settings.map),url=new URL(location.href);if(room)url.searchParams.set('room',room.id);
 const setAI=(i:number,patch:Partial<AI>)=>void act('configure',{settings:{...room!.settings,ai:room!.settings.ai.map((a,j)=>j===i?{...a,...patch}:a)}});
 const factions:Option<string>[]=setup.factions.map(f=>({value:f.id,label:f.name,leading:<Flag id={f.id} className="h-4 w-6 shrink-0 rounded-sm"/>}));
 const teams:Option<number>[]=[0,1,2,3,4].map(t=>({value:t,label:t?`Team ${t}`:'No team',leading:<Swatch color={['#7d8876','#2a6fdb','#d83a2e','#3fae49','#e7b42f'][t]}/>}));
 const maps:Option<string>[]=setup.maps.map(m=>({value:m.id,label:m.title,description:`${m.slots.length} slots`}));
 const difficulties:Option<string>[]=setup.bots.map(b=>({value:b.type,label:b.name}));
 const available=connection!=='offline'&&!!setup.multiplayer&&!busy;
 const allReady=room&&room.players.length>=2&&room.players.every(p=>p.ready&&p.connected);
 const next=room?(room.players.length<2?'Share the invite to bring in a second commander.':!mine?.ready?'Choose your faction and team, then mark yourself ready.':!allReady?'Waiting for the other commanders to get ready.':mine?.id===1?'Everyone is ready. You can start the match.':'Everyone is ready. Waiting for the host to start.'):'';
 return <div className="mp-overlay"><section role="dialog" aria-modal="true" aria-labelledby="mp-title" className="hud-panel mp-dialog" onKeyDown={e=>{if(e.key==='Escape'&&!room)setOpen(false);if(e.key==='Tab'){const nodes=Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]')).filter(n=>n.getClientRects().length);const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}}}>
 <header className="mp-header"><div><span className="mp-eyebrow">RTS AI · LOCAL ROOM SERVER</span><h1 id="mp-title">{room?'Room lobby':'Private multiplayer'}</h1><p>{room?'Choose your side. Prepare your team.':'Host a match or join a friend’s room.'}</p></div><Button autoFocus variant="ghost" onClick={()=>room?void act('leave').then(()=>location.reload()):setOpen(false)} aria-label={room?'Leave room':'Back'}>{room?'Leave room':'Back'}</Button></header>
 <div className="mp-connection" role="status"><span className={`mp-dot ${connection}`}/><span>{connection==='online'?'Local server connected':connection==='offline'?'Local server unavailable':'Checking local server…'}</span><Button variant="ghost" size="sm" onClick={()=>void checkConnection()}>Check connection</Button></div>
 {connection==='offline'&&<div className="mp-error" role="alert"><strong>Start the local server to play</strong><p>{connectionMessage}</p><code>launch-multiplayer.cmd</code></div>}
 {!setup.multiplayer&&<p className="mp-error" role="alert">This build needs an updated runtime. <a className="underline" href={(() => {const u=new URL(location.href);u.searchParams.set('runtime','interp');return u.href;})()}>Open the updated interpreter build</a>.</p>}
 {!room?<>
 <div className="mp-choices"><section className="mp-card mp-host"><span className="mp-eyebrow">01 · HOST</span><h2>Create a private room</h2><p>You choose the map and AI opponents. Share an invite, then start when everyone is ready.</p><Button size="lg" disabled={!available} onClick={()=>void enter(true)}>{busy==='create'?'Creating your room…':'Create private room'}</Button></section>
 <section className="mp-card"><span className="mp-eyebrow">02 · JOIN</span><h2>Have an invite?</h2><p>Paste the link or code from your host.</p><form onSubmit={e=>{e.preventDefault();void enter(false);}}><label className="mp-field">Invite link or room code<input aria-label="Invite link or room code" placeholder="Paste an invite link or room code" autoComplete="off" value={invite} onChange={e=>setInvite(e.target.value)}/></label><div className="mp-actions"><Button size="lg" type="submit" disabled={!available||!invite.trim()}>{busy==='join'?'Joining…':'Join room'}</Button><Button variant="ghost" disabled={!available||!invite.trim()} onClick={()=>void enter(false,true)}>Watch as spectator</Button></div></form></section></div>
 <p className="mp-note">Playing locally? Open the invite in a second browser profile or private window on this computer. This server supports local play; it doesn’t make an internet room.</p>
 </>:<>
 <nav className="mp-steps" aria-label="Room progress"><span className="done">1 · Invite a friend</span><span className={room.players.length>=2?'done':''}>2 · Choose your sides</span><span className={allReady?'done':''}>3 · Ready & play</span></nav>
 <section className="mp-invite"><div><h2>Invite your commanders</h2><p>Room <strong className="digits">{room.id}</strong> · {room.players.length} / {map?.slots.length||2} human & AI slots</p></div><div className="mp-copy"><input readOnly aria-label="Room invite" value={url.href}/><Button onClick={()=>void navigator.clipboard.writeText(url.href).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2500);}).catch(()=>setError('Could not copy. Select the invite link and copy it manually.'))}>{copied?'Copied!':'Copy invite'}</Button></div></section>
 <div className="mp-lobby"><section className="mp-card"><h2>Battlefield</h2>{map&&previews[map.id]&&<img className="mp-map" src={previews[map.id]} alt={`${map.title} map preview`}/>}<label className="mp-field">Map<OptionSelect aria-label="Multiplayer map" className="mp-picker" disabled={mine?.id!==1||!!busy} value={room.settings.map} options={maps} onValueChange={map=>void act('configure',{settings:{map,ai:[]}})}/></label><p className="mp-note">{mine?.id===1?'Choose a map with extra slots to add AI. Changing the map clears AI and ready states.':'The host chooses the map and AI opponents.'}</p></section>
 <section className="mp-card mp-roster"><h2>Commanders</h2>{room.players.map(p=><div className="mp-player" key={p.id}><div className="mp-player-title"><Flag id={p.faction} className="h-5 w-8 rounded-sm"/><strong>Player {p.id}{p.id===mine?.id?' · You':p.id===1?' · Host':''}</strong><span className={`mp-badge ${p.ready?'ready':''}`}>{!p.connected?'Disconnected':p.ready?'Ready':'Not ready'}</span></div><div className="mp-player-fields"><label className="mp-field">Faction<SearchSelect aria-label={`Player ${p.id} faction`} className="mp-picker" placeholder="Search factions…" empty="No factions match. Try another name." disabled={p.id!==mine?.id||!!busy} value={p.faction} options={factions} onValueChange={faction=>void act('configure',{faction})}/></label><label className="mp-field">Team<OptionSelect aria-label={`Player ${p.id} team`} className="mp-picker" disabled={p.id!==mine?.id||!!busy} value={p.team} options={teams} onValueChange={team=>void act('configure',{team})}/></label></div></div>)}
 {room.players.length<2&&<div className="mp-empty">Waiting for a friend…<p>Copy the invite above and open it in another profile.</p></div>}
 {room.settings.ai.map((a,i)=><div className="mp-player" key={`ai${i}`}><div className="mp-player-title"><Flag id={a.faction} className="h-5 w-8 rounded-sm"/><strong>AI {i+1}</strong><span className="mp-badge">Computer</span></div><div className="mp-player-fields"><label className="mp-field">Faction<SearchSelect aria-label={`AI ${i+1} faction`} className="mp-picker" placeholder="Search factions…" empty="No factions match. Try another name." disabled={mine?.id!==1||!!busy} value={a.faction} options={factions} onValueChange={faction=>setAI(i,{faction})}/></label><label className="mp-field">Difficulty<OptionSelect aria-label={`AI ${i+1} difficulty`} className="mp-picker" disabled={mine?.id!==1||!!busy} value={a.bot} options={difficulties} onValueChange={bot=>setAI(i,{bot})}/></label><label className="mp-field">Team<OptionSelect aria-label={`AI ${i+1} team`} className="mp-picker" disabled={mine?.id!==1||!!busy} value={a.team} options={teams} onValueChange={team=>setAI(i,{team})}/></label></div></div>)}
 {mine?.id===1&&<div className="mp-actions"><Button variant="outline" disabled={!!busy||room.settings.ai.length+Math.max(2,room.players.length)>=(map?.slots.length||0)} onClick={()=>void act('configure',{settings:{...room.settings,ai:[...room.settings.ai,{faction:setup.factions.find(f=>!f.random)!.id,bot:setup.bots[0].type,team:0}]}})}>Add AI</Button><Button variant="ghost" disabled={!!busy||!room.settings.ai.length} onClick={()=>void act('configure',{settings:{...room.settings,ai:room.settings.ai.slice(0,-1)}})}>Remove AI</Button></div>}<p className="mp-note">Commanders on the same numbered team are allies. “No team” means every commander fights for themselves.</p>
 </section></div>
 <RoomChat room={room} send={text=>act('chat',{text})}/>
 <footer className="mp-footer"><p role="status">{busy==='start'?'Starting the match…':next}</p><div className="mp-actions"><Button variant={mine?.ready?'outline':'default'} size="lg" disabled={room.state!=='lobby'||!!busy||connection==='offline'} onClick={()=>void act('ready',{ready:!mine?.ready})}>{mine?.ready?'Unready':'Ready'}</Button>{mine?.id===1&&<Button size="lg" disabled={!allReady||!!busy||connection==='offline'} onClick={()=>void act('start')}>Start synchronized match</Button>}</div></footer></>}
 {(error||room?.error)&&<div role="alert" className="mp-error"><strong>Unable to continue</strong><p>{error||room?.error}</p></div>}
 </section></div>;
}
