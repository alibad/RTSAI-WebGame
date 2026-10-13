// Game controller: owns the canvas, renderer and worker client; turns mouse/keyboard input into engine
// commands (selection, orders, modes, control groups); feeds the store the HUD renders from. The engine is the
// source of truth for selection, order modes and production; the page only predicts what it draws this frame.

import { TouchControls } from "./touch";
import { CoCommander } from "./cocommander";
import { Renderer, type Camera, type Overlay } from "./render/renderer";
import { SimClient } from "./sim/client";
import { savedMapFiles, type SavedMap } from "./net/saved-maps";
import type { Actor, SetupData, Snapshot, StartInfo, UiState } from "./sim/protocol";
import type { IconSprite } from "./render/icons";
import { store, type Perf } from "./store";
import { cursorFor, loadModCursors } from "./ui/cursors";
import { MouseLock } from "./pointer";
import { AudioEngine } from "./audio";
import { preferences } from "./preferences";
import { Sandbox, worldToCell } from "./sandbox";
import { Coach } from "./ai-lab";

// OpenRA enums
const MOD_SHIFT = 1, MOD_ALT = 2, MOD_CTRL = 4, MOD_META = 8;
const BTN_LEFT = 1, BTN_RIGHT = 2;
// ViewportControllerWidget with the default settings: edge scrolling within 5 px of the edge
// (ViewportEdgeScrollMargin), 30 view px per 25 ms (ViewportEdgeScrollStep), the same for the arrow keys.
const EDGE_PX = 5;
const SCROLL_PX_PER_MS = 30 / 25;
// The production tabs' hotkeys (the mod's ProductionTypeButton keys, hotkeys.yaml): E R T Y U I.
const TAB_KEYS: Record<string, string> = { KeyE: "Building", KeyR: "Support", KeyT: "Infantry", KeyY: "Vehicle", KeyU: "Aircraft", KeyI: "Ship" };
// MapBookmarkSave/Restore 01-04: Q W E R with Ctrl / Alt.
const BOOKMARK_KEYS: Record<string, number> = { KeyQ: 0, KeyW: 1, KeyE: 2, KeyR: 3 };

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
  multiplayer = false;
  readonly renderer: Renderer;
  readonly client: SimClient;
  readonly radar = new RadarModel();
  readonly audio = new AudioEngine();
  // Practice battles and encounters (sandbox scenarios) have no co-commander: it neither observes nor advises there.
  readonly cc = new CoCommander(this.audio, () => !this.coach.review && !this.multiplayer && !this.sandboxMatch && !this.replayMatch, {
    observe: () => this.client.adviserObserve(),
    execute: (id, commands, tick) => this.client.adviserExecute(id, commands, tick),
    status: (enabled, message) => this.client.adviserStatus(enabled, message),
  });
  readonly coach = new Coach(this);
  private lastListener = 0;
  private launchGeneration = 0;
  private artWait: ReturnType<typeof setInterval> | null = null;
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
  private cursorInFlight = false;
  /** When the hovered cell (or what is on it) last changed without the cursor answer yet. */
  private cursorAsked = 0;
  private cursorName = "default";
  private cursorAnswered = false;
  private cursorCss = new WeakMap<HTMLElement, string>();
  /** Hover-to-cursor times (ms): from the frame the pointer reached a new cell to the frame showing its cursor. */
  readonly cursorLatency: number[] = [];
  /** The minimap under the pointer (Minimap.tsx): the world position it points at. */
  minimapHover: { wx: number; wy: number; el: HTMLElement } | null = null;
  /** Shift, Alt, Ctrl, Meta held (engine Modifiers): they change the cursor (force-fire, force-move). */
  private modState = 0;
  private bookmarks: ([number, number, number] | null)[] = [null, null, null, null];
  /** Mouse lock (pointer.ts): keeps the mouse inside the game; edge scrolling at the window edges. */
  readonly lock: MouseLock;
  private lastView = "";
  private frames = 0;
  private fpsT = 0;
  private lastFrame = 0;
  /**
   * Most frames drawn a second (?fps=N; 0: every display refresh). The world ticks 25 times a second and is
   * interpolated between ticks, so 60 looks the same as every refresh of a 144 Hz screen, at well under half the work.
   */
  private readonly maxFps = (() => {
    const v = Number(new URLSearchParams(location.search).get("fps") ?? 60);
    return Number.isFinite(v) && v >= 0 ? v : 60;
  })();
  private nextDraw = 0;
  private lastDraw = 0;
  /** What the last drawn frame showed (shouldDraw skips an identical one). */
  private drawn: { snapshot: Snapshot | null; version: number; view: string } = { snapshot: null, version: -1, view: "" };
  private lastClick = { t: 0, id: -1 };
  private lastGroupTap = { t: 0, index: -1 };
  private iconRequested = new Set<string>();
  private iconQueue = new Map<string, IconSprite>();
  /** The last pointer was a finger (no edge scrolling, no hover). */
  private touching = false;
  private pendingLatency: { t0: number; tick: number; snapAt?: number } | null = null;
  private tickArrival = new Map<number, number>();
  private latency: number[] = [];
  private onKeyDown = (e: KeyboardEvent) => this.keyDown(e);
  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.key.toLowerCase());
    this.modState = this.mods(e);
    if (e.key.toLowerCase() === "v" && store.get().cc.listening) this.cc.stopListening();
  };
  /** Saved maps on this page by engine id: their Firestore id and whether their files are mounted (ensureMap). */
  private savedMaps = new Map<string, { saved: string; mounted: Promise<void> | null; ready: boolean }>();
  private mountWaiters = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  private onBlur = () => { this.keys.clear(); this.modState = 0; };
  private onMove = (e: MouseEvent) => this.mouseMove(e);
  private onUp = (e: MouseEvent) => this.mouseUp(e);

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.client = new SimClient(this.renderer);
    store.set({ shared: this.client.shared });
    this.client.onSnapshot = (s) => this.onSnapshot(s);
    this.client.onSheets = (uploaded, total) => store.set({ sheets: { uploaded, total } });
    this.renderer.onMissingTexture = (id) => this.client.needSheet(id);
    this.lock = new MouseLock(canvas, () => { this.lastCursorKey = ""; });
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
    c.on("mapMounted", (m) => {
      const waiter = this.mountWaiters.get(m.map);
      this.mountWaiters.delete(m.map);
      if (m.error) waiter?.reject(Error("Couldn't load this map.")); else waiter?.resolve();
    });
    c.on("mapGenerated", (m) => {
      const waiter = this.generateWaiter;
      this.generateWaiter = null;
      if (m.error || !m.map) { waiter?.reject(Error(m.error || "Couldn't make a map.")); return; }
      const s = store.get();
      if (s.setup && !s.setup.maps.some((x) => x.id === m.map)) {
        const url = m.png?.byteLength ? URL.createObjectURL(new Blob([m.png], { type: "image/png" })) : "";
        const players = m.players ?? 2;
        store.set({
          previews: { ...s.previews, [m.map]: url },
          setup: { ...s.setup, maps: [{ id: m.map, uid: m.map, title: m.title ?? "Random map", players, tileset: "TEMPERATE", author: "",
            generated: true, landscape: m.landscape, slots: Array.from({ length: players }, (_, i) => `Multi${i}`) }, ...s.setup.maps] },
        });
      }
      waiter?.resolve(m.map);
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
      this.cursorInFlight = false;
      if (m.seq !== this.cursorSeq) return;
      this.cursorName = m.cursor;
      if (m.cursor !== store.get().cursor) store.set({ cursor: m.cursor });
      this.cursorAnswered = true; // shown by the next frame (updateHover), which closes the measurement
    });
    c.on("cursorset", (m) => { loadModCursors(new Uint8Array(m.data)); this.lastCursorKey = ""; });
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
    c.on("companion", (m) => this.cc.onEngine(m.event));
  }

  private perf(p: Partial<Perf>) {
    store.set({ perf: { ...store.get().perf, ...p } });
  }

  boot(runtime: string, privateContent: boolean, profile = "") {
    store.set({ phase: "boot", runtime, profile, stage: "Starting the engine", error: "" });
    this.client.init(runtime, new URL("./", location.href).href, privateContent && !profile, new URLSearchParams(location.search).get("gc") ?? undefined, profile || undefined);
  }

  prepare(map: string) {
    const s = store.get();
    if (s.preparedMap === map || s.preparing === map) return;
    store.set({ preparing: map });
    if (!this.savedMaps.has(map)) { this.client.send({ type: "prepare", map }); return; }
    // A saved map is fetched and mounted first (once); the player may have picked another map meanwhile.
    void this.ensureMap(map).then(
      () => { if (store.get().preparing === map) this.client.send({ type: "prepare", map }); },
      () => { if (store.get().preparing === map) store.set({ preparing: null }); });
  }

  /**
   * Players' saved maps join the map list (net/saved-maps.ts). They are isometric `rtsai` maps, so only the isometric
   * game offers them. Their previews come with the list; the map files are fetched when a map is first used.
   */
  addSavedMaps(maps: SavedMap[]) {
    const s = store.get();
    if (!s.setup || s.profile !== "public" || !maps.length) return;
    const known = new Set(s.setup.maps.map((m) => m.id)), previews = { ...s.previews };
    const added: SetupData["maps"] = [];
    for (const m of maps) {
      if (!this.savedMaps.has(m.id)) this.savedMaps.set(m.id, { saved: m.saved, mounted: null, ready: false });
      if (known.has(m.id)) continue;
      known.add(m.id);
      previews[m.id] = URL.createObjectURL(new Blob([m.preview.slice()], { type: "image/png" }));
      added.push({ id: m.id, uid: m.id, title: m.title, players: m.players, tileset: "TEMPERATE", author: "", saved: m.saved, place: m.place,
        slots: Array.from({ length: m.players }, (_, i) => `Multi${i}`) });
    }
    if (added.length) store.set({ setup: { ...s.setup, maps: [...s.setup.maps, ...added] }, previews });
  }

  /** Fetches a saved map's files and mounts them in the engine (once); rejects with a message for the player. */
  ensureMap(map: string): Promise<void> {
    const entry = this.savedMaps.get(map);
    if (!entry) return Promise.resolve();
    return entry.mounted ??= (async () => {
      const files = await savedMapFiles(entry.saved, map);
      const png = await (await fetch(store.get().previews[map])).arrayBuffer();
      const bin = files.bin.slice().buffer;
      await new Promise<void>((resolve, reject) => {
        this.mountWaiters.set(map, { resolve, reject });
        this.client.send({ type: "mountMap", map, yaml: files.yaml, bin, png });
      });
      entry.ready = true;
      const { [map]: _, ...rest } = store.get().mapErrors;
      store.set({ mapErrors: rest });
    })().catch((e: unknown) => {
      entry.mounted = null;
      const error = e instanceof Error && e.message ? e.message : "Couldn't load this map. Check your connection and try again.";
      store.set({ mapErrors: { ...store.get().mapErrors, [map]: error } });
      throw Error(error);
    });
  }

  private generateWaiter: { resolve: (map: string) => void; reject: (e: Error) => void } | null = null;

  /**
   * Makes a random map with the engine's map generator, in the worker (MapGen.cs), and adds it to the setup's map list.
   * Resolves with its id. One at a time: a second request while one runs is refused.
   */
  generateMap(request: { seed: number; size?: number; players?: number; terrain?: string; resources?: string }): Promise<string> {
    if (this.generateWaiter) return Promise.reject(Error("A map is already being made."));
    return new Promise<string>((resolve, reject) => {
      this.generateWaiter = { resolve, reject };
      this.client.send({ type: "generateMap", request: JSON.stringify(request) });
    });
  }

  preview(map: string) {
    if (store.get().previews[map] !== undefined) return;
    store.set({ previews: { ...store.get().previews, [map]: "" } });
    this.client.send({ type: "preview", map });
  }

  start(scenarioJson: string, paused = false) {
    this.cancelPendingStart();
    const generation = this.launchGeneration;
    this.coach.reset();
    this.multiplayer = JSON.parse(scenarioJson).multiplayer === true;
    this.scenarioJson = scenarioJson;
    this.overlay.selected.clear();
    this.ui = null;
    this.latency = [];
    store.set({ phase: "loading", stage: "Building the world", ui: null, catalog: [], verify: "", menuOpen: false, paused });
    // A saved map not mounted yet (e.g. a guest's copy of the host's map) is fetched first.
    const map = String(JSON.parse(scenarioJson).map ?? "");
    if (this.savedMaps.has(map) && !this.savedMaps.get(map)!.ready) {
      store.set({ stage: "Loading the map" });
      void this.ensureMap(map).then(
        () => { if (generation === this.launchGeneration) this.afterMap(scenarioJson, paused, generation); },
        (e: Error) => { if (generation === this.launchGeneration) store.set({ phase: "error", error: e.message }); });
      return;
    }
    this.afterMap(scenarioJson, paused, generation);
  }

  private afterMap(scenarioJson: string, paused: boolean, generation: number) {
    const sides = scenarioFactions(scenarioJson);
    this.wantFactions(sides?.all ?? null, sides?.local);
    // Prebaked sprite sheets still streaming in: the world starts once they are on the GPU (nothing drawn invisible).
    const { uploaded, total } = store.get().sheets;
    if (uploaded < total) {
      store.set({ stage: "Loading art", detail: `${uploaded} / ${total}` });
      this.artWait = setInterval(() => {
        if (generation !== this.launchGeneration) return;
        const s = store.get().sheets;
        if (s.uploaded < s.total) { store.set({ detail: `${s.uploaded} / ${s.total}` }); return; }
        clearInterval(this.artWait!); this.artWait = null;
        store.set({ stage: "Building the world", detail: "" });
        this.launch(scenarioJson, paused, generation);
      }, 100);
      return;
    }
    this.launch(scenarioJson, paused, generation);
  }

  /**
   * The factions a game will show (null: not known yet, e.g. random): their sprite sheets load first. The game waits
   * only for `local`'s (the player's own; opponents start out of sight) when given.
   */
  wantFactions(factions: string[] | null, local?: string) {
    this.client.wantGroups(factions, factions && local ? [local] : factions);
  }

  cancelPendingStart() {
    this.cc.endMatch();
    this.launchGeneration++;
    if (this.artWait) clearInterval(this.artWait);
    this.artWait = null;
  }

  private launch(scenarioJson: string, paused: boolean, generation: number) {
    if (generation !== this.launchGeneration) return;
    // The co-commander (skirmish only): the local companion is started first, then the match with its bridge on.
    if (!store.get().cc.enabled || !store.get().ccAvailable || this.sandbox) {
      this.client.start(scenarioJson, paused);
      return;
    }
    if (store.get().cc.mode === "browser") {
      this.cc.matchStarted();
      this.client.start(scenarioJson, paused, "browser");
      return;
    }
    store.set({ stage: "Starting the co-commander" });
    this.cc.ensureRunning()
      .then(() => { if (generation !== this.launchGeneration) return; this.cc.matchStarted(); this.client.start(scenarioJson, paused, true); })
      .catch((e) => {
        if (generation !== this.launchGeneration) return;
        store.set({ cc: { ...store.get().cc, error: String(e instanceof Error ? e.message : e) } });
        this.client.start(scenarioJson, paused);
      });
  }

  quit() {
    this.cancelPendingStart();
    this.client.send({ type: "end" });
    this.audio.stop(-1);
    this.info = null;
    this.ui = null;
    store.set({ phase: "setup", info: null, ui: null, catalog: [], menuOpen: false, keysOpen: false, preparedMap: null });
    // A replay watched at 4x must not speed up the next match (the worker keeps its speed between worlds).
    this.client.send({ type: "speed", speed: 1 });
  }

  setPaused(paused: boolean) {
    if (this.multiplayer) return;
    this.client.send({ type: "pause", paused });
    this.audio.pause(-1, paused);
    store.set({ paused });
  }

  private cursorsRequested = false;
  /** A practice battle or encounter (a sandbox scenario), not a skirmish, mission or multiplayer match. */
  get sandboxMatch() { try { return JSON.parse(this.scenarioJson || "{}").sandbox === true; } catch { return false; } }
  /** Watching a saved match's recorded orders (MatchLibrary): nobody can command, so nothing offers orders. */
  get replayMatch() { try { return JSON.parse(this.scenarioJson || "{}").webReplay?.readonly === true; } catch { return false; } }
  /** Every unit's display name (the engine's tooltips), loaded once: the selection panel names units the build menu does not list. */
  private actorLabelsLoaded = false;
  private loadActorLabels() {
    if (this.actorLabelsLoaded) return;
    this.actorLabelsLoaded = true;
    void this.command<{ units?: { name: string; label: string }[] }>({ cmd: "units" }).then((r) => {
      const labels: Record<string, string> = {};
      for (const u of r.units ?? []) labels[u.name] = u.label.replace(/(\w+)\s+$/i, "$1");
      store.set({ actorLabels: labels });
    }).catch(() => { this.actorLabelsLoaded = false; });
  }
  /** The mod's cursors, asked once: by the menu as soon as the mod is loaded (ui/feel.ts), else by the first match. */
  requestCursors() { if (!this.cursorsRequested) { this.cursorsRequested = true; this.client.send({ type: "cursorset" }); } }

  captureUi() {
    return { cam: { ...this.cam }, bookmarks: this.bookmarks.map((b) => b ? [...b] : null), tab: store.get().tab };
  }
  private started(info: StartInfo, radarTerrain: ArrayBuffer, startMs: number) {
    this.requestCursors();
    this.loadActorLabels();
    // The sandbox keeps its camera between editing and running (it frames the placements itself).
    if (!this.sandbox || !this.info) this.cam = { x: info.start[0], y: info.start[1], zoom: 1 };
    this.info = info;
    const practice = JSON.parse(this.scenarioJson || "{}");
    if (!this.sandbox && practice.sandbox && practice.placements?.length) {
      const p = practice.placements as {u: number; v: number}[];
      const xs = p.map(a => a.u * info.tileSize[0]); const ys = p.map(a => a.v * info.tileSize[1] / 2);
      this.cam.zoom = Math.max(.35, Math.min(1.5, this.canvas.clientWidth / (Math.max(...xs) - Math.min(...xs) + 500), this.canvas.clientHeight / (Math.max(...ys) - Math.min(...ys) + 400)));
      this.cam.x = info.cellOrigin[0] + p.reduce((n, a) => n + 2 * a.u + (a.v & 1), 0) / p.length * info.tileSize[0] / 2;
      this.cam.y = info.cellOrigin[1] + p.reduce((n, a) => n + a.v, 0) / p.length * info.tileSize[1] / 2;
    }
    const savedView = practice.webReplay?.readonly ? null : practice.webReplay?.view;
    if (savedView?.cam && [savedView.cam.x, savedView.cam.y, savedView.cam.zoom].every(Number.isFinite)) {
      this.cam = { x: savedView.cam.x, y: savedView.cam.y, zoom: Math.max(0.35, Math.min(3, savedView.cam.zoom)) };
      if (Array.isArray(savedView.bookmarks) && savedView.bookmarks.length === 4)
        this.bookmarks = savedView.bookmarks.map((b: number[] | null) => b && b.length === 3 && b.every(Number.isFinite) ? [b[0], b[1], b[2]] : null);
      if (typeof savedView.tab === "string") store.set({ tab: savedView.tab });
    }
    const w = info.gridType === "Rectangular" ? info.mapSize[0] : info.mapSize[0] * 2 + 1;
    const h = info.mapSize[1];
    this.radar.terrain = new ImageData(new Uint8ClampedArray(radarTerrain), w, h);
    this.radar.width = w;
    this.radar.height = h;
    this.radar.cols = info.mapSize[0];
    this.radar.blips = new Int32Array(0);
    this.radar.bump();
    store.set({ phase: "playing", info, startMs, timings: { ...store.get().timings, ...info.timings } });
    this.sendView(true);
    const detail = { version: 1, event: "world-started", mode: store.get().profile === "public-classic" ? "classic" : "isometric", transport: practice.network?.peer ? "direct" : practice.multiplayer ? "room" : "singleplayer" };
    window.dispatchEvent(new CustomEvent("rtsai:world-started", { detail }));
    if (window.parent !== window) window.parent.postMessage({ type: "rtsai:world-started", ...detail }, location.origin);
  }

  private onUi(u: UiState) {
    u = { ...u, selection: u.selection ?? [], queues: u.queues ?? [] };
    const s = store.get();
    const catalog = u.catalog ?? s.catalog;
    u.selection ??= [];
    const previousSelection = this.ui?.selection ?? [];
    this.ui = u;
    this.overlay.selected = new Set(u.selection.map((a) => a.id));
    const patch: Partial<typeof s> = { ui: u };
    if (u.catalog) {
      patch.catalog = catalog;
      // Cameos for everything the sidebar can show.
      this.requestIcons(catalog.flatMap((q) => q.items.map((i) => i.name)));
    }
    this.requestIcons((u.selection ?? []).map((a) => a.type)); // empty while spectating (sandbox editor)
    // Keep the open tab on a queue that exists; prefer one with something ready.
    if (!catalog.some((q) => q.type === s.tab && q.items.length)) {
      const first = catalog.find((q) => q.items.length);
      if (first) patch.tab = first.type;
    }
    // Switch once on a new selection; leave manual tab choices alone on later UI ticks.
    const selectionChanged = u.selection.length !== previousSelection.length
      || u.selection.some((a, i) => a.id !== previousSelection[i]?.id || a.own !== previousSelection[i]?.own);
    if (selectionChanged && u.selection.length === 1 && u.selection[0].own) {
      const produces = u.selection[0].produces ?? [];
      const queue = catalog.find((q) => produces.includes(q.type) && q.items.length
        && u.queues.some((state) => state.type === q.type && state.enabled));
      if (queue) patch.tab = queue.type;
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
    this.coach.record(s, this.ui);
  }

  // ---------------------------------------------------------------- frame loop

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.lastFrame ? Math.min(100, now - this.lastFrame) : 16;
    this.lastFrame = now;
    const playing = store.get().phase === "playing";
    if (playing) this.scroll(dt);
    this.client.poll(performance.now());
    const cur = this.client.cur;
    this.updateHover(cur);
    this.overlay.markers = this.sandboxMarkers();
    // Outside a match the canvas is hidden behind the menus (App.tsx): drawing it there was full-screen work every frame.
    const replay = playing ? (this.coach.review ? [this.coach.review.snapshot, null] as const : this.sandbox?.replayFrame()) : null;
    if (playing && this.shouldDraw(now, cur, !!replay)) {
      if (replay) this.renderer.render(replay[0], replay[1], this.cam, this.overlay, replay[0].receivedAt + 40);
      else this.renderer.render(cur, this.client.prev, this.cam, this.overlay, performance.now());
      this.frames++;
    }
    if (this.iconQueue.size) this.rasterIcons();
    if (now - this.lastListener > 100) { this.audio.setListener(this.cam.x, this.cam.y); this.lastListener = now; }

    const pl = this.pendingLatency;
    if (pl?.snapAt && cur) {
      this.latency.push(performance.now() - pl.t0);
      if (this.latency.length > 200) this.latency.shift();
      this.pendingLatency = null;
    }

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

  /**
   * Whether this display refresh draws: at most maxFps frames a second, and only when the frame would differ from
   * the last one drawn (a new or still-interpolating tick, a camera or overlay change, new textures...). A paused
   * game or an idle view draws only the 4-a-second safety refresh.
   */
  private shouldDraw(now: number, cur: Snapshot | null, replaying: boolean) {
    const interval = this.maxFps > 0 ? 1000 / this.maxFps : 0;
    if (now < this.nextDraw - 1) return false;
    const r = this.renderer, ov = this.overlay, c = this.canvas;
    let selected = 0;
    for (const id of ov.selected) selected += id;
    const view = [this.cam.x, this.cam.y, this.cam.zoom, c.clientWidth, c.clientHeight, window.devicePixelRatio, ov.hover,
      ov.selected.size, selected, ov.dragBox, ov.statusBars, JSON.stringify(ov.markers ?? [])].join();
    const interpolating = !!cur && now - cur.receivedAt < 60; // ticks are 40 ms apart, drawn in between
    const flashing = !!ov.orderFlash && now - ov.orderFlash.t < 650;
    const changed = replaying || interpolating || flashing || cur !== this.drawn.snapshot || r.version !== this.drawn.version
      || view !== this.drawn.view || r.pixelProbe !== null || r.frameGrab !== null || now - this.lastDraw > 250;
    if (!changed) return false;
    if (this.nextDraw + interval < now) this.nextDraw = now; // after idle refreshes: restart the cadence
    this.nextDraw += interval;
    this.lastDraw = now;
    this.drawn = { snapshot: cur, version: r.version, view };
    return true;
  }

  // ---------------------------------------------------------------- camera

  /** Client (CSS) coordinates to world: the camera works in CSS pixels at any device pixel ratio (Renderer.viewSize). */
  private toWorld(clientX: number, clientY: number): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [this.cam.x + (clientX - r.left - r.width / 2) / this.cam.zoom, this.cam.y + (clientY - r.top - r.height / 2) / this.cam.zoom];
  }

  /** The visible world rectangle (x0, y0, x1, y1) for the minimap frame. */
  viewRect(): [number, number, number, number] {
    const [W, H] = Renderer.viewSize(this.canvas, this.cam.zoom);
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

  /** Edge directions (x, y in -1..1) of the pointer: the window edges while locked, else none. */
  private edgeDirections(): [number, number] {
    if (!this.lock.locked || !document.hasFocus()) return [0, 0];
    const x = this.lock.x, y = this.lock.y;
    return [x < EDGE_PX ? -1 : x >= window.innerWidth - EDGE_PX ? 1 : 0, y < EDGE_PX ? -1 : y >= window.innerHeight - EDGE_PX ? 1 : 0];
  }

  private scroll(dt: number) {
    let ux = 0, uy = 0;
    const k = this.keys;
    if (!k.has("alt")) {
      if (k.has("arrowleft")) ux -= 1;
      if (k.has("arrowright")) ux += 1;
      if (k.has("arrowup")) uy -= 1;
      if (k.has("arrowdown")) uy += 1;
    }
    if (this.lock.locked) {
      // Mouse locked: the drawn cursor at a window edge (ViewportControllerWidget.CheckForDirections).
      const [ex, ey] = this.edgeDirections();
      ux = ux || ex;
      uy = uy || ey;
    } else if (!this.lock.enabled && this.mouse.inside && !this.touching && !this.drag && document.hasFocus()) {
      // Mouse lock turned off: the battlefield's own edges, as before. (Unlocked with the lock on: none, the
      // cursor could leave the window.)
      const r = this.canvas.getBoundingClientRect();
      if (this.mouse.sx < r.left + EDGE_PX) ux = ux || -1;
      if (this.mouse.sx >= r.right - EDGE_PX) ux = ux || 1;
      if (this.mouse.sy < r.top + EDGE_PX) uy = uy || -1;
      if (this.mouse.sy >= r.bottom - EDGE_PX) uy = uy || 1;
    }
    if (ux || uy) {
      // Rate for a 25 ms step, diagonals no faster (UpdateCameraTick); view (CSS) px to world px.
      const step = (Math.min(dt, 25) * SCROLL_PX_PER_MS * preferences.scroll) / (this.cam.zoom * Math.max(1, Math.hypot(ux, uy)));
      this.cam.x += ux * step;
      this.cam.y += uy * step;
      this.clampCam();
      this.sendView();
    }
  }

  /** The scroll cursor at a window edge while locked, "-blocked" where the map ends (ViewportControllerWidget). */
  private edgeCursor(): string | null {
    const [ex, ey] = this.edgeDirections();
    if (!ex && !ey) return null;
    const b = this.info?.bounds;
    const blockedX = !!b && ((ex < 0 && this.cam.x <= b[0]) || (ex > 0 && this.cam.x >= b[2]));
    const blockedY = !!b && ((ey < 0 && this.cam.y <= b[1]) || (ey > 0 && this.cam.y >= b[3]));
    const name = "scroll-" + (ey < 0 ? "t" : ey > 0 ? "b" : "") + (ex < 0 ? "l" : ex > 0 ? "r" : "");
    return name + ((ex && ey ? blockedX && blockedY : blockedX || blockedY) ? "-blocked" : "");
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
    const playing = store.get().phase === "playing";
    const locked = this.lock.locked;
    // What the pointer is over: the battlefield, the minimap, or the HUD.
    let surface: "map" | "minimap" | null = null;
    let wx = 0, wy = 0;
    let el: HTMLElement | null = null;
    if (locked) {
      const under = this.lock.elementAt();
      if (under === this.canvas) { surface = "map"; [wx, wy] = this.toWorld(this.lock.x, this.lock.y); el = this.canvas; }
      else if (this.minimapHover && under === this.minimapHover.el) { surface = "minimap"; ({ wx, wy, el } = this.minimapHover); }
    } else if (this.minimapHover) { surface = "minimap"; ({ wx, wy, el } = this.minimapHover); }
    else if (this.mouse.inside) { surface = "map"; wx = this.mouse.wx; wy = this.mouse.wy; el = this.canvas; }
    if (!playing || !s) surface = null;

    const a = surface === "map" && s ? this.actorAt(wx, wy, s) : null;
    this.overlay.hover = a && a.flags & 1 ? a.id : null;

    let name = "default";
    if (surface) {
      // The engine's answer (OrderGenerator.GetCursor) for this cell and what is on it, asked at most once per
      // frame and never twice at once; a 4 px grid keeps it exact at cell borders.
      const sel = [...this.overlay.selected].join(",");
      const key = `${surface}|${Math.round(wx / 4)},${Math.round(wy / 4)}|${a?.id ?? -1}|${sel}|${this.ui?.mode ?? ""}|${this.modState}`;
      if (key !== this.lastCursorKey && !this.drag?.active) {
        if (!this.cursorAsked) this.cursorAsked = performance.now();
        if (!this.cursorInFlight) {
          this.lastCursorKey = key;
          this.cursorInFlight = true;
          this.client.send({ type: "cursor", x: wx, y: wy, mods: this.modState | (surface === "minimap" ? 0x10000 : 0), seq: ++this.cursorSeq });
        }
      }
      name = this.cursorName;
    }
    const edge = locked ? this.edgeCursor() : null;
    if (edge) name = edge;
    if (this.cursorAnswered && !this.cursorInFlight && this.lastCursorKey) {
      // Hover to cursor shown: from the frame the pointer reached the new cell to this frame.
      this.cursorAnswered = false;
      if (this.cursorAsked) {
        this.cursorLatency.push(performance.now() - this.cursorAsked);
        if (this.cursorLatency.length > 300) this.cursorLatency.shift();
        this.cursorAsked = 0;
      }
    }
    if (locked) {
      this.lock.setCursor(name);
      this.lock.draw();
    } else if (el) {
      const css = cursorFor(name, performance.now());
      if (this.cursorCss.get(el) !== css) { el.style.cursor = css; this.cursorCss.set(el, css); }
    }
  }

  /** Hover-to-cursor time (ms): median and p95 of the last changes. */
  cursorLatencyStats() {
    const v = [...this.cursorLatency].sort((x, y) => x - y);
    const q = (f: number) => (v.length ? v[Math.min(v.length - 1, Math.floor(f * v.length))] : 0);
    return { n: v.length, median: q(0.5), p95: q(0.95), max: v.at(-1) ?? 0 };
  }

  setMouseLock(on: boolean) {
    this.lock.setEnabled(on);
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
    if (this.coach.review) return;
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
    if (this.coach.review && !["stats", "ai-lab", "placements", "units"].includes(String(cmd.cmd))) return Promise.resolve({ error: "Return live before issuing orders." } as T);
    return this.client.command<T>(cmd);
  }

  setMode(mode: string) {
    const current = this.ui?.mode ?? "";
    this.command({ cmd: "mode", mode: current === mode ? "none" : mode });
  }

  async group(index: number, action: "select" | "create" | "add" | "combine" | "jump") {
    const r = await this.command<{ selection?: number[]; center?: [number, number] }>({ cmd: "group", index, action });
    if (action === "jump") { if (r.center) this.lookAt(r.center[0], r.center[1]); return; }
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
    if (this.multiplayer) { store.set({ verify: "Benchmarks are unavailable during multiplayer." }); return; }
    store.set({ verify: "Benchmarking..." });
    this.client.send({ type: "bench", ticks });
  }

  requestVerify() {
    if (this.multiplayer) { store.set({ verify: "The room server compares both players' OpenRA hashes every frame." }); return; }
    store.set({ verify: "Replaying this game natively..." });
    this.client.send({ type: "log" });
  }

  private async verifyNative(logJson: string) {
    try {
      const res = await fetch(new URL("api/verify", new URL("./", location.href)), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: JSON.parse(this.scenarioJson), log: JSON.parse(logJson), profile: store.get().profile || undefined }),
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

  /**
   * The next battlefield frame exactly as drawn (the WebGL canvas at device resolution, without the DOM HUD), for
   * feedback screenshots. Rejects when no world frame is drawn in time (no match running, or the tab is hidden).
   */
  captureFrame(timeoutMs = 1500) {
    return new Promise<HTMLCanvasElement>((resolve, reject) => {
      const done = (frame: HTMLCanvasElement) => { clearTimeout(timer); resolve(frame); };
      const timer = setTimeout(() => {
        if (this.renderer.frameGrab === done) this.renderer.frameGrab = null;
        reject(new Error("No battlefield frame was drawn"));
      }, timeoutMs);
      this.renderer.frameGrab = done;
    });
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
      this.cam.x -= (e.clientX - d.cx) / this.cam.zoom;
      this.cam.y -= (e.clientY - d.cy) / this.cam.zoom;
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
    // Edge scrolling and hover follow a mouse; a touch screen has neither (its taps still send mouseenter).
    window.addEventListener("pointermove", (e) => { this.touching = e.pointerType === "touch"; }, { passive: true });
    window.addEventListener("pointerdown", (e) => { this.touching = e.pointerType === "touch"; }, { passive: true, capture: true });
    // Touch (phones, tablets): tap, long-press, one-finger box, two-finger pan and pinch (touch.ts).
    new TouchControls(c, {
      toWorld: (x, y) => this.toWorld(x, y),
      ownAt: (wx, wy) => { const s = this.client.cur; const a = s && this.actorAt(wx, wy, s); return !!(s && a && this.ownSelectable(s, a)); },
      hasSelection: () => this.overlay.selected.size > 0,
      mode: () => this.ui?.mode ?? "",
      select: (wx, wy) => { store.set({ menuOpen: false }); this.clickSelect(wx, wy, false); },
      order: (wx, wy) => this.click(wx, wy, BTN_RIGHT, 0),
      modeClick: (wx, wy) => this.click(wx, wy, BTN_LEFT, 0),
      boxSelect: (x0, y0, x1, y1) => this.boxSelect(x0, y0, x1, y1, false),
      setBox: (box) => { this.overlay.dragBox = box; },
      clear: () => { if (this.ui?.mode) this.command({ cmd: "mode", mode: "none" }); else this.select([]); },
      pan: (dx, dy) => {
        this.cam.x -= dx / this.cam.zoom;
        this.cam.y -= dy / this.cam.zoom;
        this.clampCam();
        this.sendView();
      },
      zoomAt: (x, y, factor) => {
        const [wx, wy] = this.toWorld(x, y);
        const z = Math.min(3, Math.max(0.35, this.cam.zoom * factor));
        this.cam.x = wx - (wx - this.cam.x) * (this.cam.zoom / z);
        this.cam.y = wy - (wy - this.cam.y) * (this.cam.zoom / z);
        this.cam.zoom = z;
        this.clampCam();
        this.sendView(true);
      },
    });
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("mouseenter", () => (this.mouse.inside = true));
    c.addEventListener("mouseleave", () => (this.mouse.inside = false));
    c.addEventListener("mousedown", (e) => {
      if (this.coach.review) return;
      this.lock.maybeLock(e);
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
      const z = Math.min(3, Math.max(0.35, this.cam.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
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

  /**
   * The desktop game's hotkeys, as the mod binds them (mods/common/hotkeys/*.yaml and the mod's hotkeys.yaml, wired by
   * its ingame chrome), each doing what its widget logic does. ui/Hotkeys.tsx lists them.
   */
  private keyDown(e: KeyboardEvent) {
    if (this.coach.review && e.key !== "Escape" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) return;
    const tag = (e.target as HTMLElement)?.tagName;
    this.modState = this.mods(e);
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement)?.isContentEditable || store.get().phase !== "playing") return;
    const k = e.key.toLowerCase();
    const code = e.code;
    this.keys.add(k);
    const ctrl = e.ctrlKey || e.metaKey, alt = e.altKey, shift = e.shiftKey;
    const done = () => e.preventDefault();

    if (e.key === "Escape") {
      if (this.coach.review) { this.coach.live(); return done(); }
      // The Esc that released the mouse lock is the browser's, not the game's.
      if (this.lock.locked || performance.now() - this.lock.releasedAt < 400) return;
      const st = store.get();
      if (st.keysOpen) store.set({ keysOpen: false });
      else if (st.menuOpen) store.set({ menuOpen: false });
      else if (this.ui?.mode) this.command({ cmd: "mode", mode: "none" });
      else store.set({ menuOpen: true }); // the options menu (MenuButton OPTIONS_BUTTON, Key: escape)
      return done();
    }
    if (e.key === "?" || (e.key === "/" && shift)) { store.set({ keysOpen: !store.get().keysOpen }); return done(); }
    if (e.key === "Pause" || (k === "p" && !ctrl && !alt)) { this.setPaused(!store.get().paused); return done(); }

    // Control groups (ControlGroupsWidget): N select (twice: jump), Ctrl+N create, Ctrl+Shift+N add to,
    // Shift+N combine with, Alt+N jump to.
    const digit = code.startsWith("Digit") ? Number(code.slice(5)) : -1;
    if (digit >= 0) {
      const index = digit === 0 ? 9 : digit - 1;
      if (alt) this.group(index, "jump");
      else if (ctrl && shift) this.group(index, "add");
      else if (ctrl) this.group(index, "create");
      else if (shift) this.group(index, "combine");
      else this.group(index, "select");
      return done();
    }

    // Production (ProductionPaletteWidget, HotkeyPrefix Production, HotkeyCount 24): F1-F12 the palette's icons,
    // Ctrl+F1-F12 the 13th-24th; Shift builds five. A left click on the icon, as the desktop.
    const fkey = /^F(\d{1,2})$/.exec(e.key);
    if (fkey && !alt) {
      const n = Number(fkey[1]) - 1 + (ctrl ? 12 : 0);
      const tab = store.get().tab;
      const item = store.get().catalog.find((c) => c.type === tab)?.items[n];
      if (item) this.command({ cmd: "produce", queue: tab, item: item.name, count: shift ? 5 : 1, front: false });
      return done();
    }
    // Production tabs (ProductionTypeButton): E R T Y U I.
    if (TAB_KEYS[code] && !ctrl && !alt) {
      // As its button: only when that production is available (ProductionTypeButton.IsDisabled).
      const type = TAB_KEYS[code];
      const st = store.get();
      const enabled = (st.ui?.queues?.find((q) => q.type === type)?.enabled ?? false) && !!st.catalog.find((c) => c.type === type)?.items.length;
      if (enabled) store.set({ tab: type });
      return done();
    }

    // Viewport (ViewportControllerWidget): Alt+arrows jump to the map edges, [ ] zoom, . reset, Ctrl+Q/W/E/R save a
    // bookmark, Alt+Q/W/E/R go back to it. Plain arrows scroll (scroll()).
    if (alt && k.startsWith("arrow") && this.info) {
      const b = this.info.bounds;
      if (k === "arrowup") this.lookAt(this.cam.x, b[1]);
      if (k === "arrowdown") this.lookAt(this.cam.x, b[3]);
      if (k === "arrowleft") this.lookAt(b[0], this.cam.y);
      if (k === "arrowright") this.lookAt(b[2], this.cam.y);
      return done();
    }
    if (code in BOOKMARK_KEYS && (ctrl || alt) && !(ctrl && alt)) {
      const i = BOOKMARK_KEYS[code];
      if (ctrl) this.bookmarks[i] = [this.cam.x, this.cam.y, this.cam.zoom];
      else if (this.bookmarks[i]) { const [x, y, z] = this.bookmarks[i]!; this.cam.zoom = z; this.lookAt(x, y); }
      return done();
    }
    if (!ctrl && !alt && (code === "BracketRight" || code === "BracketLeft" || code === "Period")) {
      this.cam.zoom = code === "Period" ? 1 : Math.min(3, Math.max(0.35, this.cam.zoom * (code === "BracketRight" ? 1.25 : 0.8)));
      this.clampCam();
      this.sendView(true);
      return done();
    }
    // DisableUserInterface (Shift+=) / DisableAllUserInterface (Alt+Shift+=): hide the HUD.
    if (code === "Equal" && shift) { store.set({ uiHidden: !store.get().uiHidden }); return done(); }

    // Co-commander: G, or J, applies the displayed recommendation; modified shortcuts remain available.
    if ((code === "KeyG" || code === "KeyJ") && !ctrl && !alt && !shift) {
      const p = this.cc.pending();
      if (p && !e.repeat) void this.cc.decide(p, true);
      return done();
    }
    if (ctrl && code === "Space") { (document.querySelector("[data-cc-input]") as HTMLInputElement | null)?.focus(); return done(); }
    if (ctrl && (code === "Enter" || code === "Backspace")) {
      if (e.repeat) return done();
      const p = this.cc.pending();
      if (p) this.cc.decide(p, code === "Enter");
      return done();
    }

    // Unit stances (StanceSelector, Alt+A/S/D/F).
    if (alt && !ctrl) {
      const stance = ({ KeyA: "attackanything", KeyS: "defend", KeyD: "returnfire", KeyF: "holdfire" } as Record<string, string>)[code];
      if (stance) { this.command({ cmd: "stance", stance }); return done(); }
      return;
    }

    // Command bar: A attack move (also with Ctrl/Shift held), D guard, F deploy, Ctrl+X scatter, S stop; Shift queues.
    if (code === "KeyA") { this.setMode("attackmove"); return done(); }
    if (code === "KeyX" && ctrl) { this.command({ cmd: "scatter", queued: shift }); return done(); }
    if (ctrl && code === "Tab") { this.cycle("cycleproduction"); return done(); }
    if (ctrl) return;
    switch (code) {
      case "KeyS": this.command({ cmd: "stop" }); break;
      case "KeyD": this.setMode("guard"); break;
      case "KeyF": this.command({ cmd: "deploy", queued: shift }); break;
      // Sidebar buttons: Z sell, C repair, B beacon.
      case "KeyZ": this.setMode("sell"); break;
      case "KeyC": this.setMode("repair"); break;
      case "KeyB": this.setMode("beacon"); break;
      // WORLD_KEYHANDLER logics.
      case "KeyQ": this.selectHotkey("selectall"); break;
      case "KeyW": this.selectHotkey("selecttype"); break;
      case "KeyH": this.cycle("cyclebase"); break;
      case "KeyN": this.cycle("cycleharvester"); break;
      case "Home": this.cycle("toselection"); break;
      case "Space": this.cycle("lastevent"); break;
      case "Comma": this.overlay.statusBars = ((this.overlay.statusBars ?? 0) + 1) % 3; break;
      case "KeyM": this.audio.setMuted(!this.audio.muted); break;
      // Co-commander push-to-talk (this page's own).
      case "KeyV": if (store.get().cc.enabled && !e.repeat) this.cc.startListening(); break;
      default: return;
    }
    done();
  }

  /** SelectAllUnits (Q) / SelectUnitsByType (W): the units on screen, or across the map when that adds nothing. */
  private async selectHotkey(cmd: "selectall" | "selecttype") {
    const [x0, y0, x1, y1] = this.viewRect();
    const r = await this.command<{ selection?: number[] }>({ cmd, x0: Math.floor(x0), y0: Math.floor(y0), x1: Math.ceil(x1), y1: Math.ceil(y1), mods: this.modState });
    if (r.selection) { this.overlay.selected = new Set(r.selection); this.lastCursorKey = ""; }
  }

  /** Cycle base / harvesters / production buildings, jump to the selection or the last event. */
  private async cycle(cmd: string) {
    const r = await this.command<{ selection?: number[]; center?: [number, number] }>({ cmd });
    if (r.selection) { this.overlay.selected = new Set(r.selection); this.lastCursorKey = ""; }
    if (r.center) this.lookAt(r.center[0], r.center[1]);
  }

  dispose() {
    this.cancelPendingStart();
    cancelAnimationFrame(this.raf);
    window.removeEventListener("mousemove", this.onMove);
    window.removeEventListener("mouseup", this.onUp);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.client.dispose();
    this.lock.dispose();
  }
}

/**
 * The factions of a scenario's players and the local human's faction, or null when one is
 * random (resolved only when the world is created).
 */
function scenarioFactions(scenarioJson: string): { all: string[]; local?: string } | null {
  try {
    const s = JSON.parse(scenarioJson) as { localClient?: number; multiplayer?: boolean; players?: { client?: number; faction?: string; bot?: string }[]; sandbox?: boolean; placements?: unknown[] };
    const players = s.players ?? [];
    const factions = players.map((p) => p.faction ?? "random");
    if (factions.some((f) => !f || f.startsWith("random"))) return null;
    // A sandbox shows both sides from the start: wait for both.
    return { all: factions, local: s.sandbox || s.placements?.length ? undefined : players.find((p) => !p.bot && (!s.multiplayer || p.client === s.localClient))?.faction };
  } catch {
    return null;
  }
}
