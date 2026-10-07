// Game controller: owns the canvas, renderer and worker client; turns mouse/keyboard input into engine
// commands (selection, orders, modes, control groups); feeds the store the HUD renders from. The engine is the
// source of truth for selection, order modes and production; the page only predicts what it draws this frame.

import { Renderer, type Camera, type Overlay } from "./render/renderer";
import { SimClient } from "./sim/client";
import type { Actor, Snapshot, StartInfo, UiState } from "./sim/protocol";
import type { IconSprite } from "./render/icons";
import { store, type Perf } from "./store";
import { cursorFor } from "./ui/cursors";
import { AudioEngine } from "./audio";
import { Sandbox, worldToCell } from "./sandbox";

// OpenRA enums
const MOD_SHIFT = 1, MOD_ALT = 2, MOD_CTRL = 4, MOD_META = 8;
const BTN_LEFT = 1, BTN_RIGHT = 2;
const EDGE_PX = 6;

/** Minimap data: terrain image, blips and shroud, with a version so the canvas redraws only on change. */
export class RadarModel {
  terrain: ImageData | null = null;
  width = 0; // radar px (2W + 1)
  height = 0;
  blips = new Int32Array(0);
  shroud: Uint8Array | null = null;
  cols = 0;
  version = 0;
  private listeners = new Set<() => void>();
  subscribe(f: () => void) { this.listeners.add(f); return () => { this.listeners.delete(f); }; }
  bump() { this.version++; for (const f of this.listeners) f(); }
}

export class Game {
  readonly renderer: Renderer;
  readonly client: SimClient;
  readonly radar = new RadarModel();
  readonly audio = new AudioEngine();
  private lastListener = 0;
  cam: Camera = { x: 0, y: 0, zoom: 1 };
  overlay: Overlay = { selected: new Set(), hover: null, dragBox: null, orderFlash: null, ownPlayer: -1 };
  info: StartInfo | null = null;
  ui: UiState | null = null;
  scenarioJson = "";
  sandbox: Sandbox | null = null;
  private raf = 0;
  private mouse = { x: 0, y: 0, wx: 0, wy: 0, inside: false, sx: 0, sy: 0 };
  private drag: { x0: number; y0: number; active: boolean; pan: boolean; cx: number; cy: number } | null = null;
  private keys = new Set<string>();
  private cursorSeq = 0;
  private lastCursorKey = "";
  private lastView = "";
  private frames = 0;
  private fpsT = 0;
  private lastFrame = 0;
  private lastClick = { t: 0, id: -1 };
  private lastGroupTap = { t: 0, index: -1 };
  private iconRequested = new Set<string>();
  private iconQueue = new Map<string, IconSprite>();
  private pendingLatency: { t0: number; tick: number; snapAt?: number } | null = null;
  private tickArrival = new Map<number, number>();
  private latency: number[] = [];
  private onKeyDown = (e: KeyboardEvent) => this.keyDown(e);
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase());
  private onBlur = () => this.keys.clear();
  private onMove = (e: MouseEvent) => this.mouseMove(e);
  private onUp = (e: MouseEvent) => this.mouseUp(e);

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.client = new SimClient(this.renderer);
    store.set({ shared: this.client.shared });
    this.client.onSnapshot = (s) => this.onSnapshot(s);
    this.wire();
    this.bind();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ---------------------------------------------------------------- worker events

  private wire() {
    const c = this.client;
    c.on("progress", (m) => store.set({ stage: m.stage, detail: m.detail ?? "" }));
    c.on("error", (m) => store.set({ phase: "error", error: m.message }));
    c.on("ready", (m) => {
      store.set({ phase: "setup", setup: m.setup, privateContent: m.privateContent, timings: { ...m.timings, "runtime.start": m.runtimeMs }, downloads: m.downloadBytes });
    });
    c.on("prepared", (m) => {
      const s = store.get();
      store.set({ preparedMap: m.map, preparing: s.preparing === m.map ? null : s.preparing, timings: { ...s.timings, ...m.timings, "prepare.total": m.ms }, lazy: m.lazy ?? s.lazy });
    });
    c.on("preview", (m) => {
      const url = m.png.byteLength ? URL.createObjectURL(new Blob([m.png], { type: "image/png" })) : "";
      store.set({ previews: { ...store.get().previews, [m.map]: url } });
    });
    c.on("started", (m) => this.started(m.info, m.radarTerrain, m.startMs));
    c.on("ui", (m) => this.onUi(JSON.parse(m.json) as UiState));
    c.on("shroud", (m) => {
      const cells = new Uint8Array(m.cells);
      if (this.info) this.renderer.setShroud(cells, this.info.mapSize[0], this.info.mapSize[1]);
      this.radar.shroud = cells;
      this.radar.bump();
    });
    c.on("radar", (m) => { this.radar.blips = new Int32Array(m.blips); this.radar.bump(); });
    c.on("icon", (m) => {
      if (m.info) this.iconQueue.set(m.name, JSON.parse(m.info) as IconSprite);
      else store.set({ icons: { ...store.get().icons, [m.name]: null } });
    });
    c.on("cursor", (m) => {
      if (m.seq !== this.cursorSeq) return;
      this.canvas.style.cursor = cursorFor(m.cursor);
      if (m.cursor !== store.get().cursor) store.set({ cursor: m.cursor });
    });
    c.on("ordered", (m) => {
      const pl = this.pendingLatency;
      if (pl && pl.t0 === m.t) {
        pl.tick = m.tick + 1;
        for (const [tick, at] of this.tickArrival) if (tick >= pl.tick && !pl.snapAt) pl.snapAt = at;
      }
    });
    c.on("stats", (m) => {
      const s = JSON.parse(m.json);
      this.perf({ simTickMs: m.tickMs, tps: m.ticksPerSecond, lateTicks: m.lateTicks, heapMB: m.heapBytes / 1048576, managedMB: s.managedMB });
      if (m.lazy) store.set({ lazy: m.lazy });
    });
    c.on("audio", (m) => {
      const a = this.audio;
      switch (m.op) {
        case "source": a.source(m.id, m.channels, m.bits, m.rate, m.data); break;
        case "play": a.play(m.sound, m.source, m.loop, m.relative, m.x, m.y, m.volume, m.attenuate); break;
        case "stream": a.stream(m.sound, m.channels, m.bits, m.rate, m.data, m.end, m.volume); break;
        case "stop": a.stop(m.sound); break;
        case "volume": a.volume(m.sound, m.volume); break;
        case "pause": a.pause(m.sound, m.paused); break;
      }
    });
    c.on("bench", (m) => store.set({ verify: `${m.ticks} ticks in ${m.ms.toFixed(0)} ms = ${(m.ms / m.ticks).toFixed(2)} ms/tick` }));
    c.on("log", (m) => this.verifyNative(m.json));
  }

  private perf(p: Partial<Perf>) {
    store.set({ perf: { ...store.get().perf, ...p } });
  }

  boot(runtime: string, privateContent: boolean) {
    store.set({ phase: "boot", runtime, stage: "Starting the engine", error: "" });
    this.client.init(runtime, new URL("./", location.href).href, privateContent, new URLSearchParams(location.search).get("gc") ?? undefined);
  }

  prepare(map: string) {
    const s = store.get();
    if (s.preparedMap === map || s.preparing === map) return;
    store.set({ preparing: map });
    this.client.send({ type: "prepare", map });
  }

  preview(map: string) {
    if (store.get().previews[map] !== undefined) return;
    store.set({ previews: { ...store.get().previews, [map]: "" } });
    this.client.send({ type: "preview", map });
  }

  start(scenarioJson: string, paused = false) {
    this.scenarioJson = scenarioJson;
    this.overlay.selected.clear();
    this.ui = null;
    this.latency = [];
    store.set({ phase: "loading", stage: "Building the world", ui: null, catalog: [], verify: "", menuOpen: false, paused: false });
    this.client.start(scenarioJson, paused);
  }

  quit() {
    this.client.send({ type: "end" });
    this.audio.stop(-1);
    this.info = null;
    this.ui = null;
    store.set({ phase: "setup", info: null, ui: null, catalog: [], menuOpen: false, preparedMap: null });
  }

  setPaused(paused: boolean) {
    this.client.send({ type: "pause", paused });
    this.audio.pause(-1, paused);
    store.set({ paused });
  }

  private started(info: StartInfo, radarTerrain: ArrayBuffer, startMs: number) {
    this.info = info;
    this.cam = { x: info.start[0], y: info.start[1], zoom: 1 };
    const w = info.mapSize[0] * 2 + 1;
    const h = info.mapSize[1];
    this.radar.terrain = new ImageData(new Uint8ClampedArray(radarTerrain), w, h);
    this.radar.width = w;
    this.radar.height = h;
    this.radar.cols = info.mapSize[0];
    this.radar.blips = new Int32Array(0);
    this.radar.bump();
    store.set({ phase: "playing", info, startMs, timings: { ...store.get().timings, ...info.timings } });
    this.sendView(true);
  }

  private onUi(u: UiState) {
    const s = store.get();
    const catalog = u.catalog ?? s.catalog;
    this.ui = u;
    const patch: Partial<typeof s> = { ui: u };
    if (u.catalog) {
      patch.catalog = catalog;
      // Cameos for everything the sidebar can show.
      this.requestIcons(catalog.flatMap((q) => q.items.map((i) => i.name)));
    }
    this.requestIcons(u.selection.map((a) => a.type));
    // Keep the open tab on a queue that exists; prefer one with something ready.
    if (!catalog.some((q) => q.type === s.tab && q.items.length)) {
      const first = catalog.find((q) => q.items.length);
      if (first) patch.tab = first.type;
    }
    store.set(patch);
  }

  /** Cameos whose sheet has reached the GPU are rendered and handed to the HUD (a few per frame). */
  private rasterIcons() {
    const done: Record<string, string> = {};
    let n = 0;
    const publicShot = store.get().publicShot;
    for (const [name, sprite] of this.iconQueue) {
      // Screenshot mode: only the project's own (modern-faction) cameos.
      const url = publicShot && !name.startsWith("r2") ? "" : this.renderer.renderIcon(sprite);
      if (url === "") { done[name] = ""; this.iconQueue.delete(name); continue; }
      if (url) { done[name] = url; this.iconQueue.delete(name); }
      if (++n >= 12) break;
    }
    if (Object.keys(done).length) store.set({ icons: { ...store.get().icons, ...done } });
  }

  requestIcons(names: string[]) {
    const missing = [...new Set(names)].filter((n) => !this.iconRequested.has(n));
    if (!missing.length) return;
    for (const n of missing) this.iconRequested.add(n);
    this.client.send({ type: "icons", names: missing });
  }

  private onSnapshot(s: Snapshot) {
    this.overlay.ownPlayer = s.header.localPlayer;
    for (const id of this.overlay.selected) if (!s.actorById.has(id)) this.overlay.selected.delete(id);
    const now = performance.now();
    this.tickArrival.set(s.header.tick, now);
    if (this.tickArrival.size > 30) this.tickArrival.delete(this.tickArrival.keys().next().value!);
    const pl = this.pendingLatency;
    if (pl && pl.tick > 0 && s.header.tick >= pl.tick && !pl.snapAt) pl.snapAt = now;
    this.sandbox?.record(s);
  }

  // ---------------------------------------------------------------- frame loop

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.lastFrame ? Math.min(100, now - this.lastFrame) : 16;
    this.lastFrame = now;
    if (store.get().phase === "playing") this.scroll(dt);
    this.client.poll(performance.now());
    const cur = this.client.cur;
    this.updateHover(cur);
    this.overlay.markers = this.sandboxMarkers();
    const replay = this.sandbox?.replayFrame();
    if (replay) this.renderer.render(replay[0], replay[1], this.cam, this.overlay, replay[0].receivedAt + 40);
    else this.renderer.render(cur, this.client.prev, this.cam, this.overlay, performance.now());
    if (this.iconQueue.size) this.rasterIcons();
    if (now - this.lastListener > 100) { this.audio.setListener(this.cam.x, this.cam.y); this.lastListener = now; }

    const pl = this.pendingLatency;
    if (pl?.snapAt && cur) {
      this.latency.push(performance.now() - pl.t0);
      if (this.latency.length > 200) this.latency.shift();
      this.pendingLatency = null;
    }

    this.frames++;
    if (now - this.fpsT >= 500) {
      const h = cur?.header;
      this.perf({
        fps: (this.frames * 1000) / (now - this.fpsT), frameMs: this.renderer.stats.frameMs, draws: this.renderer.stats.draws,
        tick: h?.tick ?? 0, syncHash: h?.syncHash ?? 0, engineTickMs: h?.tickMs ?? 0, buildMs: h?.buildMs ?? 0,
        latency: [...this.latency], missed: this.client.missedSnapshots,
      });
      this.frames = 0;
      this.fpsT = now;
    }
  };

  // ---------------------------------------------------------------- camera

  private toWorld(clientX: number, clientY: number): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const sx = (clientX - r.left) * dpr;
    const sy = (clientY - r.top) * dpr;
    return [this.cam.x + (sx - this.canvas.width / 2) / this.cam.zoom, this.cam.y + (sy - this.canvas.height / 2) / this.cam.zoom];
  }

  /** The visible world rectangle (x0, y0, x1, y1) for the minimap frame. */
  viewRect(): [number, number, number, number] {
    const W = this.canvas.width / this.cam.zoom;
    const H = this.canvas.height / this.cam.zoom;
    return [this.cam.x - W / 2, this.cam.y - H / 2, this.cam.x + W / 2, this.cam.y + H / 2];
  }

  private clampCam() {
    const b = this.info?.bounds;
    if (!b) return;
    this.cam.x = Math.min(b[2], Math.max(b[0], this.cam.x));
    this.cam.y = Math.min(b[3], Math.max(b[1], this.cam.y));
  }

  private sendView(force = false) {
    if (!this.info) return;
    const [x0, y0, x1, y1] = this.viewRect();
    const m = 320;
    const r = [x0 - m, y0 - m, x1 + m, y1 + m * 2].map(Math.round);
    const key = r.map((v) => Math.round(v / 64)).join(",");
    if (!force && key === this.lastView) return;
    this.lastView = key;
    this.client.send({ type: "view", x0: r[0], y0: r[1], x1: r[2], y1: r[3] });
    this.radar.bump();
  }

  lookAt(x: number, y: number) {
    this.cam.x = x;
    this.cam.y = y;
    this.clampCam();
    this.sendView(true);
  }

  private scroll(dt: number) {
    const speed = (0.9 * dt) / this.cam.zoom;
    let dx = 0, dy = 0;
    const k = this.keys;
    if (k.has("arrowleft")) dx -= speed;
    if (k.has("arrowright")) dx += speed;
    if (k.has("arrowup")) dy -= speed;
    if (k.has("arrowdown")) dy += speed;
    // Edge scrolling, only while the pointer is over the battlefield.
    if (this.mouse.inside && !this.drag && document.hasFocus()) {
      const r = this.canvas.getBoundingClientRect();
      if (this.mouse.sx <= r.left + EDGE_PX) dx -= speed;
      if (this.mouse.sx >= r.right - EDGE_PX - 1) dx += speed;
      if (this.mouse.sy <= r.top + EDGE_PX) dy -= speed;
      if (this.mouse.sy >= r.bottom - EDGE_PX - 1) dy += speed;
    }
    if (dx || dy) {
      this.cam.x += dx;
      this.cam.y += dy;
      this.clampCam();
      this.sendView();
    }
  }

  // ---------------------------------------------------------------- selection

  private actorAt(wx: number, wy: number, s: Snapshot): Actor | null {
    let best: Actor | null = null;
    for (const a of s.actors) {
      if (!(a.flags & 32) || a.bw <= 0) continue;
      const x0 = Math.round(a.sx) + a.bx, y0 = Math.round(a.sy) + a.by;
      if (wx >= x0 && wx <= x0 + a.bw && wy >= y0 && wy <= y0 + a.bh) {
        if (!best || ((a.flags & 1) && !(best.flags & 1)) || ((a.flags & 1) === (best.flags & 1) && a.sy > best.sy)) best = a;
      }
    }
    return best;
  }

  private updateHover(s: Snapshot | null) {
    if (!s || !this.mouse.inside || store.get().phase !== "playing") {
      this.overlay.hover = null;
      return;
    }
    const a = this.actorAt(this.mouse.wx, this.mouse.wy, s);
    this.overlay.hover = a && a.flags & 1 ? a.id : null;
    const key = `${Math.round(this.mouse.wx)},${Math.round(this.mouse.wy)},${this.overlay.selected.size},${this.ui?.mode ?? ""}`;
    if (key !== this.lastCursorKey && !this.drag?.active) {
      this.lastCursorKey = key;
      this.client.send({ type: "cursor", x: this.mouse.wx, y: this.mouse.wy, mods: 0, seq: ++this.cursorSeq });
    }
  }

  async select(ids: number[], additive = false) {
    const r = await this.client.request<{ selection: number[] }>({ type: "select", ids, additive });
    this.overlay.selected = new Set(r.selection);
    this.lastCursorKey = "";
  }

  private ownSelectable(s: Snapshot, a: Actor) {
    return (a.flags & 1) !== 0 && a.owner === s.header.localPlayer;
  }

  private boxSelect(x0: number, y0: number, x1: number, y1: number, additive: boolean) {
    const s = this.client.cur;
    if (!s) return;
    const l = Math.min(x0, x1), r = Math.max(x0, x1), t = Math.min(y0, y1), b = Math.max(y0, y1);
    const inBox = s.actors.filter((a) => this.ownSelectable(s, a) && a.sx >= l && a.sx <= r && a.sy >= t && a.sy <= b);
    // Units take precedence over buildings in a box (as in the desktop game).
    const units = inBox.filter((a) => !(a.flags & 8));
    this.select((units.length ? units : inBox).map((a) => a.id), additive);
  }

  private clickSelect(wx: number, wy: number, additive: boolean) {
    const s = this.client.cur;
    if (!s) return;
    const a = this.actorAt(wx, wy, s);
    const now = performance.now();
    if (a && a.flags & 1) {
      if (now - this.lastClick.t < 350 && this.lastClick.id === a.id && this.ownSelectable(s, a)) {
        // Double click: every unit of that type on screen.
        const [vx0, vy0, vx1, vy1] = this.viewRect();
        const same = s.actors.filter((b) => this.ownSelectable(s, b) && b.type === a.type && b.sx >= vx0 && b.sx <= vx1 && b.sy >= vy0 && b.sy <= vy1);
        this.select(same.map((b) => b.id), additive);
      } else if (additive && this.overlay.selected.has(a.id)) {
        this.select([...this.overlay.selected].filter((id) => id !== a.id), false);
      } else this.select([a.id], additive);
      this.lastClick = { t: now, id: a.id };
    } else if (!additive) this.select([], false);
  }

  /** Selects only the selected actors of one type (selection panel click). */
  selectType(type: string) {
    const ids = (this.ui?.selection ?? []).filter((a) => a.own && a.type === type).map((a) => a.id);
    this.select(ids, false);
  }

  // ---------------------------------------------------------------- orders and commands

  private click(wx: number, wy: number, button: number, mods: number) {
    const t0 = performance.now();
    if (button === BTN_RIGHT && this.overlay.selected.size > 0) {
      this.pendingLatency = { t0, tick: 0 };
      const attack = store.get().cursor.startsWith("attack");
      this.overlay.orderFlash = { x: wx, y: wy, t: t0, color: attack ? [1, 0.25, 0.2] : [0.3, 1, 0.4] };
    }
    this.client.send({ type: "click", x: Math.round(wx), y: Math.round(wy), button, mods, t: t0 });
  }

  /** Right-click order at a world position (minimap). */
  orderAt(wx: number, wy: number) {
    this.click(wx, wy, BTN_RIGHT, 0);
  }

  command<T = Record<string, unknown>>(cmd: Record<string, unknown>) {
    return this.client.command<T>(cmd);
  }

  setMode(mode: string) {
    const current = this.ui?.mode ?? "";
    this.command({ cmd: "mode", mode: current === mode ? "none" : mode });
  }

  async group(index: number, action: "select" | "create" | "add" | "combine") {
    const r = await this.command<{ selection?: number[]; center?: [number, number] }>({ cmd: "group", index, action });
    if (r.selection) this.overlay.selected = new Set(r.selection);
    const now = performance.now();
    if (action === "select" && this.lastGroupTap.index === index && now - this.lastGroupTap.t < 400 && r.center) this.lookAt(r.center[0], r.center[1]);
    this.lastGroupTap = { t: now, index };
  }

  /** Automated latency probe: n move orders to points around the selection's centre, 400 ms apart. */
  async latencyProbe(n = 20) {
    const s = this.client.cur;
    if (!s) return;
    if (this.overlay.selected.size === 0) {
      const own = s.actors.filter((a) => this.ownSelectable(s, a) && !(a.flags & 8)).slice(0, 8);
      await this.select(own.map((a) => a.id));
    }
    for (let i = 0; i < n; i++) {
      const cur = this.client.cur!;
      const sel = [...this.overlay.selected].map((id) => cur.actorById.get(id)).filter(Boolean) as Actor[];
      if (!sel.length) break;
      const cx = sel.reduce((a, b) => a + b.sx, 0) / sel.length;
      const cy = sel.reduce((a, b) => a + b.sy, 0) / sel.length;
      const ang = (i * 2.4) % (2 * Math.PI);
      this.click(cx + Math.cos(ang) * 160, cy + Math.sin(ang) * 80, BTN_RIGHT, 0);
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 60));
    }
  }

  bench(ticks: number) {
    store.set({ verify: "Benchmarking..." });
    this.client.send({ type: "bench", ticks });
  }

  requestVerify() {
    store.set({ verify: "Replaying this game natively..." });
    this.client.send({ type: "log" });
  }

  private async verifyNative(logJson: string) {
    try {
      const res = await fetch(new URL("api/verify", new URL("./", location.href)), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: JSON.parse(this.scenarioJson), log: JSON.parse(logJson) }),
      });
      const r = await res.json();
      store.set({
        verify: r.error ? `Error: ${r.error}` : r.match
          ? `Identical: ${r.compared} of ${r.compared} net frames (wasm = native CoreCLR)`
          : `MISMATCH at frame ${r.firstMismatch} (${r.compared} compared)`,
      });
    } catch (e) {
      store.set({ verify: `Error: ${e}` });
    }
  }

  /** Pixel statistics of the next rendered frame (rendering checks without screenshots). */
  probePixels() {
    return new Promise<{ nonBackground: number; colors: number; meanRGB: number[] }>((resolve) => (this.renderer.pixelProbe = resolve));
  }

  // ---------------------------------------------------------------- DOM input

  private mods(e: MouseEvent | KeyboardEvent) {
    return (e.shiftKey ? MOD_SHIFT : 0) | (e.altKey ? MOD_ALT : 0) | (e.ctrlKey ? MOD_CTRL : 0) | (e.metaKey ? MOD_META : 0);
  }

  private sandboxMarkers() {
    const st = this.sandbox && store.get().sandbox;
    if (!st || st.mode !== "edit" || !this.info) return undefined;
    const [ox, oy] = this.info.cellOrigin;
    const hw = this.info.tileSize[0] / 2, hh = this.info.tileSize[1] / 2;
    return st.sides.flatMap((s, i) => s.order === "move" && s.destination
      ? [{ x: ox + (2 * s.destination.u + (s.destination.v & 1)) * hw, y: oy + s.destination.v * hh, color: (i === 0 ? [0.3, 0.55, 1] : [1, 0.35, 0.3]) as [number, number, number] }]
      : []);
  }

  /** Sandbox editing input: place with the brush, set a side's destination, right-click removes. */
  private sandboxEdit(e: MouseEvent, wx: number, wy: number) {
    const sb = this.sandbox;
    if (!sb || sb.state.mode !== "edit" || !this.info) return false;
    const st = sb.state;
    if (e.button === 0 && st.pickDestination !== null) {
      const cell = worldToCell(wx, wy, this.info.cellOrigin, this.info.tileSize);
      const sides = [...st.sides] as typeof st.sides;
      sides[st.pickDestination] = { ...sides[st.pickDestination], order: "move", destination: cell };
      store.set({ sandbox: { ...st, sides, pickDestination: null } });
      this.overlay.orderFlash = { x: wx, y: wy, t: performance.now(), color: st.pickDestination === 0 ? [0.3, 0.55, 1] : [1, 0.35, 0.3] };
      return true;
    }
    if (e.button === 0 && st.brush) {
      sb.spawn(st.brush, wx, wy);
      return true;
    }
    if (e.button === 2) {
      const s = this.client.cur;
      const a = s && this.actorAt(wx, wy, s);
      if (a && s.players[a.owner] && s.players[a.owner].flags & 4) sb.remove(a.id);
      return true;
    }
    return false;
  }

  private mouseMove(e: MouseEvent) {
    const [wx, wy] = this.toWorld(e.clientX, e.clientY);
    Object.assign(this.mouse, { x: e.clientX, y: e.clientY, wx, wy, sx: e.clientX, sy: e.clientY });
    const d = this.drag;
    if (!d) return;
    if (d.pan) {
      const dpr = window.devicePixelRatio || 1;
      this.cam.x -= ((e.clientX - d.cx) * dpr) / this.cam.zoom;
      this.cam.y -= ((e.clientY - d.cy) * dpr) / this.cam.zoom;
      d.cx = e.clientX;
      d.cy = e.clientY;
      this.clampCam();
      this.sendView();
      return;
    }
    if (!d.active && Math.hypot(e.clientX - d.cx, e.clientY - d.cy) > 5) d.active = true;
    if (d.active) this.overlay.dragBox = [d.x0, d.y0, wx, wy];
  }

  private mouseUp(e: MouseEvent) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.overlay.dragBox = null;
    if (d.pan) return;
    const [wx, wy] = this.toWorld(e.clientX, e.clientY);
    if (d.active) this.boxSelect(d.x0, d.y0, wx, wy, e.shiftKey);
    else if (e.button === 0) this.clickSelect(wx, wy, e.shiftKey);
  }

  private bind() {
    const c = this.canvas;
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("mouseenter", () => (this.mouse.inside = true));
    c.addEventListener("mouseleave", () => (this.mouse.inside = false));
    c.addEventListener("mousedown", (e) => {
      c.focus();
      store.set({ menuOpen: false });
      const [wx, wy] = this.toWorld(e.clientX, e.clientY);
      if (this.sandboxEdit(e, wx, wy)) { e.preventDefault(); return; }
      const mode = this.ui?.mode ?? "";
      if (e.button === 1) this.drag = { x0: wx, y0: wy, active: true, pan: true, cx: e.clientX, cy: e.clientY };
      else if (mode && e.button === 0) this.click(wx, wy, BTN_LEFT, this.mods(e)); // placement, sell, repair, attack-move, guard
      else if (mode && e.button === 2) this.command({ cmd: "mode", mode: "none" });
      else if (e.button === 0) this.drag = { x0: wx, y0: wy, active: false, pan: false, cx: e.clientX, cy: e.clientY };
      else if (e.button === 2) this.click(wx, wy, BTN_RIGHT, this.mods(e));
      e.preventDefault();
    });
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const [wx, wy] = this.toWorld(e.clientX, e.clientY);
      const z = Math.min(3, Math.max(0.5, this.cam.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      this.cam.x = wx - (wx - this.cam.x) * (this.cam.zoom / z);
      this.cam.y = wy - (wy - this.cam.y) * (this.cam.zoom / z);
      this.cam.zoom = z;
      this.clampCam();
      this.sendView(true);
    }, { passive: false });
    // Sandbox: drag a unit from the palette onto the battlefield.
    c.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("application/x-rtsai-unit")) e.preventDefault(); });
    c.addEventListener("drop", (e) => {
      const type = e.dataTransfer?.getData("application/x-rtsai-unit");
      if (!type || !this.sandbox || this.sandbox.state.mode !== "edit") return;
      e.preventDefault();
      const [wx, wy] = this.toWorld(e.clientX, e.clientY);
      this.sandbox.spawn(type, wx, wy);
    });
    window.addEventListener("mousemove", this.onMove);
    window.addEventListener("mouseup", this.onUp);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
  }

  private keyDown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || store.get().phase !== "playing") return;
    const k = e.key.toLowerCase();
    this.keys.add(k);
    if (e.key === "F2") { store.set({ statsOpen: !store.get().statsOpen }); e.preventDefault(); return; }
    if (e.key === "Escape") {
      if (this.ui?.mode) this.command({ cmd: "mode", mode: "none" });
      else if (store.get().menuOpen) store.set({ menuOpen: false });
      else this.select([]);
      return;
    }
    if (e.key === "F10" || (k === "p" && !e.ctrlKey)) { this.setPaused(!store.get().paused); e.preventDefault(); return; }
    // Control groups: N select (double-tap jumps), Ctrl+N create, Shift+N add, Alt+N combine.
    const digit = e.code.startsWith("Digit") ? Number(e.code.slice(5)) : -1;
    if (digit >= 0) {
      const index = digit === 0 ? 9 : digit - 1;
      this.group(index, e.ctrlKey || e.metaKey ? "create" : e.shiftKey ? "add" : e.altKey ? "combine" : "select");
      e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.metaKey) return;
    switch (k) {
      case "s": this.command({ cmd: "stop" }); break;
      case "d": this.command({ cmd: "deploy", queued: e.shiftKey }); break;
      case "x": this.command({ cmd: "scatter", queued: e.shiftKey }); break;
      case "a": this.setMode("attackmove"); break;
      case "g": this.setMode("guard"); break;
      case "z": this.setMode("repair"); break;
      case "q": this.setMode("sell"); break;
      case "h": if (this.info) this.lookAt(this.info.start[0], this.info.start[1]); break;
      default: return;
    }
    e.preventDefault();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("mousemove", this.onMove);
    window.removeEventListener("mouseup", this.onUp);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.client.worker.terminate();
  }
}
