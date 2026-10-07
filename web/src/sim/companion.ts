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

export interface CompanionEngine {
  /** Starts the call; the engine replies through reply(id, ...) (JSImport companionReply). */
  call(id: number, method: string, request: Uint8Array): void;
}

export class CompanionRelay {
  private ws: WebSocket | null = null;
  private wanted = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private calls = new Map<number, number>(); // engine call id -> relay request id
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

  close() {
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
