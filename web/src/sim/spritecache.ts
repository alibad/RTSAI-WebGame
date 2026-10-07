// Prebaked sprite sheets (worker side of sim/OpenRA.WebSim/SpriteStore.cs). A map's packed sprite table and its
// sheets' pixels (gzip) live in IndexedDB, keyed by the engine's reservation key and invalidated when the game
// data changes; restoring skips decoding and packing every sprite file.

const DB_NAME = "rtsai-webgame";
const TABLES = "sprite-tables";
const SHEETS = "sprite-sheets";
/** Packings kept (about 30-45 MB each, one per map and data version); the least recently used go first. */
const KEEP = 4;

interface TableRecord { key: string; version: string; table: ArrayBuffer; sheets: { width: number; height: number }[]; created: number }

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TABLES)) db.createObjectStore(TABLES, { keyPath: "key" });
      if (!db.objectStoreNames.contains(SHEETS)) db.createObjectStore(SHEETS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}

async function gzip(data: Uint8Array) {
  return new Response(new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
}

async function gunzip(blob: Blob) {
  return new Uint8Array(await new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}

/** Sheet sizes from the table header (ORASPR01, count, then type u8, width i32, height i32 per sheet). */
function sheetSizes(table: Uint8Array) {
  const dv = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const n = dv.getInt32(8, true);
  const out: { width: number; height: number }[] = [];
  for (let i = 0, p = 12; i < n; i++, p += 9) out.push({ width: dv.getInt32(p + 1, true), height: dv.getInt32(p + 5, true) });
  return out;
}

export interface BakeStats { restored: number; saved: number; bytes: number; ms: number }

/** A packing baked ahead of time and shipped with the data (websim bake): its table, and where its sheets are. */
export interface ShippedPacking { key: string; table: Uint8Array; sheets: { width: number; height: number; url: string }[] }

/**
 * Reads data/<profile>/sprites/index.json and the tables of every packing baked from exactly this bundle; sheets
 * are fetched only when a packing is restored. Null when there are none (or they were baked from other content).
 */
export async function fetchShippedSprites(dir: string, bundleId: string): Promise<ShippedPacking[] | null> {
  try {
    const res = await fetch(new URL("index.json", dir));
    if (!res.ok) return null;
    const index = await res.json() as { format: string; bundle: string; packings: Record<string, { sheets: { width: number; height: number }[] }> };
    if (index.format !== "ORASPR01" || index.bundle !== bundleId) {
      console.warn(`sprite cache: shipped sheets are for bundle ${index.bundle}, not ${bundleId}; ignored`);
      return null;
    }
    return await Promise.all(Object.entries(index.packings).map(async ([key, p]) => {
      const t = await fetch(new URL(`${key}.table.gz`, dir));
      if (!t.ok) throw new Error(`${key}.table.gz: HTTP ${t.status}`);
      return {
        key,
        table: await gunzip(await t.blob()),
        sheets: p.sheets.map((sh, i) => ({ ...sh, url: new URL(`${key}.${i}.gz`, dir).href })),
      };
    }));
  } catch (e) {
    console.warn("sprite cache: shipped sheets unavailable", e);
    return null;
  }
}

export class SpriteBake {
  private db: Promise<IDBDatabase> | null = null;
  private tables = new Map<string, TableRecord>();
  private shipped = new Map<string, ShippedPacking>();
  private capture: Map<number, Promise<Blob>> | null = null;
  readonly stats: BakeStats = { restored: 0, saved: 0, bytes: 0, ms: 0 };

  constructor(private version: string, private postSheet: (id: number, width: number, height: number, gz: Blob) => void) {}

  /** Reads the cached tables for this game data version (and drops stale ones). */
  async init() {
    try {
      this.db = open();
      const db = await this.db;
      const all = await done(db.transaction(TABLES).objectStore(TABLES).getAll()) as TableRecord[];
      const sheetKeys = new Set(await done(db.transaction(SHEETS).objectStore(SHEETS).getAllKeys()) as string[]);
      // A table is usable only for this data version and with every sheet present (else it is dropped).
      const complete = (t: TableRecord) => t.sheets.every((_, i) => sheetKeys.has(`${t.key}#${i}`));
      const stale = all.filter((t) => t.version !== this.version || !complete(t));
      for (const t of all) if (!stale.includes(t)) this.tables.set(t.key, t);
      this.drop(db, stale);
      this.evict(db);
    } catch (e) {
      console.warn("sprite cache unavailable", e);
      this.db = null;
    }
  }

  private drop(db: IDBDatabase, tables: TableRecord[]) {
    if (!tables.length) return;
    const tx = db.transaction([TABLES, SHEETS], "readwrite");
    for (const t of tables) {
      this.tables.delete(t.key);
      tx.objectStore(TABLES).delete(t.key);
      for (let i = 0; i < t.sheets.length; i++) tx.objectStore(SHEETS).delete(`${t.key}#${i}`);
    }
  }

  /** Keeps the KEEP most recently used packings. */
  private evict(db: IDBDatabase) {
    const all = [...this.tables.values()].sort((a, b) => b.created - a.created);
    this.drop(db, all.slice(KEEP));
  }

  /** Around Prepare/Start: sheets streamed meanwhile are compressed so a fresh packing can be stored. */
  beginCapture() { if (this.db) this.capture = new Map(); }
  endCapture() { this.capture = null; }

  onTexture(id: number, data: Uint8Array) {
    this.capture?.set(id, gzip(data.slice()));
  }

  addShipped(p: ShippedPacking) { this.shipped.set(p.key, p); }

  /** SpriteStore.Load (synchronous, from C#): the shipped or cached table for this exact reservation key. */
  load(key: string): Uint8Array {
    const s = this.shipped.get(key);
    const t = this.tables.get(key);
    console.info(`sprite cache: ${s ? "shipped" : t ? "hit" : "miss"} ${key} (${this.shipped.size} shipped, ${this.tables.size} cached)`);
    return s ? s.table : t ? new Uint8Array(t.table) : new Uint8Array(0);
  }

  /** SpriteStore.Saved: store the table and the sheets' compressed pixels (async, after Prepare). */
  saved(key: string, table: Uint8Array, idList: ArrayLike<number>) {
    // The id list arrives from .NET as a typed array: map() on it would coerce the promises to NaN.
    const ids = Array.from(idList);
    const capture = this.capture;
    if (!this.db || !capture) return;
    const blobs = ids.map((id) => capture.get(id));
    const missing = ids.filter((id) => !capture.has(id));
    if (missing.length) { // a sheet never reached the page: do not cache a partial packing
      console.warn(`sprite cache: not saved, ${missing.length}/${ids.length} sheets were not streamed`, missing.join(","));
      return;
    }
    const record: TableRecord = { key, version: this.version, table: table.slice().buffer, sheets: sheetSizes(table), created: Date.now() };
    (async () => {
      const t0 = performance.now();
      const data = await Promise.all(blobs as Promise<Blob>[]);
      const db = await this.db!;
      const tx = db.transaction([TABLES, SHEETS], "readwrite");
      data.forEach((b, i) => tx.objectStore(SHEETS).put(b, `${key}#${i}`));
      tx.objectStore(TABLES).put(record);
      await new Promise((r, j) => { tx.oncomplete = r; tx.onerror = () => j(tx.error); });
      this.tables.set(key, record);
      this.evict(db);
      this.stats.saved++;
      this.stats.bytes = data.reduce((n, b) => n + b.size, 0);
      this.stats.ms = performance.now() - t0;
      console.info(`sprite cache: saved ${ids.length} sheets, ${(this.stats.bytes / 1048576).toFixed(1)} MB in ${this.stats.ms.toFixed(0)} ms`);
    })().catch((e) => console.warn("sprite cache save failed", e));
  }

  /**
   * SpriteStore.Restored: the restored sheets go from the cache to the page still compressed; the page inflates
   * them (off this thread, which is busy loading the world meanwhile).
   */
  restored(key: string, idList: ArrayLike<number>) {
    const ids = Array.from(idList);
    const shipped = this.shipped.get(key);
    if (shipped) {
      // Shipped sheets come over HTTP (cached by the browser like the rest of the data), still compressed.
      this.stats.restored++;
      const t0 = performance.now();
      Promise.all(shipped.sheets.map(async (sh, i) => {
        const res = await fetch(sh.url);
        if (!res.ok) throw new Error(`${sh.url}: HTTP ${res.status}`);
        this.postSheet(ids[i], sh.width, sh.height, await res.blob());
      })).then(() => {
        this.stats.ms = performance.now() - t0;
        console.info(`sprite cache: fetched ${ids.length} shipped sheets in ${this.stats.ms.toFixed(0)} ms`);
      }).catch((e) => console.warn("sprite cache: shipped sheets failed", e));
      return;
    }
    const t = this.tables.get(key);
    if (!t || !this.db) return;
    this.stats.restored++;
    t.created = Date.now(); // last use, for eviction
    this.db.then((db) => db.transaction(TABLES, "readwrite").objectStore(TABLES).put(t)).catch(() => {});
    const t0 = performance.now();
    (async () => {
      const db = await this.db!;
      const tx = db.transaction(SHEETS);
      const blobs = await Promise.all(ids.map((_, i) => done(tx.objectStore(SHEETS).get(`${key}#${i}`)) as Promise<Blob | undefined>));
      blobs.forEach((blob, i) => {
        if (blob instanceof Blob) this.postSheet(ids[i], t.sheets[i].width, t.sheets[i].height, blob);
        else console.warn(`sprite cache: sheet ${i} of ${key} is missing`);
      });
      this.stats.ms = performance.now() - t0;
      console.info(`sprite cache: read ${ids.length} sheets in ${this.stats.ms.toFixed(0)} ms`);
    })().catch((e) => console.warn("sprite cache restore failed", e));
  }
}

/** Page side: inflates a cached sheet. */
export async function gunzipSheet(blob: Blob) {
  return gunzip(blob);
}

/** A short stable hash (FNV-1a 32) of a string, for cache versions. */
export function hashString(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}
