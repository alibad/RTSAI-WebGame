import { buildIdentity } from "../sim/build-identity";
import { GameSelect } from '../components/ui/fields';
import { useEffect, useRef, useState } from 'react';
import type { Game } from '../game';
import { useStore } from '../store';
import { MatchChat } from './MatchChat';
import { Button } from '../components/ui/button';
import { DirectPeer, PeerLockstep, peerMap, peerOptions, validatePeerScenario, type PeerScenario } from '../peer';

function Video({ stream, muted = false }: { stream: MediaStream | null; muted?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (video.current) video.current.srcObject = stream; }, [stream]);
  return <video ref={video} autoPlay playsInline muted={muted} className="w-40 max-w-full rounded" aria-label={muted ? 'Your camera' : 'Friend camera'} />;
}

export function DirectMultiplayer({ game }: { game: Game }) {
  const setup = useStore(s => s.setup), phase = useStore(s => s.phase);
  const [open, setOpen] = useState(false), [input, setInput] = useState(''), [output, setOutput] = useState('');
  const [state, setState] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState('');
  const [host, setHost] = useState(false), [verified, setVerified] = useState(false), [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false), [friendReady, setFriendReady] = useState(false);
  const [faction, setFaction] = useState('china'), [friend, setFriend] = useState('iran'), [map, setMap] = useState('');
  const [chat, setChat] = useState<{ id: string; text: string }[]>([]), [message, setMessage] = useState(''), [call, setCall] = useState<MediaStream | null>(null);
  const [frame, setFrame] = useState(0);
  const peer = useRef<DirectPeer | null>(null), local = useRef(1), lock = useRef<PeerLockstep | null>(null), version = useRef(''), active = useRef(false), started = useRef(false), generation = useRef(0), working = useRef(false);
  const lobby = useRef({ verified: false, ready: false, friendReady: false, faction: 'china', friend: 'iran', map: '' });

  function clearReady() {
    lobby.current.ready = false; lobby.current.friendReady = false;
    setReady(false); setFriendReady(false);
  }
  function closePeer() {
    const previous = peer.current; peer.current = null; previous?.close(); setCall(null);
  }
  function fail(value: unknown) {
    const text = value instanceof Error ? value.message : String(value);
    setError(text); setState(started.current ? 'Match stopped' : 'Connection stopped'); setOpen(true);
    lobby.current.verified = false; setVerified(false); clearReady();
    if (started.current) { game.cancelPendingStart(); game.client.send({ type: 'peerStop', error: text }); }
    closePeer();
  }
  function reset(close = false) {
    generation.current++; working.current = false; closePeer();
    if (started.current) game.quit();
    started.current = false; lock.current = null; lobby.current.verified = false; lobby.current.map = '';
    setPlaying(false); setVerified(false); clearReady(); setBusy(false); setState(''); setError(''); setNotice(''); setInput(''); setOutput(''); setChat([]); setMessage(''); setFrame(0); setCopied(false); setOpen(!close);
  }
  function launch(value: unknown) {
    if (useStore.getState().phase !== 'setup') throw Error('Another world is already open. Return to setup before starting a direct match.');
    if (!setup || started.current || !lobby.current.verified || !lobby.current.ready || !lobby.current.friendReady) throw Error('Both commanders must be connected and ready before starting');
    const scenario = validatePeerScenario(value, setup), l = lobby.current;
    if (scenario.map !== l.map || scenario.players[local.current - 1].faction !== l.faction || scenario.players[2 - local.current].faction !== l.friend) throw Error('Peer settings changed after readiness. Start a new connection.');
    lock.current = new PeerLockstep(frame => game.client.send({ type: 'peerFrame', ...frame }));
    started.current = true; setPlaying(true); setOpen(false); setState('Connected');
    useStore.getState().set({ cc: { ...useStore.getState().cc, enabled: false } });
    game.start(JSON.stringify({ ...scenario, localClient: local.current, network: { peer: true } }));
  }
  useEffect(() => {
    active.current = true;
    game.client.on('peerOut', m => {
      if (!active.current || !started.current || !peer.current || !lock.current) return;
      try { peer.current.send({ kind: 'events', events: m.events }); lock.current.receive(local.current, m.events); } catch (e) { fail(e); }
    });
    game.client.on('networkStatus', m => { if (active.current && started.current) { setFrame(m.frame); if (m.error && peer.current) fail(m.error); } });
    return () => { active.current = false; const p = peer.current; peer.current = null; p?.close(); };
  }, [game]);
  useEffect(() => { if (phase === 'setup' && started.current) reset(true); }, [phase]);

  async function fingerprint() {
    const profile = useStore.getState().profile, runtime = new URLSearchParams(location.search).get('runtime') || 'aot';
    return 'direct-4:' + await buildIdentity(profile, runtime);
  }
  async function connect(create: boolean) {
    if (working.current || peer.current || started.current) return;
    working.current = true; const turn = ++generation.current;
    setBusy(true); setError(''); setVerified(false); setCopied(false);
    try {
      if (!setup?.multiplayer) throw Error('Load the updated game runtime first');
      if (!setup.maps.some(m => m.slots.length >= 2)) throw Error('This content has no supported two-player map');
      version.current = await fingerprint(); if (turn !== generation.current) return;
      const p = new DirectPeer(); peer.current = p; local.current = create ? 1 : 2; setHost(create);
      lobby.current.verified = false; clearReady();
      lobby.current.map = create ? (map || setup.maps.find(m => m.slots.length >= 2)!.id) : '';
      let greeted = false;
      const current = () => active.current && turn === generation.current && peer.current === p;
      p.onError = e => { if (current()) fail(e); };
      p.onState = s => {
        if (!current()) return;
        setState(s === 'connected' ? (lobby.current.verified ? 'Connected' : 'Checking game compatibility…') : s);
        if (s === 'connected' && p.channel?.readyState === 'open' && !greeted) { greeted = true; p.send({ kind: 'hello', version: version.current, faction: lobby.current.faction }); }
        if (['failed', 'closed', 'disconnected'].includes(s)) fail('Direct connection interrupted. Both commanders must return to setup and exchange new codes.');
      };
      p.onMessage = m => {
        if (!current()) return;
        try {
          const l = lobby.current;
          if (m.kind === 'hello') {
            if (l.verified || started.current) throw Error('Repeated peer handshake. Start a new connection.');
            if (m.version !== version.current) throw Error('Different game builds. Reload both browsers with the same build.');
            if (!setup.factions.some(f => f.id === m.faction && !f.random)) throw Error('Unknown friend faction');
            l.friend = m.faction as string; setFriend(l.friend); l.verified = true; setVerified(true); setState('Connected · choose your side, then Ready');
            if (create) { const selected = setup.maps.find(m => m.id === l.map)!; p.send({ kind: 'map', map: selected.id, uid: selected.uid }); setMap(selected.id); }
          } else {
            if (!l.verified) throw Error('Peer handshake is required');
            if (m.kind === 'map') {
              if (create || started.current) throw Error('Only the host chooses the lobby map');
              const selected = peerMap(setup, m.map, m.uid); l.map = selected.id; setMap(selected.id); clearReady();
            } else if (m.kind === 'faction') {
              if (started.current || !setup.factions.some(f => f.id === m.faction && !f.random)) throw Error('Invalid friend faction change');
              l.friend = m.faction as string; setFriend(l.friend); clearReady();
            } else if (m.kind === 'ready') {
              const selected = setup.maps.find(m => m.id === l.map);
              if (started.current || typeof m.ready !== 'boolean' || !selected || m.map !== selected.id || m.uid !== selected.uid || m.faction !== l.friend || m.friend !== l.faction) throw Error('Ready settings do not match. Choose your sides again.');
              l.friendReady = m.ready; setFriendReady(m.ready);
            } else if (m.kind === 'start') {
              if (create || m.version !== version.current) throw Error('Invalid peer start request');
              launch(m.scenario);
            } else if (m.kind === 'events') {
              if (!lock.current || !started.current) throw Error('Match has not started');
              lock.current.receive(create ? 2 : 1, m.events as Parameters<PeerLockstep['receive']>[1]);
            } else if (m.kind === 'chat') {
              if (typeof m.text !== 'string' || !m.text.trim() || m.text.length > 500) throw Error('Invalid chat message');
              setChat(c => [...c, { id: crypto.randomUUID(), text: `Friend: ${m.text}` }].slice(-100));
            } else if (m.kind === 'leave') fail('Your friend left. Both commanders must start a new match.');
            else throw Error('Unknown peer message');
          }
        } catch (e) { fail(e); }
      };
      setState('Gathering connection code…');
      const code = create ? await p.offer() : await p.answer(input);
      if (current()) { setOutput(code); setState(create ? 'Offer ready · send it to your friend' : 'Answer ready · send it back to the host'); }
    } catch (e) { if (turn === generation.current) fail(e); } finally { if (turn === generation.current) { working.current = false; setBusy(false); } }
  }
  async function acceptAnswer() {
    if (working.current || !peer.current || verified) return;
    working.current = true; setBusy(true); const p = peer.current;
    try { await p.connect(input); if (peer.current === p && !lobby.current.verified) setState('Connecting to your friend…'); } catch (e) { if (peer.current === p) fail(e); } finally { working.current = false; setBusy(false); }
  }
  function changeFaction(value: string) {
    lobby.current.faction = value; setFaction(value); clearReady();
    if (peer.current && verified) { try { peer.current.send({ kind: 'faction', faction: value }); } catch (e) { fail(e); } }
  }
  function changeMap(value: string) {
    const selected = setup!.maps.find(m => m.id === value)!; lobby.current.map = value; setMap(value); clearReady();
    try { peer.current!.send({ kind: 'map', map: value, uid: selected.uid }); } catch (e) { fail(e); }
  }
  function markReady() {
    try {
      const l = lobby.current, selected = setup!.maps.find(m => m.id === l.map);
      if (!l.verified || !selected) throw Error('Wait for the host to choose a compatible map');
      const next = !l.ready; peer.current!.send({ kind: 'ready', ready: next, map: selected.id, uid: selected.uid, faction: l.faction, friend: l.friend });
      l.ready = next; setReady(next);
    } catch (e) { fail(e); }
  }
  function start() {
    try {
      const l = lobby.current;
      if (!l.verified || !l.ready || !l.friendReady || started.current || local.current !== 1) throw Error('Both commanders must be ready');
      const selected = setup!.maps.find(m => m.id === l.map)!;
      const scenario: PeerScenario = { multiplayer: true, map: selected.id, mapUid: selected.uid, seed: crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646 + 1, options: { ...peerOptions },
        players: [l.faction, l.friend].map((f, i) => ({ client: i + 1, slot: selected.slots[i], faction: f, spawn: i + 1, team: 0, color: i ? 'D83A2E' : '2A6FDB' })) };
      validatePeerScenario(scenario, setup!); peer.current!.send({ kind: 'start', version: version.current, scenario }); launch(scenario);
    } catch (e) { fail(e); }
  }
  async function camera() { try { setNotice(''); setCall(await peer.current!.camera()); } catch (e) { setNotice(`Camera/microphone unavailable: ${e instanceof Error ? e.message : String(e)}. The game connection remains open.`); } }
  function leave() { try { peer.current?.send({ kind: 'leave' }); } catch {} reset(true); }
  if (!setup || (!playing && phase !== 'setup')) return null;
  const matchChat = playing && verified && <MatchChat inputLabel="Direct chat message" messages={chat.map(({ id, text }) => ({ id, author: text.startsWith('You: ') ? 'You' : 'Friend', text: text.slice(text.indexOf(': ') + 2) }))} send={async text => { peer.current!.send({ kind: 'chat', text }); setChat(c => [...c, { id: crypto.randomUUID(), text: `You: ${text}` }].slice(-100)); }} />;
  if (!open) return <>{matchChat}<Button className={`fixed z-[100] ${import.meta.env.VITE_STATIC_BUILD === '1' ? 'right-4 top-4' : 'right-4 top-16'}`} style={playing ? { right: 'calc(var(--sidebar-w) + 16px)' } : undefined} onClick={() => setOpen(true)}>{playing ? 'Direct match connection' : 'Direct peer-to-peer'}</Button></>;
  return <>{matchChat}<div className={`${playing ? 'fixed left-4 top-14 w-[min(500px,90vw)]' : 'fixed inset-0 grid place-items-center bg-black/90 p-4'} z-[110]`}>
    <section role="dialog" aria-modal="true" aria-labelledby="direct-title" className="hud-panel max-h-[85vh] w-full max-w-[650px] overflow-auto space-y-3 p-5" onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}>
      <h1 id="direct-title" className="text-xl">Direct peer-to-peer</h1>
      <p className="text-sm">Two commanders connect directly. No room server or account is used. Share codes through your existing chat.</p>
      {!playing && <ol className="list-decimal pl-5 text-sm space-y-1"><li>Host: create an offer and send it to your friend.</li><li>Friend: paste the offer, answer it, and send the answer back.</li><li>Host: paste the answer and connect. Choose your sides; both press Ready.</li></ol>}
      <p className="text-xs">A public STUN server helps find a route. No TURN relay is configured; some networks cannot connect. Try another network if needed.</p>
      <p role="status" aria-live="polite">{state}{playing && ` · frame ${frame}`}</p>
      {!playing && <label className="block">Your faction<GameSelect aria-label="Direct faction" className="hud-inset ml-2 p-1" disabled={busy || !!error || (!verified && !!output)} value={faction} onChange={e => changeFaction(e.target.value)}>{setup.factions.filter(f => !f.random).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</GameSelect></label>}
      {!verified && !playing && !error && <>
        <div className="flex flex-wrap gap-2"><Button disabled={busy || !!output} onClick={() => void connect(true)}>Create offer</Button><Button disabled={busy || !!output || !input.trim()} onClick={() => void connect(false)}>Answer friend offer</Button></div>
        <label className="block">Friend connection code<textarea aria-label="Friend connection code" className="hud-inset block w-full p-2" rows={3} maxLength={128000} disabled={busy} value={input} onChange={e => setInput(e.target.value)} /></label>
        {host && output && <Button disabled={busy || !input.trim()} onClick={() => void acceptAnswer()}>Connect with friend answer</Button>}
        {output && <label className="block">Your {host ? 'offer' : 'answer'} code<textarea readOnly aria-label="Your connection code" className="hud-inset block w-full p-2" rows={3} value={output} /><Button onClick={() => void navigator.clipboard.writeText(output).then(() => setCopied(true)).catch(() => setNotice('Could not copy. Select the code and copy it manually.'))}>{copied ? 'Copied!' : 'Copy code'}</Button></label>}
      </>}
      {verified && <>
        {!playing && <><p>Friend faction: {setup.factions.find(f => f.id === friend)?.name}</p>{host ? <label>Map<GameSelect aria-label="Direct map" className="hud-inset ml-2 p-1" value={map} onChange={e => changeMap(e.target.value)}>{setup.maps.filter(m => m.slots.length >= 2).map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</GameSelect></label> : <p>Map: {setup.maps.find(m => m.id === map)?.title || 'Waiting for the host'}</p>}
          <p role="status">You: {ready ? 'Ready' : 'Not ready'} · Friend: {friendReady ? 'Ready' : 'Not ready'}</p><p className="text-xs">Changing faction or map clears both ready states.</p>
          <div className="flex flex-wrap gap-2"><Button disabled={!map} onClick={markReady}>{ready ? 'Unready' : 'Ready'}</Button>{host ? <Button disabled={!ready || !friendReady} onClick={start}>Start direct match</Button> : <p>Only the host starts after both commanders are ready.</p>}</div></>}
        <div className="flex flex-wrap gap-2"><Video stream={peer.current?.remoteMedia ?? null} /><Video stream={call} muted /></div>
        <div className="flex flex-wrap gap-2"><Button onClick={() => void camera()}>Enable camera and microphone</Button>{call && <Button onClick={() => { peer.current?.stopCamera(); setCall(null); }}>Stop camera and microphone</Button>}</div>
        {!playing && <><div aria-live="polite" className="max-h-32 overflow-auto text-sm">{chat.map(entry => <p key={entry.id}>{entry.text}</p>)}</div><form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (!message.trim()) return; try { peer.current!.send({ kind: 'chat', text: message.trim() }); setChat(c => [...c, { id: crypto.randomUUID(), text: `You: ${message.trim()}` }].slice(-100)); setMessage(''); } catch (e) { fail(e); } }}><input aria-label="Direct chat message" maxLength={500} className="hud-inset min-w-0 flex-1 p-2" value={message} onChange={e => setMessage(e.target.value)} /><Button type="submit">Send</Button></form></>}
      </>}
      {error && <div role="alert" className="text-red-400"><p>{error}</p>{!verified && <p className="text-sm">The previous world cannot be resumed. Both commanders must exchange new codes and start a new match.</p>}</div>}
      {notice && <p role="status">{notice}</p>}
      <div className="flex flex-wrap gap-2">{(!verified || playing) && <Button onClick={() => reset()}>Start a new connection</Button>}<Button onClick={() => setOpen(false)}>Minimize</Button><Button onClick={leave}>{playing ? 'Leave match' : 'Close connection'}</Button></div>
    </section>
  </div></>;
}
