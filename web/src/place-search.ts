// Explicit searches only: no per-keystroke geocoding. Share the queue with country lookup,
// cache repeat queries, and respect Nominatim's one-request-per-second limit.
const cache = new Map<string, unknown>();
let queue: Promise<unknown> = Promise.resolve();
let nextRequest = 0;

export function geocode<T>(operation: "search" | "reverse", params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const key = `${operation}?${new URLSearchParams({ format: "jsonv2", ...params })}`;
  const task = queue.catch(() => undefined).then(async () => {
    signal?.throwIfAborted();
    if (cache.has(key)) return cache.get(key) as T;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, nextRequest - Date.now())));
    signal?.throwIfAborted();
    nextRequest = Date.now() + 1100;
    const response = await fetch(`https://nominatim.openstreetmap.org/${key}`, {
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(12000)]),
    });
    if (!response.ok) throw Error("Place search is unavailable. Try again or pick a point on the map.");
    const result = await response.json() as T;
    cache.set(key, result);
    if (cache.size > 50) cache.delete(cache.keys().next().value!);
    return result;
  });
  queue = task;
  return task;
}

export interface PlaceResult { name: string; lat: number; lon: number; detail: string }
export async function searchPlaces(query: string, signal: AbortSignal): Promise<PlaceResult[]> {
  const results = await geocode<{ display_name: string; lat: string; lon: string; name?: string }[]>("search", { q: query, limit: "5" }, signal);
  const labels = new Set<string>();
  return results.map(r => ({ name: r.name || r.display_name.split(",")[0], detail: r.display_name, lat: Number(r.lat), lon: Number(r.lon) }))
    .filter(r => {
      if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon) || Math.abs(r.lat) > 84 || Math.abs(r.lon) > 180 || labels.has(r.detail)) return false;
      labels.add(r.detail);
      return true;
    });
}
