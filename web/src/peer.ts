/** Direct two-player transport. Signaling is copied between friends; no room service is used. */
export type PeerEvent = { kind: 'orders'; frame: number; data: string } | { kind: 'hash'; frame: number; hash: number; defeat: string };
export type PeerFrame = { frame: number; packets: { client: number; data: string }[] };

export class PeerLockstep {
  frame = 0;
  private orders = new Map<number, Map<number, string>>();
  private hashes = new Map<number, Map<number, string>>();
  constructor(private completed: (frame: PeerFrame) => void) {}
  receive(client: number, events: PeerEvent[]) {
    if (![1, 2].includes(client) || !Array.isArray(events) || events.length > 16) throw Error('Invalid peer packet');
    for (const e of events) {
      if (!Number.isInteger(e.frame) || e.frame < 1 || e.frame > this.frame + 2) throw Error('Invalid peer frame');
      if (e.kind === 'orders') {
        if (e.frame <= this.frame) continue;
        if (typeof e.data !== 'string' || e.data.length > 131072 || !/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.data)) throw Error('Invalid peer orders');
        let packets = this.orders.get(e.frame);
        if (!packets) this.orders.set(e.frame, packets = new Map());
        if (packets.has(client) && packets.get(client) !== e.data) throw Error('Conflicting peer orders');
        packets.set(client, e.data);
      } else if (e.kind === 'hash') {
        if (!Number.isInteger(e.hash) || e.hash < -2147483648 || e.hash > 2147483647 || typeof e.defeat !== 'string' || !/^\d{1,20}$/.test(e.defeat)) throw Error('Invalid peer synchronization report');
        let hashes = this.hashes.get(e.frame);
        if (!hashes) this.hashes.set(e.frame, hashes = new Map());
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
  constructor(iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]) {
    this.pc = new RTCPeerConnection({ iceServers });
    this.pc.ontrack = e => { if (!this.remoteMedia.getTrackById(e.track.id)) this.remoteMedia.addTrack(e.track); };
    this.pc.onconnectionstatechange = () => this.onState(this.pc.connectionState);
    this.pc.ondatachannel = e => this.attach(e.channel);
  }
  private attach(channel: RTCDataChannel) {
    this.channel = channel;
    channel.onopen = () => this.onState('connected');
    channel.onclose = () => this.onState('closed');
    channel.onerror = () => this.onState('failed');
    channel.onmessage = e => {
      try {
        if (typeof e.data !== 'string' || e.data.length > 150000) throw Error('Invalid peer message');
        const value = JSON.parse(e.data);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid peer message');
        this.onMessage(value);
      } catch (error) { this.onState(String(error instanceof Error ? error.message : error)); }
    };
  }
  send(message: object) {
    if (this.channel?.readyState !== 'open') throw Error('Peer disconnected. Match paused.');
    if (this.channel.bufferedAmount > 1048576) throw Error('Peer connection is congested. Match paused.');
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
    this.pc.addTransceiver('audio', { direction: 'sendrecv' });
    this.pc.addTransceiver('video', { direction: 'sendrecv' });
    this.attach(this.pc.createDataChannel('rtsai', { ordered: true }));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    return this.description();
  }
  private parse(code: string, type: 'offer' | 'answer') {
    if (code.length > 128000) throw Error('Connection code is too large');
    let value: RTCSessionDescriptionInit;
    try { value = JSON.parse(atob(code.trim())); } catch { throw Error('Invalid connection code'); }
    if (value.type !== type || typeof value.sdp !== 'string') throw Error(`Paste the friend's ${type} code`);
    return value;
  }
  async answer(offer: string) {
    await this.pc.setRemoteDescription(this.parse(offer, 'offer'));
    for (const transceiver of this.pc.getTransceivers()) transceiver.direction = 'sendrecv';
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    return this.description();
  }
  async connect(answer: string) { await this.pc.setRemoteDescription(this.parse(answer, 'answer')); }
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
  close() { this.stopCamera(); this.channel?.close(); this.pc.close(); }
}
