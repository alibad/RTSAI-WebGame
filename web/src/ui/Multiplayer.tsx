import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Game } from '../game';
import { useStore } from '../store';
import { Button } from '../components/ui/button';
import { Flag } from './Flag';
import { OptionSelect, SearchSelect, Swatch, type Option } from '../components/ui/fields';
import { MatchChat } from './MatchChat';
import { MessageSquare, ChevronDown, Video, VideoOff, Copy, Check } from 'lucide-react';
import { MultiplayerSession, inviteLink, type RemoteMedia, type SessionView } from '../multiplayer';

const TEAM_COLORS = ['#7d8876', '#2a6fdb', '#d83a2e', '#3fae49', '#e7b42f'];

function MediaTile({ media }: { media: RemoteMedia }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (video.current) video.current.srcObject = media.stream; }, [media.stream]);
  return <figure className="mp-media-tile"><video ref={video} autoPlay playsInline aria-label={`${media.label} camera`} /><figcaption>{media.label}</figcaption></figure>;
}

function LobbyChat({ view, say }: { view: SessionView; say: (text: string) => Promise<void> }) {
  const [text, setText] = useState(''), [open, setOpen] = useState(false), [seen, setSeen] = useState(view.chat.length), [error, setError] = useState('');
  useEffect(() => { if (open) setSeen(view.chat.length); }, [open, view.chat.length]);
  const unread = Math.max(0, view.chat.length - seen);
  return <div className="hud-panel p-2 text-xs"><Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}><MessageSquare size={14} /> Lobby chat{unread > 0 && <span className="mp-unread">{unread}</span>}</Button>{open && <div className="mt-2">
    <div aria-live="polite" className="mp-chat-messages">{view.chat.length ? view.chat.map(m => <p key={m.id} className={m.author ? '' : 'mp-note'}>{m.author && <strong>{m.author}: </strong>}{m.text}</p>) : <p className="mp-note">No messages yet. Say hello to your commanders.</p>}</div>
    <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (!text.trim()) return; say(text).then(() => { setText(''); setError(''); }, err => setError(err instanceof Error ? err.message : String(err))); }}><input aria-label="Lobby chat message" placeholder="Message your commanders…" maxLength={500} value={text} onChange={e => setText(e.target.value)} className="hud-inset min-w-0 flex-1 p-2 rounded-md text-xs" /><Button size="sm" type="submit" disabled={!text.trim()}>Send</Button></form>
    {error && <p role="alert" className="mp-chat-send-error">{error}</p>}
  </div>}</div>;
}

function MatchBar({ view, session }: { view: SessionView; session: MultiplayerSession }) {
  const [details, setDetails] = useState(false), stopped = view.stage === 'stopped';
  return <section aria-label="Multiplayer controls" className="mp-match">
    <div className="hud-panel mp-match-bar"><span className="mp-match-name">Multiplayer</span><Button variant="ghost" size="sm" className="mp-match-connection" aria-label="Connection details" aria-expanded={details} onClick={() => setDetails(!details)}><span className={`mp-dot ${stopped ? 'offline' : 'online'}`} /><span>{stopped ? 'Match stopped' : 'Connected'}</span><ChevronDown size={12} /></Button></div>
    {details && <div className="hud-panel mp-network-details"><h2>Connection details</h2><dl><div><dt>You are</dt><dd>Player {view.you}</dd></div><div><dt>Simulation frame</dt><dd>{view.frame}</dd></div></dl><p>Orders travel directly between players{view.host ? '; your game relays them to everyone.' : ' through the host.'}</p><Button variant="ghost" size="sm" onClick={() => setDetails(false)}>Close details</Button></div>}
    {stopped && <div role="alert" className="hud-panel mp-match-error"><strong>Match stopped</strong><p>{view.error}</p><Button variant="outline" size="sm" onClick={() => session.dismiss()}>Return to menu</Button></div>}
  </section>;
}

export function Multiplayer({ game }: { game: Game }) {
  const session = useMemo(() => new MultiplayerSession(game), [game]);
  const view = useSyncExternalStore(session.subscribe, session.snapshot);
  const setup = useStore(s => s.setup), phase = useStore(s => s.phase), previews = useStore(s => s.previews);
  const joinParam = useRef(new URLSearchParams(location.search).get('join'));
  const [open, setOpen] = useState(!!joinParam.current), [invite, setInvite] = useState(joinParam.current ?? ''), [copied, setCopied] = useState(false);
  const inWorld = phase === 'playing' || phase === 'loading';

  // An invite link joins as soon as the game is ready; the code leaves the address bar so a reload doesn't rejoin.
  useEffect(() => {
    if (!setup || !joinParam.current || phase !== 'setup') return;
    const code = joinParam.current; joinParam.current = null;
    const url = new URL(location.href); url.searchParams.delete('join'); history.replaceState(history.state, '', url);
    void session.join(code);
  }, [setup, phase, session]);
  useEffect(() => { if (open && view.lobby?.map) game.preview(view.lobby.map); }, [open, view.lobby?.map, game]);
  // The lobby's sides: their art (and the shared art) downloads while the commanders get ready.
  const sides = view.lobby ? [...view.lobby.players, ...view.lobby.ai].map(s => s.faction).join(",") : "";
  const mySide = view.lobby?.players[view.you - 1]?.faction;
  useEffect(() => { if (sides && view.stage === "lobby") game.wantFactions(sides.split(","), mySide); }, [sides, mySide, view.stage, game]);
  useEffect(() => { if (view.stage === 'playing') setOpen(false); }, [view.stage]);

  const factions = useMemo<Option<string>[]>(() => (setup?.factions ?? []).filter(f => !f.random).map(f => ({ value: f.id, label: f.name, leading: <Flag id={f.id} className="h-4 w-6 shrink-0 rounded-sm" /> })), [setup]);
  if (!setup) return null;

  const tiles = view.remote.length > 0 && <div className="mp-media" aria-label="Friend cameras">{view.remote.map(m => <MediaTile key={m.id} media={m} />)}</div>;
  if (inWorld) {
    if (view.stage !== 'playing' && view.stage !== 'stopped') return null;
    return <>{view.stage === 'playing' && <MatchChat messages={view.chat.filter(m => m.author)} send={text => session.say(text)} />}<MatchBar view={view} session={session} />{tiles}</>;
  }
  if (phase !== 'setup') return null;
  if (!open) return <Button className="fixed right-4 top-4 z-[100]" onClick={() => setOpen(true)}>{view.stage === 'lobby' ? 'Match lobby' : 'Multiplayer'}</Button>;

  const lobby = view.lobby, map = setup.maps.find(m => m.id === lobby?.map), mine = lobby?.players[view.you - 1];
  const link = view.room && view.host ? inviteLink(view.room) : '';
  const teams: Option<number>[] = [0, 1, 2, 3, 4].map(t => ({ value: t, label: t ? `Team ${t}` : 'No team', leading: <Swatch color={TEAM_COLORS[t]} /> }));
  // Saved Earth maps first, as the player's own; guests get the host's from Firestore when the host picks one.
  const maps: Option<string>[] = [...setup.maps.filter(m => m.saved), ...setup.maps.filter(m => !m.saved)].filter(m => m.slots.length >= 2)
    .map(m => ({ value: m.id, label: m.title, description: `Up to ${m.slots.length} players`, group: setup.maps.some(x => x.saved) ? (m.saved ? 'Your maps' : 'Maps') : undefined }));
  const bots: Option<string>[] = setup.bots.map(b => ({ value: b.type, label: b.name }));
  const free = lobby && map ? map.slots.length - lobby.players.length - lobby.ai.length : 0;
  const everyoneReady = !!lobby && lobby.players.length >= 2 && lobby.players.every(p => p.ready);
  const hint = view.status || (!lobby ? '' : view.host
    ? lobby.players.length < 2 ? 'Send the invite. Friends join from their own browser, anywhere.' : everyoneReady ? 'Everyone is ready. Start when you like.' : 'Waiting for everyone to press Ready.'
    : mine?.ready ? 'You’re ready. Waiting for the host to start.' : 'Pick your faction and team, then press Ready.');
  const close = () => { session.leave(); setOpen(false); };
  const copy = () => navigator.clipboard.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); }, () => undefined);

  return <div className="mp-overlay"><section role="dialog" aria-modal="true" aria-labelledby="mp-title" className="hud-panel mp-dialog" onKeyDown={e => { if (e.key === 'Escape' && view.stage !== 'lobby') close(); }}>
    <header className="mp-header"><div><span className="mp-eyebrow">RTS AI · PLAY TOGETHER</span><h1 id="mp-title">{view.stage === 'lobby' ? 'Match lobby' : 'Multiplayer'}</h1><p>{view.stage === 'lobby' ? (view.host ? 'You’re hosting. Choose the battlefield and invite your friends.' : 'You’re in. Choose your side.') : 'Play with friends. Your games connect directly to each other.'}</p></div>
      <Button autoFocus variant="ghost" onClick={close}>{view.stage === 'lobby' ? 'Leave' : view.stage === 'connecting' ? 'Cancel' : 'Back'}</Button></header>

    {(view.stage === 'idle' || view.stage === 'stopped') && <>
      {view.error && <div className="mp-error" role="alert"><strong>{view.stage === 'stopped' ? 'The match ended' : 'Couldn’t connect'}</strong><p>{view.error}</p></div>}
      <div className="mp-choices" style={{ marginTop: 24 }}>
        <section className="mp-card mp-host"><span className="mp-eyebrow">HOST</span><h2>Start a match</h2><p>You choose the map and AI opponents, then send friends a link.</p><Button size="lg" onClick={() => void session.host()}>Create match</Button></section>
        <section className="mp-card"><span className="mp-eyebrow">JOIN</span><h2>Have an invite?</h2><p>Paste the link or the 6-character code.</p><form onSubmit={e => { e.preventDefault(); void session.join(invite); }}><label className="mp-field">Invite link or code<input aria-label="Invite link or code" placeholder="K7Q4MX" autoComplete="off" value={invite} onChange={e => setInvite(e.target.value)} /></label><div className="mp-actions"><Button size="lg" type="submit" disabled={!invite.trim()}>Join match</Button></div></form></section>
      </div>
      <p className="mp-note">Up to {Math.max(...setup.maps.map(m => m.slots.length))} players. Some strict networks block direct connections; if joining fails, try another network.</p>
    </>}

    {view.stage === 'connecting' && <div className="mp-progress" role="status"><span className="mp-dot" /><span>{view.status}</span></div>}

    {view.stage === 'lobby' && lobby && map && <>
      {view.host ? <section className="mp-invite"><div><h2>Invite your friends</h2><p>Match code <strong className="mp-code">{view.room}</strong> · {lobby.players.length} of {map.slots.length - lobby.ai.length} commanders</p></div>
        <div className="mp-copy"><input readOnly aria-label="Invite link" value={link} onFocus={e => e.currentTarget.select()} /><Button onClick={() => void copy()}>{copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy invite</>}</Button></div></section>
        : <section className="mp-invite"><h2>Connected to the host</h2><p>Match <strong className="mp-code">{view.room}</strong> · you are Player {view.you}</p></section>}
      <div className="mp-lobby"><section className="mp-card"><h2>Battlefield</h2>{previews[map.id] ? <img className="mp-map" src={previews[map.id]} alt={`${map.title} map preview`} /> : <div className="mp-map mp-map-empty">{map.title}<span>{map.slots.length} players</span></div>}
        <label className="mp-field">Map<OptionSelect aria-label="Multiplayer map" className="mp-picker" disabled={!view.host} value={lobby.map} options={maps} onValueChange={id => session.setMap(id)} /></label>
        {!view.host && <p className="mp-note">The host chooses the map and AI opponents.</p>}</section>
        <section className="mp-card mp-roster"><h2>Commanders</h2>
          {lobby.players.map((p, i) => { const id = i + 1, me = id === view.you; return <div className="mp-player" key={`p${id}`}><div className="mp-player-title"><Flag id={p.faction} className="h-5 w-8 rounded-sm" /><strong>Player {id}{me ? ' · You' : ''}</strong><span className={`mp-badge ${p.ready ? 'ready' : ''}`}>{i === 0 ? 'Host' : p.ready ? 'Ready' : 'Not ready'}</span></div>
            <div className="mp-player-fields"><label className="mp-field">Faction<SearchSelect aria-label={`Player ${id} faction`} className="mp-picker" placeholder="Search factions…" empty="No factions match. Try another name." disabled={!me} value={p.faction} options={factions} onValueChange={faction => session.setSeat({ faction })} /></label><label className="mp-field">Team<OptionSelect aria-label={`Player ${id} team`} className="mp-picker" disabled={!me} value={p.team} options={teams} onValueChange={team => session.setSeat({ team })} /></label></div></div>; })}
          {lobby.players.length < 2 && <div className="mp-empty">Waiting for friends…<p>Copy the invite and send it in any chat app.</p></div>}
          {lobby.ai.map((a, i) => <div className="mp-player" key={`ai${i}`}><div className="mp-player-title"><Flag id={a.faction} className="h-5 w-8 rounded-sm" /><strong>AI {i + 1}</strong><span className="mp-badge">Computer</span></div><div className="mp-player-fields">
            <label className="mp-field">Faction<SearchSelect aria-label={`AI ${i + 1} faction`} className="mp-picker" placeholder="Search factions…" empty="No factions match. Try another name." disabled={!view.host} value={a.faction} options={factions} onValueChange={faction => session.setAi(lobby.ai.map((x, j) => j === i ? { ...x, faction } : x))} /></label>
            <label className="mp-field">Difficulty<OptionSelect aria-label={`AI ${i + 1} difficulty`} className="mp-picker" disabled={!view.host} value={a.bot} options={bots} onValueChange={bot => session.setAi(lobby.ai.map((x, j) => j === i ? { ...x, bot } : x))} /></label>
            <label className="mp-field">Team<OptionSelect aria-label={`AI ${i + 1} team`} className="mp-picker" disabled={!view.host} value={a.team} options={teams} onValueChange={team => session.setAi(lobby.ai.map((x, j) => j === i ? { ...x, team } : x))} /></label></div></div>)}
          {view.host && <div className="mp-actions"><Button variant="outline" disabled={free <= 0} onClick={() => session.setAi([...lobby.ai, { faction: factions[(lobby.players.length + lobby.ai.length) % factions.length].value, bot: setup.bots[0].type, team: 0 }])}>Add AI</Button>{lobby.ai.length > 0 && <Button variant="ghost" onClick={() => session.setAi(lobby.ai.slice(0, -1))}>Remove AI</Button>}</div>}
          <p className="mp-note">Same numbered team = allies. “No team” means everyone fights for themselves.</p>
        </section></div>
      <div className="mp-extras"><LobbyChat view={view} say={text => session.say(text)} /><Button variant="ghost" size="sm" aria-pressed={view.camera} onClick={() => void session.toggleCamera()}>{view.camera ? <><VideoOff size={14} /> Stop camera and mic</> : <><Video size={14} /> Camera and mic</>}</Button></div>
      {tiles}
      <footer className="mp-footer"><p role="status">{hint}</p><div className="mp-actions">{view.host
        ? <Button size="lg" disabled={!everyoneReady} onClick={() => session.start()}>Start match</Button>
        : <Button size="lg" variant={mine?.ready ? 'outline' : 'default'} disabled={view.mapLoading && !mine?.ready} onClick={() => session.setReady(!mine?.ready)}>{mine?.ready ? 'Not ready' : 'Ready'}</Button>}</div></footer>
    </>}
  </section></div>;
}
