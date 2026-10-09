import { useEffect, useRef, useState } from 'react';
import type { Game } from '../game';
import { useStore } from '../store';
import { MatchChat } from './MatchChat';
import { Button } from '../components/ui/button';
import { DirectPeer, PeerLockstep, type PeerEvent } from '../peer';

function Video({ stream, muted = false }: { stream: MediaStream | null; muted?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (video.current) video.current.srcObject = stream; }, [stream]);
  return <video ref={video} autoPlay playsInline muted={muted} className="w-40 max-w-full rounded" aria-label={muted ? 'Your camera' : 'Friend camera'} />;
}

type Scenario = { multiplayer: true; map: string; seed: number; options: Record<string, string>; players: { client: number; slot: string; faction: string; spawn: number; team: number; color: string }[] };

export function DirectMultiplayer({ game }: { game: Game }) {
  const setup = useStore(s => s.setup), phase = useStore(s => s.phase);
  const [open, setOpen] = useState(false), [input, setInput] = useState(''), [output, setOutput] = useState('');
  const [state, setState] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [host, setHost] = useState(false), [verified, setVerified] = useState(false), [playing, setPlaying] = useState(false);
  const [faction, setFaction] = useState('china'), [friend, setFriend] = useState('iran'), [map, setMap] = useState('');
  const [chat, setChat] = useState<{id:string;text:string}[]>([]), [message, setMessage] = useState(''), [call, setCall] = useState<MediaStream | null>(null);
  const [frame, setFrame] = useState(0);
  const peer = useRef<DirectPeer | null>(null), local = useRef(1), lock = useRef<PeerLockstep | null>(null), version = useRef(''), active = useRef(false), started = useRef(false);
  const choice = useRef(faction); choice.current = faction;

  function fail(value: unknown) {
    const text = value instanceof Error ? value.message : String(value); setError(text);
    if (started.current) game.client.send({ type: 'peerStop', error: text });
  }
  function launch(scenario: Scenario) {
    if (started.current || !setup) return;
    const selectedMap = setup.maps.find(m => m.id === scenario.map);
    if (!selectedMap || scenario.multiplayer !== true || !Number.isInteger(scenario.seed) || scenario.seed < 1 || scenario.players.length !== 2 || scenario.players.some((p, i) => p.client !== i + 1 || p.slot !== selectedMap.slots[i] || !setup.factions.some(f => f.id === p.faction && !f.random))) throw Error('Invalid peer match settings');
    lock.current = new PeerLockstep(frame => game.client.send({ type: 'peerFrame', ...frame }));
    started.current = true; setPlaying(true); setOpen(false);
    useStore.getState().set({ cc: { ...useStore.getState().cc, enabled: false } });
    game.start(JSON.stringify({ ...scenario, localClient: local.current, network: { peer: true } }));
  }
  useEffect(() => {
    active.current = true;
    game.client.on('peerOut', m => {
      if (!active.current || !started.current || !peer.current || !lock.current) return;
      try { peer.current.send({ kind: 'events', events: m.events }); lock.current.receive(local.current, m.events); } catch (e) { fail(e); }
    });
    game.client.on('networkStatus', m => { if (active.current && started.current) { setFrame(m.frame); if (m.error) setError(m.error); } });
    return () => { active.current = false; peer.current?.close(); };
  }, [game]);
  useEffect(() => {
    if (phase === 'setup' && started.current) { peer.current?.close(); started.current = false; setPlaying(false); setVerified(false); setCall(null); setState(''); }
  }, [phase]);

  async function fingerprint() {
    const profile = useStore.getState().profile, runtime = new URLSearchParams(location.search).get('runtime') || 'aot';
    const digest = async (path: string) => {
      const r = await fetch(new URL(path, new URL('./', location.href))); if (!r.ok) throw Error('Cannot identify this build');
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await r.arrayBuffer())), x => x.toString(16).padStart(2, '0')).join('');
    };
    return 'direct-1:' + await digest(`${import.meta.env.VITE_RT_BASE ?? 'rt/'}${profile ? profile + '/' : ''}${runtime}/_framework/dotnet.js`) + ':' + await digest(`${import.meta.env.VITE_DATA_BASE ?? 'data/'}${profile ? profile + '/' : ''}web-bundle.pack`);
  }
  async function connect(create: boolean) {
    setBusy(true); setError(''); setVerified(false); setOutput('');
    try {
      if (!setup?.multiplayer) throw Error('Load the updated game runtime first');
      peer.current?.close(); version.current = await fingerprint();
      const p = new DirectPeer(); peer.current = p; local.current = create ? 1 : 2; setHost(create);
      p.onState = s => {
        setState(s);
        if (s === 'connected' && p.channel?.readyState === 'open') p.send({ kind: 'hello', version: version.current, faction: choice.current });
        if (['failed', 'closed', 'disconnected'].includes(s)) fail('Direct connection interrupted. Return to setup and reconnect.');
      };
      p.onMessage = m => {
        try {
          if (m.kind === 'hello') {
            if (m.version !== version.current) throw Error('Different game builds. Reload both browsers with the same build.');
            if (!setup.factions.some(f => f.id === m.faction && !f.random)) throw Error('Unknown friend faction');
            setFriend(m.faction as string); setVerified(true);
          } else if (m.kind === 'faction') {
            if (!setup.factions.some(f => f.id === m.faction && !f.random)) throw Error('Unknown friend faction');
            setFriend(m.faction as string);
          } else if (m.kind === 'start') {
            if (create) throw Error('Only the host starts the match');
            if (m.version !== version.current) throw Error('Different game build');
            launch(m.scenario as Scenario);
          } else if (m.kind === 'events') {
            if (!lock.current) throw Error('Match has not started');
            lock.current.receive(create ? 2 : 1, m.events as PeerEvent[]);
          } else if (m.kind === 'chat') {
            if (typeof m.text !== 'string' || m.text.length > 500) throw Error('Invalid chat message');
            setChat(c => [...c, {id:crypto.randomUUID(),text:`Friend: ${m.text}`}].slice(-100));
          } else if (m.kind === 'leave') fail('Your friend left the match');
        } catch (e) { fail(e); }
      };
      setState('Gathering connection code…');
      setOutput(create ? await p.offer() : await p.answer(input));
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  function start() {
    try {
      const selected = setup!.maps.find(m => m.id === map) ?? setup!.maps.find(m => m.slots.length >= 2)!;
      const scenario: Scenario = { multiplayer: true, map: selected.id, seed: crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646 + 1,
        options: { techlevel: 'unrestricted', shortgame: 'True', crates: 'False', startingunits: 'none', startingcash: '10000' },
        players: [faction, friend].map((f, i) => ({ client: i + 1, slot: selected.slots[i], faction: f, spawn: i + 1, team: 0, color: i ? 'D83A2E' : '2A6FDB' })) };
      peer.current!.send({ kind: 'start', version: version.current, scenario }); launch(scenario);
    } catch (e) { fail(e); }
  }
  async function camera() { try { setCall(await peer.current!.camera()); } catch (e) { fail(e); } }
  function leave() {
    try { peer.current?.send({ kind: 'leave' }); } catch { /* connection is already closed */ }
    peer.current?.close(); peer.current = null; setCall(null); setVerified(false); setState(''); setError(''); setOpen(false);
    if (started.current) { game.quit(); started.current = false; setPlaying(false); }
  }
  if (!setup || (!playing && phase !== 'setup')) return null;
  const matchChat=playing&&<MatchChat inputLabel="Direct chat message" messages={chat.map(({id,text})=>({id,author:text.startsWith('You: ')?'You':'Friend',text:text.slice(text.indexOf(': ')+2)}))} send={async text=>{peer.current!.send({kind:'chat',text});setChat(c=>[...c,{id:crypto.randomUUID(),text:`You: ${text}`} ].slice(-100));}}/>;
  if (!open) return <>{matchChat}<Button className={`fixed z-[100] ${import.meta.env.VITE_STATIC_BUILD === "1" ? "right-4 top-4" : "right-4 top-16"}`} style={playing ? { right: "calc(var(--sidebar-w) + 16px)" } : undefined} onClick={() => setOpen(true)}>{playing ? 'Match connection' : 'Multiplayer'}</Button></>;
  return <>{matchChat}<div className={`${playing ? 'fixed left-4 top-14 w-[min(500px,90vw)]' : 'fixed inset-0 grid place-items-center bg-black/90 p-4'} z-[110]`}>
    <div className="hud-panel max-h-[85vh] w-full max-w-[650px] overflow-auto space-y-3 p-5">
      <h1 className="text-xl">Multiplayer</h1>
      {!playing && <p className="text-sm">Play a two-player match. Exchange connection codes with your friend through your existing chat. Some networks may prevent a connection.</p>}
      <p aria-live="polite">{state}{playing && ` · frame ${frame}`}</p>
      {!playing && <label className="block">Your faction<select aria-label="Direct faction" className="hud-inset ml-2 p-1" value={faction} onChange={e => { setFaction(e.target.value); if (verified) peer.current?.send({ kind: 'faction', faction: e.target.value }); }}>{setup.factions.filter(f => !f.random).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>}
      {!verified && !playing && <>
        <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void connect(true)}>Create offer</Button><Button disabled={busy || !input} onClick={() => void connect(false)}>Answer friend offer</Button></div>
        <label className="block">Friend connection code<textarea aria-label="Friend connection code" className="hud-inset block w-full p-2" rows={3} value={input} onChange={e => setInput(e.target.value)} /></label>
        {host && output && <Button disabled={busy || !input} onClick={() => void peer.current!.connect(input).catch(fail)}>Connect with friend answer</Button>}
        {output && <label className="block">Your {host ? 'offer' : 'answer'} code<textarea readOnly aria-label="Your connection code" className="hud-inset block w-full p-2" rows={3} value={output} /><Button onClick={() => void navigator.clipboard.writeText(output).catch(fail)}>Copy code</Button></label>}
      </>}
      {verified && <>
        {!playing && <><p>Friend faction: {setup.factions.find(f => f.id === friend)?.name}</p>{host ? <><label>Map<select aria-label="Direct map" className="hud-inset ml-2 p-1" value={map || setup.maps.find(m => m.slots.length >= 2)?.id} onChange={e => setMap(e.target.value)}>{setup.maps.filter(m => m.slots.length >= 2).map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</select></label><Button onClick={start}>Start match</Button></> : <p>Waiting for your friend to start.</p>}</>}
        <div className="flex flex-wrap gap-2"><Video stream={peer.current?.remoteMedia ?? null} /><Video stream={call} muted /></div>
        <div className="flex gap-2"><Button onClick={() => void camera()}>Enable camera and microphone</Button>{call && <Button onClick={() => { peer.current?.stopCamera(); setCall(null); }}>Stop camera and microphone</Button>}</div>
        {!playing&&<><div aria-live="polite" className="max-h-32 overflow-auto text-sm">{chat.map(entry => <p key={entry.id}>{entry.text}</p>)}</div>
        <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (!message.trim()) return; try { peer.current!.send({ kind: 'chat', text: message.trim() }); setChat(c => [...c, {id:crypto.randomUUID(),text:`You: ${message.trim()}`} ].slice(-100)); setMessage(''); } catch (e) { fail(e); } }}><input aria-label="Direct chat message" maxLength={500} className="hud-inset min-w-0 flex-1 p-2" value={message} onChange={e => setMessage(e.target.value)} /><Button type="submit">Send</Button></form></>}
      </>}
      {error && <p role="alert" className="text-red-400">{error}</p>}
      <div className="flex gap-2"><Button onClick={() => setOpen(false)}>Minimize</Button><Button onClick={leave}>{playing ? 'Leave match' : 'Close connection'}</Button></div>
    </div>
  </div></>;
}
