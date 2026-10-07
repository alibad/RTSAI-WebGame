// Page-side handle on the simulation worker: owns the SharedArrayBuffer ring, turns new slots into parsed
// snapshots (keeping the previous one for interpolation), forwards sprite/texture tables to the renderer, and
// offers request/reply calls (selection, commands) and typed message subscriptions for the rest.

import {
  RING_BYTES, RING_HEADER_BYTES, RING_LEN_AT, RING_SEQ_AT, RING_SLOT_BYTES, RING_SLOTS, parseSnapshot,
  type FromWorker, type Snapshot, type ToWorker,
} from "./protocol";
import type { Renderer } from "../render/renderer";
import { gunzipSheet } from "./spritecache";

type Handler<T extends FromWorker["type"]> = (m: Extract<FromWorker, { type: T }>) => void;

export class SimClient {
  readonly worker: Worker;
  readonly shared: boolean;
  private sab: SharedArrayBuffer | null = null;
  private header: Int32Array | null = null;
  private bytes: Uint8Array | null = null;
  private lastSeq = 0;
  private pending: { bytes: Uint8Array; seq: number }[] = [];
  /** Longest time a cached sprite sheet took to inflate and upload (ms). */
  sheetMs = 0;
  private handlers = new Map<string, ((m: FromWorker) => void)[]>();
  private replies = new Map<number, (json: string) => void>();
  private nextReq = 1;
  private resyncing = false;
  cur: Snapshot | null = null;
  prev: Snapshot | null = null;
  strings: string[] = [];
  missedSnapshots = 0;
  onSnapshot: ((s: Snapshot) => void) | null = null;

  constructor(private renderer: Renderer) {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.shared = typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated === true;
    if (this.shared) {
      this.sab = new SharedArrayBuffer(RING_BYTES);
      this.header = new Int32Array(this.sab, 0, RING_HEADER_BYTES / 4);
      this.bytes = new Uint8Array(this.sab);
    }
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.handle(e.data);
    this.worker.onerror = (e) => this.emit({ type: "error", message: e.message || "worker error" });
  }

  on<T extends FromWorker["type"]>(type: T, h: Handler<T>) {
    const list = this.handlers.get(type) ?? [];
    list.push(h as (m: FromWorker) => void);
    this.handlers.set(type, list);
  }

  private emit(m: FromWorker) {
    for (const h of this.handlers.get(m.type) ?? []) h(m);
  }

  send(m: ToWorker) {
    this.worker.postMessage(m);
  }

  /** A command that answers with JSON (selection, control groups, production...). */
  request<T = Record<string, unknown>>(m: { type: "command"; json: string } | { type: "select"; ids: number[]; additive: boolean }): Promise<T> {
    const req = this.nextReq++;
    return new Promise((resolve) => {
      this.replies.set(req, (json) => resolve(JSON.parse(json) as T));
      this.send({ ...m, req } as ToWorker);
    });
  }

  command<T = Record<string, unknown>>(cmd: Record<string, unknown>) {
    return this.request<T>({ type: "command", json: JSON.stringify(cmd) });
  }

  init(runtime: string, base: string, privateContent: boolean, gcParams?: string, profile?: string) {
    this.send({ type: "init", runtime, base, sab: this.sab, privateContent, gcParams, profile });
  }

  start(scenario: string, paused = false) {
    this.cur = this.prev = null;
    this.lastSeq = this.header ? Atomics.load(this.header, 0) : 0;
    this.strings = [];
    this.pending = [];
    this.renderer.resetSprites();
    this.send({ type: "start", scenario, paused });
  }

  private handle(m: FromWorker) {
    switch (m.type) {
      case "started":
        this.renderer.setStartInfo(m.info, m.terrain);
        break;
      case "texture":
        this.renderer.uploadTexture(m.id, m.version, m.width, m.height, m.kind, m.data);
        return;
      case "texturefree":
        this.renderer.freeTexture(m.id);
        return;
      case "texturegz": {
        const t0 = performance.now();
        gunzipSheet(m.gz).then((data) => {
          this.renderer.uploadTexture(m.id, 1, m.width, m.height, 0, data.buffer as ArrayBuffer);
          this.sheetMs = Math.max(this.sheetMs, performance.now() - t0);
        }).catch((e) => console.warn("sprite cache: sheet inflate failed", e));
        return;
      }
      case "modelbuffer":
        this.renderer.setModelBuffer(m.id, m.data);
        return;
      case "snapshot":
        this.pending.push({ bytes: new Uint8Array(m.bytes), seq: m.seq });
        return;
      case "reply": {
        const r = this.replies.get(m.req);
        this.replies.delete(m.req);
        r?.(m.json);
        return;
      }
    }
    this.emit(m);
  }

  private accept(bytes: Uint8Array, now: number) {
    const s = parseSnapshot(bytes, now);
    if (s.resync) {
      this.strings = [];
      this.renderer.resetSprites();
      this.resyncing = false;
    } else if (this.resyncing) return; // incremental tables are stale until the resync snapshot arrives
    for (const str of s.strings) this.strings.push(str);
    this.renderer.addSprites(s.sprites);
    this.renderer.runModels(s);
    this.prev = this.cur;
    this.cur = s;
    this.onSnapshot?.(s);
  }

  private requestResync() {
    if (this.resyncing) return;
    this.resyncing = true;
    this.send({ type: "resync" });
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
        this.requestResync();
        return;
      }
      while (this.lastSeq < latest) {
        const seq = this.lastSeq + 1;
        const slot = seq % RING_SLOTS;
        if (Atomics.load(this.header, RING_SEQ_AT + slot) === 0) {
          // Sent by postMessage (too big for a slot): apply it in order once the message has arrived.
          const i = this.pending.findIndex((p) => p.seq === seq);
          if (i < 0) break;
          this.lastSeq = seq;
          this.accept(this.pending.splice(i, 1)[0].bytes, now);
          continue;
        }
        const len = Atomics.load(this.header, RING_LEN_AT + slot);
        const off = RING_HEADER_BYTES + slot * RING_SLOT_BYTES;
        const copy = this.bytes.slice(off, off + len);
        this.lastSeq = seq;
        if (Atomics.load(this.header, RING_SEQ_AT + slot) !== seq) {
          // Overwritten while copying: resync rather than apply a torn snapshot.
          this.missedSnapshots++;
          this.requestResync();
          continue;
        }
        this.accept(copy, now);
      }
      if (this.pending.length) this.pending = this.pending.filter((p) => p.seq > this.lastSeq);
    } else {
      for (const p of this.pending) this.accept(p.bytes, now);
      this.pending = [];
    }
  }

  str(id: number) {
    return id >= 0 ? this.strings[id] ?? "" : "";
  }
}
