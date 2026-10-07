// Game controller: camera, mouse/keyboard input, selection, orders, latency probes and the frame loop.
// React only renders the HUD from the periodic `state` callback; the canvas never goes through React.

import { Renderer, type Camera, type Overlay } from "./render/renderer";
import { SimClient } from "./sim/client";
import type { Actor, FromWorker, Snapshot, StartInfo } from "./sim/protocol";

// OpenRA enums
const MOD_SHIFT = 1, MOD_ALT = 2, MOD_CTRL = 4, MOD_META = 8;
const BTN_RIGHT = 2;

export interface HudState {
  phase: "idle" | "loading" | "ready" | "starting" | "running" | "error";
  stage: string;
  detail: string;
  error: string;
  runtime: string;
  shared: boolean;
  info: StartInfo | null;
  tick: number;
  syncHash: number;
  fps: number;
  frameMs: number;
  simTickMs: number; // worker-measured tick incl. snapshot
  engineTickMs: number; // C# World tick only
  buildMs: number;
  tps: number;
  lateTicks: number;
  draws: number;
  batches: number;
  textures: number;
  heapMB: number;
  managedMB: number;
  units: number;
  latency: number[]; // input -> first frame drawn from the snapshot that executed the order
  latencyVisible: number[]; // same, only when a selected unit visibly changed (moved/turned)
  selection: { type: string; count: number }[];
  players: { name: string; color: string; units: number; local: boolean }[];
  timings: Record<string, number>;
  downloads: Record<string, number>;
  startMs: number;
  bench: string;
  verify: string;
  cursor: string;
}

const CURSORS: Record<string, string> = {
  default: "default", select: "pointer", move: "crosshair", "move-blocked": "not-allowed", "move-rough": "crosshair",
  attack: "crosshair", attackoutsiderange: "crosshair", "attack-move": "crosshair", deploy: "cell", "deploy-blocked": "not-allowed",
  enter: "alias", "enter-blocked": "not-allowed", capture: "alias", repair: "help", sell: "copy", ability: "cell",
  "generic-blocked": "not-allowed", harvest: "cell", c4: "alias",
};

export class Game {
  readonly renderer: Renderer;
  readonly client: SimClient;
  cam: Camera = { x: 0, y: 0, zoom: 1 };
  overlay: Overlay = { selected: new Set(), hover: null, dragBox: null, orderFlash: null, ownPlayer: -1 };
  hud: HudState;
  private raf = 0;
  private mouse = { x: 0, y: 0, wx: 0, wy: 0, inside: false };
  private drag: { x0: number; y0: number; active: boolean; pan: boolean; cx: number; cy: number } | null = null;
  private keys = new Set<string>();
  private cursorSeq = 0;
  private lastCursorPx = "";
  private lastView = "";
  private frames = 0;
  private fpsT = 0;
  private pendingLatency: { t0: number; tick: number; ids: number[]; before: Map<number, [number, number, number]> } | null = null;
  private scenarioJson = "";
  private lastFrame = 0;
  private tickArrival = new Map<number, number>();

  constructor(private canvas: HTMLCanvasElement, private onState: (s: HudState) => void) {
    this.renderer = new Renderer(canvas);
    this.hud = {
      phase: "idle", stage: "", detail: "", error: "", runtime: "interp", shared: false, info: null, tick: 0, syncHash: 0,
      fps: 0, frameMs: 0, simTickMs: 0, engineTickMs: 0, buildMs: 0, tps: 0, lateTicks: 0, draws: 0, batches: 0, textures: 0,
      heapMB: 0, managedMB: 0, units: 0, latency: [], latencyVisible: [], selection: [], players: [], timings: {}, downloads: {},
      startMs: 0, bench: "", verify: "", cursor: "default",
    };
    this.client = new SimClient(this.renderer, {
      onProgress: (stage, detail) => this.set({ stage, detail: detail ?? "" }),
      onReady: (m) => this.onReady(m),
      onStarted: (info, startMs) => this.onStarted(info, startMs),
      onSnapshot: (s) => this.onSnapshot(s),
      onCursor: (c) => {
        this.canvas.style.cursor = CURSORS[c] ?? "crosshair";
        if (c !== this.hud.cursor) this.set({ cursor: c });
      },
      onOrdered: (m) => {
        const pl = this.pendingLatency as (typeof this.pendingLatency & { snapAt?: number }) | null;
        if (pl && pl.t0 === m.t) {
          pl.tick = m.tick + 1;
          // The executing snapshot may already have arrived through the shared ring before this message.
          for (const [tick, at] of this.tickArrival) if (tick >= pl.tick && !pl.snapAt) pl.snapAt = at;
        }
      },
      onStats: (m) => {
        const s = JSON.parse(m.json);
        this.set({
          simTickMs: m.tickMs, tps: m.ticksPerSecond, lateTicks: m.lateTicks, heapMB: m.heapBytes / 1048576,
          managedMB: s.managedMB, units: s.units,
        });
      },
      onBench: (m) => this.set({ bench: `${m.ticks} ticks in ${m.ms.toFixed(0)} ms = ${(m.ms / m.ticks).toFixed(2)} ms/tick` }),
      onLog: (json) => this.verify(json),
      onError: (message) => this.set({ phase: "error", error: message }),
    });
    this.hud.shared = this.client.shared;
    this.bind();
    this.raf = requestAnimationFrame(this.frame);
  }

  private set(p: Partial<HudState>) {
    Object.assign(this.hud, p);
    this.onState({ ...this.hud });
  }

  boot(runtime: string, privateContent: boolean) {
    this.set({ phase: "loading", runtime, stage: "Starting worker", error: "" });
    this.client.init(runtime, privateContent);
  }

  private onReady(m: Extract<FromWorker, { type: "ready" }>) {
    this.set({ phase: "ready", stage: "Engine loaded", timings: { ...m.timings, "runtime.start": m.runtimeMs }, downloads: m.downloadBytes });
  }

  start(scenarioJson: string) {
    this.scenarioJson = scenarioJson;
    this.overlay.selected.clear();
    this.set({ phase: "starting", stage: "Building the world", latency: [], latencyVisible: [], verify: "", bench: "" });
    this.client.start(scenarioJson);
  }

  private onStarted(info: StartInfo, startMs: number) {
    this.cam = { x: info.start[0], y: info.start[1], zoom: 1 };
    this.set({ phase: "running", info, startMs, timings: { ...this.hud.timings, ...Object.fromEntries(Object.entries(info.timings)) } });
    this.sendView(true);
  }

  private onSnapshot(s: Snapshot) {
    // Ownership index of the local player for selection rules.
    this.overlay.ownPlayer = s.header.localPlayer;
    // Drop selected actors that died or left the view.
    for (const id of this.overlay.selected) if (!s.actorById.has(id)) this.overlay.selected.delete(id);

    const now = performance.now();
    this.tickArrival.set(s.header.tick, now);
    if (this.tickArrival.size > 30) this.tickArrival.delete(this.tickArrival.keys().next().value!);
    const pl = this.pendingLatency as (typeof this.pendingLatency & { snapAt?: number }) | null;
    if (pl && pl.tick > 0 && s.header.tick >= pl.tick && !pl.snapAt) pl.snapAt = now;
  }

  // ---------------------------------------------------------------- frame loop

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.lastFrame ? Math.min(100, now - this.lastFrame) : 16;
    this.lastFrame = now;
    this.scrollKeys(dt);
    this.client.poll(performance.now());
    const cur = this.client.cur;
    this.updateHover(cur);
    this.renderer.render(cur, this.client.prev, this.cam, this.overlay, performance.now());

    // Latency: first frame drawn from the snapshot whose tick executed the order.
    const pl = this.pendingLatency as (typeof this.pendingLatency & { snapAt?: number }) | null;
    if (pl?.snapAt && cur) {
      const ms = performance.now() - pl.t0;
      let visible = false;
      for (const id of pl.ids) {
        const a = cur.actorById.get(id);
        const b = pl.before.get(id);
        if (a && b && (a.facing !== b[2] || Math.abs(a.sx - b[0]) > 0.01 || Math.abs(a.sy - b[1]) > 0.01)) visible = true;
      }
      this.hud.latency = [...this.hud.latency, ms].slice(-200);
      if (visible) this.hud.latencyVisible = [...this.hud.latencyVisible, ms].slice(-200);
      this.pendingLatency = null;
    }

    this.frames++;
    if (now - this.fpsT >= 500) {
      const st = this.renderer.stats;
      const h = cur?.header;
      this.set({
        fps: (this.frames * 1000) / (now - this.fpsT), frameMs: st.frameMs, draws: st.draws, batches: st.batches,
        textures: this.renderer.textureCount, tick: h?.tick ?? 0, syncHash: h?.syncHash ?? 0, engineTickMs: h?.tickMs ?? 0,
        buildMs: h?.buildMs ?? 0, selection: this.selectionSummary(cur), players: this.playerSummary(cur),
      });
      this.frames = 0;
      this.fpsT = now;
    }
  };

  private selectionSummary(s: Snapshot | null) {
    if (!s) return [];
    const counts = new Map<string, number>();
    for (const id of this.overlay.selected) {
      const a = s.actorById.get(id);
      if (a) counts.set(this.client.str(a.type), (counts.get(this.client.str(a.type)) ?? 0) + 1);
    }
    return [...counts].map(([type, count]) => ({ type, count }));
  }

  private playerSummary(s: Snapshot | null) {
    if (!s) return [];
    const counts = new Map<number, number>();
    for (const a of s.actors) if (a.flags & 1 && a.maxHp > 0) counts.set(a.owner, (counts.get(a.owner) ?? 0) + 1);
    return s.players
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.flags & 4)
      .map(({ p, i }) => ({
        name: this.client.str(p.name), color: `#${(p.color & 0xffffff).toString(16).padStart(6, "0")}`,
        units: counts.get(i) ?? 0, local: !!(p.flags & 1),
      }));
  }

  // ---------------------------------------------------------------- camera & coordinates

  private toWorld(clientX: number, clientY: number): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const sx = (clientX - r.left) * dpr;
    const sy = (clientY - r.top) * dpr;
    return [this.cam.x + (sx - this.canvas.width / 2) / this.cam.zoom, this.cam.y + (sy - this.canvas.height / 2) / this.cam.zoom];
  }

  private clampCam() {
    const b = this.hud.info?.bounds;
    if (!b) return;
    this.cam.x = Math.min(b[2], Math.max(b[0], this.cam.x));
    this.cam.y = Math.min(b[3], Math.max(b[1], this.cam.y));
  }

  private sendView(force = false) {
    if (!this.hud.info) return;
    const W = this.canvas.width / this.cam.zoom;
    const H = this.canvas.height / this.cam.zoom;
    const m = 320;
    const r = [this.cam.x - W / 2 - m, this.cam.y - H / 2 - m, this.cam.x + W / 2 + m, this.cam.y + H / 2 + m * 2].map(Math.round);
    const key = r.map((v) => Math.round(v / 64)).join(",");
    if (!force && key === this.lastView) return;
    this.lastView = key;
    this.client.send({ type: "view", x0: r[0], y0: r[1], x1: r[2], y1: r[3] });
  }

  private scrollKeys(dt: number) {
    const speed = (0.9 * dt) / this.cam.zoom;
    let dx = 0, dy = 0;
    if (this.keys.has("ArrowLeft") || this.keys.has("a")) dx -= speed;
    if (this.keys.has("ArrowRight") || this.keys.has("d")) dx += speed;
    if (this.keys.has("ArrowUp") || this.keys.has("w")) dy -= speed;
    if (this.keys.has("ArrowDown")) dy += speed;
    if (dx || dy) {
      this.cam.x += dx;
      this.cam.y += dy;
      this.clampCam();
      this.sendView();
    }
  }

  // ---------------------------------------------------------------- picking & selection

  private actorAt(wx: number, wy: number, s: Snapshot): Actor | null {
    let best: Actor | null = null;
    for (const a of s.actors) {
      if (!(a.flags & 32) || a.bw <= 0) continue;
      const x0 = Math.round(a.sx) + a.bx, y0 = Math.round(a.sy) + a.by;
      if (wx >= x0 && wx <= x0 + a.bw && wy >= y0 && wy <= y0 + a.bh) {
        if (!best || a.sy > best.sy || ((a.flags & 1) && !(best.flags & 1))) best = a;
      }
    }
    return best;
  }

  private updateHover(s: Snapshot | null) {
    if (!s || !this.mouse.inside) {
      this.overlay.hover = null;
      return;
    }
    const a = this.actorAt(this.mouse.wx, this.mouse.wy, s);
    this.overlay.hover = a && a.flags & 1 ? a.id : null;
    const key = `${Math.round(this.mouse.wx)},${Math.round(this.mouse.wy)},${this.overlay.selected.size}`;
    if (key !== this.lastCursorPx && this.hud.phase === "running" && !this.drag?.active) {
      this.lastCursorPx = key;
      this.client.send({ type: "cursor", x: this.mouse.wx, y: this.mouse.wy, mods: 0, seq: ++this.cursorSeq });
    }
  }

  private commitSelection(ids: number[], additive: boolean) {
    if (!additive) this.overlay.selected.clear();
    for (const id of ids) this.overlay.selected.add(id);
    this.client.send({ type: "select", ids: [...this.overlay.selected], additive: false });
    this.lastCursorPx = "";
  }

  private boxSelect(x0: number, y0: number, x1: number, y1: number, additive: boolean) {
    const s = this.client.cur;
    if (!s) return;
    const l = Math.min(x0, x1), r = Math.max(x0, x1), t = Math.min(y0, y1), b = Math.max(y0, y1);
    const ids = s.actors
      .filter((a) => a.flags & 1 && !(a.flags & 8) && a.owner === s.header.localPlayer && a.sx >= l && a.sx <= r && a.sy >= t && a.sy <= b)
      .map((a) => a.id);
    this.commitSelection(ids, additive);
  }

  private clickSelect(wx: number, wy: number, additive: boolean) {
    const s = this.client.cur;
    if (!s) return;
    const a = this.actorAt(wx, wy, s);
    if (a && a.flags & 1) {
      if (additive && this.overlay.selected.has(a.id)) {
        this.overlay.selected.delete(a.id);
        this.commitSelection([], true);
      } else this.commitSelection([a.id], additive);
    } else if (!additive) this.commitSelection([], false);
  }

  // ---------------------------------------------------------------- orders

  order(wx: number, wy: number, mods: number) {
    const s = this.client.cur;
    if (!s || this.overlay.selected.size === 0) return;
    const t0 = performance.now();
    const ids = [...this.overlay.selected];
    const before = new Map<number, [number, number, number]>();
    for (const id of ids) {
      const a = s.actorById.get(id);
      if (a) before.set(id, [a.sx, a.sy, a.facing]);
    }
    this.pendingLatency = { t0, tick: 0, ids, before };
    const attack = this.hud.cursor.startsWith("attack");
    this.overlay.orderFlash = { x: wx, y: wy, t: t0, color: attack ? [1, 0.25, 0.2] : [0.3, 1, 0.4] };
    this.client.send({ type: "click", x: wx, y: wy, button: BTN_RIGHT, mods, t: t0 });
  }

  stop() {
    this.client.send({ type: "stop", t: performance.now() });
  }

  /** Automated latency probe: n move orders, one every 400 ms, to points around the selection's centre. */
  async latencyProbe(n = 20) {
    const s = this.client.cur;
    if (!s) return;
    if (this.overlay.selected.size === 0) {
      const own = s.actors.filter((a) => a.flags & 1 && !(a.flags & 8) && a.owner === s.header.localPlayer).slice(0, 8);
      this.commitSelection(own.map((a) => a.id), false);
      await new Promise((r) => setTimeout(r, 200));
    }
    for (let i = 0; i < n; i++) {
      const cur = this.client.cur!;
      const sel = [...this.overlay.selected].map((id) => cur.actorById.get(id)).filter(Boolean) as Actor[];
      if (sel.length === 0) break;
      const cx = sel.reduce((a, b) => a + b.sx, 0) / sel.length;
      const cy = sel.reduce((a, b) => a + b.sy, 0) / sel.length;
      const ang = (i * 2.4) % (2 * Math.PI);
      this.order(cx + Math.cos(ang) * 160, cy + Math.sin(ang) * 80, 0);
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 60));
    }
  }

  /** Centres the camera on a world-pixel position (defaults to the map centre). */
  lookAt(x?: number, y?: number) {
    const b = this.hud.info?.bounds;
    this.cam.x = x ?? (b ? (b[0] + b[2]) / 2 : this.cam.x);
    this.cam.y = y ?? (b ? (b[1] + b[3]) / 2 : this.cam.y);
    this.clampCam();
    this.sendView(true);
  }

  /** Pixel statistics of the next rendered frame (rendering checks without screenshots). */
  probePixels() {
    return new Promise<{ nonBackground: number; colors: number; meanRGB: number[] }>((resolve) => (this.renderer.pixelProbe = resolve));
  }

  bench(ticks: number) {
    this.set({ bench: "running..." });
    this.client.send({ type: "bench", ticks });
  }

  requestVerify() {
    this.set({ verify: "Replaying this session natively..." });
    this.client.send({ type: "log" });
  }

  private async verify(logJson: string) {
    try {
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: JSON.parse(this.scenarioJson), log: JSON.parse(logJson) }),
      });
      const r = await res.json();
      this.set({
        verify: r.error ? `Error: ${r.error}` : r.match
          ? `Identical: ${r.compared} of ${r.compared} net frames, wasm SyncHash = native (CoreCLR x64)`
          : `MISMATCH at frame ${r.firstMismatch} (${r.compared} compared)`,
      });
    } catch (e) {
      this.set({ verify: `Error: ${e}` });
    }
  }

  // ---------------------------------------------------------------- DOM input

  private mods(e: MouseEvent | KeyboardEvent) {
    return (e.shiftKey ? MOD_SHIFT : 0) | (e.altKey ? MOD_ALT : 0) | (e.ctrlKey ? MOD_CTRL : 0) | (e.metaKey ? MOD_META : 0);
  }

  private bind() {
    const c = this.canvas;
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("mouseenter", () => (this.mouse.inside = true));
    c.addEventListener("mouseleave", () => (this.mouse.inside = false));
    c.addEventListener("mousedown", (e) => {
      const [wx, wy] = this.toWorld(e.clientX, e.clientY);
      if (e.button === 0) this.drag = { x0: wx, y0: wy, active: false, pan: false, cx: e.clientX, cy: e.clientY };
      else if (e.button === 1) this.drag = { x0: wx, y0: wy, active: true, pan: true, cx: e.clientX, cy: e.clientY };
      else if (e.button === 2) this.order(Math.round(wx), Math.round(wy), this.mods(e));
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      const [wx, wy] = this.toWorld(e.clientX, e.clientY);
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      this.mouse.wx = wx;
      this.mouse.wy = wy;
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
    });
    window.addEventListener("mouseup", (e) => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      this.overlay.dragBox = null;
      if (d.pan) return;
      const [wx, wy] = this.toWorld(e.clientX, e.clientY);
      if (d.active) this.boxSelect(d.x0, d.y0, wx, wy, e.shiftKey);
      else if (e.button === 0) this.clickSelect(wx, wy, e.shiftKey);
    });
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const [wx, wy] = this.toWorld(e.clientX, e.clientY);
      const z = Math.min(3, Math.max(0.5, this.cam.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      // keep the point under the cursor fixed
      this.cam.x = wx - (wx - this.cam.x) * (this.cam.zoom / z);
      this.cam.y = wy - (wy - this.cam.y) * (this.cam.zoom / z);
      this.cam.zoom = z;
      this.clampCam();
      this.sendView(true);
    }, { passive: false });
    window.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      this.keys.add(e.key);
      if (e.key === "s" || e.key === "S") this.stop();
      if (e.key === "Escape") this.commitSelection([], false);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.key));
    window.addEventListener("blur", () => this.keys.clear());
    window.addEventListener("resize", () => this.sendView(true));
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.client.worker.terminate();
  }
}
