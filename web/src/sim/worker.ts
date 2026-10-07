/// <reference lib="webworker" />
// The simulation worker: hosts the .NET WebAssembly runtime running the real OpenRA engine + RTS AI mod,
// ticks the world at 25 tps and publishes one snapshot per tick into a SharedArrayBuffer ring, plus the game-UI
// state (credits, power, queues, selection), shroud and radar for the page's HUD.

import {
  RING_BYTES, RING_HEADER_BYTES, RING_LEN_AT, RING_SEQ_AT, RING_SLOTS, RING_SLOT_BYTES,
  textureUpdates, type FromWorker, type ToWorker,
} from "./protocol";
import { LazyMount, httpRangeReader, mountPack } from "./lazyfs";

declare const self: DedicatedWorkerGlobalScope;

const TICK_MS = 40;
const RADAR_EVERY = 5; // ticks between radar blip updates

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let S: any = null; // [JSExport] surface of OpenRA.WebSim.Browser.Interop
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runtimeApi: any = null;
let base = "/";
let lazy: LazyMount | null = null;
let ringHeader: Int32Array | null = null;
let ringBytes: Uint8Array | null = null;
let seq = 0;
let running = false;
let paused = false;
let nextTick = 0;
let tickTimes: number[] = [];
let lateTicks = 0;
let ticksThisSecond = 0;
let tps = 0;
let lastSecond = 0;
let ticks = 0;
let lastUi = "";
let timer: ReturnType<typeof setTimeout> | null = null;

function post(msg: FromWorker, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

function publish(view: { slice(): Uint8Array; length: number }) {
  const bytes = view.slice();
  seq++;
  if (ringHeader && ringBytes && bytes.length <= RING_SLOT_BYTES) {
    const slot = seq % RING_SLOTS;
    ringBytes.set(bytes, RING_HEADER_BYTES + slot * RING_SLOT_BYTES);
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

async function fetchBytes(url: string, stage: string) {
  post({ type: "progress", stage, detail: url });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
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
  const runtimeUrl = new URL(`rt/${msg.runtime}/_framework/dotnet.js`, base).href;
  // dotnet.js treats a worker that already has an onmessage handler as one of its own pthread workers and
  // waits for a thread handshake that never comes. Declare this worker a "sidecar" (a single-threaded host).
  (globalThis as unknown as { dotnetSidecar: boolean }).dotnetSidecar = true;
  const { dotnet } = await import(/* @vite-ignore */ runtimeUrl);
  // A soft heap limit makes the GC collect before growing the heap (WebAssembly memory never shrinks, so the
  // high-water mark during loading is what the tab keeps).
  runtimeApi = await dotnet.withDiagnosticTracing(false).withEnvironmentVariable("MONO_GC_PARAMS", msg.gcParams ?? "soft-heap-limit=200m").create();
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
    // Sheets committed by the engine go straight to the page (no copy kept in the WebAssembly heap).
    texture: (id: number, version: number, width: number, height: number, view: { slice(): Uint8Array }) => {
      const data = view.slice().buffer;
      post({ type: "texture", id, version, width, height, kind: 0, data: data as ArrayBuffer }, [data as ArrayBuffer]);
    },
    progress: (step: string) => post({ type: "progress", stage: step, detail: `${((performance.now() - t0) / 1000).toFixed(1)} s` }),
  });
  const config = runtimeApi.getConfig();
  const exports = await runtimeApi.getAssemblyExports(config.mainAssemblyName);
  S = exports.OpenRA.WebSim.Browser.Interop;
  const runtimeMs = performance.now() - t0;

  const bundle = await fetchBytes(new URL("data/web-bundle.pack", base).href, "Downloading game data");
  post({ type: "progress", stage: "Mounting game data", detail: `${(bundle.length / 1048576).toFixed(1)} MB` });
  // Files read straight from the downloaded bundle: nothing is copied into the WebAssembly heap.
  lazy = new LazyMount(runtimeApi.Module.FS);
  S.SetProgress();
  mountPack(lazy, bundle, "/vfs");

  let privateContent = false;
  // The mod's own (licensed) audio, fetched by byte range from web-audio.pack when a sound is first played.
  const audioIndex = await fetch(new URL("data/web-audio.json", base));
  if (audioIndex.ok) {
    const { files } = (await audioIndex.json()) as { files: { path: string; offset: number; size: number }[] };
    const read = httpRangeReader(new URL("data/web-audio.pack", base).href);
    for (const f of files) lazy.add(`/vfs/${f.path}`, f.size, (s, e) => read(f.offset + s, f.offset + e));
  }

  if (msg.privateContent) {
    // The player's own RA2 files: mounted lazily (only the chunks a game reads are fetched), local only.
    const res = await fetch(new URL("private/manifest.json", base));
    if (res.ok) {
      const { files } = (await res.json()) as { files: { path: string; size: number }[] };
      if (files.length) {
        for (const f of files)
          lazy.add(`/vfs/support/Content/ra2/${f.path}`, f.size, httpRangeReader(new URL(`private/files/${f.path.split("/").map(encodeURIComponent).join("/")}`, base).href));
        privateContent = true;
      }
    }
  }

  post({ type: "progress", stage: "Loading rules" });
  const timings = JSON.parse(S.Boot());
  timings["worker.total"] = performance.now() - t0;
  timings["heap.ready"] = (runtimeApi.Module.HEAPU8.length / 1048576) | 0;
  post({ type: "ready", timings, runtimeMs, downloadBytes: resourceBytes(), setup: JSON.parse(S.Setup()), privateContent });
}

function stopLoop() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

function start(scenario: string) {
  stopLoop();
  const t0 = performance.now();
  post({ type: "progress", stage: "Building the world" });
  const info = JSON.parse(S.Start(scenario));
  info.timings["heap.started"] = (runtimeApi.Module.HEAPU8.length / 1048576) | 0;
  const terrain: Uint8Array = S.Terrain();
  const tbuf = terrain.slice().buffer;
  const radar: Uint8Array = S.RadarTerrain();
  const rbuf = radar.slice().buffer;
  lastUi = "";
  ticks = 0;
  post({ type: "started", info, terrain: tbuf, radarTerrain: rbuf, startMs: performance.now() - t0, lazy: lazy?.stats }, [tbuf, rbuf]);
  sendShroud(true);
  running = true;
  nextTick = performance.now();
  lastSecond = nextTick;
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

function loop() {
  timer = null;
  if (!running) return;
  const now = performance.now();
  if (!paused) {
    let n = 0;
    while (now >= nextTick && n < 2) {
      tickOnce();
      nextTick += TICK_MS;
      n++;
    }
    if (now - nextTick > 200) {
      // Fell more than 5 ticks behind (sim slower than real time): drop the backlog instead of spiralling.
      lateTicks++;
      nextTick = now + TICK_MS;
    }
  } else nextTick = now + TICK_MS;

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
  try {
    switch (m.type) {
      case "init": await init(m); break;
      case "prepare": {
        const t0 = performance.now();
        const timings = JSON.parse(S.Prepare(m.map));
        timings["heap.prepared"] = (runtimeApi.Module.HEAPU8.length / 1048576) | 0;
        post({ type: "prepared", map: m.map, ms: performance.now() - t0, timings, lazy: lazy?.stats });
        break;
      }
      case "preview": {
        const png: Uint8Array = S.MapPreview(m.map);
        const buf = png.slice().buffer;
        post({ type: "preview", map: m.map, png: buf }, [buf]);
        break;
      }
      case "start": start(m.scenario); break;
      case "end": stopLoop(); S.EndGame(); break;
      case "pause": paused = m.paused; break;
      case "view": S?.View(m.x0 | 0, m.y0 | 0, m.x1 | 0, m.y1 | 0); break;
      case "select": post({ type: "reply", req: m.req, json: S.Select(JSON.stringify(m.ids), m.additive) }); break;
      case "command": {
        let json: string;
        try { json = S.Command(m.json); } catch (err) { json = JSON.stringify({ error: String(err instanceof Error ? err.message : err) }); }
        post({ type: "reply", req: m.req, json });
        sendUi(); // mode changes show without waiting for the next tick
        break;
      }
      case "click": {
        const count = S.Click(m.x | 0, m.y | 0, m.button, m.mods);
        post({ type: "ordered", count, t: m.t, tick: S.WorldTick() });
        sendUi();
        break;
      }
      case "cursor": post({ type: "cursor", cursor: S.Cursor(m.x | 0, m.y | 0, m.mods), seq: m.seq }); break;
      case "icons": {
        for (const name of m.names) post({ type: "icon", name, info: S.Icon(name) });
        break;
      }
      case "bench": {
        const wasRunning = running;
        stopLoop();
        const ms = S.TickMany(m.ticks);
        post({ type: "bench", ticks: m.ticks, ms });
        if (wasRunning) { running = true; nextTick = performance.now(); loop(); }
        break;
      }
      case "log": post({ type: "log", json: S.SessionLog() }); break;
      case "resync": S.Resync(); S.UiResync(); lastUi = ""; sendShroud(true); break;
    }
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err) });
  }
};
