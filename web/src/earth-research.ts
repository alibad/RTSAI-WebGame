// Saved geography first. Live discovery refreshes bounded areas, never a document per marker.
import { areaFor, boundsAt, contains, DETAIL_TTL, mappedSites, mergeSites, nearby, RETRY_DELAY, SITE_TTL, siteQuery, sources, type AreaSnapshot, type CoreSite, type Place, type Site, type Source } from "./earth-site-model";
import { packagedSites } from "./earth-site-catalog";
import { keepSiteRecord, savedSiteRecord, savedSiteRecords, sitesAreDurable } from "./earth-site-storage";
export type { Place, Site } from "./earth-site-model";
export type SiteStatus = { count: number; storage: "browser" | "session"; dataset: string; updatedAt: number; refreshing: boolean };
const REFERENCES = [
  { name: "Khasab Airport", lat: 26.17083, lon: 56.24056, revision: 1371388595 },
  { name: "Qeshm International Airport", lat: 26.7546389, lon: 55.9023528, revision: 1374048451 },
];
export function referenceSites(place: Place, radius: number): Site[] {
  return nearby(REFERENCES.map(p => ({ ...p, id: `reference-${p.revision}`, kind: "Airfield", source: "Wikipedia" as const, snapshot: "Reference checked 16 Oct 2026",
    extract: "Geographic reference. Current operations are not verified.", url: `https://en.wikipedia.org/w/index.php?oldid=${p.revision}` })), place, radius);
}
async function json(url: string, signal: AbortSignal) {
  const r = await fetch(url, { signal }); if (!r.ok) throw Error(`Source returned ${r.status}`); return r.json();
}
const inFlight = new Map<string, Promise<{ sites: CoreSite[]; complete: boolean }>>();
export async function researchSites(place: Place, radius: number, options: {
  signal: AbortSignal; mapped: (query: string, signal: AbortSignal) => Promise<{ elements?: unknown[]; remark?: string }>;
  update: (sites: Site[]) => void; known?: (sites: CoreSite[]) => void; log: (message: string) => void; status?: (value: SiteStatus) => void; force?: boolean;
}) {
  const { signal, mapped, update, log } = options, area = areaFor(place, radius), requested = boundsAt(place, radius * 1.6);
  await new Promise(resolve => setTimeout(resolve, 300)); if (signal.aborted) return;
  let known: CoreSite[] = referenceSites(place, radius), version = "Local discoveries";
  const publish = (refreshing: boolean) => {
    if (signal.aborted) return;
    const list = nearby(known, place, radius); update(list); options.known?.(known);
    options.status?.({ count: list.length, storage: sitesAreDurable() ? "browser" : "session", dataset: version, updatedAt: Math.max(0, ...list.map(s => s.updatedAt ?? 0)), refreshing });
  };
  if (known.length) publish(true);
  const [packaged, saved] = await Promise.all([packagedSites(requested, options.force), savedSiteRecords<AreaSnapshot>("area:")]);
  if (signal.aborted) return;
  version = packaged.catalog.manifest?.version ?? version;
  known = mergeSites(known, packaged.catalog.sites, ...packaged.regions.map(r => r.sites), ...saved.map(s => s.sites));
  const same = saved.find(s => s.id === area.id);
  const snapshot: AreaSnapshot = same ? { ...same, sites: [...same.sites], checked: { ...same.checked }, attempted: { ...same.attempted } }
    : { id: area.id, bounds: area.bounds, updatedAt: 0, checked: {}, attempted: {}, sites: [] };
  const covered = (source: Source) => Math.max(0,
    ...saved.filter(s => contains(s.bounds, requested)).map(s => s.checked[source] ?? 0),
    ...packaged.regions.filter(r => contains(r.bounds, requested)).map(r => r.coverage[source] ?? 0));
  const needed = sources.filter(source => options.force || (Date.now() - covered(source) > SITE_TTL && Date.now() - (snapshot.attempted[source] ?? 0) > RETRY_DELAY));
  publish(needed.length > 0); log(`Loaded <b>${nearby(known, place, radius).length}</b> known sites from saved datasets`);
  const work = async (source: Source) => {
    const key = `${area.id}:${source}`;
    try {
      let promise = inFlight.get(key);
      if (!promise) {
        // Shared refresh fills the cache even if a moving view is cancelled; its own deadline bounds the work.
        const deadline = AbortSignal.timeout(source === "OpenStreetMap" ? 15000 : 12000);
        promise = source === "OpenStreetMap" ? mapped(siteQuery(area.bounds), deadline).then(p => ({ sites: mappedSites(p, Date.now()), complete: true })) : (async () => {
          const dy = area.radius * .8 / 111320, dx = dy / Math.cos(area.place.lat * Math.PI / 180);
          const points = area.radius > 10000 ? [[area.place.lat, area.place.lon], [area.place.lat + dy, area.place.lon], [area.place.lat - dy, area.place.lon], [area.place.lat, area.place.lon + dx], [area.place.lat, area.place.lon - dx]] : [[area.place.lat, area.place.lon]];
          const responses = await Promise.allSettled(points.map(([lat, lon]) => json(`https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${lat}|${lon}&gsradius=10000&gslimit=500&format=json&origin=*`, deadline)));
          const valid = responses.filter(r => r.status === "fulfilled" && Array.isArray(r.value.query?.geosearch));
          if (!valid.length) throw Error("No article response");
          const relevant = /air ?base|airbase|naval|military|army|camp |fort|barracks|garrison|\b(airport|port|harbou?r|strait|bridge|dam|canal|island)\b/i;
          type Article = { pageid: number; title: string; lat: number; lon: number };
          return { sites: mergeSites(valid.flatMap(r => r.status === "fulfilled" ? (r.value.query.geosearch as Article[]).filter(a => relevant.test(a.title) && !/stadium|university|school|hospital|mosque|church|club|museum|hotel|mall/i.test(a.title))
            .map(a => ({ id: `wiki-${a.pageid}`, name: a.title, kind: /military|air ?base|naval|barracks|fort/i.test(a.title) ? "Military" : "Infrastructure", lat: a.lat, lon: a.lon, source: "Wikipedia" as const, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(a.title.replaceAll(" ", "_"))}`, updatedAt: Date.now() })) : [])), complete: valid.length === points.length };
        })();
        inFlight.set(key, promise); void promise.finally(() => inFlight.delete(key)).catch(() => undefined);
      }
      const result = await promise, records = result.sites;
      snapshot.attempted[source] = Date.now(); if (result.complete) snapshot.checked[source] = Date.now(); snapshot.updatedAt = Date.now();
      snapshot.sites = mergeSites(snapshot.sites.filter(s => s.source !== source), records);
      await keepSiteRecord(`area:${area.id}`, { ...snapshot, sites: [...snapshot.sites], checked: { ...snapshot.checked }, attempted: { ...snapshot.attempted } });
      known = mergeSites(known, records); publish(true);
      if (!signal.aborted) log(`Saved <b>${records.length}</b> ${source} site records in this browser`);
    } catch {
      snapshot.attempted[source] = Date.now();
      await keepSiteRecord(`area:${area.id}`, { ...snapshot, sites: [...snapshot.sites], checked: { ...snapshot.checked }, attempted: { ...snapshot.attempted } });
      if (!signal.aborted) log(`${source} refresh unavailable; saved sites remain available.`);
    }
  };
  await Promise.allSettled(needed.map(work)); publish(false);
}
/** Only the selected article's text. Marker loading never fans out into article summaries. */
export async function siteDetails(site: Site, signal: AbortSignal): Promise<Partial<Site>> {
  if (site.source !== "Wikipedia" || !site.id.startsWith("wiki-") || !site.url?.startsWith("https://en.wikipedia.org/wiki/")) return {};
  const key = `detail:${site.id}`, cached = await savedSiteRecord<{ updatedAt: number; detail: Partial<Site> }>(key);
  if (cached && Date.now() - cached.updatedAt < DETAIL_TTL) return cached.detail;
  try {
    const title = decodeURIComponent(site.url.slice("https://en.wikipedia.org/wiki/".length));
    const summary = await json(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, AbortSignal.any([signal, AbortSignal.timeout(8000)]));
    const detail = { extract: typeof summary.extract === "string" ? summary.extract.slice(0, 1600) : undefined, snapshot: `Article context saved ${new Date().toLocaleDateString()} · see source for license` };
    await keepSiteRecord(key, { updatedAt: Date.now(), detail }); return detail;
  } catch { return cached?.detail ?? {}; }
}
