export type Place = { name: string; lat: number; lon: number };
export type Bounds = [south: number, west: number, north: number, east: number];
export type Source = "OpenStreetMap" | "Wikipedia";
export type Site = { id: string; name: string; kind: string; lat: number; lon: number; source: Source; url?: string; extract?: string; thumb?: string; operator?: string; dist: number; snapshot?: string; updatedAt?: number };
export type CoreSite = Omit<Site, "dist">;
export type AreaSnapshot = { id: string; bounds: Bounds; updatedAt: number; checked: Partial<Record<Source, number>>; attempted: Partial<Record<Source, number>>; sites: CoreSite[] };
export const SITE_TTL = 7 * 86400000, RETRY_DELAY = 5 * 60000, DETAIL_TTL = 30 * 86400000;
export const sources: Source[] = ["OpenStreetMap", "Wikipedia"];
export const distance = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const r = Math.PI / 180, dl = (b.lat - a.lat) * r, dn = (b.lon - a.lon) * r;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) ** 2)));
};
export const boundsAt = (p: Place, radius: number): Bounds => {
  const dy = radius / 111320, dx = dy / Math.max(.1, Math.cos(p.lat * Math.PI / 180));
  return [Math.max(-85, p.lat - dy), Math.max(-180, p.lon - dx), Math.min(85, p.lat + dy), Math.min(180, p.lon + dx)];
};
export const contains = (a: Bounds, b: Bounds) => a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];
export const intersects = (a: Bounds, b: Bounds) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
export function areaFor(place: Place, radius: number) {
  const lat = Math.round(place.lat * 20) / 20, lon = Math.round(place.lon * 20) / 20;
  const span = [5000, 10000, 25000, 75000, 150000].find(n => n >= radius * 1.6 + 4000) ?? 150000;
  return { id: `${lat.toFixed(2)}:${lon.toFixed(2)}:${span}`, place: { name: place.name, lat, lon }, radius: span, bounds: boundsAt({ name: "", lat, lon }, span) };
}
export const nearby = (list: CoreSite[], place: Place, radius: number): Site[] => list.map(s => ({ ...s, dist: distance(place, s) })).filter(s => s.dist <= radius * 1.6).sort((a, b) => a.dist - b.dist || a.id.localeCompare(b.id));
export function mergeSites(...lists: CoreSite[][]): CoreSite[] {
  const byId = new Map<string, CoreSite>();
  for (const s of lists.flat()) if (s && typeof s.id === "string" && typeof s.name === "string" && Number.isFinite(s.lat) && Number.isFinite(s.lon) && Math.abs(s.lat) <= 85 && Math.abs(s.lon) <= 180 && sources.includes(s.source)) {
    const old = byId.get(s.id);
    if (!old || (s.updatedAt ?? 0) >= (old.updatedAt ?? 0)) byId.set(s.id, { ...old, ...s, name: s.name.slice(0, 200) });
  }
  return [...byId.values()];
}
export function mappedSites(payload: { elements?: unknown[]; remark?: string }, updatedAt: number): CoreSite[] {
  if (!Array.isArray(payload.elements) || payload.remark) throw Error("Incomplete geographic response");
  type Element = { id: number; type: string; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> };
  return mergeSites((payload.elements as Element[]).flatMap(e => {
    const c = e.center ?? (e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : null), t = e.tags ?? {};
    if (!c) return [];
    const kind = t.aeroway === "aerodrome" ? (t.military || t.landuse === "military" || /air ?base|military/i.test(t.name ?? "") ? "Air base" : "Airfield")
      : t.landuse === "port" || t.landuse === "harbour" || t.harbour || t.industrial === "port" || t["seamark:type"] === "harbour" ? "Port" : t.military === "barracks" ? "Barracks" : t.military === "naval_base" ? "Naval base" : t.military === "airfield" ? "Air base" : "Military area";
    return [{ id: `osm-${e.type}-${e.id}`, name: t["name:en"] || t.name || kind, kind, ...c, source: "OpenStreetMap", url: `https://www.openstreetmap.org/${e.type}/${e.id}`, operator: t["operator:en"] ?? t.operator ?? t.military_service, updatedAt }];
  }));
}
export function siteQuery(bounds: Bounds) {
  const b = bounds.join(",");
  return `[out:json][timeout:15];(nwr["landuse"="military"](${b});nwr["military"](${b});nwr["aeroway"="aerodrome"](${b});nwr["landuse"~"^(port|harbour)$"](${b});nwr["harbour"](${b});nwr["industrial"="port"](${b});nwr["seamark:type"="harbour"](${b}););out tags center;`;
}
