// The mod's own cursors: the Cursors sequences of mod.yaml (art, palettes, hotspots) as the engine's CursorManager
// loads them, sent once by the worker (Ui.CursorSet). The engine decides which cursor applies
// (OrderGenerator.GetCursor, RadarWidget's "-minimap" variants, ViewportControllerWidget's scroll cursors); this
// turns its names into CSS cursors (hardware, no added latency) and into canvases for the drawn cursor that the
// mouse lock (pointer.ts) shows. Animated cursors advance one frame per 80 ms, as CursorManager.Tick (every second
// 40 ms UI tick).
// Until the set arrives (and for a name the mod lacks) the plain CSS cursors stand in.

export const CURSOR_FRAME_MS = 80;

export interface ModCursor {
  name: string;
  /** Every frame drawn into one box (the union of the frames around the hotspot), so all frames share a hotspot. */
  frames: HTMLCanvasElement[];
  hx: number;
  hy: number;
}

const set = new Map<string, ModCursor>();
const cssCache = new Map<string, string[]>();
let version = 0;

/** Parses Ui.CursorSet(): u32 header length, JSON [{name, frames: [[x, y, w, h, offset]]}], RGBA pixels. */
export function loadModCursors(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + n))) as { name: string; frames: [number, number, number, number, number][] }[];
  const pixels = data.subarray(4 + n);
  set.clear();
  cssCache.clear();
  for (const c of header) {
    if (!c.frames.length) continue;
    // CursorManager: bounds relative to the hotspot, the hotspot itself always inside.
    let x0 = 0, y0 = 0, x1 = 1, y1 = 1;
    for (const [x, y, w, h] of c.frames) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h); }
    const frames = c.frames.map(([x, y, w, h, off]) => {
      const canvas = document.createElement("canvas");
      canvas.width = x1 - x0;
      canvas.height = y1 - y0;
      if (w > 0 && h > 0) {
        const img = new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset + off, w * h * 4).slice(), w, h);
        canvas.getContext("2d")!.putImageData(img, x - x0, y - y0);
      }
      return canvas;
    });
    set.set(c.name, { name: c.name, frames, hx: -x0, hy: -y0 });
  }
  version++;
}

export function modCursorsVersion() { return version; }

/** The mod cursor for an engine name: the name itself, else its family without a suffix, else "default". */
export function modCursor(name: string): ModCursor | null {
  return set.get(name) ?? set.get(name.replace(/-minimap$/, "")) ?? set.get("default") ?? null;
}

/** The frame showing at time t (ms). */
export function cursorFrame(c: ModCursor, t: number) {
  return c.frames.length > 1 ? Math.floor(t / CURSOR_FRAME_MS) % c.frames.length : 0;
}

/** CSS cursor value for an engine cursor name at time t (ms). */
export function cursorFor(engineName: string, t = 0): string {
  const c = modCursor(engineName || "default");
  if (!c) return fallback(engineName);
  let css = cssCache.get(c.name);
  if (!css) {
    // CSS cursors over 128 px are ignored by browsers: those keep the plain fallback.
    css = c.frames.map((f) => (f.width <= 128 && f.height <= 128 ? `url("${f.toDataURL("image/png")}") ${c.hx} ${c.hy}, auto` : fallback(c.name)));
    cssCache.set(c.name, css);
  }
  return css[cursorFrame(c, t)];
}

function fallback(name: string) {
  if (!name || name.startsWith("default")) return "default";
  if (name.includes("blocked") || name === "nopower") return "not-allowed";
  if (name.startsWith("scroll")) return "move";
  return "crosshair";
}
