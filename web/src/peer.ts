/**
 * Direct multiplayer transport. Browsers meet through the matchmaker (net/matchmaker.ts), which only passes WebRTC
 * offers and answers; orders, lobby, chat and media then flow over direct connections. Every guest connects to the
 * host, who relays each player's order packets to the others, so every world receives the same frames.
 */
export type PeerEvent = { kind: 'orders'; frame: number; data: string } | { kind: 'hash'; frame: number; hash: number; defeat: string };
export type PeerFrame = { frame: number; packets: { client: number; data: string }[] };
export type PeerCatalog = { maps: { id: string; uid: string; slots: string[] }[]; factions: { id: string; random: boolean }[]; bots: { type: string }[] };
export type PeerHuman = { client: number; slot: string; faction: string; spawn: number; team: number; color: string };
export type PeerBot = { bot: string; slot: string; faction: string; spawn: number; team: number; color: string };
export type PeerScenario = { multiplayer: true; map: string; mapUid: string; seed: number; options: Record<string, string>; players: (PeerHuman | PeerBot)[] };
export const peerOptions = { techlevel: 'unrestricted', shortgame: 'True', crates: 'False', startingunits: 'none', startingcash: '10000' };
export const peerColors = ['2A6FDB', 'D83A2E', '3FAE49', 'E7B42F', '9B59D0', '1FB5B5', 'E67E22', 'D4D4D4'];
export const MAX_TEAM = 4;

export function peerMap(catalog: PeerCatalog, id: unknown, uid: unknown) {
  const map = catalog.maps.find(m => m.id === id && m.uid === uid && m.slots.length >= 2);
  if (!map) throw Error('Different or unsupported maps. Reload both browsers with the same content.');
  return map;
}

/** Humans first (clients 1..n), then bots, each in the map's slot order. Throws on anything else. */
export function validatePeerScenario(value: unknown, catalog: PeerCatalog): PeerScenario {
  const s = value as PeerScenario | null;
  if (!s || typeof s !== 'object' || s.multiplayer !== true || !Number.isInteger(s.seed) || s.seed < 1 || s.seed > 2147483646 || !Array.isArray(s.players)) throw Error('Invalid peer match settings');
  const map = peerMap(catalog, s.map, s.mapUid);
  if (!s.options || Object.keys(s.options).length !== Object.keys(peerOptions).length || Object.entries(peerOptions).some(([key, value]) => s.options[key] !== value)) throw Error('Invalid peer match options');
  const humans = s.players.filter(p => p && !('bot' in p)).length;
  if (humans < 2 || s.players.length > map.slots.length) throw Error('Invalid peer players');
  const players = s.players.map((p, i) => {
    const bot = i >= humans;
    if (!p || typeof p !== 'object' || p.slot !== map.slots[i] || p.spawn !== i + 1 || !Number.isInteger(p.team) || p.team < 0 || p.team > MAX_TEAM || p.color !== peerColors[i] || !catalog.factions.some(f => f.id === p.faction && !f.random)) throw Error('Invalid peer players');
    if (bot) {
      if (!('bot' in p) || !catalog.bots.some(b => b.type === p.bot) || 'client' in p) throw Error('Invalid peer players');
      return { bot: p.bot, slot: p.slot, faction: p.faction, spawn: p.spawn, team: p.team, color: p.color };
    }
    if ('bot' in p || (p as PeerHuman).client !== i + 1) throw Error('Invalid peer players');
    return { client: i + 1, slot: p.slot, faction: p.faction, spawn: p.spawn, team: p.team, color: p.color };
  });
  return { multiplayer: true, map: map.id, mapUid: map.uid, seed: s.seed, options: { ...peerOptions }, players };
}

/** Session descriptions travel through the matchmaker; only a data-channel SDP is accepted. */
export function checkSdp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 24000 || !value.startsWith('v=0') || !value.includes('m=application')) throw Error('Invalid connection description');
  return value;
}

/**
 * What one side's connection description offered, without its addresses: the kinds of route (host: same network,
 * srflx: a public address found through STUN, relay) and how its NAT maps ports. A NAT that gives each STUN server a
 * different public port ("symmetric", common on mobile carriers) can't take a direct line from most other networks.
 */
export function routeSummary(sdp: string | null | undefined) {
  const kinds = new Set<string>();
  let publicRoute = false, perServer = false;
  // Each section (audio, video, data) gathers on its own sockets, one per network interface (its host candidates):
  // a NAT that keeps one port gives each socket one public port; a symmetric one gives it a new port per server.
  for (const section of (sdp ?? '').split(/\r?\nm=/)) {
    let sockets = 0;
    const ports = new Map<string, Set<string>>();
    for (const line of section.split(/\r?\n/)) {
      const m = /^a=candidate:\S+ \d+ (\S+) \d+ (\S+) (\d+) typ (\S+)/i.exec(line);
      if (!m) continue;
      const [, protocol, address, port, kind] = m;
      kinds.add(kind);
      if (protocol.toLowerCase() !== 'udp') continue;
      if (kind === 'host') sockets++;
      if (kind === 'srflx') { publicRoute = true; ports.set(address, (ports.get(address) ?? new Set()).add(port)); }
    }
    if ([...ports.values()].some(p => p.size > Math.max(1, sockets))) perServer = true;
  }
  const nat = !publicRoute ? 'no public route' : perServer ? 'new port per server' : 'keeps one port';
  return { routes: [...kinds].sort().join(',') || 'none', nat };
}

/** The longest input delay a match may run with: 12 frames, about half a second. */
export const MAX_INPUT_DELAY = 12;
/** An engine that fell this many frames behind without sending a synchronization report has stopped reporting. */
const UNCHECKED_LIMIT = 250;

/**
 * How many frames ahead orders are sent, for players whose slowest path (one way, in ms: guest to host, or guest to
 * guest through the host) takes `oneWayMs`. A frame is 40 ms; the delay leaves one frame of room for jitter, so the
 * match keeps the game's own speed. Nearby players get 2 frames (80 ms, below what a hand notices); OpenRA's own
 * default is 3.
 */
export function inputDelay(oneWayMs: number) {
  return Math.min(MAX_INPUT_DELAY, Math.max(2, Math.ceil(((Number.isFinite(oneWayMs) ? oneWayMs : 80) + 40) / 40)));
}

/**
 * Lockstep barrier for clients 1..count, with an input delay. The orders a client's engine issues while it is at
 * frame n run at frame n + delay in every world (the first `delay` frames run without orders). So a frame's orders
 * are already travelling while the frames before it play, and the match keeps the game's speed as long as a message
 * crosses in less than delay + 1 frames; a slower line holds frames back until its orders arrive, never skips them.
 * The engines' synchronization reports are compared as they arrive, without holding frames back: the first frame
 * whose reports differ stops the match and is named. Any malformed, conflicting or mismatching input stops it for good.
 */
export class PeerLockstep {
  /** The last frame released to the engine. */
  frame = 0;
  /** Every frame up to this one had the same synchronization report from every client. */
  checked = 0;
  stopped = false;
  private orders = new Map<number, Map<number, string>>();
  private hashes = new Map<number, Map<number, string>>();
  constructor(private count: number, private completed: (frame: PeerFrame) => void, readonly delay = 0) {
    if (!Number.isInteger(count) || count < 2 || count > peerColors.length) throw Error('Invalid peer player count');
    if (!Number.isInteger(delay) || delay < 0 || delay > MAX_INPUT_DELAY) throw Error('Invalid peer input delay');
  }
  /** The clients whose orders the next frame is still waiting for (empty while frames flow). */
  waitingFor() {
    const issued = this.frame + 1 - this.delay, got = issued < 1 ? null : this.orders.get(issued);
    return issued < 1 ? [] : Array.from({ length: this.count }, (_, i) => i + 1).filter(c => !got?.has(c));
  }
  receive(client: number, events: PeerEvent[]) {
    if (this.stopped) throw Error('Peer match stopped. Start a new match.');
    try { this.accept(client, events); } catch (error) { this.stopped = true; throw error; }
  }
  private accept(client: number, events: PeerEvent[]) {
    if (!Number.isInteger(client) || client < 1 || client > this.count || !Array.isArray(events) || events.length > 16) throw Error('Invalid peer packet');
    for (const e of events) {
      if (!e || typeof e !== 'object') throw Error('Invalid peer event');
      // No engine can be further ahead: it needs this client's orders, which are issued one frame at a time.
      if (!Number.isInteger(e.frame) || e.frame < 1 || e.frame > this.frame + this.delay + 2) throw Error('Invalid peer frame');
      if (e.kind === 'orders') {
        if (e.frame + this.delay <= this.frame) continue;
        if (typeof e.data !== 'string' || e.data.length > 131072 || !/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.data)) throw Error('Invalid peer orders');
        let packets = this.orders.get(e.frame);
        if (!packets) this.orders.set(e.frame, packets = new Map());
        if (packets.has(client) && packets.get(client) !== e.data) throw Error('Conflicting peer orders');
        packets.set(client, e.data);
      } else if (e.kind === 'hash') {
        if (e.frame <= this.checked) continue;
        if (!Number.isInteger(e.hash) || e.hash < -2147483648 || e.hash > 2147483647 || typeof e.defeat !== 'string' || !/^\d{1,20}$/.test(e.defeat)) throw Error('Invalid peer synchronization report');
        let hashes = this.hashes.get(e.frame);
        if (!hashes) this.hashes.set(e.frame, hashes = new Map());
        if (hashes.has(client) && hashes.get(client) !== `${e.hash}:${e.defeat}`) throw Error('Conflicting peer synchronization report');
        hashes.set(client, `${e.hash}:${e.defeat}`);
        if (hashes.size === this.count && new Set(hashes.values()).size !== 1) throw Error(`Synchronization mismatch at frame ${e.frame}. Match stopped.`);
        // Reports complete in frame order per client, so the checked mark moves over every finished frame.
        while (this.hashes.get(this.checked + 1)?.size === this.count) this.hashes.delete(++this.checked);
      } else throw Error('Unknown peer event');
    }
    // Several frames can become ready at once: the first `delay` frames, and whenever a late packet arrives.
    for (;;) {
      const next = this.frame + 1, issued = next - this.delay;
      const packets = issued < 1 ? null : this.orders.get(issued);
      if (issued >= 1 && packets?.size !== this.count) break;
      this.frame = next;
      if (packets) this.orders.delete(issued);
      this.completed({ frame: next, packets: Array.from({ length: this.count }, (_, i) => ({ client: i + 1, data: packets?.get(i + 1) ?? '' })) });
    }
    if (this.frame - this.checked > UNCHECKED_LIMIT) throw Error('A player’s game stopped reporting its state. Match stopped.');
  }
}

const ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];

/** One direct connection: a reliable ordered data channel, plus audio/video senders that stay empty until a camera starts. */
export class DirectPeer {
  readonly pc: RTCPeerConnection;
  readonly remoteMedia = new MediaStream();
  channel: RTCDataChannel | null = null;
  onMessage: (message: Record<string, unknown>) => void = () => {};
  onOpen: () => void = () => {};
  onClose: (reason: string) => void = () => {};
  onMedia: () => void = () => {};
  /** Round trip to the other side in ms (the lowest of the last few pings), or null before the first answer. */
  rtt: number | null = null;
  private pings: number[] = [];
  private closed = false;
  private lastMessage = Date.now();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  constructor(iceServers: RTCIceServer[] = ICE_SERVERS) {
    this.pc = new RTCPeerConnection({ iceServers });
    // Remote tracks exist from the start but stay muted until the other side shares a camera.
    this.pc.ontrack = e => {
      if (!this.remoteMedia.getTrackById(e.track.id)) this.remoteMedia.addTrack(e.track);
      e.track.onmute = e.track.onunmute = () => this.onMedia();
      this.onMedia();
    };
    this.pc.onconnectionstatechange = () => { if (this.pc.connectionState === 'failed') this.fail('The direct connection failed.'); };
    this.pc.ondatachannel = e => this.attach(e.channel);
  }
  get open() { return !this.closed && this.channel?.readyState === 'open'; }
  private fail(reason: string) { if (this.closed) return; this.close(); this.onClose(reason); }
  private attach(channel: RTCDataChannel) {
    this.channel = channel;
    channel.onopen = () => {
      this.lastMessage = Date.now();
      const ping = () => { try { this.send({ kind: 'ping', t: performance.now() }); } catch { this.fail('The direct connection closed.'); } };
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastMessage > 15000) return this.fail('No response for 15 seconds.');
        ping();
      }, 3000);
      // The first answers come at once, so a match that starts right after a join already knows the distance.
      for (const wait of [0, 400, 800]) setTimeout(() => { if (this.open) ping(); }, wait);
      this.onOpen();
    };
    channel.onclose = () => this.fail('The direct connection closed.');
    channel.onerror = () => this.fail('The direct connection failed.');
    channel.onmessage = e => {
      try {
        if (typeof e.data !== 'string' || e.data.length > 150000) throw Error('Invalid peer message');
        const value = JSON.parse(e.data);
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.kind !== 'string') throw Error('Invalid peer message');
        this.lastMessage = Date.now();
        if (value.kind === 'ping') { this.send({ kind: 'pong', t: value.t }); return; }
        if (value.kind === 'pong') {
          const took = performance.now() - value.t;
          if (typeof value.t === 'number' && took >= 0 && took < 15000) { this.pings = [...this.pings, took].slice(-5); this.rtt = Math.min(...this.pings); }
          return;
        }
        this.onMessage(value);
      } catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
    };
  }
  send(message: object) {
    if (!this.open) throw Error('Peer disconnected. Start a new match.');
    if (this.channel!.bufferedAmount > 1048576) throw Error('Peer connection is congested. Match stopped.');
    this.channel!.send(JSON.stringify(message));
  }
  /** Waits for ICE gathering (a complete description saves trickle round trips through the matchmaker). */
  private async description() {
    if (this.pc.iceGatheringState !== 'complete') await new Promise<void>((resolve, reject) => {
      // A blocked public STUN endpoint must not prevent same-network connections.
      const timer = setTimeout(() => { this.pc.removeEventListener('icegatheringstatechange', changed); if (this.pc.localDescription?.sdp.includes('a=candidate:')) resolve(); else reject(Error('No connection route found. Try another network.')); }, 8000);
      const changed = () => { if (this.pc.iceGatheringState === 'complete') { clearTimeout(timer); this.pc.removeEventListener('icegatheringstatechange', changed); resolve(); } };
      this.pc.addEventListener('icegatheringstatechange', changed);
    });
    return this.pc.localDescription!.sdp;
  }
  /** Guest side: create the channel and an offer for the host. */
  async offer() {
    if (this.closed || this.pc.localDescription) throw Error('Create a new connection before making another offer');
    this.pc.addTransceiver('audio', { direction: 'sendrecv' });
    this.pc.addTransceiver('video', { direction: 'sendrecv' });
    this.attach(this.pc.createDataChannel('rtsai', { ordered: true }));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    return this.description();
  }
  /** Host side: answer a guest's offer. */
  async answer(offer: string) {
    if (this.closed || this.pc.remoteDescription) throw Error('Create a new connection before answering again');
    await this.pc.setRemoteDescription({ type: 'offer', sdp: checkSdp(offer) });
    for (const transceiver of this.pc.getTransceivers()) transceiver.direction = 'sendrecv';
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    return this.description();
  }
  /** Guest side: apply the host's answer. */
  async accept(answer: string) {
    if (this.closed || this.pc.signalingState !== 'have-local-offer') throw Error('This offer was already answered. Start a new connection.');
    await this.pc.setRemoteDescription({ type: 'answer', sdp: checkSdp(answer) });
  }
  /** Sends the given camera/microphone tracks (or nothing) on the existing senders: no renegotiation. */
  async share(media: MediaStream | null) {
    for (const transceiver of this.pc.getTransceivers()) {
      if (transceiver.mid === null) continue;
      const kind = transceiver.receiver.track.kind;
      await transceiver.sender.replaceTrack(media?.getTracks().find(t => t.kind === kind) ?? null);
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.remoteMedia.getTracks().forEach(t => t.stop()); this.channel?.close(); this.pc.close();
  }
}
