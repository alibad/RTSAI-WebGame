import { intersects, mergeSites, type Bounds, type CoreSite, type Source, type AreaSnapshot } from "./earth-site-model";
import { keepSiteRecord, savedSiteRecord, savedSiteRecords } from "./earth-site-storage";
export interface RegionPack { id: string; name: string; bounds: Bounds; updatedAt: number; coverage: Partial<Record<Source, number>>; file: string; sha256: string; bytes: number; count: number }
export interface SiteManifest { schema: 1; version: string; count: number; updatedAt: number; scope: string; overview: { file: string; sha256: string; bytes: number }; regions: RegionPack[] }
export type SiteCatalog = { manifest: SiteManifest | null; sites: CoreSite[] };
let loading: Promise<SiteCatalog> | null = null;
const pending = new Map<string, Promise<unknown>>();
async function pack<T>(entry: { file: string; sha256: string; bytes: number }): Promise<T> {
  if (!/^(overview|region-[a-z0-9-]+)-[a-f0-9]{16}\.json$/.test(entry.file) || entry.bytes > 2000000) throw Error("Invalid site pack");
  const id = `pack:${entry.sha256}`, cached = await savedSiteRecord<T>(id); if (cached) return cached;
  if (pending.has(id)) return pending.get(id) as Promise<T>;
  const work = (async () => {
    const r = await fetch(new URL(`earth-sites/${entry.file}`, new URL("./", location.href)), { signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw Error("Saved site pack unavailable");
    const bytes = await r.arrayBuffer(); if (bytes.byteLength !== entry.bytes) throw Error("Site pack size mismatch");
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
    if (hash !== entry.sha256) throw Error("Site pack checksum mismatch");
    const data = JSON.parse(new TextDecoder().decode(bytes)) as T; await keepSiteRecord(id, data); return data;
  })();
  pending.set(id, work); try { return await work; } finally { pending.delete(id); }
}
export function preloadKnownSites(force = false): Promise<SiteCatalog> {
  if (force) loading = null;
  return loading ??= (async () => {
    const old = await savedSiteRecord<{ manifest: SiteManifest; checked: number }>("manifest");
    let manifest = old?.manifest ?? null;
    if (force || !old || Date.now() - old.checked > 86400000) try {
      const r = await fetch(new URL("earth-sites/manifest.json", new URL("./", location.href)), { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw Error("Site manifest unavailable");
      const next = await r.json() as SiteManifest;
      if (next.schema !== 1 || !Array.isArray(next.regions) || next.regions.length > 2000 || !next.overview) throw Error("Invalid site manifest");
      manifest = next; await keepSiteRecord("manifest", { manifest, checked: Date.now() });
    } catch { /* Last good manifest also works offline. */ }
    let sites: CoreSite[] = [];
    if (manifest) try { sites = await pack<CoreSite[]>(manifest.overview); } catch { /* Browser discoveries remain available. */ }
    const areas = await savedSiteRecords<AreaSnapshot>("area:");
    return { manifest, sites: mergeSites(sites, ...areas.map(a => a.sites)) };
  })();
}
export async function packagedSites(bounds: Bounds, force = false) {
  // The overview already contains every marker. Bound optional regional metadata even if future packs overlap.
  const catalog = await preloadKnownSites(force), candidates = (catalog.manifest?.regions.filter(r => intersects(r.bounds, bounds)) ?? []).slice(0, 8);
  const loaded = await Promise.allSettled(candidates.map(r => pack<{ sites: CoreSite[] }>(r).then(data => ({ ...r, sites: data.sites }))));
  return { catalog, regions: loaded.flatMap(r => r.status === "fulfilled" ? [r.value] : []) };
}
