import { overpassFailure, terrainBox, terrainQuery } from "@site/lib/earth-evidence";

type TerrainBox = { s: number; w: number; n: number; e: number };
type OverpassPayload = { elements?: Record<string, unknown>[]; remark?: string; osm3s?: { timestamp_osm_base?: string } };

export type TerrainSnapshot = {
  schema: 1; id: string; title: string; bounds: TerrainBox; detail: "local" | "regional";
  fetchedAt: string; osmBase?: string; endpoint: string; query: string; payload: OverpassPayload;
};
type Entry = Omit<TerrainSnapshot, "payload" | "query"> & { file: string; sha256: string; bytes: number };
type RecordValue = { id: string; snapshot: TerrainSnapshot; bytes: number; used: number };
const memory = new Map<string, RecordValue>();
let database: Promise<IDBDatabase> | undefined;
let hydration: Promise<void> | undefined;
let manifest: Promise<Entry[]> | undefined;
let durable = typeof indexedDB !== "undefined";
const MAX_BYTES = 32_000_000, MAX_RECORDS = 12, MAX_SNAPSHOT = 12_000_000;
const db = () => database ??= new Promise<IDBDatabase>((resolve, reject) => {
  if (typeof indexedDB === "undefined") return reject(Error("Storage unavailable"));
  const request = indexedDB.open("rtsai-earth-terrain", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("areas", { keyPath: "id" });
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
export const coversTerrain = (outer: TerrainBox, inner: TerrainBox) =>
  [outer.s, outer.w, outer.n, outer.e, inner.s, inner.w, inner.n, inner.e].every(Number.isFinite) &&
  outer.s <= inner.s + 1e-9 && outer.w <= inner.w + 1e-9 && outer.n >= inner.n - 1e-9 && outer.e >= inner.e - 1e-9;
export const validTerrainPayload = (p: OverpassPayload) => !!p && Array.isArray(p.elements) && !overpassFailure(p) && !p.remark;
const valid = (s: TerrainSnapshot) => s?.schema === 1 && !!s.bounds &&
  [s.bounds.s, s.bounds.w, s.bounds.n, s.bounds.e].every(Number.isFinite) &&
  s.bounds.s < s.bounds.n && s.bounds.w < s.bounds.e && Number.isFinite(Date.parse(s.fetchedAt)) &&
  (s.detail === "local" || s.detail === "regional") && validTerrainPayload(s.payload);
async function hydrate() {
  await (hydration ??= (async () => {
    try {
      const d = await db();
      const records = await new Promise<RecordValue[]>((resolve, reject) => {
        const r = d.transaction("areas").objectStore("areas").getAll();
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
      });
      for (const r of records) if (valid(r.snapshot)) memory.set(r.id, r);
    } catch { durable = false; }
  })());
}
async function keep(snapshot: TerrainSnapshot) {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).length;
  if (bytes > MAX_SNAPSHOT) return false;
  await hydrate();
  const record = { id: snapshot.id, snapshot, bytes, used: Date.now() };
  memory.set(record.id, record);
  let total = [...memory.values()].reduce((sum, r) => sum + r.bytes, 0);
  const removed: string[] = [];
  for (const r of [...memory.values()].sort((a, b) => a.used - b.used)) {
    if (total <= MAX_BYTES && memory.size <= MAX_RECORDS) break;
    total -= r.bytes; memory.delete(r.id); removed.push(r.id);
  }
  try {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction("areas", "readwrite"), store = tx.objectStore("areas");
      store.put(record); removed.forEach(id => store.delete(id));
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    return true;
  } catch { durable = false; return false; }
}
const localURL = (file: string) => new URL(`earth-terrain/${file}`, new URL("./", location.href)).href;
async function packaged(bounds: TerrainBox, detail: string, signal: AbortSignal) {
  const entries = await (manifest ??= fetch(localURL("manifest.json"), { signal: AbortSignal.timeout(4000) })
    .then(async r => { const data = r.ok ? await r.json() : null; return Array.isArray(data?.areas) ? data.areas as Entry[] : []; }).catch(() => []));
  const choices = entries.filter(e => e?.bounds && typeof e.fetchedAt === "string" && coversTerrain(e.bounds, bounds) && (detail === "regional" || e.detail === "local"))
    .sort((a, b) => (b.osmBase || b.fetchedAt).localeCompare(a.osmBase || a.fetchedAt));
  for (const e of choices) {
    signal.throwIfAborted();
    if (!/^[a-z0-9-]+\.json$/.test(e.file) || e.bytes > MAX_SNAPSHOT) continue;
    try {
      const r = await fetch(localURL(e.file), { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      if (!r.ok) continue;
      const data = await r.arrayBuffer();
      if (data.byteLength !== e.bytes) continue;
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map(b => b.toString(16).padStart(2, "0")).join("");
      if (hash !== e.sha256) continue;
      const snapshot: TerrainSnapshot = JSON.parse(new TextDecoder().decode(data));
      if (!valid(snapshot) || !coversTerrain(snapshot.bounds, bounds) || (detail === "local" && snapshot.detail !== "local")) continue;
      const saved = await keep(snapshot);
      return { snapshot, saved };
    } catch { signal.throwIfAborted(); }
  }
  return null;
}
export type TerrainResult = { snapshot: TerrainSnapshot; source: "browser" | "packaged" | "live"; saved: boolean; refreshFailed?: boolean };
export async function acquireTerrain(lat: number, lon: number, radius: number, options: {
  signal: AbortSignal; title: string; refresh?: boolean;
  request: (query: string, signal: AbortSignal) => Promise<OverpassPayload>;
}): Promise<TerrainResult> {
  const bounds = terrainBox(lat, lon, radius), detail = radius <= 10000 ? "local" : "regional";
  await hydrate(); options.signal.throwIfAborted();
  const hit = [...memory.values()].filter(r => coversTerrain(r.snapshot.bounds, bounds) && (detail === "regional" || r.snapshot.detail === "local"))
    .sort((a, b) => (b.snapshot.osmBase || b.snapshot.fetchedAt).localeCompare(a.snapshot.osmBase || a.snapshot.fetchedAt))[0];
  let saved: TerrainResult | null = hit ? { snapshot: hit.snapshot, source: "browser", saved: durable } : null;
  if (hit) { hit.used = Date.now(); void keep(hit.snapshot); }
  if (!saved) { const pack = await packaged(bounds, detail, options.signal); if (pack) saved = { ...pack, source: "packaged" }; }
  if (saved && !options.refresh) return saved;
  const query = terrainQuery(lat, lon, radius);
  try {
    const payload = await options.request(query, options.signal);
    options.signal.throwIfAborted();
    if (!validTerrainPayload(payload)) throw Error("Incomplete geography response");
    const snapshot: TerrainSnapshot = { schema: 1, id: `${detail}:${lat}:${lon}:${radius}`, title: options.title, bounds, detail,
      fetchedAt: new Date().toISOString(), osmBase: payload.osm3s?.timestamp_osm_base, endpoint: "OpenStreetMap / Overpass", query, payload };
    return { snapshot, source: "live", saved: await keep(snapshot) };
  } catch {
    options.signal.throwIfAborted();
    if (saved) return { ...saved, refreshFailed: true };
    throw Error("The geography service is busy and this area has no saved terrain yet. Your selection is kept. Try Generate again, or choose a previously saved area.");
  }
}
