// Direct multiplayer session: one per game. The host creates a match at the matchmaker (Firestore, net/matchmaker.ts)
// and shares an invite; each guest's browser connects straight to the host's. The host runs the lobby and relays order
// packets between guests; the matchmaker only introduces browsers and is closed when the match starts.
import type { Game } from './game';
import { useStore } from './store';
import { buildIdentity } from './sim/build-identity';
import { answerJoin, closeMatch, createMatch, joinMatch, removeJoin, watchJoins } from './net/matchmaker';
import { track } from './net/track';
import { savedMap } from './net/saved-maps';
import { DirectPeer, MAX_TEAM, PeerLockstep, peerColors, peerMap, peerOptions, validatePeerScenario, type PeerEvent, type PeerScenario } from './peer';

export type Seat = { faction: string; team: number; ready: boolean };
export type AiSeat = { faction: string; bot: string; team: number };
/** `saved`: the Firestore id when the map is a player's saved Earth map, so guests can fetch it (net/saved-maps.ts). */
export type Lobby = { revision: number; map: string; mapUid: string; saved?: string; players: Seat[]; ai: AiSeat[] };
export type ChatLine = { id: string; author: string; text: string };
export type RemoteMedia = { id: string; label: string; stream: MediaStream };
export type Stage = 'idle' | 'connecting' | 'lobby' | 'playing' | 'stopped';
export type SessionView = {
  stage: Stage; host: boolean; room: string; you: number; lobby: Lobby | null; chat: ChatLine[];
  status: string; error: string; frame: number; camera: boolean; remote: RemoteMedia[];
  /** A guest is fetching the host's saved map; Ready waits for it. */
  mapLoading: boolean;
};

const idle: SessionView = { stage: 'idle', host: false, room: '', you: 0, lobby: null, chat: [], status: '', error: '', frame: 0, camera: false, remote: [], mapLoading: false };
const ANSWER_WAIT_MS = 45000, OPEN_WAIT_MS = 20000, HELLO_WAIT_MS = 20000;

/** Accepts an invite link (…?join=CODE) or the bare code. */
export function inviteCode(input: string) {
  let value = input.trim();
  if (value.includes('://')) { try { value = new URL(value).searchParams.get('join') ?? ''; } catch { value = ''; } }
  value = value.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(value)) throw Error('Paste the invite link or the 6-character code from your host.');
  return value;
}

export function inviteLink(room: string) {
  const here = new URL(location.href), link = new URL(here.pathname, here.origin);
  // Keep only what selects the same game build and mode; the code does the rest.
  for (const key of ['game', 'profile', 'runtime', 'private']) { const v = here.searchParams.get(key); if (v !== null) link.searchParams.set(key, v); }
  link.searchParams.set('join', room);
  return link.href;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
class Cancelled extends Error {}

type Guest = { key: string; peer: DirectPeer; seated: boolean; timer?: ReturnType<typeof setTimeout> };

export class MultiplayerSession {
  private view: SessionView = idle;
  private listeners = new Set<() => void>();
  private generation = 0;
  private version = '';
  private lock: PeerLockstep | null = null;
  // Host: the seated players are seats[0] (the host) and one per seated guest, in join order.
  private guests: Guest[] = [];
  private seats: Seat[] = [];
  private hostPeer: DirectPeer | null = null;
  private media: MediaStream | null = null;
  private unwatch: (() => void) | null = null;
  private pendingJoin: { cancel: () => Promise<void> } | null = null;

  constructor(private game: Game) {
    game.client.on('peerOut', m => this.outgoing(m.events));
    game.client.on('networkStatus', m => {
      if (this.view.stage !== 'playing') return;
      if (m.error) this.stop(m.error); else this.set({ frame: m.frame });
    });
    // Leaving the world from the game menu leaves the match too.
    useStore.subscribe((s, prev) => { if (s.phase === 'setup' && prev.phase !== 'setup' && this.view.stage === 'playing') this.leave(false); });
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.view;
  private set(patch: Partial<SessionView>) { this.view = { ...this.view, ...patch }; for (const l of this.listeners) l(); }
  private guard(turn: number) { if (turn !== this.generation) throw new Cancelled(); }
  private get setup() { const s = useStore.getState().setup; if (!s?.multiplayer) throw Error('This game build does not support multiplayer. Reload the page.'); return s; }

  private async fingerprint() {
    const profile = useStore.getState().profile, runtime = new URLSearchParams(location.search).get('runtime') || 'aot';
    return 'p2p-1:' + await buildIdentity(profile, runtime);
  }

  // ------------------------------------------------------------------------------------------------ host

  async host() {
    const turn = this.reset();
    this.set({ stage: 'connecting', host: true, status: 'Creating your match…' });
    try {
      const setup = this.setup, map = setup.maps.find(m => m.slots.length >= 2);
      if (!map) throw Error('This game has no multiplayer maps.');
      this.version = await this.fingerprint(); this.guard(turn);
      const room = await createMatch(this.version); this.guard(turn);
      this.seats = [{ faction: this.freeFaction(), team: 0, ready: true }];
      this.set({ stage: 'lobby', room, you: 1, status: '', lobby: { revision: 1, map: map.id, mapUid: map.uid, players: this.seats, ai: [] } });
      track('multiplayer_created');
      // Offers are pushed as guests arrive; a late joiner still gets answered, then told if the match is full.
      const unwatch = await watchJoins(room, j => void this.admit(turn, j.id, j.offer), e => { if (turn === this.generation) this.fail(e.message); });
      if (turn !== this.generation) unwatch(); else this.unwatch = unwatch;
    } catch (e) { if (!(e instanceof Cancelled)) this.fail(message(e)); }
  }

  private freeFaction() {
    const factions = this.setup.factions.filter(f => !f.random).map(f => f.id), used = new Set(this.seats.map(s => s.faction));
    return factions.find(f => !used.has(f)) ?? factions[0];
  }

  private seatsLeft() {
    const lobby = this.view.lobby!, map = this.setup.maps.find(m => m.id === lobby.map)!;
    return map.slots.length - lobby.ai.length - this.seats.length;
  }

  private async admit(turn: number, key: string, offer: string) {
    const peer = new DirectPeer(), guest: Guest = { key, peer, seated: false };
    this.guests.push(guest);
    peer.onMessage = m => {
      try { this.fromGuest(guest, m); }
      catch (e) { if (this.view.stage === 'playing') this.stop(message(e)); else this.dropGuest(guest, message(e)); }
    };
    peer.onClose = reason => this.dropGuest(guest, reason);
    peer.onOpen = () => { if (this.media) void peer.share(this.media); };
    peer.onMedia = () => this.refreshMedia();
    guest.timer = setTimeout(() => { if (!guest.seated) this.dropGuest(guest, 'did not finish connecting'); }, HELLO_WAIT_MS + OPEN_WAIT_MS);
    try {
      const answer = await peer.answer(offer);
      if (turn !== this.generation) return peer.close();
      await answerJoin(this.view.room, key, answer);
    } catch { this.dropGuest(guest, ''); }
  }

  private client(guest: Guest) { return this.guests.filter(g => g.seated).indexOf(guest) + 2; }

  private fromGuest(guest: Guest, m: Record<string, unknown>) {
    const lobby = this.view.lobby;
    if (m.kind === 'hello') {
      if (guest.seated) throw Error('Repeated handshake');
      if (m.version !== this.version) return this.turnAway(guest, 'Your game version differs from the host’s. Both of you reload the page, then try again.');
      if (this.view.stage !== 'lobby' || this.seatsLeft() <= 0) return this.turnAway(guest, 'This match is full. Ask your host to pick a map with more players, or to remove an AI.');
      clearTimeout(guest.timer); guest.seated = true; void removeJoin(this.view.room, guest.key);
      this.seats = [...this.seats, { faction: this.freeFaction(), team: 0, ready: false }];
      this.publish(false, `Player ${this.client(guest)} joined.`);
      return;
    }
    if (!guest.seated || !lobby) throw Error('Handshake required');
    const client = this.client(guest), seat = client - 1;
    if (m.kind === 'seat' && this.view.stage === 'lobby') {
      const next = { ...this.seats[seat] };
      if (m.faction !== undefined) { if (!this.setup.factions.some(f => f.id === m.faction && !f.random)) throw Error('Invalid faction'); next.faction = m.faction as string; }
      if (m.team !== undefined) { if (!Number.isInteger(m.team) || (m.team as number) < 0 || (m.team as number) > MAX_TEAM) throw Error('Invalid team'); next.team = m.team as number; }
      this.seats = this.seats.map((s, i) => i === seat ? next : s);
      this.publish(true);
    } else if (m.kind === 'ready' && this.view.stage === 'lobby') {
      if (typeof m.ready !== 'boolean') throw Error('Invalid ready state');
      if (m.revision === lobby.revision) { this.seats = this.seats.map((s, i) => i === seat ? { ...s, ready: m.ready as boolean } : s); this.publish(false); }
      else this.sendLobby(guest);
    } else if (m.kind === 'chat') {
      const text = this.chatText(m.text);
      this.addChat(`Player ${client}`, text);
      for (const g of this.seated()) if (g !== guest) this.trySend(g.peer, { kind: 'chat', client, text });
    } else if (m.kind === 'events') {
      if (this.view.stage !== 'playing' || !this.lock) throw Error('Match has not started');
      this.lock.receive(client, m.events as PeerEvent[]);
      for (const g of this.seated()) if (g !== guest) this.trySend(g.peer, { kind: 'events', client, events: m.events });
    } else if (m.kind === 'leave') this.dropGuest(guest, 'left');
    else if (m.kind === 'stop' && this.view.stage === 'playing') this.stop(typeof m.reason === 'string' ? m.reason.slice(0, 300) : `Player ${client} stopped the match.`);
    else if (m.kind === 'stop') this.dropGuest(guest, 'left');
    else throw Error('Unknown message');
  }

  private seated() { return this.guests.filter(g => g.seated); }

  /** Tells a guest why it can't join, then hangs up once the message has had time to arrive. */
  private turnAway(guest: Guest, reason: string) {
    clearTimeout(guest.timer); void removeJoin(this.view.room, guest.key);
    guest.peer.onMessage = () => {};
    this.trySend(guest.peer, { kind: 'stop', reason });
    setTimeout(() => this.dropGuest(guest, ''), 1500);
  }

  private dropGuest(guest: Guest, reason: string) {
    if (!this.guests.includes(guest)) return;
    const client = guest.seated ? this.client(guest) : 0;
    clearTimeout(guest.timer); guest.peer.close();
    this.guests = this.guests.filter(g => g !== guest);
    this.refreshMedia();
    if (!client) return;
    if (this.view.stage === 'playing') return this.stop(`Player ${client} ${reason === 'left' ? 'left the match' : 'lost connection'}. The match stopped.`);
    if (this.view.stage !== 'lobby') return;
    this.seats = this.seats.filter((_, i) => i !== client - 1);
    this.publish(false, `Player ${client} ${reason === 'left' ? 'left' : 'disconnected'}.`);
  }

  /** New lobby revision to everyone. Settings changes clear readiness; joins and leaves do not. */
  private publish(clearReady: boolean, note?: string) {
    const lobby = this.view.lobby!;
    if (clearReady) this.seats = this.seats.map((s, i) => ({ ...s, ready: i === 0 }));
    const next = { ...lobby, revision: lobby.revision + 1, players: this.seats };
    this.set({ lobby: next, ...(note ? { chat: [...this.view.chat, { id: crypto.randomUUID(), author: '', text: note }].slice(-100) } : {}) });
    for (const g of this.seated()) this.sendLobby(g);
  }
  private sendLobby(guest: Guest) { this.trySend(guest.peer, { kind: 'lobby', lobby: this.view.lobby, you: this.client(guest) }); }
  private trySend(peer: DirectPeer, m: object) { try { peer.send(m); } catch { /* its close handler reports it */ } }

  setMap(id: string) {
    const map = this.setup.maps.find(m => m.id === id && m.slots.length >= 2);
    if (!this.view.host || !map || this.view.stage !== 'lobby') return;
    if (map.slots.length < this.seats.length) return this.set({ status: `${map.slots.length}-player map: too many commanders.` });
    const ai = this.view.lobby!.ai.slice(0, map.slots.length - this.seats.length);
    this.set({ lobby: { ...this.view.lobby!, map: map.id, mapUid: map.uid, saved: map.saved, ai }, status: '' });
    this.publish(true);
    // A saved map loads now, so starting doesn't wait for it.
    if (map.saved) this.game.ensureMap(map.id).catch(e => this.set({ status: message(e) }));
  }
  setAi(ai: AiSeat[]) {
    if (!this.view.host || this.view.stage !== 'lobby') return;
    const lobby = this.view.lobby!, map = this.setup.maps.find(m => m.id === lobby.map)!;
    if (ai.length + this.seats.length > map.slots.length) return;
    this.set({ lobby: { ...lobby, ai } });
    this.publish(true);
  }

  start() {
    if (!this.view.host || this.view.stage !== 'lobby') return;
    try {
      const lobby = this.view.lobby!, map = this.setup.maps.find(m => m.id === lobby.map)!, guests = this.seated();
      if (guests.length < 1) throw Error('Invite at least one friend first.');
      if (!this.seats.every(s => s.ready)) throw Error('Everyone must be ready.');
      if (useStore.getState().phase !== 'setup') throw Error('Return to the main menu before starting.');
      const seats: { faction: string; team: number; bot?: string }[] = [...this.seats, ...lobby.ai];
      const scenario: PeerScenario = { multiplayer: true, map: map.id, mapUid: map.uid, seed: crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646 + 1, options: { ...peerOptions },
        players: seats.map((s, i) => {
          const common = { slot: map.slots[i], faction: s.faction, spawn: i + 1, team: s.team, color: peerColors[i] };
          return s.bot ? { bot: s.bot, ...common } : { client: i + 1, ...common };
        }) };
      validatePeerScenario(scenario, this.setup);
      for (const g of guests) g.peer.send({ kind: 'start', version: this.version, scenario, you: this.client(g) });
      // Late joiners can no longer be admitted; the matchmaker forgets the match.
      this.unwatch?.(); this.unwatch = null; void closeMatch(this.view.room);
      track('multiplayer_started', { players: this.seats.length, ai: lobby.ai.length, map: map.title });
      this.launch(scenario, 1);
    } catch (e) { this.set({ status: message(e) }); }
  }

  // ------------------------------------------------------------------------------------------------ guest

  async join(input: string) {
    let room: string;
    try { room = inviteCode(input); } catch (e) { return this.set({ stage: 'idle', error: message(e) }); }
    const turn = this.reset();
    this.set({ stage: 'connecting', host: false, room, status: 'Contacting your host…' });
    try {
      this.setup;
      this.version = await this.fingerprint(); this.guard(turn);
      const peer = new DirectPeer(); this.hostPeer = peer;
      let opened: () => void = () => {};
      const open = new Promise<void>(resolve => { opened = resolve; });
      peer.onOpen = () => { opened(); if (this.media) void peer.share(this.media); };
      peer.onClose = reason => { if (turn === this.generation) this.fail(this.view.stage === 'connecting' ? "Couldn't connect to your host." : `Lost connection to the host. ${reason}`); };
      peer.onMessage = m => { try { this.fromHost(m); } catch (e) { this.stop(message(e)); } };
      peer.onMedia = () => this.refreshMedia();
      const offer = await peer.offer(); this.guard(turn);
      const joined = await joinMatch(room, this.version, offer); this.pendingJoin = joined; this.guard(turn);
      this.set({ status: 'Waiting for your host to answer…' });
      const answer = await joined.answer(ANSWER_WAIT_MS); this.guard(turn);
      this.set({ status: 'Connecting directly…' });
      await peer.accept(answer);
      const timeout = sleep(OPEN_WAIT_MS).then(() => { throw Error("Couldn't connect directly to your host. Some networks block direct connections; try another network, such as a phone hotspot."); });
      await Promise.race([open, timeout]); this.guard(turn);
      peer.send({ kind: 'hello', version: this.version });
    } catch (e) { if (!(e instanceof Cancelled)) this.fail(message(e)); }
  }

  private fromHost(m: Record<string, unknown>) {
    if (m.kind === 'lobby') {
      if (this.view.stage !== 'connecting' && this.view.stage !== 'lobby') return;
      const lobby = m.lobby as Lobby, you = m.you as number;
      if (!lobby || !Array.isArray(lobby.players) || !Array.isArray(lobby.ai) || !Number.isInteger(you) || you < 2 || you > lobby.players.length) throw Error('Invalid lobby');
      const known = this.setup.maps.some(m => m.id === lobby.map && m.uid === lobby.mapUid && m.slots.length >= 2);
      if (!known && typeof lobby.saved !== 'string') peerMap(this.setup, lobby.map, lobby.mapUid);
      const changed = lobby.map !== this.view.lobby?.map;
      if (this.view.stage === 'connecting') track('multiplayer_joined');
      this.set({ stage: 'lobby', lobby, you, ...(changed ? { status: '', mapLoading: false } : {}) });
      if (changed && typeof lobby.saved === 'string') void this.loadHostMap(lobby.saved, lobby.map);
    } else if (m.kind === 'chat') {
      this.addChat(`Player ${Number(m.client) | 0}`, this.chatText(m.text));
    } else if (m.kind === 'start') {
      if (this.view.stage !== 'lobby' || m.version !== this.version) throw Error('Invalid start request');
      const scenario = validatePeerScenario(m.scenario, this.setup), lobby = this.view.lobby!, you = this.view.you;
      const humans = scenario.players.filter(p => 'client' in p), bots = scenario.players.filter(p => 'bot' in p);
      const agreed = m.you === you && scenario.map === lobby.map && humans.length === lobby.players.length && lobby.players.every((s, i) => s.faction === humans[i].faction && s.team === humans[i].team)
        && bots.length === lobby.ai.length && lobby.ai.every((a, i) => a.faction === bots[i].faction && a.team === bots[i].team && a.bot === (bots[i] as { bot: string }).bot);
      if (!agreed || !lobby.players[you - 1].ready) throw Error('Match settings changed after you were ready. Start a new match.');
      if (useStore.getState().phase !== 'setup') throw Error('Another world is already open. Return to the main menu before joining a match.');
      this.launch(scenario, you);
    } else if (m.kind === 'events') {
      const client = m.client as number;
      if (this.view.stage !== 'playing' || !this.lock || client === this.view.you) throw Error('Invalid relayed orders');
      this.lock.receive(client, m.events as PeerEvent[]);
    } else if (m.kind === 'stop') this.stop(typeof m.reason === 'string' ? m.reason.slice(0, 300) : 'The host stopped the match.', false);
    else throw Error('Unknown message');
  }

  setSeat(patch: { faction?: string; team?: number }) {
    if (this.view.stage !== 'lobby') return;
    if (this.view.host) {
      this.seats = this.seats.map((s, i) => i === 0 ? { ...s, ...patch } : s);
      this.publish(true);
    } else this.trySend(this.hostPeer!, { kind: 'seat', ...patch });
  }
  /** Guest: the host's saved map, fetched from Firestore and mounted before this player can be ready. */
  private async loadHostMap(saved: string, id: string) {
    const turn = this.generation;
    this.set({ mapLoading: true, status: 'Downloading your host’s map…' });
    try {
      if (!this.setup.maps.some(m => m.id === id)) {
        const map = await savedMap(saved);
        if (!map || map.id !== id) throw Error('Your host’s map isn’t available. Ask them to pick another map.');
        this.game.addSavedMaps([map]);
      }
      await this.game.ensureMap(id);
      if (turn === this.generation && this.view.lobby?.map === id) this.set({ mapLoading: false, status: '' });
    } catch (e) {
      if (turn === this.generation && this.view.lobby?.map === id) this.set({ mapLoading: false, status: message(e) });
    }
  }

  setReady(ready: boolean) {
    if (this.view.stage !== 'lobby' || this.view.host) return;
    if (ready && (this.view.mapLoading || !this.setup.maps.some(m => m.id === this.view.lobby!.map))) return;
    this.trySend(this.hostPeer!, { kind: 'ready', ready, revision: this.view.lobby!.revision });
  }

  // ------------------------------------------------------------------------------------------------ match

  private launch(scenario: PeerScenario, you: number) {
    const humans = scenario.players.filter(p => 'client' in p).length;
    this.lock = new PeerLockstep(humans, frame => this.game.client.send({ type: 'peerFrame', ...frame }));
    this.unwatch?.(); this.unwatch = null;
    this.set({ stage: 'playing', you, frame: 0, status: '' });
    useStore.getState().set({ cc: { ...useStore.getState().cc, enabled: false } });
    this.game.start(JSON.stringify({ ...scenario, localClient: you, network: { peer: true } }));
  }

  private outgoing(events: PeerEvent[]) {
    if (this.view.stage !== 'playing' || !this.lock) return;
    try {
      if (this.view.host) { for (const g of this.seated()) g.peer.send({ kind: 'events', client: 1, events }); }
      else this.hostPeer!.send({ kind: 'events', events });
      this.lock.receive(this.view.you, events);
    } catch (e) { this.stop(message(e)); }
  }

  /** Stops a running match (or lobby) for everyone and keeps the reason on screen. */
  stop(reason: string, notify = true) {
    if (this.view.stage === 'idle' || this.view.stage === 'stopped') return;
    const playing = this.view.stage === 'playing';
    if (/Synchronization mismatch|Invalid peer|Conflicting peer/.test(reason)) track('game_error', { where: 'multiplayer', message: reason.slice(0, 200) });
    if (notify) for (const p of this.peers()) this.trySend(p, { kind: 'stop', reason });
    if (playing) { this.game.cancelPendingStart(); this.game.client.send({ type: 'peerStop', error: reason }); }
    this.closeAll();
    // Failing to get in at all returns to the start screen; an ended lobby or match stays "stopped" until dismissed.
    this.set({ stage: playing || this.view.stage === 'lobby' ? 'stopped' : 'idle', error: reason, status: '' });
  }

  private fail(reason: string) {
    if (this.view.stage === 'playing') return this.stop(reason);
    if (this.view.host && this.view.room) void closeMatch(this.view.room);
    for (const p of this.peers()) this.trySend(p, this.view.host ? { kind: 'stop', reason: 'The host closed the match.' } : { kind: 'leave' });
    this.closeAll();
    this.set({ stage: this.view.stage === 'lobby' ? 'stopped' : 'idle', error: reason, status: '' });
  }

  /** Leave the match or lobby and return to the main menu. */
  leave(quitWorld = true) {
    const { stage, host, room } = this.view;
    for (const p of this.peers()) this.trySend(p, host ? { kind: 'stop', reason: stage === 'playing' ? 'The host left the match. The match stopped.' : 'The host closed the match.' } : { kind: 'leave' });
    if (host && room && stage !== 'playing') void closeMatch(room);
    // Reset first: quitting the world notifies the phase subscriber, which must see an idle session.
    this.reset();
    if (quitWorld && (stage === 'playing' || stage === 'stopped') && useStore.getState().phase !== 'setup') this.game.quit();
  }

  private peers() { return [...this.guests.map(g => g.peer), ...(this.hostPeer ? [this.hostPeer] : [])]; }

  private closeAll() {
    this.generation++;
    this.unwatch?.(); this.unwatch = null;
    if (this.view.stage !== 'playing') void this.pendingJoin?.cancel();
    this.pendingJoin = null;
    for (const g of this.guests) clearTimeout(g.timer);
    for (const p of this.peers()) { p.onClose = () => {}; p.close(); }
    this.guests = []; this.hostPeer = null; this.lock = null;
    this.media?.getTracks().forEach(t => t.stop()); this.media = null;
  }

  private reset() {
    this.closeAll();
    this.seats = [];
    this.set({ ...idle });
    return this.generation;
  }

  // ------------------------------------------------------------------------------------------------ chat & media

  private chatText(value: unknown) { if (typeof value !== 'string' || !value.trim() || value.length > 500) throw Error('Invalid chat message'); return value.trim(); }
  private addChat(author: string, text: string) { this.set({ chat: [...this.view.chat, { id: crypto.randomUUID(), author, text }].slice(-100) }); }

  async say(text: string) {
    const clean = this.chatText(text);
    if (this.view.host) for (const g of this.seated()) g.peer.send({ kind: 'chat', client: 1, text: clean });
    else this.hostPeer!.send({ kind: 'chat', text: clean });
    this.addChat('You', clean);
  }

  async toggleCamera() {
    if (this.media) {
      this.media.getTracks().forEach(t => t.stop()); this.media = null;
      for (const p of this.peers()) void p.share(null);
      return this.set({ camera: false });
    }
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      if (this.view.stage === 'idle' || this.view.stage === 'stopped') return media.getTracks().forEach(t => t.stop());
      this.media = media;
      for (const p of this.peers()) await p.share(media);
      this.set({ camera: true, status: '' });
    } catch (e) { this.set({ status: `Camera and microphone unavailable: ${message(e)}` }); }
  }

  private refreshMedia() {
    const remote = this.view.host
      ? this.seated().map(g => ({ id: g.key, label: `Player ${this.client(g)}`, stream: g.peer.remoteMedia }))
      : this.hostPeer ? [{ id: 'host', label: 'Player 1', stream: this.hostPeer.remoteMedia }] : [];
    this.set({ remote: remote.filter(r => r.stream.getTracks().some(t => !t.muted && t.readyState === 'live')) });
  }

  dismiss() { if (this.view.stage === 'stopped') this.leave(); }
}
