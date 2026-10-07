// Worker side of the AI co-commander relay (server/companion.mjs): the local companion's gRPC calls arrive over a
// WebSocket as raw protobuf requests; the engine's CompanionBridge answers them (OpenRA.WebSim.CompanionRpc) and the
// reply goes back the same way. Frames: u32 LE header length, JSON header, protobuf payload.

const enc = new TextEncoder();
const dec = new TextDecoder();

function frame(header: object, payload: Uint8Array = new Uint8Array(0)) {
  const h = enc.encode(JSON.stringify(header));
  const out = new Uint8Array(4 + h.length + payload.length);
  new DataView(out.buffer).setUint32(0, h.length, true);
  out.set(h, 4);
  out.set(payload, 4 + h.length);
  return out;
}

/**
 * Splits one top-level length-delimited field out of a serialized protobuf message: the message without it, and the
 * field's bytes (null when absent). Used to send the observation's large spatial map apart from the rest.
 */
export function splitField(buf: Uint8Array, field: number): { rest: Uint8Array; value: Uint8Array | null } {
  const keep: [number, number][] = [];
  let value: Uint8Array | null = null;
  let p = 0;
  const varint = () => { let v = 0, s = 1, b: number; do { b = buf[p++]; v += (b & 0x7f) * s; s *= 128; } while (b & 0x80); return v; };
  while (p < buf.length) {
    const start = p;
    const tag = varint();
    const wire = tag % 8, num = Math.floor(tag / 8);
    if (wire === 0) varint();
    else if (wire === 1) p += 8;
    else if (wire === 5) p += 4;
    else if (wire === 2) { const len = varint(); if (num === field) value = buf.subarray(p, p + len); p += len; }
    else throw new Error(`protobuf wire type ${wire}`);
    if (num !== field) keep.push([start, p]);
  }
  const rest = new Uint8Array(keep.reduce((n, [a, b]) => n + b - a, 0));
  let o = 0;
  for (const [a, b] of keep) { rest.set(buf.subarray(a, b), o); o += b - a; }
  return { rest, value };
}

/** A top-level varint field's value (the first occurrence), or -1. */
function varintField(buf: Uint8Array, field: number) {
  let p = 0;
  const varint = () => { let v = 0, s = 1, b: number; do { b = buf[p++]; v += (b & 0x7f) * s; s *= 128; } while (b & 0x80); return v; };
  while (p < buf.length) {
    const tag = varint();
    const wire = tag % 8, num = Math.floor(tag / 8);
    if (wire === 0) { const v = varint(); if (num === field) return v; }
    else if (wire === 1) p += 8;
    else if (wire === 5) p += 4;
    else if (wire === 2) p += varint();
    else return -1;
  }
  return -1;
}

async function deflate(data: Uint8Array) {
  return new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
}

/** GameObservation field 10: the spatial map (float32 per cell and channel), most of an observation's bytes. */
const SPATIAL_FIELD = 10;

export interface CompanionEngine {
  /** Starts the call; the engine replies through reply(id, ...) (JSImport companionReply). */
  call(id: number, method: string, request: Uint8Array): void;
}

export class CompanionRelay {
  private ws: WebSocket | null = null;
  private wanted = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private calls = new Map<number, number>(); // engine call id -> relay request id
  private observer: ReturnType<typeof setInterval> | null = null;
  private lastSpatial: Uint8Array | null = null;
  private lastTick = -1;
  private sending = false;
  /** Observation stream: bytes sent vs the full observations they stand for. */
  readonly obsStats = { sent: 0, full: 0, frames: 0 };
  private nextCall = 1;
  readonly stats = { calls: 0, errors: 0, connected: false };

  constructor(private url: string, private engine: CompanionEngine, private onState: (connected: boolean) => void) {}

  connect() {
    this.wanted = true;
    if (this.ws) return;
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => { this.stats.connected = true; this.onState(true); };
    ws.onmessage = (e) => this.message(new Uint8Array(e.data as ArrayBuffer));
    ws.onclose = () => {
      this.ws = null;
      if (this.stats.connected) this.onState(false);
      this.stats.connected = false;
      if (this.wanted) this.retry = setTimeout(() => { this.retry = null; this.connect(); }, 1000);
    };
    ws.onerror = () => ws.close();
    this.ws = ws;
  }

  /**
   * Pushes observations as the game produces them (instead of the companion polling over the link): the spatial map
   * goes as a compressed XOR against the previous one (mostly unchanged), the rest compressed. The relay rebuilds the
   * full message, so the companion sees exactly what Observe returns. Built for the hosted link, where the full
   * observation (about 400 KB, twice a second) would not fit.
   */
  streamObservations(read: () => Uint8Array, intervalMs = 500) {
    if (this.observer) return;
    this.observer = setInterval(() => { void this.pushObservation(read); }, intervalMs);
  }

  private async pushObservation(read: () => Uint8Array) {
    if (this.sending || this.ws?.readyState !== WebSocket.OPEN) return;
    const full = read();
    if (!full.length) return;
    const { rest, value } = splitField(full, SPATIAL_FIELD);
    const tick = varintField(full, 1); // GameObservation.tick
    if (tick >= 0 && tick === this.lastTick) return;
    this.sending = true;
    try {
      const spatial = value ?? new Uint8Array(0);
      let kind = 0; // 0 full, 1 xor against the previous
      let body = spatial;
      if (this.lastSpatial && this.lastSpatial.length === spatial.length) {
        const x = new Uint8Array(spatial.length);
        for (let i = 0; i < spatial.length; i++) x[i] = spatial[i] ^ this.lastSpatial[i];
        body = x;
        kind = 1;
      }
      const [lite, sp] = await Promise.all([deflate(rest), deflate(body)]);
      const payload = new Uint8Array(4 + lite.length + 1 + sp.length);
      new DataView(payload.buffer).setUint32(0, lite.length, true);
      payload.set(lite, 4);
      payload[4 + lite.length] = kind;
      payload.set(sp, 5 + lite.length);
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.send(frame({ t: "obs" }, payload));
      this.lastSpatial = spatial.slice();
      this.lastTick = tick;
      this.obsStats.sent += payload.length;
      this.obsStats.full += full.length;
      this.obsStats.frames++;
    } finally {
      this.sending = false;
    }
  }

  close() {
    if (this.observer) clearInterval(this.observer);
    this.observer = null;
    this.lastSpatial = null;
    this.wanted = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.ws?.close();
    this.ws = null;
    this.calls.clear();
  }

  private message(buf: Uint8Array) {
    const n = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
    const header = JSON.parse(dec.decode(buf.subarray(4, 4 + n))) as { t: string; id: number; method: string };
    if (header.t !== "call") return;
    this.stats.calls++;
    const call = this.nextCall++;
    this.calls.set(call, header.id);
    try {
      this.engine.call(call, header.method, buf.slice(4 + n));
    } catch (e) {
      this.reply(call, 13, String(e), new Uint8Array(0));
    }
  }

  /** The engine's answer (JSImport companionReply). */
  reply(call: number, code: number, message: string, payload: Uint8Array) {
    const id = this.calls.get(call);
    if (id === undefined) return;
    this.calls.delete(call);
    if (code !== 0) this.stats.errors++;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame({ t: "reply", id, code, message }, payload));
  }
}
