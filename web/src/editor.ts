// The map editor's controller. The engine's own editor (sim EditorHost: the desktop editor's world, brushes, undo and
// save) does the editing; this sends it the chosen brush and the pointer in world pixels, shows what it reports, keeps
// the player's maps in a library in this browser (IndexedDB), and opens maps from anywhere: the bundled and generated
// maps, a new blank one, a random one from the engine's generator, a real place (the website's Earth compiler), or an
// .oramap file.

import type { Game, GenerateRequest } from "./game";
import { fromBase64, toBase64, type ElevationGrid } from "./elevation";
import { store } from "./store";
import type { IconSprite } from "./render/icons";

export type TileSprite = IconSprite & { x: number; y: number };
export interface EditorTemplate { id: number; size: [number, number]; categories: string[]; tiles: TileSprite[] }
export interface EditorActor { name: string; label: string; categories: string[] }
export interface EditorCatalog {
  categories: string[]; templates: EditorTemplate[]; actors: EditorActor[]; resources: string[];
  owners: { name: string; color: string; playable: boolean }[]; title: string; author: string; size: [number, number];
}
export type EditorTool = "select" | "terrain" | "resource" | "actor" | "spawn";

export interface EditorState {
  /** The map open in the editor (its engine id), null on the start screen. */
  map: string | null;
  opening: string | null;
  error: string;
  catalog: EditorCatalog | null;
  tool: EditorTool;
  brush: string;
  category: string;
  owner: string;
  title: string;
  undo: boolean;
  redo: boolean;
  dirty: boolean;
  saving: boolean;
  /** The last save: the map's id in the library (playable in skirmish and the simulator). */
  saved: string | null;
  thumbs: Record<number, string>;
}

const initial: EditorState = {
  map: null, opening: null, error: "", catalog: null, tool: "select", brush: "select", category: "", owner: "Neutral", title: "",
  undo: false, redo: false, dirty: false, saving: false, saved: null, thumbs: {},
};

type History = { undo?: boolean; redo?: boolean; brush?: string; error?: string };

// ---------------------------------------------------------------- the library (this browser)

export interface LibraryMap { id: string; title: string; players: number; files: Record<string, Uint8Array>; updated: number }
const DB = "rtsai-maps", STORE = "maps";
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function libraryMaps(): Promise<LibraryMap[]> {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const r = d.transaction(STORE).objectStore(STORE).getAll();
      r.onsuccess = () => resolve((r.result as LibraryMap[]).sort((a, b) => b.updated - a.updated));
      r.onerror = () => reject(r.error);
    });
  } catch { return []; }
}
async function keep(map: LibraryMap) {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction(STORE, "readwrite");
    t.objectStore(STORE).put(map);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

async function libraryMap(id: string | null): Promise<LibraryMap | null> {
  if (!id) return null;
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const r = d.transaction(STORE).objectStore(STORE).get(id);
      r.onsuccess = () => resolve(r.result ?? null); r.onerror = () => reject(r.error);
    });
  } catch { return null; }
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class EditorController {
  private moveInFlight = false;
  private pendingMove: [number, number] | null = null;
  private down = false;

  constructor(readonly game: Game) {
    if (!store.get().editor) store.set({ editor: { ...initial } });
  }

  get state() { return store.get().editor ?? initial; }
  get active() { return !!this.state.map && store.get().phase === "playing" && !this.state.opening; }
  private patch(p: Partial<EditorState>) { store.set({ editor: { ...this.state, ...p } }); }

  /** Maps kept in this browser join the map lists (skirmish, simulator, editor), mounted in the engine. */
  async loadLibrary() {
    for (const m of await libraryMaps()) await this.mount(m);
  }

  /** A map's files into the engine's file system and the map lists. */
  private async mount(m: LibraryMap) {
    const s = store.get();
    if (!s.setup) return;
    const files: Record<string, ArrayBuffer> = {};
    for (const [name, bytes] of Object.entries(m.files)) files[name] = bytes.slice().buffer;
    await this.game.client.mountFiles(`/vfs/mods/rtsai/web/content/maps/${m.id}`, files);
    const png = m.files["map.png"];
    const url = png ? URL.createObjectURL(new Blob([png.slice()], { type: "image/png" })) : "";
    const others = s.setup.maps.filter((x) => x.id !== m.id);
    store.set({
      previews: { ...store.get().previews, [m.id]: url },
      setup: { ...s.setup, maps: [{ id: m.id, uid: m.id, title: m.title, players: m.players, tileset: "TEMPERATE", author: "", library: true, slots: Array.from({ length: m.players }, (_, i) => `Multi${i}`) }, ...others] },
    });
  }

  /** Opens a map in the editor: {map: id} or {new: {width, height, title}}. */
  async open(spec: { map: string } | { new: { width: number; height: number; title: string } }, label = "map" in spec ? spec.map : "new") {
    this.patch({ ...initial, opening: label, thumbs: this.state.thumbs });
    try {
      if ("map" in spec) await this.game.ensureMap(spec.map);
      const r = await this.game.client.editorOpen<{ id?: string; error?: string }>(spec);
      if (!r.id) throw Error(r.error ?? "Couldn't open this map.");
      await new Promise<void>((resolve) => { const t = setInterval(() => { if (store.get().phase === "playing") { clearInterval(t); resolve(); } }, 50); });
      const catalog = await this.call<EditorCatalog & { error?: string }>({ op: "catalog" });
      const firstCategory = catalog.categories.find((c) => catalog.templates.some((t) => t.categories.includes(c))) ?? "";
      this.patch({ map: r.id, opening: null, catalog, category: firstCategory, title: catalog.title, error: "" });
      this.game.cam.zoom = 0.6;
      this.game.lookAt((store.get().info!.bounds[0] + store.get().info!.bounds[2]) / 2, (store.get().info!.bounds[1] + store.get().info!.bounds[3]) / 2);
    } catch (e) {
      this.patch({ opening: null, map: null, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** A new random map from the engine's generator, opened for editing. */
  async random(request: Partial<GenerateRequest> = {}) {
    this.patch({ opening: "random", error: "" });
    try {
      const id = await this.game.generateMap({ seed: Math.floor(Math.random() * 1e9), players: 2, terrain: "random", ...request });
      await this.open({ map: id });
    } catch (e) { this.patch({ opening: null, error: e instanceof Error ? e.message : String(e) }); }
  }

  /** Map files from elsewhere (an .oramap upload, the Earth compiler): mounted, listed and kept in the library. */
  async addFiles(id: string, title: string, players: number, files: Record<string, Uint8Array>) {
    const m: LibraryMap = { id, title, players, files, updated: Date.now() };
    await this.mount(m);
    await keep(m).catch(() => undefined);
  }

  /**
   * A real place's ground on an Earth map's files: its hills and valleys from the elevation, with the engine's slope
   * tiles (sim Relief.cs). `keep`: more level ground (MPos and radius in cells), for the bases a mission may put there.
   */
  async relief(files: Record<string, Uint8Array>, grid: ElevationGrid, keep: { u: number; v: number; r: number }[]) {
    const elevation = new Uint8Array(grid.data.buffer, grid.data.byteOffset, grid.data.byteLength);
    const reply = await this.game.client.relief<{ files?: Record<string, string>; levels?: number; slopes?: number; metersPerLevel?: number; error?: string }>({
      files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, toBase64(bytes)])),
      elevation: toBase64(elevation), columns: grid.columns, rows: grid.rows, metersPerCell: grid.metersPerCell, keep,
    });
    if (reply.error || !reply.files) throw Error(reply.error ?? "The ground couldn't be shaped");
    return {
      files: Object.fromEntries(Object.entries(reply.files).map(([name, b64]) => [name, fromBase64(b64)])) as Record<string, Uint8Array>,
      levels: reply.levels ?? 0, slopes: reply.slopes ?? 0, metersPerLevel: reply.metersPerLevel ?? 0,
    };
  }

  /** Map files from elsewhere, opened for editing. */
  async openFiles(id: string, title: string, players: number, files: Record<string, Uint8Array>) {
    await this.addFiles(id, title, players, files);
    await this.open({ map: id });
  }

  call<T = History>(op: Record<string, unknown>) {
    return this.game.client.editor<T>(op);
  }

  private history(h: History) {
    this.patch({ undo: !!h.undo, redo: !!h.redo, brush: h.brush ?? this.state.brush, ...(h.error ? { error: h.error } : {}) });
  }

  setTool(tool: EditorTool) {
    this.patch({ tool });
    if (tool === "select") void this.call({ op: "brush", brush: "select" }).then((h) => this.history(h));
    if (tool === "spawn") void this.call({ op: "brush", brush: "actor", type: "mpspawn", owner: "Neutral" }).then((h) => this.history(h));
  }
  setCategory(category: string) { this.patch({ category }); }
  setOwner(owner: string) { this.patch({ owner }); }
  setTitle(title: string) { this.patch({ title, dirty: true }); }
  fail(error: string) { this.patch({ error }); }

  brushTile(id: number) { void this.call({ op: "brush", brush: "tile", id }).then((h) => this.history(h)); }
  brushResource(type: string) { void this.call({ op: "brush", brush: "resource", type }).then((h) => this.history(h)); }
  /** Lakes and rivers with shores (sim EditorWaterBrush); `radius` is the stroke's half-width in cells. */
  brushWater(radius: number) { void this.call({ op: "brush", brush: "water", radius }).then((h) => this.history(h)); }
  brushActor(type: string) { void this.call({ op: "brush", brush: "actor", type, owner: this.state.owner }).then((h) => this.history(h)); }

  /** Mouse input on the battlefield, in world px. Moves are coalesced: one in flight, the latest kept. */
  pointer(kind: "down" | "up" | "move", wx: number, wy: number, button: number, mods: number) {
    if (!this.active) return;
    if (kind === "move") {
      if (this.moveInFlight) { this.pendingMove = [wx, wy]; return; }
      this.moveInFlight = true;
      void this.call({ op: "pointer", event: "move", x: Math.round(wx), y: Math.round(wy), button: this.down ? 1 : 0, mods }).finally(() => {
        this.moveInFlight = false;
        const next = this.pendingMove;
        this.pendingMove = null;
        if (next) this.pointer("move", next[0], next[1], button, mods);
      });
      return;
    }
    if (kind === "down") this.down = button === 1;
    if (kind === "up") this.down = false;
    void this.call({ op: "pointer", event: kind, x: Math.round(wx), y: Math.round(wy), button, mods }).then((h) => {
      this.history(h);
      if (kind === "up" || kind === "down") this.patch({ dirty: true });
      // Right-click drops a brush (the desktop editor's rule): the tool follows.
      if (h.brush === "select" && this.state.tool !== "select" && button === 2) this.patch({ tool: "select" });
    });
  }

  undo() { void this.call({ op: "undo" }).then((h) => this.history(h)); }
  redo() { void this.call({ op: "redo" }).then((h) => this.history(h)); }
  deleteSelection() { void this.call({ op: "delete" }).then((h) => this.history(h)); }

  /** Saves into this browser's library (and the map lists); returns the saved map's id. */
  async save(): Promise<string | null> {
    if (!this.active || this.state.saving) return null;
    const sourceId = this.state.saved ?? this.state.map;
    this.patch({ saving: true, error: "" });
    try {
      const r = await this.call<{ id?: string; title?: string; players?: number; files?: Record<string, string>; error?: string }>({ op: "save", title: this.state.title || "Untitled map", author: "RTS AI player" });
      if (!r.id || !r.files) throw Error(r.error ?? "Couldn't save this map.");
      const files = Object.fromEntries(Object.entries(r.files).map(([k, v]) => [k, b64(v)]));
      // The engine rewrites terrain/actors, but geographic evidence belongs to the authored map too.
      const previous = await libraryMap(sourceId);
      for (const name of ["earth.json", "sites.json", "provenance.json"]) if (!files[name] && previous?.files[name]) files[name] = previous.files[name].slice();
      const m: LibraryMap = { id: r.id, title: r.title ?? this.state.title, players: r.players ?? 2, files, updated: Date.now() };
      await this.mount(m);
      await keep(m);
      this.patch({ saving: false, saved: r.id, dirty: false });
      return r.id;
    } catch (e) {
      this.patch({ saving: false, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  /** The saved map as an .oramap file (a zip of its files), for the desktop editor or sharing. */
  async download() {
    const id = this.state.saved ?? await this.save();
    if (!id) return;
    const m = await libraryMap(id);
    if (!m) return;
    const zip = zipStore(m.files);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([zip.slice()], { type: "application/zip" }));
    a.download = `${(m.title || "map").replace(/[^\w-]+/g, "-").toLowerCase()}.oramap`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /** Thumbnails of templates, drawn from the engine's own tile sprites (like the cameos); retried while sheets load. */
  thumbnails(ids: number[]) {
    const cat = this.state.catalog;
    if (!cat) return;
    const want = ids.filter((id, i) => ids.indexOf(id) === i && this.state.thumbs[id] === undefined).map((id) => cat.templates.find((t) => t.id === id)).filter((t): t is EditorTemplate => !!t);
    if (!want.length) return;
    const done: Record<number, string> = {};
    for (const t of want.slice(0, 48)) {
      const url = this.game.renderer.renderTiles(t.tiles);
      if (url !== null) done[t.id] = url;
    }
    if (Object.keys(done).length) this.patch({ thumbs: { ...this.state.thumbs, ...done } });
    if (want.length > Object.keys(done).length) setTimeout(() => this.thumbnails(ids), 120);
  }

  close() {
    this.patch({ ...initial, thumbs: this.state.thumbs });
    if (store.get().phase === "playing") this.game.quit();
  }
}

// ---------------------------------------------------------------- .oramap (a zip, stored without compression)

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function zipStore(files: Record<string, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = new TextEncoder().encode(name), crc = crc32(data);
    const local = new Uint8Array(30 + n.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, n.length, true);
    local.set(n, 30);
    const c = new Uint8Array(46 + n.length), cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, n.length, true); cv.setUint32(42, offset, true);
    c.set(n, 46);
    parts.push(local, data); central.push(c);
    offset += local.length + data.length;
  }
  const size = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true); ev.setUint32(12, size, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + size + 22);
  let p = 0;
  for (const x of [...parts, ...central, end]) { out.set(x, p); p += x.length; }
  return out;
}
