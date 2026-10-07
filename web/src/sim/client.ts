// Page-side handle on the simulation worker: owns the SharedArrayBuffer ring, turns new slots into parsed
// snapshots (keeping the previous one for interpolation) and forwards sprite/texture tables to the renderer.

import {
  RING_BYTES, RING_HEADER_BYTES, RING_SLOT_BYTES, RING_SLOTS, parseSnapshot,
  type FromWorker, type Snapshot, type StartInfo, type ToWorker,
} from "./protocol";
import type { Renderer } from "../render/renderer";

export interface ClientEvents {
  onProgress(stage: string, detail?: string): void;
  onReady(m: Extract<FromWorker, { type: "ready" }>): void;
  onStarted(info: StartInfo, startMs: number): void;
  onSnapshot(s: Snapshot): void;
  onCursor(cursor: string): void;
  onOrdered(m: Extract<FromWorker, { type: "ordered" }>): void;
  onStats(m: Extract<FromWorker, { type: "stats" }>): void;
  onBench(m: Extract<FromWorker, { type: "bench" }>): void;
  onLog(json: string): void;
  onError(message: string): void;
}

export class SimClient {
  readonly worker: Worker;
  readonly shared: boolean;
  private sab: SharedArrayBuffer | null = null;
  private header: Int32Array | null = null;
  private bytes: Uint8Array | null = null;
  private lastSeq = 0;
  private pending: { bytes: Uint8Array; seq: number }[] = [];
  cur: Snapshot | null = null;
  prev: Snapshot | null = null;
  strings: string[] = [];
  missedSnapshots = 0;

  constructor(private renderer: Renderer, private ev: ClientEvents) {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.shared = typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated === true;
    if (this.shared) {
      this.sab = new SharedArrayBuffer(RING_BYTES);
      this.header = new Int32Array(this.sab, 0, RING_HEADER_BYTES / 4);
      this.bytes = new Uint8Array(this.sab);
    }
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.handle(e.data);
    this.worker.onerror = (e) => ev.onError(e.message || "worker error");
  }

  send(m: ToWorker) {
    this.worker.postMessage(m);
  }

  init(runtime: string, privateContent: boolean) {
    this.send({ type: "init", runtime, sab: this.sab, privateContent });
  }

  start(scenario: string) {
    this.cur = this.prev = null;
    this.lastSeq = 0;
    this.strings = [];
    this.send({ type: "start", scenario });
  }

  private handle(m: FromWorker) {
    switch (m.type) {
      case "progress": this.ev.onProgress(m.stage, m.detail); break;
      case "ready": this.ev.onReady(m); break;
      case "started":
        this.renderer.setStartInfo(m.info, m.terrain);
        this.ev.onStarted(m.info, m.startMs);
        break;
      case "texture": this.renderer.uploadTexture(m.id, m.version, m.width, m.height, m.kind, m.data); break;
      case "snapshot": this.pending.push({ bytes: new Uint8Array(m.bytes), seq: m.seq }); break;
      case "cursor": this.ev.onCursor(m.cursor); break;
      case "ordered": this.ev.onOrdered(m); break;
      case "stats": this.ev.onStats(m); break;
      case "bench": this.ev.onBench(m); break;
      case "log": this.ev.onLog(m.json); break;
      case "error": this.ev.onError(m.message); break;
    }
  }

  private resyncing = false;

  private accept(bytes: Uint8Array, now: number) {
    const s = parseSnapshot(bytes, now);
    if (s.resync) {
      this.strings = [];
      this.renderer.resetSprites();
      this.resyncing = false;
    } else if (this.resyncing) return; // incremental tables are stale until the resync snapshot arrives
    for (const str of s.strings) this.strings.push(str);
    this.renderer.addSprites(s.sprites);
    this.prev = this.cur;
    this.cur = s;
    this.ev.onSnapshot(s);
  }

  /** Called once per animation frame: picks up every snapshot published since the last frame, in order. */
  poll(now: number) {
    if (this.header && this.bytes) {
      const latest = Atomics.load(this.header, 0);
      if (latest > this.lastSeq + RING_SLOTS - 1) {
        // Fell behind the ring (e.g. the tab was hidden): sprite/string tables are incremental, so ask the
        // worker to resend them and drop snapshots until the resync one arrives.
        this.missedSnapshots += latest - this.lastSeq;
        this.lastSeq = latest;
        if (!this.resyncing) {
          this.resyncing = true;
          this.send({ type: "resync" });
        }
        return;
      }
      while (this.lastSeq < latest) {
        const seq = this.lastSeq + 1;
        const slot = seq % RING_SLOTS;
        const len = Atomics.load(this.header, 1 + slot);
        const off = RING_HEADER_BYTES + slot * RING_SLOT_BYTES;
        const copy = this.bytes.slice(off, off + len);
        this.lastSeq = seq;
        if (Atomics.load(this.header, 4 + slot) !== seq) {
          // Overwritten while copying: resync rather than apply a torn snapshot.
          this.missedSnapshots++;
          if (!this.resyncing) {
            this.resyncing = true;
            this.send({ type: "resync" });
          }
          continue;
        }
        this.accept(copy, now);
      }
    } else {
      for (const p of this.pending) this.accept(p.bytes, now);
      this.pending = [];
    }
  }

  str(id: number) {
    return id >= 0 ? this.strings[id] ?? "" : "";
  }
}
