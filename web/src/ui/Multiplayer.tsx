import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { Game } from '../game';
import { useStore } from '../store';
import { Flag } from './Flag';
import { OptionSelect, SearchSelect, Swatch, type Option } from '../components/ui/fields';
import { MatchChat } from './MatchChat';
import { Check, ChevronDown, Copy, Crown, Dices, LogIn, Map as MapIcon, MessageSquare, Plus, Radio, TriangleAlert, Users, Video, VideoOff, X } from 'lucide-react';
import { MultiplayerSession, inviteLink, type RemoteMedia, type SessionView } from '../multiplayer';
import { GameButton } from './kit/game';
import { Brackets } from './screen-parts';

// Multiplayer with friends, on the game kit: choose (host or join), connecting, the lobby, and the bar during a match.

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
  return <div className="mp-chat" data-open={open}>
    <GameButton variant="ghost" size="sm" aria-expanded={open} icon={<MessageSquare size={14} />} onClick={() => setOpen(!open)}>Lobby chat{unread > 0 && <span className="mp-unread">{unread}</span>}</GameButton>
    {open && <div className="mp-chat-body">
      <div aria-live="polite" className="mp-chat-messages">{view.chat.length ? view.chat.map(m => <p key={m.id} className={m.author ? '' : 'mp-note'}>{m.author && <strong>{m.author}: </strong>}{m.text}</p>) : <p className="mp-note">No messages yet. Say hello to your commanders.</p>}</div>
      <form className="mp-chat-form" onSubmit={e => { e.preventDefault(); if (!text.trim()) return; say(text).then(() => { setText(''); setError(''); }, err => setError(err instanceof Error ? err.message : String(err))); }}>
        <input aria-label="Lobby chat message" placeholder="Message your commanders…" maxLength={500} value={text} onChange={e => setText(e.target.value)} />
        <GameButton size="sm" type="submit" disabled={!text.trim()}>Send</GameButton>
      </form>
      {error && <p role="alert" className="mp-chat-send-error">{error}</p>}
    </div>}
  </div>;
}

function MatchBar({ view, session }: { view: SessionView; session: MultiplayerSession }) {
  const [details, setDetails] = useState(false), stopped = view.stage === 'stopped';
  return <section aria-label="Multiplayer controls" className="mp-match" data-ui-sfx>
    <div className="mp-match-bar">
      <span className="mp-match-name"><Users size={13} aria-hidden="true" />Multiplayer</span>
      <button type="button" className="mp-match-connection" aria-label="Connection details" aria-expanded={details} onClick={() => setDetails(!details)}>
        <span className={`mp-dot ${stopped ? 'offline' : 'online'}`} /><span>{stopped ? 'Match stopped' : 'Connected'}</span><ChevronDown size={12} aria-hidden="true" />
      </button>
    </div>
    {details && <div className="mp-popover mp-network-details">
      <h2 className="scr-label"><Radio size={13} aria-hidden="true" />Connection details</h2>
      <dl><div><dt>You are</dt><dd>Player {view.you}</dd></div><div><dt>Simulation frame</dt><dd className="digits">{view.frame}</dd></div></dl>
      <p>Orders travel directly between players{view.host ? '; your game relays them to everyone.' : ' through the host.'}</p>
      <GameButton variant="ghost" size="sm" onClick={() => setDetails(false)}>Close details</GameButton>
    </div>}
    {stopped && <div role="alert" className="mp-popover mp-match-error">
      <span className="mp-match-error-icon" aria-hidden="true"><TriangleAlert size={16} /></span>
      <div><strong>Match stopped</strong><p>{view.error}</p><GameButton variant="primary" size="sm" onClick={() => session.dismiss()}>Return to menu</GameButton></div>
    </div>}
  </section>;
}

export function Multiplayer({ game }: { game: Game }) {
  const session = useMemo(() => new MultiplayerSession(game), [game]);
  const view = useSyncExternalStore(session.subscribe, session.snapshot);
  const setup = useStore(s => s.setup), phase = useStore(s => s.phase), previews = useStore(s => s.previews), publicShot = useStore(s => s.publicShot);
  const joinParam = useRef(new URLSearchParams(location.search).get('join'));
  const [open, setOpen] = useState(!!joinParam.current), [invite, setInvite] = useState(joinParam.current ?? ''), [copied, setCopied] = useState(false);
  // Which choice the player made last: its card shows what went wrong with it.
  const [attempt, setAttempt] = useState<'host' | 'join' | null>(joinParam.current ? 'join' : null);
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
  if (!open) return <button type="button" className="mp-launch" data-ui-sfx data-lobby={view.stage === 'lobby'} onClick={() => setOpen(true)}>
    <Users size={15} aria-hidden="true" /><span>{view.stage === 'lobby' ? 'Match lobby' : 'Multiplayer'}</span>
  </button>;

  const lobby = view.lobby, mine = lobby?.players[view.you - 1];
  // A guest's copy of the host's random map is still being made: the lobby shows it from the host's description.
  const map = setup.maps.find(m => m.id === lobby?.map) ?? (lobby?.generated ? { id: lobby.map, uid: lobby.mapUid, title: lobby.generated.title,
    players: lobby.generated.slots, tileset: 'TEMPERATE', author: '', slots: Array.from({ length: lobby.generated.slots }, (_, i) => `Multi${i}`) } : undefined);
  const link = view.room && view.host ? inviteLink(view.room) : '';
  const teams: Option<number>[] = [0, 1, 2, 3, 4].map(t => ({ value: t, label: t ? `Team ${t}` : 'No team', leading: <Swatch color={TEAM_COLORS[t]} /> }));
  // Random maps made here first, then saved Earth maps, as the player's own. Guests make the host's random map in their
  // own browser and get a saved one from Firestore.
  const ownGroups = setup.maps.some(x => x.saved || x.generated);
  const maps: Option<string>[] = [...setup.maps.filter(m => m.generated), ...setup.maps.filter(m => m.saved), ...setup.maps.filter(m => !m.saved && !m.generated)].filter(m => m.slots.length >= 2)
    .map(m => ({ value: m.id, label: m.title, description: `Up to ${m.slots.length} players`, group: ownGroups ? (m.generated ? 'Random maps' : m.saved ? 'Your maps' : 'Maps') : undefined }));
  const bots: Option<string>[] = setup.bots.map(b => ({ value: b.type, label: b.name }));
  const free = lobby && map ? map.slots.length - lobby.players.length - lobby.ai.length : 0;
  const everyoneReady = !!lobby && lobby.players.length >= 2 && lobby.players.every(p => p.ready);
  const hint = view.status || (!lobby ? '' : view.host
    ? lobby.players.length < 2 ? 'Send the invite. Friends join from their own browser, anywhere.' : everyoneReady ? 'Everyone is ready. Start when you like.' : 'Waiting for everyone to press Ready.'
    : mine?.ready ? 'You’re ready. Waiting for the host to start.' : 'Pick your faction and team, then press Ready.');
  const close = () => { session.leave(); setOpen(false); };
  const copy = () => navigator.clipboard.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); }, () => undefined);
  const choosing = view.stage === 'idle' || view.stage === 'stopped';
  const error = choosing && view.error ? view.error : '';
  const ended = view.stage === 'stopped' && !!error;
  const hostError = !ended && error && attempt === 'host' ? error : '';
  const joinError = !ended && error && attempt !== 'host' ? error : '';
  const preview = map && !publicShot ? previews[map.id] ?? '' : '';
  const closeLabel = view.stage === 'lobby' ? 'Leave match' : view.stage === 'connecting' ? 'Cancel' : 'Close multiplayer';

  return <div className="gd-overlay mp-overlay" data-ui-sfx onPointerDown={e => { if (e.target === e.currentTarget && choosing) close(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="mp-title" className={`gd-panel mp-dialog mp-stage-${view.stage}`} onKeyDown={e => { if (e.key === 'Escape' && view.stage !== 'lobby') close(); }}>
      <header className="gd-header mp-header">
        <div className="min-w-0"><span className="menu-eyebrow">Play together</span><h2 id="mp-title">{view.stage === 'lobby' ? 'Match lobby' : 'Multiplayer'}</h2></div>
        <button type="button" autoFocus className="gd-close" aria-label={closeLabel} onClick={close}><X size={18} /></button>
      </header>

      <div className="gd-body mp-body">
        {choosing && <>
          {ended && <div className="mp-error mp-ended" role="alert"><TriangleAlert size={18} aria-hidden="true" /><div><strong>The match ended</strong><p>{view.error}</p></div></div>}
          <div className="mp-choices">
            <section className="mp-choice" aria-labelledby="mp-host-title">
              <span className="mp-choice-art" style={{ backgroundImage: 'url("menu/skirmish.webp")' }} aria-hidden="true" />
              <div className="mp-choice-body">
                <span className="mp-choice-icon" aria-hidden="true"><Crown size={20} /></span>
                <span className="menu-eyebrow">Host</span>
                <h3 id="mp-host-title">Start a match</h3>
                <p>You choose the map and AI opponents, then send friends a link.</p>
                {hostError && <div className="mp-error" role="alert"><strong>Couldn’t create the match</strong><p>{hostError}</p></div>}
                <GameButton variant="primary" size="lg" icon={<Plus size={16} aria-hidden="true" />} onClick={() => { setAttempt('host'); void session.host(); }}>Create match</GameButton>
              </div>
            </section>
            <section className="mp-choice" aria-labelledby="mp-join-title">
              <span className="mp-choice-art" style={{ backgroundImage: 'url("menu/campaign.webp")' }} aria-hidden="true" />
              <div className="mp-choice-body">
                <span className="mp-choice-icon" aria-hidden="true"><LogIn size={20} /></span>
                <span className="menu-eyebrow">Join</span>
                <h3 id="mp-join-title">Have an invite?</h3>
                <p>Paste the link or the 6-character code.</p>
                <form className="mp-join-form" onSubmit={e => { e.preventDefault(); setAttempt('join'); void session.join(invite); }}>
                  <input aria-label="Invite link or code" className="mp-input mp-code-input" placeholder="K7Q4MX" autoComplete="off" spellCheck={false} value={invite} onChange={e => setInvite(e.target.value)} aria-invalid={!!joinError} />
                  {joinError && <div className="mp-error" role="alert"><strong>Couldn’t connect</strong><p>{joinError}</p></div>}
                  <GameButton variant={invite.trim() ? 'primary' : 'secondary'} size="lg" type="submit" icon={<LogIn size={16} aria-hidden="true" />} disabled={!invite.trim()}>Join match</GameButton>
                </form>
              </div>
            </section>
          </div>
          <p className="mp-note">Up to {Math.max(...setup.maps.map(m => m.slots.length))} players. Some strict networks block direct connections; if joining fails, try another network.</p>
        </>}

        {view.stage === 'connecting' && <div className="mp-connecting">
          <span className="scr-radar" aria-hidden="true"><i /><i /><i /></span>
          <p role="status">{view.status}</p>
          <GameButton onClick={close}>Cancel</GameButton>
        </div>}

        {view.stage === 'lobby' && lobby && map && <>
          <section className="mp-invite" aria-label={view.host ? 'Invite' : 'Match'}>
            <div className="mp-invite-code"><span className="menu-eyebrow">Match code</span><strong className="mp-code">{view.room}</strong></div>
            {view.host ? <div className="mp-invite-share">
              <h3>Invite your friends</h3>
              <p>{lobby.players.length} of {map.slots.length - lobby.ai.length} commanders · friends join from their own browser</p>
              <div className="mp-copy"><input readOnly className="mp-input" aria-label="Invite link" value={link} onFocus={e => e.currentTarget.select()} /><GameButton variant="primary" icon={copied ? <Check size={14} /> : <Copy size={14} />} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy invite'}</GameButton></div>
            </div> : <div className="mp-invite-share"><h3>Connected to the host</h3><p>You are Player {view.you}</p></div>}
          </section>

          <div className="mp-lobby">
            <section className="mp-card mp-battlefield" aria-label="Battlefield">
              <h3 className="scr-label"><MapIcon size={14} aria-hidden="true" />Battlefield</h3>
              <div className="mp-map">
                {preview ? <img src={preview} alt={`${map.title} map preview`} draggable={false} /> : <span className="mp-map-empty"><MapIcon size={34} strokeWidth={1.3} aria-hidden="true" /></span>}
                <Brackets className="always" />
                <span className="mp-map-caption"><b>{map.title}</b><small>{map.slots.length} players</small></span>
              </div>
              {view.host ? <div className="mp-map-pick">
                <label className="mp-field"><span>Map</span><OptionSelect aria-label="Multiplayer map" className="mp-picker" value={lobby.map} options={maps} onValueChange={id => session.setMap(id)} /></label>
                <GameButton size="sm" icon={<Dices size={14} aria-hidden="true" />} disabled={view.mapLoading} onClick={() => void session.newRandomMap()} data-testid="mp-random-map">{view.mapLoading ? 'Making a map…' : 'New random map'}</GameButton>
              </div>
                : <p className="mp-note">The host chooses the map and AI opponents.</p>}
            </section>

            <section className="mp-card mp-roster" aria-label="Commanders">
              <header className="scr-panel-head"><h3 className="scr-label"><Users size={14} aria-hidden="true" />Commanders</h3><span className="scr-count">{lobby.players.length + lobby.ai.length} / {map.slots.length}</span></header>
              {lobby.players.map((p, i) => {
                const id = i + 1, me = id === view.you;
                return <div className="mp-player" key={`p${id}`} data-me={me} style={{ '--team': TEAM_COLORS[p.team] } as CSSProperties}>
                  <span className="mp-player-flag"><Flag id={p.faction} /></span>
                  <div className="mp-player-main">
                    <div className="mp-player-title"><strong>Player {id}{me ? ' · You' : ''}</strong><span className={`mp-badge ${i === 0 ? 'host' : p.ready ? 'ready' : ''}`}>{i === 0 ? 'Host' : p.ready ? 'Ready' : 'Not ready'}</span></div>
                    <div className="mp-player-fields">
                      <label className="mp-field"><span>Faction</span><SearchSelect aria-label={`Player ${id} faction`} className="mp-picker" placeholder="Search factions…" empty="No factions match. Try another name." disabled={!me} value={p.faction} options={factions} onValueChange={faction => session.setSeat({ faction })} /></label>
                      <label className="mp-field"><span>Team</span><OptionSelect aria-label={`Player ${id} team`} className="mp-picker" disabled={!me} value={p.team} options={teams} onValueChange={team => session.setSeat({ team })} /></label>
                    </div>
                  </div>
                </div>;
              })}
              {lobby.players.length < 2 && <div className="mp-empty"><span className="mp-empty-pulse" aria-hidden="true" /><div><b>Waiting for friends…</b><p>Copy the invite and send it in any chat app.</p></div></div>}
              {lobby.ai.map((a, i) => <div className="mp-player mp-ai" key={`ai${i}`} style={{ '--team': TEAM_COLORS[a.team] } as CSSProperties}>
                <span className="mp-player-flag"><Flag id={a.faction} /></span>
                <div className="mp-player-main">
                  <div className="mp-player-title"><strong>AI {i + 1}</strong><span className="mp-badge">Computer</span></div>
                  <div className="mp-player-fields">
                    <label className="mp-field"><span>Faction</span><SearchSelect aria-label={`AI ${i + 1} faction`} className="mp-picker" placeholder="Search factions…" empty="No factions match. Try another name." disabled={!view.host} value={a.faction} options={factions} onValueChange={faction => session.setAi(lobby.ai.map((x, j) => j === i ? { ...x, faction } : x))} /></label>
                    <label className="mp-field"><span>Difficulty</span><OptionSelect aria-label={`AI ${i + 1} difficulty`} className="mp-picker" disabled={!view.host} value={a.bot} options={bots} onValueChange={bot => session.setAi(lobby.ai.map((x, j) => j === i ? { ...x, bot } : x))} /></label>
                    <label className="mp-field"><span>Team</span><OptionSelect aria-label={`AI ${i + 1} team`} className="mp-picker" disabled={!view.host} value={a.team} options={teams} onValueChange={team => session.setAi(lobby.ai.map((x, j) => j === i ? { ...x, team } : x))} /></label>
                  </div>
                </div>
              </div>)}
              {view.host && <div className="mp-actions">
                <GameButton size="sm" icon={<Plus size={14} aria-hidden="true" />} disabled={free <= 0} onClick={() => session.setAi([...lobby.ai, { faction: factions[(lobby.players.length + lobby.ai.length) % factions.length].value, bot: setup.bots[0].type, team: 0 }])}>Add AI</GameButton>
                {lobby.ai.length > 0 && <GameButton variant="ghost" size="sm" onClick={() => session.setAi(lobby.ai.slice(0, -1))}>Remove AI</GameButton>}
              </div>}
              <p className="mp-note">Same numbered team = allies. “No team” means everyone fights for themselves.</p>
            </section>
          </div>

          <div className="mp-extras">
            <LobbyChat view={view} say={text => session.say(text)} />
            <GameButton variant="ghost" size="sm" aria-pressed={view.camera} icon={view.camera ? <VideoOff size={14} /> : <Video size={14} />} onClick={() => void session.toggleCamera()}>{view.camera ? 'Stop camera and mic' : 'Camera and mic'}</GameButton>
          </div>
          {tiles}
        </>}
      </div>

      {view.stage === 'lobby' && lobby && map && <footer className="gd-footer mp-footer">
        <p role="status">{hint}</p>
        <div className="mp-actions">
          <GameButton variant="ghost" onClick={close}>Leave</GameButton>
          {view.host
            ? <GameButton variant="primary" size="lg" className="mp-start" disabled={!everyoneReady} onClick={() => session.start()}>Start match</GameButton>
            : <GameButton variant={mine?.ready ? 'secondary' : 'primary'} size="lg" className="mp-start" disabled={view.mapLoading && !mine?.ready} onClick={() => session.setReady(!mine?.ready)}>{mine?.ready ? 'Not ready' : 'Ready'}</GameButton>}
        </div>
      </footer>}
    </section>
  </div>;
}
