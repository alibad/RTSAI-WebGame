// Page-side handle on the simulation worker: owns the SharedArrayBuffer ring, turns new slots into parsed
// snapshots (keeping the previous one for interpolation), forwards sprite/texture tables to the renderer, and
// offers request/reply calls (selection, commands) and typed message subscriptions for the rest.

import {
  RING_BYTES, RING_HEADER_BYTES, RING_GENERATION_AT, RING_LEN_AT, RING_SEQ_AT, RING_SLOT_BYTES, RING_SLOTS, parseSnapshot,
  type FromWorker, type Snapshot, type ToWorker,
} from "./protocol";
import type { AdviserCommand, AdviserObservation } from "../adviser";
import { decodeAdviserObservation, decodeAdviserReceipt, decodeAdviserStatus, encodeAdviserActions, encodeAdviserStatus } from "./adviser-rpc";
import { readVoiceLanguage, saveVoiceLanguage } from "../voice-language";
import type { Renderer } from "../render/renderer";
import { groupMembers, gunzipSheet, gzipSheet } from "./spritecache";
import { gameAssets } from "./save-versions";

type Handler<T extends FromWorker["type"]> = (m: Extract<FromWorker, { type: T }>) => void;

export class SimClient {
  readonly worker: Worker;
  readonly shared: boolean;
  private sab: SharedArrayBuffer | null = null;
  private header: Int32Array | null = null;
  private bytes: Uint8Array | null = null;
  private lastSeq = 0;
  private generation = 0;
  private active = false;
  private pending: { bytes: Uint8Array; seq: number }[] = [];
  /** Longest time a cached sprite sheet took to inflate and upload (ms). */
  sheetMs = 0;
  /** Prebaked sheets of the prepared map, by pack group; the factions the game will show (null: all). */
  private sheetList: { id: number; group: string }[] = [];
  private wanted: string[] | null = [];
  private gate: string[] | null = [];
  private requested = new Set<number>();
  /** Sheets that came from the sprite cache, still compressed: inflated again after a lost WebGL context. */
  private gzSheets = new Map<number, { width: number; height: number; gz: Blob }>();
  /**
   * Sheets the engine built (kind 0): once sent, the engine drops its copy (WebTexture.Sent), so their pixels would
   * only be on the GPU. A compressed copy is kept to rebuild them after a lost WebGL context: they are mostly empty
   * (a mission's 96 MB of them compress to about 5 MB). Compressed a moment after their last update.
   */
  private engineCopies = new Map<number, { width: number; height: number; version: number; data: ArrayBuffer | null; gz: Promise<Blob> | null; timer: ReturnType<typeof setTimeout> | null }>();
  /** A WebGL context restore in progress: engine sheets asked for again, and those the engine no longer had. */
  private restoring: { sizes: Map<number, { width: number; height: number; version: number }>; gone: number[] } | null = null;
  /** Sheets the game needs (shared + its factions) and how many of them are on the GPU. */
  onSheets: (uploaded: number, total: number) => void = () => {};
  private handlers = new Map<string, ((m: FromWorker) => void)[]>();
  private replies = new Map<number, (json: string) => void>();
  private nextReq = 1;
  private resyncing = false;
  private browserAdviser = false;
  private disposed = false;
  private lastAdviserTick = 0;
  private adviserReplies = new Map<number, { resolve: (data: Uint8Array) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
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

  private cancelReplies() {
    for (const reply of this.replies.values()) reply(JSON.stringify({ error: "World request cancelled" }));
    this.replies.clear();
    for (const pending of this.adviserReplies.values()) { clearTimeout(pending.timer); pending.reject(Error("Co-commander world request cancelled")); }
    this.adviserReplies.clear();
    this.lastAdviserTick = 0;
  }

  send(m: ToWorker) {
    if (this.disposed) return;
    if (m.type === "end") {
      this.generation++; this.active = false; this.pending = []; this.cancelReplies();
      // Nothing of the ended world stays drawable (or drawn behind the menus).
      this.cur = this.prev = null;
      this.renderer.clearWorld();
    }
    this.worker.postMessage({ ...m, generation: this.generation });
  }

  /** A command that answers with JSON (selection, control groups, production...). */
  request<T = Record<string, unknown>>(m: { type: "command"; json: string } | { type: "editorOpen"; json: string } | { type: "catalog" } | { type: "relief"; json: string } | { type: "editor"; json: string } | { type: "mountFiles"; dir: string; files: Record<string, ArrayBuffer> } | { type: "record"; map?: string } | { type: "select"; ids: number[]; additive: boolean } | { type: "voiceLanguage"; value?: string } | { type: "voicePreview" } | { type: "missionMap"; mission: string }): Promise<T> {
    const req = this.nextReq++;
    return new Promise((resolve) => {
      this.replies.set(req, (json) => resolve(JSON.parse(json) as T));
      this.send({ ...m, req } as ToWorker);
    });
  }

  command<T = Record<string, unknown>>(cmd: Record<string, unknown>) {
    return this.request<T>({ type: "command", json: JSON.stringify(cmd) });
  }

  /** Everything buildable and each faction's roster, from the rules (no world needed). */
  catalog<T = Record<string, unknown>>() {
    return this.request<T>({ type: "catalog" });
  }

  /** A real place's hills and valleys on an Earth map's files (Relief.cs, no world needed). */
  relief<T = Record<string, unknown>>(request: Record<string, unknown>) {
    return this.request<T>({ type: "relief", json: JSON.stringify(request) });
  }

  /** Opens the map editor's world (EditorHost.Open); the world arrives as a normal "started" message. */
  editorOpen<T = Record<string, unknown>>(spec: Record<string, unknown>) {
    // A new world, like start: nothing of the previous one stays drawable.
    this.generation++;
    this.active = false;
    this.cancelReplies();
    this.cur = this.prev = null;
    this.lastSeq = this.header ? Atomics.load(this.header, 0) : 0;
    this.strings = [];
    this.pending = [];
    this.renderer.resetSprites();
    return this.request<T>({ type: "editorOpen", json: JSON.stringify(spec) });
  }

  /** One map editor request (EditorHost.Call). */
  editor<T = Record<string, unknown>>(op: Record<string, unknown>) {
    return this.request<T>({ type: "editor", json: JSON.stringify(op) });
  }

  /** Files mounted in the engine's file system under `dir` (a map the player saved or uploaded). */
  mountFiles(dir: string, files: Record<string, ArrayBuffer>) {
    return this.request<{ ok?: boolean }>({ type: "mountFiles", dir, files });
  }

  voiceLanguage(value?: string) {
    return this.request<{ language?: string; syncHash?: number; tick?: number; error?: string }>({ type: "voiceLanguage", value: value === undefined ? undefined : saveVoiceLanguage(value) });
  }

  previewVoice() { return this.request({ type: "voicePreview" }); }

  /** A mission map's map.yaml ("" when it is not in the game files). */
  async missionMap(mission: string) { return (await this.request<{ text?: string }>({ type: "missionMap", mission })).text ?? ""; }

  private adviserRpc(method: "Observe" | "ExecuteCompanionActions" | "UpdateCompanionStatus", payload = new Uint8Array()): Promise<Uint8Array> {
    if (this.disposed || !this.active || !this.browserAdviser) return Promise.reject(Error("No active browser co-commander match"));
    const req = this.nextReq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.adviserReplies.delete(req); reject(Error("Co-commander engine request timed out")); }, 6000);
      this.adviserReplies.set(req, { resolve, reject, timer });
      this.send({ type: "adviserRpc", req, method, payload });
    });
  }

  async adviserObserve(): Promise<AdviserObservation> {
    const generation = this.generation;
    const observation = decodeAdviserObservation(await this.adviserRpc("Observe"));
    if (generation !== this.generation || this.disposed) throw Error("Co-commander observation belongs to an ended world");
    this.lastAdviserTick = observation.tick;
    return observation;
  }

  async adviserExecute(proposalId: string, commands: AdviserCommand[], expectedTick = this.lastAdviserTick) {
    const receipt = decodeAdviserReceipt(await this.adviserRpc("ExecuteCompanionActions", encodeAdviserActions(proposalId, expectedTick, commands)));
    if (receipt.requestId !== proposalId) throw Error("Co-commander engine receipt does not match the proposal");
    return receipt;
  }

  async adviserStatus(enabled: boolean, message?: string) {
    return decodeAdviserStatus(await this.adviserRpc("UpdateCompanionStatus", encodeAdviserStatus(enabled, message)));
  }

  dispose() {
    this.active = false;
    this.browserAdviser = false;
    this.disposed = true;
    this.cancelReplies();
    this.worker.terminate();
  }

  init(runtime: string, base: string, privateContent: boolean, gcParams?: string, profile?: string) {
    void gameAssets(profile ?? '', runtime).then(assets => {
      if (!this.disposed) this.send({ type: "init", runtime, base, sab: this.sab, privateContent, voiceLanguage: readVoiceLanguage(), gcParams, profile, ...assets });
    }).catch(error => this.emit({ type: "error", message: String(error instanceof Error ? error.message : error) }));
  }

  start(scenario: string, paused = false, companion: boolean | "browser" = false) {
    if (this.disposed) throw Error("The simulation client is disposed");
    this.browserAdviser = companion === "browser";
    this.generation++;
    this.active = false;
    this.cancelReplies();
    this.cur = this.prev = null;
    this.lastSeq = this.header ? Atomics.load(this.header, 0) : 0;
    this.strings = [];
    this.pending = [];
    this.renderer.resetSprites();
    this.send({ type: "start", scenario, paused, companion, voiceLanguage: readVoiceLanguage() });
  }

  /** The factions the game will show (null: not known, e.g. a random faction): their sheets are fetched now. */
  /**
   * `groups`: the factions to fetch now (null: all). `gate`: those the game waits for (the local player's: the others
   * are out of sight when a game starts and arrive moments later); null: all of `groups`.
   */
  wantGroups(groups: string[] | null, gate: string[] | null = groups) {
    this.wanted = groups;
    this.gate = gate;
    this.send({ type: "sheetGroups", groups, first: gate ?? undefined });
    this.sheetProgress();
  }

  /** A sprite whose sheet is missing was drawn (a faction outside the wanted ones): fetch that sheet. */
  needSheet(id: number) {
    if (this.requested.has(id) || !this.sheetList.some((s) => s.id === id)) return;
    this.requested.add(id);
    this.send({ type: "needSheets", ids: [id] });
  }

  /**
   * After a lost WebGL context: the sheets that were on the GPU, again. Shipped sheets come from the worker, cached ones
   * are inflated again here, engine sheets come from the engine where it still has their pixels. Resolves with the
   * sheets that could not be had again (the battlefield cannot be drawn completely without them).
   */
  async restoreSheets(lost: { shipped: number[]; engine: { id: number; width: number; height: number; version: number }[] }, timeoutMs = 30000): Promise<number[]> {
    const gone: number[] = [];
    const ask = lost.engine.filter((t) => !this.gzSheets.has(t.id) && !this.engineCopies.has(t.id));
    this.restoring = { sizes: new Map(ask.map((t) => [t.id, t])), gone };
    for (const t of lost.engine) {
      const cached = this.gzSheets.get(t.id);
      const copy = this.engineCopies.get(t.id);
      const pixels = copy?.data ? Promise.resolve(new Uint8Array(copy.data)) : copy?.gz ? copy.gz.then(gunzipSheet) : cached ? gunzipSheet(cached.gz) : null;
      const size = copy ?? cached;
      if (pixels && size) void pixels.then((data) => this.renderer.uploadTexture(t.id, copy?.version ?? t.version, size.width, size.height, 0, data.buffer as ArrayBuffer), () => gone.push(t.id));
    }
    if (ask.length) this.send({ type: "resendTextures", ids: ask.map((t) => t.id) });
    if (lost.shipped.length) this.send({ type: "resendSheets", ids: lost.shipped });
    const all = [...lost.shipped, ...lost.engine.map((t) => t.id)];
    const end = performance.now() + timeoutMs;
    try {
      for (;;) {
        const missing = this.renderer.missingSheets(all).filter((id) => !gone.includes(id));
        if (!missing.length) return gone;
        if (performance.now() > end) return [...gone, ...missing];
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      this.restoring = null;
      this.sheetProgress();
    }
  }

  private keepEngineCopy(id: number, version: number, width: number, height: number, data: ArrayBuffer) {
    const old = this.engineCopies.get(id);
    if (old?.timer) clearTimeout(old.timer);
    const entry = { width, height, version, data: data as ArrayBuffer | null, gz: null as Promise<Blob> | null, timer: null as ReturnType<typeof setTimeout> | null };
    entry.timer = setTimeout(() => {
      entry.timer = null;
      const raw = entry.data;
      if (!raw) return;
      entry.gz = gzipSheet(new Uint8Array(raw));
      entry.gz.then(() => { if (this.engineCopies.get(id) === entry) entry.data = null; }, () => { /* keep the raw copy */ });
    }, 1000);
    this.engineCopies.set(id, entry);
  }

  private sheetProgress() {
    // What a game waits for: shared sheets and its factions' (effects load meanwhile, never waited for).
    const gate = this.gate === null ? this.wanted : this.gate;
    // A group of several factions ("america+england+...") is waited for when any of them is.
    const wanted = this.sheetList.filter((s) => s.group !== "fx" && (s.group === "" || gate === null || groupMembers(s.group).some((g) => gate.includes(g))));
    this.onSheets(wanted.filter((s) => this.renderer.hasTexture(s.id)).length, wanted.length);
  }

  private handle(m: FromWorker) {
    const asset = m.type === "sheetList" || m.type === "texturebin" || m.type === "texturegz" || m.type === "texturefree" || m.type === "textureData";
    if (!asset && m.generation !== undefined && m.generation !== this.generation) return;
    switch (m.type) {
      case "started":
        this.active = true;
        this.renderer.setStartInfo(m.info, m.terrain);
        break;
      case "texture":
        this.renderer.uploadTexture(m.id, m.version, m.width, m.height, m.kind, m.data);
        if (m.kind === 0 && m.data.byteLength) this.keepEngineCopy(m.id, m.version, m.width, m.height, m.data);
        return;
      case "texturefree": {
        const copy = this.engineCopies.get(m.id);
        if (copy?.timer) clearTimeout(copy.timer);
        this.engineCopies.delete(m.id);
        this.gzSheets.delete(m.id);
        this.renderer.freeTexture(m.id);
        return;
      }
      case "textureData": {
        const size = this.restoring?.sizes.get(m.id);
        if (!size) return;
        if (m.data.byteLength >= size.width * size.height * 4) this.renderer.uploadTexture(m.id, size.version, size.width, size.height, 0, m.data);
        else this.restoring!.gone.push(m.id);
        return;
      }
      case "sheetList":
        this.sheetList = m.sheets;
        this.requested.clear();
        this.sheetProgress();
        return;
      case "texturebin": {
        const src = new Uint8Array(m.data);
        let rgba = src;
        if (m.planar) {
          // Plane after plane -> interleaved RGBA.
          const px = m.width * m.rows;
          rgba = new Uint8Array(px * 4);
          const r = src.subarray(0, px), g = src.subarray(px, 2 * px), b = src.subarray(2 * px, 3 * px), a = src.subarray(3 * px, 4 * px);
          for (let p = 0, o = 0; p < px; p++, o += 4) { rgba[o] = r[p]; rgba[o + 1] = g[p]; rgba[o + 2] = b[p]; rgba[o + 3] = a[p]; }
        }
        this.renderer.uploadSheetRows(m.id, m.width, m.height, m.rows, rgba);
        this.sheetProgress();
        return;
      }
      case "texturegz": {
        this.gzSheets.set(m.id, { width: m.width, height: m.height, gz: m.gz });
        const t0 = performance.now();
        gunzipSheet(m.gz).then((data) => {
          this.renderer.uploadTexture(m.id, 1, m.width, m.height, 0, data.buffer as ArrayBuffer);
          this.sheetMs = Math.max(this.sheetMs, performance.now() - t0);
          this.sheetProgress();
        }).catch((e) => console.warn("sprite cache: sheet inflate failed", e));
        return;
      }
      case "modelbuffer":
        this.renderer.setModelBuffer(m.id, m.data);
        return;
      case "snapshot":
        this.pending.push({ bytes: new Uint8Array(m.bytes), seq: m.seq });
        return;
      case "adviserReply": {
        const pending = this.adviserReplies.get(m.req);
        if (!pending) return;
        this.adviserReplies.delete(m.req); clearTimeout(pending.timer);
        if (m.code) pending.reject(Error(m.message || `Co-commander engine error ${m.code}`));
        else pending.resolve(m.payload);
        return;
      }
      case "error": this.cancelReplies(); break;
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
    if (!this.active) return;
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
        if (Atomics.load(this.header, RING_GENERATION_AT + slot) !== this.generation) { this.lastSeq = seq; continue; }
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
        if (Atomics.load(this.header, RING_SEQ_AT + slot) !== seq || Atomics.load(this.header, RING_GENERATION_AT + slot) !== this.generation) {
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
