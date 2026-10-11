/** Direct two-player transport. Signaling is copied between friends; no room service is used. */
export type PeerEvent = { kind: 'orders'; frame: number; data: string } | { kind: 'hash'; frame: number; hash: number; defeat: string };
export type PeerFrame = { frame: number; packets: { client: number; data: string }[] };
export type PeerCatalog = { maps: { id: string; uid: string; slots: string[] }[]; factions: { id: string; random: boolean }[] };
export type PeerScenario = { multiplayer: true; map: string; mapUid: string; seed: number; options: Record<string, string>; players: { client: number; slot: string; faction: string; spawn: number; team: number; color: string }[] };
export const peerOptions = { techlevel: 'unrestricted', shortgame: 'True', crates: 'False', startingunits: 'none', startingcash: '10000' };

export function peerMap(catalog: PeerCatalog, id: unknown, uid: unknown) {
  const map = catalog.maps.find(m => m.id === id && m.uid === uid && m.slots.length >= 2);
  if (!map) throw Error('Different or unsupported maps. Reload both browsers with the same content.');
  return map;
}

export function validatePeerScenario(value: unknown, catalog: PeerCatalog): PeerScenario {
  const s = value as PeerScenario | null;
  if (!s || typeof s !== 'object' || s.multiplayer !== true || !Number.isInteger(s.seed) || s.seed < 1 || s.seed > 2147483646 || !Array.isArray(s.players) || s.players.length !== 2) throw Error('Invalid peer match settings');
  const map = peerMap(catalog, s.map, s.mapUid);
  if (!s.options || Object.keys(s.options).length !== Object.keys(peerOptions).length || Object.entries(peerOptions).some(([key, value]) => s.options[key] !== value)) throw Error('Invalid peer match options');
  for (const [i, p] of s.players.entries()) {
    if (!p || p.client !== i + 1 || p.slot !== map.slots[i] || p.spawn !== i + 1 || p.team !== 0 || p.color !== (i ? 'D83A2E' : '2A6FDB') || !catalog.factions.some(f => f.id === p.faction && !f.random)) throw Error('Invalid peer players');
  }
  return { multiplayer: true, map: map.id, mapUid: map.uid, seed: s.seed, options: { ...peerOptions }, players: s.players.map(p => ({ client: p.client, slot: p.slot, faction: p.faction, spawn: p.spawn, team: p.team, color: p.color })) };
}

export function parsePeerCode(code: string, type: 'offer' | 'answer'): RTCSessionDescriptionInit {
  if (typeof code !== 'string' || code.length > 128000) throw Error('Connection code is too large');
  let value: RTCSessionDescriptionInit | null;
  try { value = JSON.parse(atob(code.trim())); } catch { throw Error('Invalid connection code'); }
  if (!value || typeof value !== 'object' || value.type !== type || typeof value.sdp !== 'string' || !value.sdp.startsWith('v=0') || !value.sdp.includes('m=application')) throw Error(`Paste the friend's ${type} code`);
  return { type, sdp: value.sdp };
}

export class PeerLockstep {
  frame = 0;
  stopped = false;
  private orders = new Map<number, Map<number, string>>();
  private hashes = new Map<number, Map<number, string>>();
  constructor(private completed: (frame: PeerFrame) => void) {}
  receive(client: number, events: PeerEvent[]) {
    if (this.stopped) throw Error('Peer match stopped. Start a new match.');
    try { this.accept(client, events); } catch (error) { this.stopped = true; throw error; }
  }
  private accept(client: number, events: PeerEvent[]) {
    if (![1, 2].includes(client) || !Array.isArray(events) || events.length > 16) throw Error('Invalid peer packet');
    for (const e of events) {
      if (!e || typeof e !== 'object') throw Error('Invalid peer event');
      if (!Number.isInteger(e.frame) || e.frame < 1 || e.frame > this.frame + 2) throw Error('Invalid peer frame');
      if (e.kind === 'orders') {
        if (e.frame <= this.frame) continue;
        if (typeof e.data !== 'string' || e.data.length > 131072 || !/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.data)) throw Error('Invalid peer orders');
        let packets = this.orders.get(e.frame);
        if (!packets) this.orders.set(e.frame, packets = new Map());
        if (packets.has(client) && packets.get(client) !== e.data) throw Error('Conflicting peer orders');
        packets.set(client, e.data);
      } else if (e.kind === 'hash') {
        if (e.frame < this.frame) continue;
        if (!Number.isInteger(e.hash) || e.hash < -2147483648 || e.hash > 2147483647 || typeof e.defeat !== 'string' || !/^\d{1,20}$/.test(e.defeat)) throw Error('Invalid peer synchronization report');
        let hashes = this.hashes.get(e.frame);
        if (!hashes) this.hashes.set(e.frame, hashes = new Map());
        if (hashes.has(client) && hashes.get(client) !== `${e.hash}:${e.defeat}`) throw Error('Conflicting peer synchronization report');
        hashes.set(client, `${e.hash}:${e.defeat}`);
        if (hashes.size === 2 && new Set(hashes.values()).size !== 1) throw Error(`Synchronization mismatch at frame ${e.frame}. Match stopped.`);
      } else throw Error('Unknown peer event');
    }
    if (this.frame && this.hashes.get(this.frame)?.size !== 2) return;
    const next = this.orders.get(this.frame + 1);
    if (next?.size === 2) {
      const previous = this.frame;
      this.frame++;
      this.orders.delete(this.frame);
      this.hashes.delete(previous);
      this.completed({ frame: this.frame, packets: [...next].sort(([a], [b]) => a - b).map(([client, data]) => ({ client, data })) });
    }
  }
}

export class DirectPeer {
  readonly pc: RTCPeerConnection;
  readonly remoteMedia = new MediaStream();
  localMedia: MediaStream | null = null;
  channel: RTCDataChannel | null = null;
  onMessage: (message: Record<string, unknown>) => void = () => {};
  onState: (state: string) => void = () => {};
  onError: (error: Error) => void = () => {};
  private closed = false;
  private lastMessage = Date.now();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  constructor(iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]) {
    this.pc = new RTCPeerConnection({ iceServers });
    this.pc.ontrack = e => { if (!this.remoteMedia.getTrackById(e.track.id)) this.remoteMedia.addTrack(e.track); };
    this.pc.onconnectionstatechange = () => this.onState(this.pc.connectionState);
    this.pc.ondatachannel = e => this.attach(e.channel);
  }
  private attach(channel: RTCDataChannel) {
    this.channel = channel;
    channel.onopen = () => {
      this.lastMessage = Date.now();
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastMessage > 15000) { this.onError(Error('Your friend stopped responding. Start a new match.')); this.close(); return; }
        try { this.send({ kind: 'ping' }); } catch (error) { this.onError(error as Error); this.close(); }
      }, 3000);
      this.onState('connected');
    };
    channel.onclose = () => this.onState('closed');
    channel.onerror = () => this.onState('failed');
    channel.onmessage = e => {
      try {
        if (typeof e.data !== 'string' || e.data.length > 150000) throw Error('Invalid peer message');
        const value = JSON.parse(e.data);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid peer message');
        this.lastMessage = Date.now();
        if (value.kind === 'ping') { this.send({ kind: 'pong' }); return; }
        if (value.kind === 'pong') return;
        this.onMessage(value);
      } catch (error) { this.onError(error instanceof Error ? error : Error(String(error))); this.close(); }
    };
  }
  send(message: object) {
    if (this.closed || this.channel?.readyState !== 'open') throw Error('Peer disconnected. Start a new match.');
    if (this.channel.bufferedAmount > 1048576) throw Error('Peer connection is congested. Match stopped.');
    this.channel.send(JSON.stringify(message));
  }
  private async description() {
    if (this.pc.iceGatheringState !== 'complete') await new Promise<void>((resolve, reject) => {
      // A blocked public STUN endpoint must not prevent same-network connections.
      const timer = setTimeout(() => { this.pc.removeEventListener('icegatheringstatechange', changed); if (this.pc.localDescription?.sdp.includes('a=candidate:')) resolve(); else reject(Error('No connection route found. Try another network.')); }, 8000);
      const changed = () => { if (this.pc.iceGatheringState === 'complete') { clearTimeout(timer); this.pc.removeEventListener('icegatheringstatechange', changed); resolve(); } };
      this.pc.addEventListener('icegatheringstatechange', changed);
    });
    return btoa(JSON.stringify(this.pc.localDescription?.toJSON()));
  }
  async offer() {
    if (this.closed || this.pc.signalingState !== 'stable' || this.pc.localDescription) throw Error('Create a new connection before making another offer');
    this.pc.addTransceiver('audio', { direction: 'sendrecv' });
    this.pc.addTransceiver('video', { direction: 'sendrecv' });
    this.attach(this.pc.createDataChannel('rtsai', { ordered: true }));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    return this.description();
  }
  async answer(offer: string) {
    if (this.closed || this.pc.signalingState !== 'stable' || this.pc.remoteDescription) throw Error('Create a new connection before joining again');
    await this.pc.setRemoteDescription(parsePeerCode(offer, 'offer'));
    for (const transceiver of this.pc.getTransceivers()) transceiver.direction = 'sendrecv';
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    return this.description();
  }
  async connect(answer: string) {
    if (this.closed || this.pc.signalingState !== 'have-local-offer') throw Error('This offer was already answered. Create a new connection.');
    await this.pc.setRemoteDescription(parsePeerCode(answer, 'answer'));
  }
  async camera() {
    const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    try {
      for (const track of media.getTracks()) {
        const transceiver = this.pc.getTransceivers().find(t => t.mid !== null && t.receiver.track.kind === track.kind);
        if (!transceiver) throw Error('Call channel is unavailable');
        await transceiver.sender.replaceTrack(track);
      }
      this.stopCamera(false);
      this.localMedia = media;
      return media;
    } catch (error) { media.getTracks().forEach(t => t.stop()); throw error; }
  }
  stopCamera(detach = true) {
    this.localMedia?.getTracks().forEach(t => t.stop());
    this.localMedia = null;
    if (detach) for (const t of this.pc.getTransceivers()) void t.sender.replaceTrack(null);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.stopCamera(); this.remoteMedia.getTracks().forEach(t => t.stop()); this.channel?.close(); this.pc.close();
  }
}
