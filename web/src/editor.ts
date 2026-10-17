// The map editor's controller. The engine's own editor (sim EditorHost: the desktop editor's world, brushes, undo and
// save) does the editing; this sends it the chosen brush and the pointer in world pixels, shows what it reports, keeps
// the player's maps in a library in this browser (IndexedDB), and opens maps from anywhere: the bundled and generated
// maps, a new blank one, a random one from the engine's generator, a real place (the website's Earth compiler), or an
// .oramap file.

import type { Game, GenerateRequest } from "./game";
import { fromBase64, toBase64, type ElevationGrid } from "./elevation";
import { store } from "./store";
import type { IconSprite } from "./render/icons";
import { EditorPointerStream } from "./editor-pointer";

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
  fieldRadius: number;
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
  placement: { added: number; blocked?: string } | null;
}

const initial: EditorState = {
  map: null, opening: null, error: "", catalog: null, tool: "select", brush: "select", fieldRadius: 2, category: "", owner: "Neutral", title: "",
  undo: false, redo: false, dirty: false, saving: false, saved: null, thumbs: {}, placement: null,
};

type History = { undo?: boolean; redo?: boolean; brush?: string; error?: string; placement?: EditorState["placement"] };

// ---------------------------------------------------------------- the library (this browser)

export interface LibraryMap { id: string; title: string; players: number; files: Record<string, Uint8Array>; updated: number }
function compatibleMap(map: LibraryMap) {
  const mode = store.get().setup?.modId;
  if (!mode) return true; // Historical runtimes did not identify their foundation.
  const yaml = map.files['map.yaml'];
  const required = yaml && /^RequiresMod:\s*(\S+)/m.exec(new TextDecoder().decode(yaml))?.[1];
  if (!required) return true;
  return mode === 'rtsai-classic-core' ? ['ra', mode].includes(required)
    : mode === 'rtsai' ? ['ra2', mode].includes(required) : required === mode;
}
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
      r.onsuccess = () => resolve((r.result as LibraryMap[]).filter(compatibleMap).sort((a, b) => b.updated - a.updated));
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
  private down = false;
  private pointers = new EditorPointerStream(async input => {
    if (!this.active) return;
    const map = this.state.map;
    const h = await this.call({ op: "pointer", ...input });
    if (!this.active || this.state.map !== map) return;
    if (input.event !== "move" || h.error) this.history(h);
    if (input.event === "up") this.patch({ dirty: h.placement ? h.placement.added > 0 || this.state.dirty : true });
    if (h.brush === "select" && this.state.tool !== "select" && input.button === 2) this.patch({ tool: "select" });
  }, error => this.fail(error instanceof Error ? error.message : String(error)));

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
    if (!compatibleMap(m)) throw new Error('This saved map belongs to another game mode. Open it in that mode; your saved copy is preserved.');
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
      setup: { ...s.setup, maps: [{ id: m.id, uid: m.id, title: m.title, players: m.players, tileset: /^Tileset:\s*(\S+)/m.exec(new TextDecoder().decode(m.files['map.yaml']))?.[1] ?? 'TEMPERATE', author: "", library: true, slots: Array.from({ length: m.players }, (_, i) => `Multi${i}`) }, ...others] },
    });
  }

  /** Opens a map in the editor: {map: id} or {new: {width, height, title}}. */
  async open(spec: { map: string } | { new: { width: number; height: number; title: string } }, label = "map" in spec ? spec.map : "new") {
    this.pointers.reset(); this.down = false;
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
    this.patch({ undo: !!h.undo, redo: !!h.redo, brush: h.brush ?? this.state.brush, ...(h.error ? { error: h.error } : {}), ...(h.placement !== undefined ? { placement: h.placement } : {}) });
  }
  private afterPointers(op: Record<string, unknown>, edited = false) {
    void this.pointers.settled().then(() => this.call(op)).then(h => {
      this.history(h);
      if (edited && !h.error) this.patch({ dirty: true, placement: null });
    }).catch(error => this.fail(error instanceof Error ? error.message : String(error)));
  }

  setTool(tool: EditorTool) {
    this.patch({ tool, placement: null });
    if (tool === "select") this.afterPointers({ op: "brush", brush: "select" });
    if (tool === "spawn") this.afterPointers({ op: "brush", brush: "actor", type: "mpspawn", owner: "Neutral" });
  }
  setCategory(category: string) { this.patch({ category }); }
  setOwner(owner: string) { this.patch({ owner }); }
  setTitle(title: string) { this.patch({ title, dirty: true }); }
  fail(error: string) { this.patch({ error }); }

  brushTile(id: number) { this.afterPointers({ op: "brush", brush: "tile", id }); }
  brushResource(type: string) { this.patch({ placement: null }); this.afterPointers({ op: "brush", brush: "resource", type, radius: this.state.fieldRadius }); }
  brushFlatten() { this.patch({ placement: null }); this.afterPointers({ op: "brush", brush: "flatten", radius: this.state.fieldRadius }); }
  fieldSize(radius: number) {
    this.patch({ fieldRadius: radius, placement: null });
    if (this.state.brush === "flatten") this.brushFlatten();
    else this.brushResource(this.state.brush.startsWith("resource:") ? this.state.brush.slice(9) : "Ore");
  }
  /** Lakes and rivers with shores (sim EditorWaterBrush); `radius` is the stroke's half-width in cells. */
  brushWater(radius: number) { this.afterPointers({ op: "brush", brush: "water", radius }); }
  brushActor(type: string) { this.afterPointers({ op: "brush", brush: "actor", type, owner: this.state.owner }); }

  /** Mouse input in world px. Coalesce moves without losing their buttons or moving them after release. */
  pointer(kind: "down" | "up" | "move", wx: number, wy: number, button: number, mods: number) {
    if (!this.active) return;
    if (kind === "down") this.down = button === 1;
    // Native brushes sample on down/move. Include the release position before completing the same stroke.
    if (kind === "up" && this.down) this.pointers.push({ event: "move", x: Math.round(wx), y: Math.round(wy), button: 1, mods });
    if (kind === "up") this.down = false;
    this.pointers.push({ event: kind, x: Math.round(wx), y: Math.round(wy), button: kind === "move" ? this.down ? 1 : 0 : button, mods });
  }

  undo() { this.afterPointers({ op: "undo" }, true); }
  redo() { this.afterPointers({ op: "redo" }, true); }
  deleteSelection() { this.afterPointers({ op: "delete" }, true); }

  /** Saves into this browser's library (and the map lists); returns the saved map's id. */
  async save(): Promise<string | null> {
    if (!this.active || this.state.saving) return null;
    const sourceId = this.state.saved ?? this.state.map;
    this.patch({ saving: true, error: "" });
    try {
      await this.pointers.settled();
      const r = await this.call<{ id?: string; title?: string; players?: number; files?: Record<string, string>; error?: string }>({ op: "save", title: this.state.title || "Untitled map", author: "RTS AI player" });
      if (!r.id || !r.files) throw Error(r.error ?? "Couldn't save this map.");
      const files = Object.fromEntries(Object.entries(r.files).map(([k, v]) => [k, b64(v)]));
      // The engine rewrites terrain/actors, but geographic evidence belongs to the authored map too.
      const previous = await libraryMap(sourceId);
      for (const name of ["earth.json", "sites.json", "geography.json", "provenance.json"]) if (!files[name] && previous?.files[name]) files[name] = previous.files[name].slice();
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
    await this.pointers.settled();
    const id = this.state.dirty || !this.state.saved ? await this.save() : this.state.saved;
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
    this.pointers.reset(); this.down = false;
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
