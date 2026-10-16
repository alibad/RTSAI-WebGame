/// <reference lib="webworker" />
// The simulation worker: hosts the .NET WebAssembly runtime running the real OpenRA engine + RTS AI mod,
// ticks the world at 25 tps and publishes one snapshot per tick into a SharedArrayBuffer ring, plus the game-UI
// state (credits, power, queues, selection), shroud and radar for the page's HUD.

import {
  RING_BYTES, RING_HEADER_BYTES, RING_GENERATION_AT, RING_LEN_AT, RING_SEQ_AT, RING_SLOTS, RING_SLOT_BYTES,
  textureUpdates, type FromWorker, type ToWorker,
} from "./protocol";
import { LazyMount, httpRangeReader, httpRangeReaderAsync, mountPack, wholeFileReader, wholeFileReaderAsync } from "./lazyfs";
import { normalizeVoiceLanguage } from "../voice-language";
import { CompanionRelay } from "./companion";
import { encodeAdviserStatus } from "./adviser-rpc";
import { fetchShippedSprites, SpriteBake, hashString } from "./spritecache";
import { fluentActorNames, fluentFiles } from "./fluent-names";

declare const self: DedicatedWorkerGlobalScope;

const TICK_MS = 40;
const RADAR_EVERY = 5; // ticks between radar blip updates

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let S: any = null;
let generation = 0;
let voiceLanguage = "faction";
let booted = false;
// Direct multiplayer: frames arrive from the page's lockstep (peerFrame); the worker only reports its own orders.
let network: { generation: number; frame: number; stopped: boolean } | null = null; // [JSExport] surface of OpenRA.WebSim.Browser.Interop
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runtimeApi: any = null;
let base = "/";
let lazy: LazyMount | null = null;
const mountedMaps = new Set<string>();
let ringHeader: Int32Array | null = null;
let ringBytes: Uint8Array | null = null;
let seq = 0;
let running = false;
let paused = false;
let replayEnd: number | null = null;
let runtimeErrors: string[] = [];
let nextTick = 0;
let tickTimes: number[] = [];
let lateTicks = 0;
let ticksThisSecond = 0;
let tps = 0;
let lastSecond = 0;
let ticks = 0;
let lastUi = "";
let timer: ReturnType<typeof setTimeout> | null = null;
let tickMs = TICK_MS; // 40 ms at 1x; the sandbox can run faster
let bake: SpriteBake | null = null; // prebaked sprite sheets (IndexedDB)
let browserAdviser = false;
let nextAdviserCall = -1; // Negative ids are disjoint from the local relay's positive ids.
const adviserCalls = new Map<number, { req: number; generation: number; timer: ReturnType<typeof setTimeout> }>();
function cancelAdviserCalls() {
  for (const [call, pending] of adviserCalls) {
    clearTimeout(pending.timer);
    post({ type: "adviserReply", req: pending.req, code: 9, message: "Co-commander world request cancelled", payload: new Uint8Array(), generation: pending.generation });
    adviserCalls.delete(call);
  }
}
function adviserReply(call: number, code: number, message: string, payload: Uint8Array) {
  const pending = adviserCalls.get(call);
  if (!pending) { if (call > 0) relay?.reply(call, code, message, payload); return; }
  adviserCalls.delete(call); clearTimeout(pending.timer);
  if (pending.generation !== generation) return;
  post({ type: "adviserReply", req: pending.req, code, message, payload, generation: pending.generation });
}
let relay: CompanionRelay | null = null; // the AI co-commander's RPC relay (local companion <-> CompanionBridge)

/** A snapshot without advancing the world (paused game, sandbox editing, camera moves while paused). */
function refresh() {
  if (!S) return;
  S.Refresh();
  sendUi();
  sendShroud(false);
}

function post(msg: FromWorker, transfer: Transferable[] = []) {
  self.postMessage({ ...msg, generation: msg.generation ?? generation }, transfer);
}

function publish(view: { slice(): Uint8Array; length: number }) {
  const bytes = view.slice();
  seq++;
  if (ringHeader && ringBytes && bytes.length <= RING_SLOT_BYTES) {
    const slot = seq % RING_SLOTS;
    ringBytes.set(bytes, RING_HEADER_BYTES + slot * RING_SLOT_BYTES);
    Atomics.store(ringHeader, RING_GENERATION_AT + slot, generation);
    Atomics.store(ringHeader, RING_LEN_AT + slot, bytes.length);
    Atomics.store(ringHeader, RING_SEQ_AT + slot, seq);
    Atomics.store(ringHeader, 0, seq);
  } else {
    // Too big for a slot (or no shared memory): send it by message, then mark the seq as published so the
    // page knows to wait for that message instead of reading the ring.
    const copy = bytes.slice();
    post({ type: "snapshot", bytes: copy.buffer, seq }, [copy.buffer]);
    if (ringHeader) {
      const slot = seq % RING_SLOTS;
      Atomics.store(ringHeader, RING_GENERATION_AT + slot, generation);
      Atomics.store(ringHeader, RING_SEQ_AT + slot, 0);
      Atomics.store(ringHeader, 0, seq);
    }
  }

  for (const t of textureUpdates(bytes)) {
    // kind 2: a render target (voxel framebuffer sheet) the page draws into itself; it has no pixels here.
    const buf = t.kind === 2 ? new ArrayBuffer(0) : (S.Texture(t.id) as Uint8Array).slice().buffer;
    post({ type: "texture", ...t, data: buf }, [buf]);
  }
  const changed: string = S.ChangedModelBuffers();
  if (changed)
    for (const id of changed.split(",").map(Number)) {
      const data = (S.ModelBuffer(id) as Uint8Array).slice().buffer;
      post({ type: "modelbuffer", id, data }, [data]);
    }
}

let bundleTag = "";

async function fetchBytes(url: string, stage: string, started?: Promise<Response>) {
  post({ type: "progress", stage, detail: url });
  const res = await (started ?? fetch(url));
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  bundleTag = res.headers.get("etag") ?? String(res.headers.get("content-length"));
  return new Uint8Array(await res.arrayBuffer());
}

function resourceBytes(): Record<string, number> {
  const out: Record<string, number> = { runtime: 0, bundle: 0, private: 0 };
  for (const e of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
    const size = e.transferSize || e.encodedBodySize || 0;
    if (e.name.includes("/rt/")) out.runtime += size;
    else if (e.name.includes("/data/")) out.bundle += size;
    else if (e.name.includes("/private/")) out.private += size;
  }
  if (lazy) out.private = lazy.stats.fetchedBytes;
  return out;
}

async function init(msg: Extract<ToWorker, { type: "init" }>) {
  const t0 = performance.now();
  base = msg.base;
  if (msg.sab) {
    ringHeader = new Int32Array(msg.sab, 0, RING_HEADER_BYTES / 4);
    ringBytes = new Uint8Array(msg.sab, 0, RING_BYTES);
  }

  post({ type: "progress", stage: "Starting the engine", detail: msg.runtime });
  // Profiles (e.g. "public", the standalone game) have their own runtime build and data under data/<profile>/.
  const profileDir = msg.profile ? `${msg.profile}/` : "";
  // The game data downloads alongside the runtime (the engine needs both to boot).
  const bundleRequest = fetch(new URL(`${msg.dataBase ?? "data/"}${profileDir}web-bundle.pack`, msg.base).href);
  // A static public build serves runtime and data under content-hashed roots (cached forever); "rt/", "data/" locally.
  const dataRoot = msg.dataBase ?? "data/";
  const runtimeUrl = new URL(`${msg.rtBase ?? "rt/"}${profileDir}${msg.runtime}/_framework/dotnet.js`, base).href;
  // dotnet.js treats a worker that already has an onmessage handler as one of its own pthread workers and
  // waits for a thread handshake that never comes. Declare this worker a "sidecar" (a single-threaded host).
  (globalThis as unknown as { dotnetSidecar: boolean }).dotnetSidecar = true;
  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...values: unknown[]) => { runtimeErrors.push(values.map(String).join(" ")); runtimeErrors = runtimeErrors.slice(-12); original(...values); };
  }
  const { dotnet } = await import(/* @vite-ignore */ runtimeUrl);
  // A soft heap limit makes the GC collect before growing the heap (WebAssembly memory never shrinks, so the
  // high-water mark during loading is what the tab keeps).
  // English UI: pins the small EFIGS culture data (otherwise the browser locale picks a 1 MB shard).
  runtimeApi = await dotnet.withModuleConfig({ printErr: (line: string) => { runtimeErrors.push(line); runtimeErrors = runtimeErrors.slice(-12); } }).withDiagnosticTracing(false).withApplicationCulture("en-US").withEnvironmentVariable("MONO_GC_PARAMS", msg.gcParams ?? "soft-heap-limit=200m").create();
  runtimeApi.setModuleImports("websim", {
    publish,
    // Sounds the engine plays (WebSoundEngine): PCM once per source, then events; music as PCM chunks.
    soundSource: (id: number, channels: number, bits: number, rate: number, view: { slice(): Uint8Array }) => {
      const data = view.slice().buffer as ArrayBuffer;
      post({ type: "audio", op: "source", id, channels, bits, rate, data }, [data]);
    },
    soundPlay: (sound: number, source: number, loop: boolean, relative: boolean, x: number, y: number, volume: number, attenuate: boolean) =>
      post({ type: "audio", op: "play", sound, source, loop, relative, x, y, volume, attenuate }),
    soundStream: (sound: number, channels: number, bits: number, rate: number, view: { slice(): Uint8Array }, end: boolean, volume: number) => {
      const data = view.slice().buffer as ArrayBuffer;
      post({ type: "audio", op: "stream", sound, channels, bits, rate, data, end, volume }, [data]);
    },
    soundStop: (sound: number) => post({ type: "audio", op: "stop", sound }),
    soundVolume: (sound: number, volume: number) => post({ type: "audio", op: "volume", sound, volume }),
    soundPause: (sound: number, paused: boolean) => post({ type: "audio", op: "pause", sound, paused }),
    // Prebaked sprite sheets (SpriteStore.cs).
    spriteLoad: (key: string) => bake?.load(key) ?? new Uint8Array(0),
    spriteSaved: (key: string, table: Uint8Array, ids: ArrayLike<number>) => bake?.saved(key, table, ids),
    spriteRestored: (key: string, ids: ArrayLike<number>) => bake?.restored(key, ids),
    textureFree: (id: number) => { bake?.forget(id); post({ type: "texturefree", id }); },
    // The WebAssembly memory's size (SimHost records it after each timed load step: timings "mem.<step>").
    memoryBytes: () => runtimeApi.Module.HEAPU8.length,
    // Sound.AudioReady (SimHost): can this audio file be read now? If not, it is fetched in the background.
    audioReady: (path: string) => lazy?.ready(path) ?? true,
    // The AI co-commander (CompanionRpc.cs): relayed RPC answers, and status/threat/action events for the panel.
    companionReply: (call: number, code: number, message: string, view: { slice(): Uint8Array }) => adviserReply(call, code, message, view.slice()),
    companionEvent: (json: string) => post({ type: "companion", event: JSON.parse(json) }),
    // Sheets committed by the engine go straight to the page (no copy kept in the WebAssembly heap).
    texture: (id: number, version: number, width: number, height: number, view: { slice(): Uint8Array }) => {
      const bytes = view.slice();
      bake?.onTexture(id, bytes);
      const data = bytes.buffer;
      post({ type: "texture", id, version, width, height, kind: 0, data: data as ArrayBuffer }, [data as ArrayBuffer]);
    },
    progress: (step: string) => post({ type: "progress", stage: step, detail: `${((performance.now() - t0) / 1000).toFixed(1)} s` }),
  });
  const config = runtimeApi.getConfig();
  const exports = await runtimeApi.getAssemblyExports(config.mainAssemblyName);
  S = exports.OpenRA.WebSim.Browser.Interop;
  const runtimeMs = performance.now() - t0;

  const bundle = await fetchBytes(new URL(`${dataRoot}${profileDir}web-bundle.pack`, base).href, "Downloading game data", bundleRequest);
  post({ type: "progress", stage: "Mounting game data", detail: `${(bundle.length / 1048576).toFixed(1)} MB` });
  // Files read straight from the downloaded bundle: nothing is copied into the WebAssembly heap.
  lazy = new LazyMount(runtimeApi.Module.FS);
  S.SetProgress();
  const packFiles = mountPack(lazy, bundle, "/vfs");
  // The bundle's content id (Bundle.cs): caches and prebaked sprites are keyed by it.
  const idAt = packFiles.get("ora/BUNDLE_ID");
  const bundleId = idAt ? new TextDecoder().decode(bundle.subarray(idAt[0], idAt[0] + idAt[1])).trim() : bundleTag;
  // Every actor's name from the mod's Fluent messages, for the HUD (the engine names only what a build menu lists).
  let actorNames: Record<string, string> = {};
  try {
    const text = (name: string) => { const at = packFiles.get(name); return at ? new TextDecoder().decode(bundle.subarray(at[0], at[0] + at[1])) : ""; };
    actorNames = fluentActorNames(fluentFiles([...packFiles.keys()], text).map(text));
  } catch { /* names fall back to the engine's lists */ }
  // Prebaked sprite sheets shipped with a profile's data (websim bake), fetched while the engine loads its rules.
  const shipped = msg.profile ? fetchShippedSprites(new URL(`${dataRoot}${profileDir}sprites/`, base).href, bundleId) : Promise.resolve(null);

  let privateContent = false;
  let privateTag = "none";
  // Read by byte range when first needed: the mod's own (licensed) audio when a sound first plays, and the large
  // sprite art when a map's sprites are decoded (never, when its sheets are prebaked or cached).
  const mount = lazy;
  await Promise.all(["web-audio", "web-art"].map(async (name) => {
    const index = await fetch(new URL(`${dataRoot}${profileDir}${name}.json`, base));
    if (!index.ok) return;
    const { files } = (await index.json()) as { files: { path: string; offset?: number; size: number; file?: string }[] };
    const url = new URL(`${dataRoot}${profileDir}${name}.pack`, base).href;
    const read = httpRangeReader(url);
    const readAsync = httpRangeReaderAsync(url);
    // Audio can also be fetched in the background: a sound that is not here yet is skipped, music waits for it.
    const background = name === "web-audio";
    for (const f of files) {
      if (f.file) {
        // A single file (static public build): fetched whole and cached by the browser.
        const fileUrl = new URL(`${dataRoot}${profileDir}${f.file}`, base).href;
        const whole = wholeFileReader(fileUrl), wholeAsync = wholeFileReaderAsync(fileUrl);
        mount.add(`/vfs/${f.path}`, f.size, whole, true, background ? wholeAsync : undefined);
      } else {
        const offset = f.offset ?? 0;
        mount.add(`/vfs/${f.path}`, f.size, (s, e) => read(offset + s, offset + e), true,
          background ? (s, e) => readAsync(offset + s, offset + e) : undefined);
      }
    }
  }));

  if (msg.privateContent && !msg.profile) {
    // The player's own RA2 files: mounted lazily (only the chunks a game reads are fetched), local only.
    const res = await fetch(new URL("private/manifest.json", base));
    if (res.ok) {
      const manifestText = await res.text();
      privateTag = hashString(manifestText);
      const { files } = JSON.parse(manifestText) as { files: { path: string; size: number }[] };
      if (files.length) {
        for (const f of files)
          lazy.add(`/vfs/support/Content/ra2/${f.path}`, f.size, httpRangeReader(new URL(`private/files/${f.path.split("/").map(encodeURIComponent).join("/")}`, base).href));
        privateContent = true;
      }
    }
  }

  bake = new SpriteBake(`${msg.profile ?? ""}|${bundleId}|${privateTag}|ORASPR01`, (id, width, height, gz) =>
    post({ type: "texturegz", id, width, height, gz }));
  bake.onSheetList = (sheets) => post({ type: "sheetList", sheets });
  bake.onSheetBytes = (s) => post({ type: "texturebin", ...s }, [s.data]);
  await bake.init();

  post({ type: "progress", stage: "Loading rules" });
  // Local, reviewed ports and generated maps mount before MapCache scans the mod folders.
  // Static builds have no local workshop API and keep their bundled catalog.
  if (["public", "public-classic"].includes(msg.profile ?? "") && import.meta.env.VITE_STATIC_BUILD !== "1") {
    const response = await fetch(new URL(`api/maps/packages?profile=${msg.profile}`, base));
    if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
      const catalog = await response.json() as { maps: { id: string; files: { name: string; url: string }[] }[] };
      for (const map of catalog.maps) {
        if (!/^(port-classic-(coast|frontier)|earth-[a-f0-9]{16})$/.test(map.id)) continue;
        for (const file of map.files) {
          if (!["map.yaml", "map.bin", "map.png"].includes(file.name)) continue;
          const r = await fetch(new URL(file.url, base));
          if (!r.ok) throw new Error(`Could not load local map ${map.id}`);
          const bytes = new Uint8Array(await r.arrayBuffer());
          lazy.add(`/vfs/mods/rtsai/web/content/maps/${map.id}/${file.name}`, bytes.length, (s, e) => bytes.subarray(s, e));
        }
      }
    }
  }
  const timings = JSON.parse(S.Boot());
  booted = true;
  S.SetVoiceLanguage(voiceLanguage);
  const shippedSprites = await shipped;
  if (shippedSprites) {
    for (const s of shippedSprites) bake.addShipped(s);
    timings["sprites.shipped"] = shippedSprites.length;
  }
  timings["worker.total"] = performance.now() - t0;
  timings["heap.ready"] = (runtimeApi.Module.HEAPU8.length / 1048576) | 0;
  post({ type: "ready", timings, runtimeMs, downloadBytes: resourceBytes(), setup: { ...JSON.parse(S.Setup()), multiplayer: typeof S.NetworkPoll === "function" && typeof S.NetworkInject === "function" }, privateContent, actorNames });
}

function stopLoop() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

function start(scenario: string, startPaused = false, companion: boolean | "browser" = false) {
  stopLoop();
  cancelAdviserCalls();
  browserAdviser = false;
  const spec = JSON.parse(scenario);
  replayEnd = spec.webReplay?.readonly ? spec.webReplay.end : null;
  network = spec.network?.peer ? { generation, frame: 0, stopped: false } : null;
  // The co-commander's CompanionBridge is created with the world: enable it first, connect the relay after.
  const controllable = !network && !spec.multiplayer && !spec.webReplay?.readonly
    && Array.isArray(spec.players) && spec.players.some((p: { bot?: string }) => !p.bot);
  browserAdviser = companion === "browser" && controllable;
  const companionEnabled = !!companion && controllable;
  S.CompanionEnable(companionEnabled);
  relay?.close();
  paused = startPaused;
  const t0 = performance.now();
  post({ type: "progress", stage: "Building the world" });
  bake?.beginCapture();
  const info = JSON.parse(S.Start(scenario));
  S.PauseAudio(startPaused);
  if (spec.webReplay && !spec.webReplay.readonly) {
    for (const [index, ids] of (spec.webReplay.groups ?? []).entries()) {
      S.Select(JSON.stringify(ids), false); S.Command(JSON.stringify({ cmd: "group", action: "create", index }));
    }
    S.Select(JSON.stringify(spec.webReplay.selection ?? []), false);
  }
  bake?.endCapture();
  info.timings["heap.started"] = (runtimeApi.Module.HEAPU8.length / 1048576) | 0;
  const terrain: Uint8Array = S.Terrain();
  const tbuf = terrain.slice().buffer;
  const radar: Uint8Array = S.RadarTerrain();
  const rbuf = radar.slice().buffer;
  lastUi = "";
  ticks = 0;
  post({ type: "started", info, terrain: tbuf, radarTerrain: rbuf, startMs: performance.now() - t0, lazy: lazy?.stats }, [tbuf, rbuf]);
  // The local player's announcer and the interface sounds, fetched in the background (a sound that is not here yet
  // is skipped, never waited for).
  try {
    const local = (spec.players as { client?: number; faction?: string; bot?: string }[]).find((p) => !p.bot && (!spec.multiplayer || p.client === spec.localClient))?.faction;
    if (lazy && local) lazy.prefetch(lazy.backgroundPaths().filter((p) => p.includes(`/eva/${local}/`) || p.includes("/audio/ui/")));
  } catch { /* a scenario without players */ }
  if (companionEnabled && companion !== "browser") {
    const url = new URL("companion/bridge", base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    relay ??= new CompanionRelay(url.href, { call: (id, method, request) => S.CompanionCall(id, method, request) },
      (connected) => post({ type: "companion", event: { kind: "link", connected } }));
    relay.connect();
    // Observations are pushed as they change (compact, see companion.ts), when the runtime can provide them.
    if (S.CompanionObservation) relay.streamObservations(() => S.CompanionObservation());
  }
  if (browserAdviser) {
    // The browser adviser uses the existing engine kill switch; it never enables native AUTO control.
    S.CompanionCall(nextAdviserCall--, "UpdateCompanionStatus", encodeAdviserStatus(true));
    post({ type: "companion", event: { kind: "link", connected: true } });
  }
  sendShroud(true);
  running = true;
  nextTick = performance.now();
  lastSecond = nextTick;
  if (paused) refresh();
  loop();
}

function sendShroud(force: boolean) {
  const cells: Uint8Array = S.Shroud(force);
  if (cells.length === 0) return;
  const buf = cells.slice().buffer;
  post({ type: "shroud", cells: buf }, [buf]);
}

function sendUi() {
  const ui: string = S.UiState();
  if (ui !== lastUi) {
    lastUi = ui;
    post({ type: "ui", json: ui });
  }
}

function tickOnce() {
  if (replayEnd !== null && S.WorldTick() >= replayEnd) { paused = true; return; }
  const t = performance.now();
  S.Tick();
  tickTimes.push(performance.now() - t);
  ticksThisSecond++;
  ticks++;
  sendUi();
  sendShroud(false);
  if (ticks % RADAR_EVERY === 0) {
    const b: Uint8Array = S.RadarBlips();
    const buf = b.slice().buffer;
    post({ type: "radar", blips: buf }, [buf]);
  }
}

function networkTick() {
  const events = JSON.parse(S.NetworkPoll());
  if (events.length) post({ type: "peerOut", events });
}

function loop() {
  timer = null;
  if (!running) return;
  const now = performance.now();
  if (network) {
    if (!network.stopped) networkTick();
    nextTick = now + tickMs;
  } else if (!paused) {
    let n = 0;
    while (now >= nextTick && n < 2) {
      tickOnce();
      nextTick += tickMs;
      n++;
    }
    if (now - nextTick > 200) {
      // Fell more than 5 ticks behind (sim slower than real time): drop the backlog instead of spiralling.
      lateTicks++;
      nextTick = now + tickMs;
    }
  } else nextTick = now + tickMs;

  if (now - lastSecond >= 1000) {
    tps = (ticksThisSecond * 1000) / (now - lastSecond);
    ticksThisSecond = 0;
    lastSecond = now;
    const mean = tickTimes.length ? tickTimes.reduce((a, b) => a + b, 0) / tickTimes.length : 0;
    tickTimes = [];
    const heapBytes = runtimeApi?.Module?.HEAPU8?.length ?? 0;
    post({ type: "stats", json: S.Stats(), heapBytes, tickMs: mean, lateTicks, ticksPerSecond: tps, lazy: lazy?.stats });
  }

  timer = setTimeout(loop, Math.max(0, nextTick - performance.now()));
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.generation !== undefined) {
    if (m.type === "start" || m.type === "end" || m.type === "editorOpen") {
      if (m.generation < generation) return;
      generation = m.generation;
    } else if (m.generation !== generation) return;
  }
  try {
    switch (m.type) {
      case "init": voiceLanguage = normalizeVoiceLanguage(m.voiceLanguage); await init(m); break;
      case "prepare": {
        const t0 = performance.now();
        bake?.beginCapture();
        const timings = JSON.parse(S.Prepare(m.map));
        bake?.endCapture();
        timings["sprites.restored"] = bake?.stats.restored ?? 0;
        timings["heap.prepared"] = (runtimeApi.Module.HEAPU8.length / 1048576) | 0;
        post({ type: "prepared", map: m.map, ms: performance.now() - t0, timings, lazy: lazy?.stats });
        break;
      }
      case "mountMap": {
        // A player's Earth map, added after boot: SimHost.MapPath finds web/content/maps/<id>/ before the MapCache,
        // and a world starts from a map outside the cache. Ids are content hashes, so a mounted map never changes.
        if (!/^earth-[a-f0-9]{16}$/.test(m.map) || !lazy) { post({ type: "mapMounted", map: m.map, error: "Invalid map" }); break; }
        if (!mountedMaps.has(m.map)) {
          const dir = `/vfs/mods/rtsai/web/content/maps/${m.map}`;
          for (const [name, bytes] of [["map.yaml", new TextEncoder().encode(m.yaml)], ["map.bin", new Uint8Array(m.bin)], ["map.png", new Uint8Array(m.png)]] as const)
            lazy.add(`${dir}/${name}`, bytes.length, (s, e) => bytes.subarray(s, e));
          mountedMaps.add(m.map);
        }
        post({ type: "mapMounted", map: m.map });
        break;
      }
      case "generateMap": {
        // The engine's own generator (MapGen.cs) makes the map here, in the player's browser. Its files are mounted
        // where Earth maps go (web/content/maps/<id>/); the id is a hash of the map, so the same request gives the same id.
        const result = JSON.parse(S.GenerateMap(m.request) as string);
        if (result.error || !lazy) { post({ type: "mapGenerated", error: result.error ?? "Map generation is unavailable" }); break; }
        const files: Record<string, Uint8Array> = {};
        for (const [name, b64] of Object.entries(result.files as Record<string, string>))
          files[name] = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        if (!mountedMaps.has(result.id)) {
          const dir = `/vfs/mods/rtsai/web/content/maps/${result.id}`;
          for (const [name, bytes] of Object.entries(files)) lazy.add(`${dir}/${name}`, bytes.length, (s, e) => bytes.subarray(s, e));
          mountedMaps.add(result.id);
        }
        const png = (files["map.png"] ?? new Uint8Array()).slice().buffer;
        post({ type: "mapGenerated", map: result.id, title: result.title, landscape: result.landscape, players: result.players, seed: result.seed, ms: result.ms, png }, [png]);
        break;
      }
      case "preview": {
        const png: Uint8Array = S.MapPreview(m.map);
        const buf = png.slice().buffer;
        post({ type: "preview", map: m.map, png: buf }, [buf]);
        break;
      }
      case "sheetGroups": bake?.setWanted(m.groups, m.first); break;
      case "needSheets": bake?.need(m.ids); break;
      case "resendSheets": bake?.resend(m.ids); break;
      case "resendTextures":
        for (const id of m.ids) {
          // The engine keeps a sheet's pixels only while it may still write to it (WebTexture.MayReopen).
          const data = (S.Texture(id) as Uint8Array).slice().buffer as ArrayBuffer;
          post({ type: "textureData", id, data }, [data]);
        }
        break;
      case "start":
        voiceLanguage = normalizeVoiceLanguage(m.voiceLanguage);
        S.SetVoiceLanguage(voiceLanguage);
        if (lazy) lazy.trace = [];
        start(m.scenario, m.paused ?? false, m.companion ?? false);
        if (lazy?.trace) { if (lazy.trace.length) console.info("lazy reads during start: " + lazy.trace.join(" ")); lazy.trace = null; }
        break;
      case "peerFrame":
        if (!network || network.stopped || !running) break;
        if (m.frame !== network.frame + 1) throw Error("Missing direct peer frame");
        for (const packet of m.packets) S.NetworkInject(packet.client, m.frame, packet.data);
        tickOnce(); network.frame = m.frame;
        post({ type: "networkStatus", frame: m.frame, latency: 0 });
        break;
      case "peerStop":
        if (network) { network.stopped = true; stopLoop(); post({ type: "networkStatus", frame: network.frame, latency: 0, error: m.error }); }
        break;
      case "editorOpen": {
        // The map editor: the engine's editor world (EditorHost.Open), drawn like a paused match that never ticks.
        stopLoop();
        relay?.close();
        const t0 = performance.now();
        post({ type: "progress", stage: "Opening the map" });
        bake?.beginCapture();
        const opened = JSON.parse(S.EditorOpen(m.json));
        bake?.endCapture();
        const terrain: Uint8Array = S.Terrain();
        const tbuf = terrain.slice().buffer;
        const radar: Uint8Array = S.RadarTerrain();
        const rbuf = radar.slice().buffer;
        lastUi = "";
        paused = true;
        replayEnd = null;
        network = null;
        post({ type: "started", info: opened.info, terrain: tbuf, radarTerrain: rbuf, startMs: performance.now() - t0, lazy: lazy?.stats }, [tbuf, rbuf]);
        post({ type: "reply", req: m.req, json: JSON.stringify({ id: opened.id }) });
        running = true;
        refresh();
        break;
      }
      case "catalog": post({ type: "reply", req: m.req, json: S.Catalog() }); break;
      case "relief": {
        let json: string;
        try { json = S.ReliefMap(m.json); } catch (err) { json = JSON.stringify({ error: String(err instanceof Error ? err.message : err) }); }
        post({ type: "reply", req: m.req, json });
        break;
      }
      case "editor": {
        let json: string;
        try { json = S.EditorCall(m.json); } catch (err) { json = JSON.stringify({ error: String(err instanceof Error ? err.message : err) }); }
        // Terrain the edit changed: only the rows it touched go to the page's terrain buffer.
        const rows: Uint8Array = S.EditorTerrain();
        if (rows.length > 4) {
          const first = new DataView(rows.buffer, rows.byteOffset, 4).getInt32(0, true);
          const data = rows.slice(4).buffer;
          post({ type: "terrainRows", first, data }, [data]);
        }
        post({ type: "reply", req: m.req, json });
        refresh();
        break;
      }
      case "mountFiles": {
        // A map's files (saved or uploaded in the editor) in the engine's file system, where SimHost.MapPath finds them.
        if (!lazy || !/^\/vfs\/mods\/rtsai\/web\/content\/maps\/[a-z0-9-]+$/.test(m.dir)) { post({ type: "reply", req: m.req, json: JSON.stringify({ error: "Invalid map" }) }); break; }
        // Ids hash the map's content: a map mounted under this id already has these files.
        const mapId = m.dir.split("/").pop()!;
        if (!mountedMaps.has(mapId)) {
          for (const [name, buf] of Object.entries(m.files)) { const bytes = new Uint8Array(buf); lazy.add(`${m.dir}/${name}`, bytes.length, (s0, e0) => bytes.subarray(s0, e0)); }
          mountedMaps.add(mapId);
        }
        post({ type: "reply", req: m.req, json: JSON.stringify({ ok: true }) });
        break;
      }
      case "refresh": refresh(); break;
      case "step": if (network) break; if (running && paused) tickOnce(); break;
      case "speed": if (network) break; tickMs = TICK_MS / Math.max(0.25, Math.min(8, m.speed)); break;
      case "end":
        browserAdviser = false; cancelAdviserCalls();
        if (network) network.stopped = true;
        stopLoop(); relay?.close(); S.EndGame(); break;
      case "pause": if (network) break; paused = m.paused; S.PauseAudio(paused); if (paused) refresh(); break;
      case "view":
        S?.View(m.x0 | 0, m.y0 | 0, m.x1 | 0, m.y1 | 0);
        if (running && paused) refresh();
        break;
      case "select": post({ type: "reply", req: m.req, json: S.Select(JSON.stringify(m.ids), m.additive) }); sendUi(); break;
      case "adviserRpc": {
        const replyError = (code: number, message: string) => post({ type: "adviserReply", req: m.req, code, message, payload: new Uint8Array() });
        if (!browserAdviser || !running || network || replayEnd !== null) { replyError(9, "No controllable single-player co-commander match"); break; }
        if (m.method !== "Observe" && m.method !== "ExecuteCompanionActions" && m.method !== "UpdateCompanionStatus") { replyError(12, "Unsupported browser co-commander RPC"); break; }
        if (!(m.payload instanceof Uint8Array) || m.payload.byteLength > 65536) { replyError(3, "Invalid browser co-commander request"); break; }
        // Native confirmed actions resolve on a game tick. Refuse while paused, before queuing anything.
        if (m.method === "ExecuteCompanionActions" && paused) { replyError(9, "Resume the match before confirming a co-commander action"); break; }
        const call = nextAdviserCall--;
        const timer = setTimeout(() => { adviserReply(call, 4, "Co-commander engine request timed out", new Uint8Array()); }, 5000);
        adviserCalls.set(call, { req: m.req, generation, timer });
        try { S.CompanionCall(call, m.method, m.payload); }
        catch (err) { adviserReply(call, 13, err instanceof Error ? err.message : String(err), new Uint8Array()); }
        break;
      }
      case "command": {
        let json: string;
        try {
          const music = String(JSON.parse(m.json).cmd).startsWith("music-");
          json = replayEnd !== null && !music ? JSON.stringify({ error: "Replays are read-only" }) : S.Command(m.json);
        } catch (err) { json = JSON.stringify({ error: String(err instanceof Error ? err.message : err) }); }
        post({ type: "reply", req: m.req, json });
        sendUi(); // mode changes show without waiting for the next tick
        break;
      }
      case "click": {
        const count = replayEnd !== null ? 0 : S.Click(m.x | 0, m.y | 0, m.button, m.mods);
        post({ type: "ordered", count, t: m.t, tick: S.WorldTick() });
        sendUi();
        break;
      }
      case "cursor": post({ type: "cursor", cursor: S.Cursor(m.x | 0, m.y | 0, m.mods), seq: m.seq }); break;
      case "cursorset": {
        const data = (S.CursorSet() as Uint8Array).slice();
        post({ type: "cursorset", data: data.buffer }, [data.buffer]);
        break;
      }
      case "icons": {
        for (const name of m.names) post({ type: "icon", name, faction: m.faction,
          info: m.faction ? S.Command(JSON.stringify({ cmd: "icon", type: name, faction: m.faction })) : S.Icon(name) });
        break;
      }
      case "bench": {
        if (network) break;
        const wasRunning = running;
        stopLoop();
        const ms = S.TickMany(m.ticks);
        post({ type: "bench", ticks: m.ticks, ms });
        if (wasRunning) { running = true; nextTick = performance.now(); loop(); }
        break;
      }
      case "log": post({ type: "log", json: S.SessionLog() }); break;
      case "voiceLanguage":
        if (m.value !== undefined) voiceLanguage = normalizeVoiceLanguage(m.value);
        post({ type: "reply", req: m.req, json: booted ? (m.value === undefined ? S.VoiceSettings() : S.SetVoiceLanguage(voiceLanguage)) : JSON.stringify({ language: voiceLanguage }) }); break;
      case "voicePreview": post({ type: "reply", req: m.req, json: booted ? S.PreviewVoice() : JSON.stringify({ error: "The runtime is still loading." }) }); break;
      case "missionMap": {
        // Mission maps are generated content (web/content/maps/<id>/, where SimHost.MapPath finds them first).
        let text = "";
        if (booted && /^[a-z0-9-]+$/.test(m.mission)) try { text = S.ReadText(`mods/rtsai/web/content/maps/${m.mission}/map.yaml`) ?? ""; } catch { /* missing */ }
        post({ type: "reply", req: m.req, json: JSON.stringify({ text }) });
        break;
      }
      case "record": {
        const selection = (JSON.parse(S.UiState()).selection ?? []).map((a: { id: number }) => a.id);
        const groups = Array.from({ length: 10 }, (_, index) => JSON.parse(S.Command(JSON.stringify({ cmd: "group", action: "select", index }))).selection);
        S.Select(JSON.stringify(selection), false);
        post({ type: "reply", req: m.req, json: JSON.stringify({ log: JSON.parse(S.SessionLog()), tick: S.WorldTick(), selection, groups }) }); break;
      }
      case "resync": S.Resync(); S.UiResync(); lastUi = ""; sendShroud(true); break;
    }
  } catch (err) {
    if (network) {
      network.stopped = true;
      stopLoop();
    }
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : err && typeof err === "object" ? JSON.stringify(err, Object.getOwnPropertyNames(err)) : String(err);
    post({ type: "error", message: [detail, ...runtimeErrors].join("\n") });
  }
};
