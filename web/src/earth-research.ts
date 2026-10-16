// Optional context for missions. Never a prerequisite for compiling geographic terrain.
export type Place = { name: string; lat: number; lon: number };
export type Site = { id: string; name: string; kind: string; lat: number; lon: number; source: "OpenStreetMap" | "Wikipedia"; url?: string; extract?: string; thumb?: string; operator?: string; dist: number };

const distance = (a: Place | Site, b: Place | Site) => {
  const r = Math.PI / 180, dl = (b.lat - a.lat) * r, dn = (b.lon - a.lon) * r;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) ** 2));
};

async function json(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw Error(`Source returned ${response.status}`);
  return response.json();
}

/** Independent, bounded lookups. Publish titles/coordinates before optional article summaries finish. */
export async function researchSites(place: Place, radius: number, options: {
  signal: AbortSignal;
  mapped: (query: string, signal: AbortSignal) => Promise<{ elements?: unknown[] }>;
  update: (sites: Site[]) => void;
  log: (message: string) => void;
}) {
  const { signal, mapped, update, log } = options;
  let osm: Site[] = [], wiki: Site[] = [];
  const publish = () => {
    // Keep mapped cards as articles arrive, so an already selected mission target never disappears.
    const named = osm.filter(s => s.name !== s.kind)
      .sort((a, b) => a.dist - b.dist).filter((s, i, all) => all.findIndex(x => x.name === s.name) === i).slice(0, 4);
    const unnamed = osm.filter(s => s.name === s.kind).sort((a, b) => a.dist - b.dist)
      .filter((s, i, all) => all.findIndex(x => x.kind === s.kind) === i).slice(0, wiki.length + named.length >= 3 ? 1 : 3);
    if (!signal.aborted) update([...wiki, ...named, ...unnamed]);
  };
  const osmWork = async () => {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const dy = radius * 1.4 / 110540, dx = radius * 1.4 / (111320 * Math.cos(place.lat * Math.PI / 180));
    const bb = `${place.lat - dy},${place.lon - dx},${place.lat + dy},${place.lon + dx}`;
    const query = `[out:json][timeout:25];(way["landuse"="military"](${bb});relation["landuse"="military"](${bb});way["military"](${bb});node["military"](${bb});way["aeroway"="aerodrome"](${bb});node["aeroway"="aerodrome"](${bb});way["landuse"~"^(port|harbour)$"](${bb});way["harbour"](${bb}););out tags center;`;
    log("Looking for nearby sites in <b>OpenStreetMap</b> (optional)");
    try {
      const payload = await mapped(query, requestSignal);
      type Element = { id: number; type: string; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> };
      osm = ((payload.elements ?? []) as Element[]).flatMap(e => {
        const c = e.center ?? (e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : null), t = e.tags ?? {};
        if (!c) return [];
        const kind = t.aeroway === "aerodrome" ? (t.military || t.landuse === "military" || /air ?base|military/i.test(t.name ?? "") ? "Air base" : "Airfield")
          : t.landuse === "port" || t.landuse === "harbour" || t.harbour ? "Port" : t.military === "barracks" ? "Barracks" : t.military === "naval_base" ? "Naval base" : t.military === "airfield" ? "Air base" : "Military area";
        const raw = t["name:en"] ?? t.name;
        const name = raw && raw.length > 3 && !/^[A-Z]{0,2}\d+$/.test(raw) ? raw : kind;
        const site: Site = { id: `osm-${e.type}-${e.id}`, name, kind, ...c, source: "OpenStreetMap", url: `https://www.openstreetmap.org/${e.type}/${e.id}`,
          operator: t["operator:en"] ?? t.operator ?? t.military_service, dist: distance(place, { ...c, name }) };
        return [site];
      });
      if (!signal.aborted) { publish(); log(`Found <b>${osm.length}</b> mapped sites`); }
    } catch { if (!signal.aborted) log("Nearby mapped sites unavailable. Battlefield building is unaffected."); }
  };
  const wikiWork = async () => {
    log("Looking up <b>Wikipedia</b> context (optional)");
    try {
      const payload = await json(`https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${place.lat}|${place.lon}&gsradius=10000&gslimit=30&format=json&origin=*`, AbortSignal.any([signal, AbortSignal.timeout(12000)]));
      const civic = /\b(stadium|university|college|school|hospital|mosque|church|club|museum|hotel|mall)\b/i;
      const rank = (title: string) => /air ?base|airbase|naval|military|army|camp |fort|barracks|garrison/i.test(title) ? 0 : civic.test(title) ? 2 : /\b(airport|port|harbou?r|strait|bridge|dam|canal|island)\b/i.test(title) ? 1 : 2;
      type Article = { pageid: number; title: string; lat: number; lon: number; dist: number };
      const top = ((payload.query?.geosearch ?? []) as Article[]).filter(i => rank(i.title) < 2).sort((a, b) => rank(a.title) - rank(b.title) || a.dist - b.dist).slice(0, 4);
      wiki = top.map(it => ({ id: `wiki-${it.pageid}`, name: it.title, kind: rank(it.title) === 0 ? "Military" : "Infrastructure", lat: it.lat, lon: it.lon,
        source: "Wikipedia", url: `https://en.wikipedia.org/wiki/${encodeURIComponent(it.title.replace(/ /g, "_"))}`, dist: it.dist }));
      publish();
      await Promise.allSettled(top.map(async it => {
        const summary = await json(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(it.title.replace(/ /g, "_"))}`, AbortSignal.any([signal, AbortSignal.timeout(8000)]));
        wiki = wiki.map(s => s.id === `wiki-${it.pageid}` ? { ...s, extract: summary.extract, thumb: summary.thumbnail?.source, url: summary.content_urls?.desktop?.page ?? s.url } : s);
        publish();
      }));
      if (!signal.aborted) log(`Found <b>${top.length}</b> nearby article${top.length === 1 ? "" : "s"}`);
    } catch { if (!signal.aborted) log("Wikipedia context unavailable. Battlefield building is unaffected."); }
  };
  await Promise.allSettled([osmWork(), wikiWork()]);
}
