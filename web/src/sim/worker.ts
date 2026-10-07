/// <reference lib="webworker" />
// The simulation worker: hosts the .NET WebAssembly runtime running the real OpenRA engine + RTS AI mod,
// ticks the world at 25 tps and publishes one snapshot per tick into a SharedArrayBuffer ring.

import {
  RING_BYTES, RING_HEADER_BYTES, RING_SLOTS, RING_SLOT_BYTES,
  textureUpdates, type FromWorker, type ToWorker,
} from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

const TICK_MS = 40;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let S: any = null; // [JSExport] surface of OpenRA.WebSim.Browser.Interop
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runtimeApi: any = null;
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

function post(msg: FromWorker, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

function publish(view: { slice(): Uint8Array; length: number }) {
  const bytes = view.slice();
  seq++;
  if (ringHeader && ringBytes && bytes.length <= RING_SLOT_BYTES) {
    const slot = seq % RING_SLOTS;
    ringBytes.set(bytes, RING_HEADER_BYTES + slot * RING_SLOT_BYTES);
    Atomics.store(ringHeader, 1 + slot, bytes.length);
    Atomics.store(ringHeader, 4 + slot, seq);
    Atomics.store(ringHeader, 0, seq);
  } else {
    const copy = bytes.slice();
    post({ type: "snapshot", bytes: copy.buffer, seq }, [copy.buffer]);
  }

  for (const t of textureUpdates(bytes)) {
    const data: Uint8Array = S.Texture(t.id);
    const buf = data.slice().buffer;
    post({ type: "texture", ...t, data: buf }, [buf]);
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
  return out;
}

async function init(msg: Extract<ToWorker, { type: "init" }>) {
  const t0 = performance.now();
  if (msg.sab) {
    ringHeader = new Int32Array(msg.sab, 0, RING_HEADER_BYTES / 4);
    ringBytes = new Uint8Array(msg.sab, 0, RING_BYTES);
  }

  post({ type: "progress", stage: "Starting .NET WebAssembly runtime", detail: msg.runtime });
  const runtimeUrl = `/rt/${msg.runtime}/_framework/dotnet.js`;
  // dotnet.js treats a worker that already has an onmessage handler as one of its own pthread workers and
  // waits for a thread handshake that never comes. Declare this worker a "sidecar" (a single-threaded host).
  (globalThis as unknown as { dotnetSidecar: boolean }).dotnetSidecar = true;
  const { dotnet } = await import(/* @vite-ignore */ runtimeUrl);
  runtimeApi = await dotnet.withDiagnosticTracing(false).create();
  runtimeApi.setModuleImports("websim", {
    publish,
    progress: (step: string) => post({ type: "progress", stage: "Loading: " + step, detail: `${((performance.now() - t0) / 1000).toFixed(1)} s` }),
  });
  const config = runtimeApi.getConfig();
  const exports = await runtimeApi.getAssemblyExports(config.mainAssemblyName);
  S = exports.OpenRA.WebSim.Browser.Interop;
  const runtimeMs = performance.now() - t0;

  const bundle = await fetchBytes("/data/web-bundle.pack", "Downloading mod bundle");
  post({ type: "progress", stage: "Mounting mod files", detail: `${(bundle.length / 1048576).toFixed(1)} MB` });
  S.Mount(bundle);

  if (msg.privateContent) {
    const content = await fetchBytes("/private/ra2-all.pack", "Mounting your local Red Alert 2 content (private)");
    S.Mount(content);
  }

  post({ type: "progress", stage: "Loading OpenRA mod data" });
  const timings = JSON.parse(S.Boot());
  timings["worker.total"] = performance.now() - t0;
  post({ type: "ready", timings, runtimeMs, downloadBytes: resourceBytes() });
}

function start(scenario: string) {
  const t0 = performance.now();
  post({ type: "progress", stage: "Building the world (rules, sequences, sprites)" });
  const info = JSON.parse(S.Start(scenario));
  const terrain: Uint8Array = S.Terrain();
  const tbuf = terrain.slice().buffer;
  post({ type: "started", info, terrain: tbuf, startMs: performance.now() - t0 }, [tbuf]);
  running = true;
  nextTick = performance.now();
  lastSecond = nextTick;
  loop();
}

function tickOnce() {
  const t = performance.now();
  S.Tick();
  tickTimes.push(performance.now() - t);
  ticksThisSecond++;
}

function loop() {
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
    post({ type: "stats", json: S.Stats(), heapBytes, tickMs: mean, lateTicks, ticksPerSecond: tps });
  }

  setTimeout(loop, Math.max(0, nextTick - performance.now()));
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case "init": await init(m); break;
      case "start": start(m.scenario); break;
      case "pause": paused = m.paused; break;
      case "view": S?.View(m.x0 | 0, m.y0 | 0, m.x1 | 0, m.y1 | 0); break;
      case "select": S.Select(JSON.stringify(m.ids), m.additive); break;
      case "click": {
        const count = S.Click(m.x | 0, m.y | 0, m.button, m.mods);
        post({ type: "ordered", count, t: m.t, tick: JSON.parse(S.Stats()).tick });
        break;
      }
      case "stop": {
        const count = S.Stop();
        post({ type: "ordered", count, t: m.t, tick: JSON.parse(S.Stats()).tick });
        break;
      }
      case "cursor": post({ type: "cursor", cursor: S.Cursor(m.x | 0, m.y | 0, m.mods), seq: m.seq }); break;
      case "bench": {
        const wasRunning = running;
        running = false;
        const ms = S.TickMany(m.ticks);
        post({ type: "bench", ticks: m.ticks, ms });
        running = wasRunning;
        if (running) { nextTick = performance.now(); loop(); }
        break;
      }
      case "log": post({ type: "log", json: S.SessionLog() }); break;
      case "resync": S.Resync(); break;
    }
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err) });
  }
};
