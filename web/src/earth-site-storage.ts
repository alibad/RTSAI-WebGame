// One local record per area or versioned pack, not one Firestore document per marker.
type RecordValue = { id: string; value: unknown; used: number; bytes: number };
const memory = new Map<string, RecordValue>();
let opening: Promise<IDBDatabase> | null = null;
let durable = typeof indexedDB !== "undefined";
let hydrated: Promise<void> | null = null;
const db = () => opening ??= new Promise<IDBDatabase>((resolve, reject) => {
  if (typeof indexedDB === "undefined") return reject(Error("Browser storage unavailable"));
  const request = indexedDB.open("rtsai-earth-sites", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("records", { keyPath: "id" });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
export const sitesAreDurable = () => durable;
export async function savedSiteRecord<T>(id: string): Promise<T | null> {
  if (memory.has(id)) return memory.get(id)!.value as T;
  try {
    const d = await db();
    const record = await new Promise<RecordValue | undefined>((resolve, reject) => {
      const r = d.transaction("records").objectStore("records").get(id); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    if (record) { memory.set(id, record); return record.value as T; }
  } catch { durable = false; }
  return null;
}
export async function savedSiteRecords<T>(prefix: string): Promise<T[]> {
  try {
    const d = await db();
    const records = await new Promise<RecordValue[]>((resolve, reject) => {
      const r = d.transaction("records").objectStore("records").getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    for (const r of records) memory.set(r.id, r);
  } catch { durable = false; }
  return [...memory.values()].filter(r => r.id.startsWith(prefix)).map(r => r.value as T);
}
export async function keepSiteRecord(id: string, value: unknown) {
  // Include old on-disk records in eviction accounting, even when this session has not opened their areas.
  await (hydrated ??= savedSiteRecords("__hydrate_only__").then(() => undefined));
  const record = { id, value, used: Date.now(), bytes: new TextEncoder().encode(JSON.stringify(value)).length };
  if (record.bytes > 2000000) return false;
  memory.set(id, record);
  // Bound the complete cache, including summaries and immutable region packs, to 8 MB / 256 records.
  let bytes = [...memory.values()].reduce((n, r) => n + r.bytes, 0);
  const evicted: string[] = [];
  for (const r of [...memory.values()].sort((a, b) => a.used - b.used)) {
    if (bytes <= 8000000 && memory.size <= 256) break;
    bytes -= r.bytes; memory.delete(r.id); evicted.push(r.id);
  }
  try {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction("records", "readwrite"), store = tx.objectStore("records");
      store.put(record); for (const key of evicted) store.delete(key);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    return true;
  } catch { durable = false; return false; }
}
