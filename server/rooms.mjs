import crypto from 'node:crypto';

export function createRooms() {
  const rooms = new Map();
  const send = (res, data, status = 200) => { res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(data)); };
  const view = r => ({id:r.id, state:r.state, settings:r.settings, chat:r.chat||[], players:r.players.map(p=>({id:p.id,faction:p.faction,team:p.team,ready:p.ready,connected:p.connected})), frame:r.frame, verifiedFrame:r.verifiedFrame||0, error:r.error});
  const fail = (r, reason) => { if(r.state==='ended') return; r.state='ended'; r.error=reason; };
  const hasLocalMaps = r => r.catalog.maps.some(map => /^(earth-|port-classic-)/.test(map.id));
  const localMapsMatch = (r, catalog) => !hasLocalMaps(r) || r.catalog.maps.every(map => catalog?.maps?.some(other => other.id === map.id && other.uid === map.uid));
  const timer = setInterval(()=> { for(const r of rooms.values()) { for(const p of r.players) if(Date.now()-p.seen>12000) {p.connected=false;if(Date.now()-p.seen>60000&&r.state=== 'playing')fail(r,`Player ${p.id} did not reconnect within 60 seconds. Match stopped.`);} r.observers=(r.observers||[]).filter(o=>Date.now()-o.seen<=60000);if(Date.now()-r.touched>3600000) rooms.delete(r.id); } },1000);
  timer.unref();
  return { close:()=>clearInterval(timer), async handle(req,res) {
    try {
      let raw=''; for await(const chunk of req) {raw+=chunk; if(raw.length>200000) throw Error('Request too large');}
      const m=JSON.parse(raw||'{}');
      if(m.op==='create') {
        if(typeof m.version!=='string'||!m.version||!m.catalog?.maps?.length) throw Error('Game version and catalog required');
        const id=crypto.randomBytes(16).toString('hex');
        const r={id,version:m.version,catalog:m.catalog,players:[],settings:{map:m.catalog.maps[0].id,ai:[],options:Object.fromEntries((m.catalog.options||[]).map(o=>[o.id,o.default]))},state:'lobby',frame:1,packets:new Map(),hashes:new Map(),waiters:new Set(),touched:Date.now()}; rooms.set(id,r);m.room=id;m.op='join';
      }
      const r=rooms.get(m.room); if(!r) return send(res,{error:'Room not found or expired'},404);r.touched=Date.now();
      if(m.op==='spectate') {
        if(!localMapsMatch(r,m.catalog))return send(res,{error:'Map libraries differ. Reload both browsers after generating or adding maps.'},409);
        if(m.version!==r.version) return send(res,{error:'Incompatible game version.'},409);
        if(r.state==='ended')throw Error('Match has ended');
        r.observers ||= [];
        if(r.observers.length>=16)throw Error('Spectator limit reached');
        const observer={token:crypto.randomBytes(24).toString('hex'),seen:Date.now()};r.observers.push(observer);
        return send(res,{...view(r),token:observer.token,client:1,observer:true,scenario:r.scenario});
      }
      if(m.op==='join') {
        if(!localMapsMatch(r,m.catalog))return send(res,{error:'Map libraries differ. Reload both browsers after generating or adding maps.'},409);
        if(m.version!==r.version) return send(res,{error:'Incompatible game version. Reload both browsers with the same build and content.'},409);
        if(r.state!=='lobby'||r.players.length>=r.catalog.maps.find(x=>x.id===r.settings.map).slots.length-r.settings.ai.length) throw Error('Room is full or already started');
        const p={id:r.players.length+1,token:crypto.randomBytes(24).toString('hex'),faction:r.catalog.factions.find(f=>!f.random)?.id,team:0,ready:false,connected:true,seen:Date.now()};r.players.push(p);return send(res,{...view(r),token:p.token,client:p.id});
      }
      const observer=r.observers?.find(p=>p.token===m.token);
      if(observer) {
        observer.seen=Date.now();
        if(m.op==='leave'){r.observers=r.observers.filter(p=>p!==observer);return send(res,view(r));}
        if(!['poll','watch'].includes(m.op))return send(res,{error:'Spectators cannot issue player commands'},403);
        if(m.op==='watch'&&(!Number.isInteger(m.after)||m.after<0||m.after>r.frame))throw Error('Invalid spectator frame');
        return send(res,{...view(r),scenario:r.scenario,frames:m.op==='watch'?(r.history||[]).slice(m.after,m.after+32):undefined});
      }
      const p=r.players.find(p=>p.token===m.token);if(!p) return send(res,{error:'Invalid room credentials'},403);p.seen=Date.now();p.connected=true;
      if(m.op==='chat') {const text=typeof m.text==='string'?m.text.trim():'';if(!text||text.length>500)throw Error('Chat messages must contain 1–500 characters');if(p.lastChat&&Date.now()-p.lastChat<500)throw Error('Please wait before sending another message');p.lastChat=Date.now();r.chat=[...(r.chat||[]),{id:crypto.randomUUID(),player:p.id,text,time:Date.now()}].slice(-100);}
      if(m.op==='leave') {p.connected=false;p.ready=false;fail(r,`Player ${p.id} left. Room closed.`);}
      if(m.op==='configure') {
        if(r.state!=='lobby') throw Error('Match settings are locked');
        if(m.faction!==undefined) {if(!r.catalog.factions.some(f=>f.id===m.faction)) throw Error('Unknown faction');p.faction=m.faction;}
        if(m.team!==undefined) {if(!Number.isInteger(m.team)||m.team<0||m.team>4) throw Error('Invalid team');p.team=m.team;}
        if(m.settings) {
          if(p.id!==1) throw Error('Only host can change map and AI');
          const map=r.catalog.maps.find(x=>x.id===m.settings.map);if(!map) throw Error('Unknown map');
          const ai=m.settings.ai||[];if(ai.length>map.slots.length-Math.max(2,r.players.length)) throw Error('Too many AI opponents for map');
          for(const a of ai) if(!r.catalog.factions.some(f=>f.id===a.faction)||!r.catalog.bots.some(b=>b.type===a.bot)||!Number.isInteger(a.team)||a.team<0||a.team>4) throw Error('Invalid AI');
          r.settings={...r.settings,map:map.id,ai};
        }
        r.players.forEach(p=>p.ready=false);
      }
      if(m.op==='ready') {if(r.state!=='lobby') throw Error('Match already started');p.ready=!!m.ready;}
      if(m.op==='start') {
        if(p.id!==1||r.state!=='lobby'||r.players.length<2||!r.players.every(p=>p.connected&&p.ready)) throw Error('At least two connected, ready players required');
        const map=r.catalog.maps.find(x=>x.id===r.settings.map);r.scenario={multiplayer:true,map:map.id,seed:crypto.randomInt(1,2147483647),options:r.settings.options,players:[...r.players.map(p=>({client:p.id,faction:p.faction,team:p.team})),...r.settings.ai].map((p,i)=>({...p,slot:map.slots[i],spawn:i+1,color:['2A6FDB','D83A2E','3FAE49','E7B42F'][i%4]}))};r.state='playing';
      }
      if(m.op==='exchange'&&r.state==='playing') {
        if(!Array.isArray(m.events||[])||(m.events||[]).length>16) throw Error('Invalid event batch');
        for(const event of m.events||[]) {
          if(!Number.isInteger(event.frame)||event.frame<1||event.frame>r.frame+1) throw Error('Invalid frame');
          if(event.kind==='orders') {
            if(event.frame<r.frame) continue;
            if(typeof event.data!=='string'||event.data.length>131072||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.data)) throw Error('Invalid order packet');
            let f=r.packets.get(event.frame);if(!f) r.packets.set(event.frame,f=new Map());
            if(f.has(p.id)&&f.get(p.id)!==event.data) throw Error('Conflicting frame packet');f.set(p.id,event.data);
          } else if(event.kind==='hash') {
            if(event.frame <= (r.verifiedFrame||0)) continue;
            if(!Number.isInteger(event.hash)||event.hash < -2147483648||event.hash > 2147483647||typeof event.defeat!=='string'||!/^\d{1,20}$/.test(event.defeat)) throw Error('Invalid synchronization report');
            let h=r.hashes.get(event.frame);if(!h)r.hashes.set(event.frame,h=new Map());h.set(p.id,`${event.hash}:${event.defeat}`);
            if(h.size===r.players.length) {if(new Set(h.values()).size!==1) fail(r,`Synchronization mismatch at frame ${event.frame}. Match stopped.`);else r.verifiedFrame=Math.max(r.verifiedFrame||0,event.frame);r.hashes.delete(event.frame);}
            if(r.hashes.size>64) fail(r,'Missing synchronization reports. Match stopped.');
          }
        }
        const f=r.state==='playing'?r.packets.get(r.frame):null;if(f?.size===r.players.length) {r.completed={frame:r.frame,packets:[...f].map(([client,data])=>({client,data}))};(r.history ||= []).push(r.completed);r.packets.delete(r.frame++);for(const wake of r.waiters)wake();r.waiters.clear();}
        else if(r.state==='playing'&&(m.events||[]).some(e=>e.kind==='orders')) {
          await new Promise(resolve=>{let timer;const wake=()=>{clearTimeout(timer);r.waiters.delete(wake);resolve();};r.waiters.add(wake);timer=setTimeout(wake,35);});
        }
      }
      return send(res,{...view(r),scenario:r.scenario,completed:r.completed});
    } catch(e) {send(res,{error:e.message},400);}
  }};
}
