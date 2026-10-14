// The Earth studio: a globe to pick any place on, a fly-in to it, a scan of public sources (OpenStreetMap's mapped
// military sites, airfields and ports; Wikipedia's articles around it, each with its source), then the battlefield
// built from the place's roads, water and land cover by the website's own Earth compiler (RTSAI-Web
// lib/earth-battlefield.ts, the same file /studio runs). From there: edit the map, or start a mission on the fly at a
// site the scan found, between any two nations.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, Dices, Globe2, LoaderCircle, MapPin, Pencil, Search, Shield, Swords, X } from "lucide-react";
import type { Game } from "../game";
import type { EditorController } from "../editor";
import { geoToCell, spawnCells, type MissionSpec } from "../mission";
import { countryAt, forceName, inferForces, type Force } from "../forces";
import { useStore } from "../store";
import { nationGroup, playableNations } from "../sides";
import { SearchSelect, type Option } from "../components/ui/fields";
import { Flag } from "./Flag";
import { GameButton } from "./kit/game";
import { compileBattlefield } from "@site/lib/earth-battlefield";
import { overpassFailure, terrainFeatures, terrainQuery } from "@site/lib/earth-evidence";
import type { Map as MapLibreMap } from "maplibre-gl";

type DataSource = { setData(data: unknown): void };

type Place = { name: string; lat: number; lon: number };
type Site = { id: string; name: string; kind: string; lat: number; lon: number; source: "OpenStreetMap" | "Wikipedia"; url?: string; extract?: string; thumb?: string; operator?: string; dist: number };

const SUGGEST: Place[] = [
  { name: "Al Udeid Air Base, Qatar", lat: 25.1173, lon: 51.3149 },
  { name: "Strait of Hormuz", lat: 26.5667, lon: 56.25 },
  { name: "Riyadh", lat: 24.7136, lon: 46.6753 },
  { name: "Suez Canal, Ismailia", lat: 30.592, lon: 32.318 },
];
const SURPRISE: Place[] = [
  { name: "Musandam Peninsula, Oman", lat: 26.18, lon: 56.25 }, { name: "Kuwait Bay", lat: 29.38, lon: 47.85 },
  { name: "Bab-el-Mandeb", lat: 12.6, lon: 43.33 }, { name: "Sinai, Egypt", lat: 29.5, lon: 33.9 }, { name: "Dead Sea, Jordan", lat: 31.5, lon: 35.5 },
];
const FOOTPRINTS = [
  { radius: 1500, size: 64 as const, label: "3 km" },
  { radius: 2500, size: 80 as const, label: "5 km" },
  { radius: 4000, size: 80 as const, label: "8 km" },
];
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

async function overpass(query: string) {
  // The local game server relays and keeps answers (server/serve.mjs); the public game asks the mirrors itself.
  const relay = import.meta.env.VITE_STATIC_BUILD !== "1" ? [new URL("api/overpass", new URL("./", location.href)).href] : [];
  for (const url of [...relay, ...OVERPASS]) {
    try {
      const r = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(query), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
      if (r.ok) return await r.json();
    } catch { /* the next mirror */ }
  }
  throw Error("OpenStreetMap didn't answer. Try again in a moment.");
}
const hav = (a: [number, number], b: [number, number]) => {
  const R = 6371000, r = Math.PI / 180, dl = (b[0] - a[0]) * r, dn = (b[1] - a[1]) * r;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const box = (p: Place, radius: number) => {
  const dy = radius / 110540, dx = radius / (111320 * Math.cos(p.lat * Math.PI / 180));
  return { s: p.lat - dy, w: p.lon - dx, n: p.lat + dy, e: p.lon + dx };
};

/** Public military and transport sites around a place: OpenStreetMap's mapped ones and Wikipedia's articles. */
async function scan(p: Place, radius: number, log: (s: string) => void): Promise<Site[]> {
  const b = box(p, radius * 1.4);
  const bb = `${b.s},${b.w},${b.n},${b.e}`;
  log("Reading <b>OpenStreetMap</b>: military sites, airfields, ports");
  const q = `[out:json][timeout:25];(way["landuse"="military"](${bb});relation["landuse"="military"](${bb});way["military"](${bb});node["military"](${bb});way["aeroway"="aerodrome"](${bb});node["aeroway"="aerodrome"](${bb});way["landuse"~"^(port|harbour)$"](${bb});way["harbour"](${bb}););out tags center;`;
  log("Reading <b>Wikipedia</b> within 10 km");
  const [osm, wiki] = await Promise.allSettled([
    overpass(q),
    fetch(`https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${p.lat}|${p.lon}&gsradius=10000&gslimit=30&format=json&origin=*`).then((r) => r.json()),
  ]);
  const sites: Site[] = [];
  if (osm.status === "fulfilled") {
    type El = { id: number; type: string; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> };
    const els = (osm.value.elements ?? []) as El[];
    for (const e of els) {
      const c = e.center ?? (e.lat !== undefined ? { lat: e.lat, lon: e.lon! } : null), t = e.tags ?? {};
      if (!c) continue;
      const kind = t.aeroway === "aerodrome" ? (t.military || t.landuse === "military" || /air ?base|military/i.test(t.name ?? "") ? "Air base" : "Airfield")
        : t.landuse === "port" || t.landuse === "harbour" || t.harbour ? "Port" : t.military === "barracks" ? "Barracks" : t.military === "naval_base" ? "Naval base" : t.military === "airfield" ? "Air base" : "Military area";
      const raw = t["name:en"] ?? t.name;
      const name = raw && raw.length > 3 && !/^[A-Z]{0,2}\d+$/.test(raw) ? raw : kind;
      const operator = t["operator:en"] ?? t.operator ?? t.military_service;
      sites.push({ id: `osm-${e.type}-${e.id}`, name, kind, lat: c.lat, lon: c.lon, source: "OpenStreetMap", url: `https://www.openstreetmap.org/${e.type}/${e.id}`, operator, dist: hav([p.lat, p.lon], [c.lat, c.lon]) });
    }
    log(`Mapped: <b>${sites.length}</b> military, airfield and port features`);
  } else log("OpenStreetMap didn't answer: the map still builds");
  if (wiki.status === "fulfilled") {
    const items = (wiki.value.query?.geosearch ?? []) as { pageid: number; title: string; lat: number; lon: number; dist: number }[];
    // Military first, then transport and landmarks; a stadium or a university named after a canal is neither.
    const civic = /\b(stadium|university|college|school|hospital|mosque|church|club|museum|hotel|mall)\b/i;
    const rank = (t: string) => /air ?base|airbase|naval|military|army|camp |fort|barracks|garrison/i.test(t) ? 0 : civic.test(t) ? 2 : /\b(airport|port|harbou?r|strait|bridge|dam|canal|island)\b/i.test(t) ? 1 : 2;
    const top = items.filter((i) => rank(i.title) < 2).sort((a, b) => rank(a.title) - rank(b.title) || a.dist - b.dist).slice(0, 4);
    for (const it of top) {
      let extract: string | undefined, thumb: string | undefined, url: string | undefined;
      try {
        const s = await (await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(it.title.replace(/ /g, "_"))}`)).json();
        extract = s.extract; thumb = s.thumbnail?.source; url = s.content_urls?.desktop?.page;
      } catch { /* the title is enough */ }
      sites.push({ id: `wiki-${it.pageid}`, name: it.title, kind: rank(it.title) === 0 ? "Military" : "Infrastructure", lat: it.lat, lon: it.lon, source: "Wikipedia", url, extract, thumb, dist: it.dist });
    }
    log(`Described: <b>${top.length}</b> nearby article${top.length === 1 ? "" : "s"}`);
  }
  // Wikipedia's described sites first, then the nearest named mapped ones; nearby duplicates of a described site go.
  const described = sites.filter((s) => s.source === "Wikipedia");
  const mapped = sites.filter((s) => s.source === "OpenStreetMap" && s.name !== s.kind && !described.some((d) => hav([d.lat, d.lon], [s.lat, s.lon]) < 1500))
    .sort((a, b) => a.dist - b.dist).filter((s, i, all) => all.findIndex((x) => x.name === s.name) === i).slice(0, 4);
  const unnamed = sites.filter((s) => s.source === "OpenStreetMap" && s.name === s.kind).sort((a, b) => a.dist - b.dist).filter((s, i, all) => all.findIndex((x) => x.kind === s.kind) === i).slice(0, described.length + mapped.length >= 3 ? 1 : 3);
  return [...described, ...mapped, ...unnamed];
}

export function EarthStudio({ game, editor, close, mission }: { game: Game; editor: EditorController; close: () => void; mission: (m: MissionSpec) => void }) {
  const setup = useStore((s) => s.setup);
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [stage, setStage] = useState<"world" | "place" | "building" | "built">("world");
  const [place, setPlace] = useState<Place | null>(null);
  const [query, setQuery] = useState("");
  const [footprint, setFootprint] = useState(1);
  const [log, setLog] = useState<string[]>([]);
  const [sites, setSites] = useState<Site[] | null>(null);
  const [site, setSite] = useState<Site | null>(null);
  const [error, setError] = useState("");
  const [built, setBuilt] = useState<{ id: string; title: string; points: { u: number; v: number }[] } | null>(null);
  const nations = playableNations(setup);
  const [fa, setFa] = useState("saudi");
  const [fb, setFb] = useState("iran");
  const [youDefend, setYouDefend] = useState(true);
  const [forces, setForces] = useState<{ defender: Force; attacker: Force } | null>(null);
  const nationOptions: Option[] = nations.map((f) => ({ value: f.id, label: f.name, group: nationGroup(f), leading: <Flag id={f.id} className="h-[12px] w-[18px] rounded-[1px]" /> }));
  const fp = FOOTPRINTS[footprint];
  const say = (s: string) => setLog((l) => [...l, s]);

  // The globe: satellite imagery, slowly turning until a place is picked.
  useEffect(() => {
    let disposed = false;
    let spin = 0;
    void Promise.all([import("maplibre-gl"), import("maplibre-gl/dist/maplibre-gl.css")]).then(([lib]) => {
      if (disposed || !mapEl.current) return;
      const m = new lib.Map({
        container: mapEl.current, center: [46, 23], zoom: 2.2, maxPitch: 70, attributionControl: { compact: true },
        style: {
          version: 8, projection: { type: "globe" },
          sources: { sat: { type: "raster", tiles: [ESRI], tileSize: 256, maxzoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics · Data © OpenStreetMap contributors, Wikipedia" } },
          layers: [{ id: "sat", type: "raster", source: "sat", paint: { "raster-fade-duration": 250 } }],
          sky: { "sky-color": "#0b1a2b", "horizon-color": "#3b77b0", "fog-color": "#0b1a2b", "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 8, 0] },
        },
      });
      map.current = m;
      m.on("load", () => { setReady(true); m.setPadding({ top: 260, bottom: 0, left: 0, right: 0 }); });
      const turn = () => { if (!disposed && map.current && !map.current.isMoving() && stageRef.current === "world") { const c = map.current.getCenter(); c.lng += 0.03; map.current.jumpTo({ center: c }); } spin = requestAnimationFrame(turn); };
      spin = requestAnimationFrame(turn);
    });
    return () => { disposed = true; cancelAnimationFrame(spin); map.current?.remove(); map.current = null; };
  }, []);
  const stageRef = useRef(stage);
  stageRef.current = stage;

  const drawFootprint = (p: Place) => {
    const m = map.current!;
    const b = box(p, fp.radius);
    const data = { type: "FeatureCollection" as const, features: [{ type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [[[b.w, b.n], [b.e, b.n], [b.e, b.s], [b.w, b.s], [b.w, b.n]]] } }] };
    if (m.getSource("fp")) (m.getSource("fp") as unknown as DataSource).setData(data);
    else {
      m.addSource("fp", { type: "geojson", data });
      m.addLayer({ id: "fp-fill", type: "fill", source: "fp", paint: { "fill-color": "#f2b84b", "fill-opacity": 0.06 } });
      m.addLayer({ id: "fp-line", type: "line", source: "fp", paint: { "line-color": "#ffd98a", "line-width": 2, "line-dasharray": [3, 2] } });
    }
  };
  const drawSites = (list: Site[]) => {
    const m = map.current!;
    const data = { type: "FeatureCollection" as const, features: list.map((s) => ({ type: "Feature" as const, properties: { id: s.id, kind: s.kind }, geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] } })) };
    if (m.getSource("sites")) (m.getSource("sites") as unknown as DataSource).setData(data);
    else {
      m.addSource("sites", { type: "geojson", data });
      m.addLayer({ id: "sites-halo", type: "circle", source: "sites", paint: { "circle-radius": 16, "circle-color": "#5fe0cb", "circle-opacity": 0.15, "circle-stroke-color": "#5fe0cb", "circle-stroke-width": 1.5 } });
      m.addLayer({ id: "sites-dot", type: "circle", source: "sites", paint: { "circle-radius": 5, "circle-color": "#5fe0cb", "circle-stroke-color": "#03231e", "circle-stroke-width": 2 } });
    }
  };

  const go = async (p: Place) => {
    const m = map.current;
    if (!m) return;
    setPlace(p); setStage("place"); setLog([]); setSites(null); setSite(null); setError(""); setBuilt(null); setForces(null);
    say(`Flying to <b>${p.name}</b>`);
    m.setPadding({ top: 0, bottom: 0, left: 0, right: 420 });
    m.flyTo({ center: [p.lon, p.lat], zoom: 12.6, pitch: 50, bearing: -25, duration: 6500, curve: 1.6, essential: true });
    await new Promise<void>((r) => m.once("moveend", () => r()));
    drawFootprint(p);
    try {
      const country = countryAt(p.lat, p.lon);
      const found = await scan(p, fp.radius, say);
      setSites(found);
      drawSites(found);
      const best = found.find((s) => /air base|naval|military|barracks/i.test(s.kind)) ?? found[0] ?? null;
      setSite(best);
      // The militaries the sources name here, and their likely opponent: the mission's two sides.
      const sources = found.map((s) => ({ text: [s.name, s.operator, s.extract].filter(Boolean).join(". "), from: `${s.source}: ${s.name}` }));
      const f = inferForces(await country, sources, nations.map((n) => n.id));
      if (f) {
        setForces(f); setFa(f.defender.id); setFb(f.attacker.id); setYouDefend(true);
        say(`Forces here: <b>${forceName(f.defender.id)}</b> (${f.defender.why}); likely attacker: <b>${forceName(f.attacker.id)}</b> (${f.attacker.why})`);
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setSites([]); }
  };

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    const hit = SUGGEST.find((s) => s.name.toLowerCase().includes(q.toLowerCase()));
    if (hit) return go(hit);
    try {
      const r = await (await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`)).json();
      if (!r.length) { setError(`Couldn't find “${q}”. Try a city or landmark.`); return; }
      void go({ name: String(r[0].display_name).split(",").slice(0, 2).join(","), lat: +r[0].lat, lon: +r[0].lon });
    } catch { setError("The place search is offline. Pick a suggestion."); }
  };

  /** The place's roads, water, land cover and buildings, compiled into a map by the website's Earth compiler. */
  const build = async () => {
    if (!place || !map.current) return;
    setStage("building"); setError("");
    try {
      say("Reading the place's <b>roads, water and land</b>");
      const payload = await overpass(terrainQuery(place.lat, place.lon, fp.radius));
      if (overpassFailure(payload)) throw Error("This area is too dense; choose a smaller footprint.");
      const features = terrainFeatures(payload);
      say(`Compiling <b>${features.length}</b> features into terrain`);
      const title = place.name.split(",")[0].slice(0, 40);
      const bf = await compileBattlefield({ latitude: place.lat, longitude: place.lon, radius: fp.radius, seed: 42, size: fp.size, players: 2, title }, features);
      say("Engine check: <b>2 start positions, bases connected</b>");
      await editor.addFiles(bf.id, bf.title, bf.players, { "map.yaml": new TextEncoder().encode(bf.yaml), "map.bin": bf.bin, "map.png": bf.png });
      // The battlefield, draped over the place it came from.
      const m = map.current, b = box(place, fp.radius);
      const url = URL.createObjectURL(new Blob([bf.png.slice()], { type: "image/png" }));
      if (m.getLayer("built")) m.removeLayer("built");
      if (m.getSource("built")) m.removeSource("built");
      m.addSource("built", { type: "image", url, coordinates: [[b.w, b.n], [b.e, b.n], [b.e, b.s], [b.w, b.s]] });
      m.addLayer({ id: "built", type: "raster", source: "built", paint: { "raster-opacity": 0, "raster-resampling": "nearest" } }, "fp-fill");
      m.setPaintProperty("built", "raster-opacity-transition", { duration: 1800, delay: 0 });
      setTimeout(() => m.setPaintProperty("built", "raster-opacity", 0.92), 50);
      m.easeTo({ pitch: 55, bearing: 45, zoom: m.getZoom() + 0.2, duration: 2400 });
      setBuilt({ id: bf.id, title: bf.title, points: spawnCells(bf.yaml) });
      setStage("built");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setStage("place"); }
  };

  // Switching role keeps the sides on the place: you take the other side's nation.
  const switchRole = (defend: boolean) => {
    if (defend === youDefend) return;
    setYouDefend(defend); setFa(fb); setFb(fa);
  };

  const startMission = () => {
    if (!built || !place) return;
    const s = site ?? { name: place.name, lat: place.lat, lon: place.lon };
    const cell = geoToCell(s.lat, s.lon, place, fp.radius, fp.size);
    mission({ map: built.id, title: `${s.name}`, site: { ...cell, name: s.name }, fa, fb, youDefend, points: built.points });
  };

  return (
    <div className="es-root" data-stage={stage}>
      <div ref={mapEl} className="es-map" />
      <button type="button" className="es-close hud-tool" aria-label="Close" onClick={close}><X /></button>
      {stage === "world" && (
        <section className="es-world">
          <h1>Where do you want to <em>fight</em>?</h1>
          <form className="es-search" onSubmit={(e) => { e.preventDefault(); void search(); }}>
            <Search size={20} aria-hidden="true" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Any city, base, coast or strait" aria-label="Find a place" data-testid="es-search" />
            <GameButton type="submit" variant="primary" disabled={!ready}>Fly there</GameButton>
          </form>
          <div className="es-chips">
            {SUGGEST.map((s) => <button key={s.name} type="button" onClick={() => void go(s)} disabled={!ready} data-place={s.name}><i />{s.name}</button>)}
            <button type="button" onClick={() => void go(SURPRISE[Math.floor(Math.random() * SURPRISE.length)])} disabled={!ready}><Dices size={14} />Surprise me</button>
          </div>
          {error && <p className="ed-error">{error}</p>}
        </section>
      )}
      {place && stage !== "world" && (
        <>
          <div className="es-place hud-panel">
            <button type="button" className="hud-tool" aria-label="Back to the globe" onClick={() => { setStage("world"); map.current?.setPadding({ top: 260, bottom: 0, left: 0, right: 0 }); map.current?.flyTo({ center: [place.lon, place.lat], zoom: 2.2, pitch: 0, bearing: 0, duration: 3000 }); }}><ArrowLeft /></button>
            <span className="es-live" /><b>{place.name}</b>
            <span className="es-coords digits">{Math.abs(place.lat).toFixed(4)}°{place.lat >= 0 ? "N" : "S"} {Math.abs(place.lon).toFixed(4)}°{place.lon >= 0 ? "E" : "W"}</span>
            <span className="es-fp" role="radiogroup" aria-label="Footprint">
              {FOOTPRINTS.map((f, i) => <button key={f.label} type="button" role="radio" aria-checked={footprint === i} disabled={stage !== "place"} onClick={() => { setFootprint(i); drawFootprint(place); }}>{f.label}</button>)}
            </span>
          </div>
          <aside className="es-intel hud-panel" data-testid="es-intel">
            <header><span className="es-live" /><span className="menu-eyebrow">Analyst · public sources</span></header>
            <div className="es-log">{log.map((l, i) => <div key={i} dangerouslySetInnerHTML={{ __html: l }} />)}</div>
            <div className="es-sites">
              {sites === null && <div className="es-scanning"><LoaderCircle className="menu-spin" size={16} />Scanning…</div>}
              {sites?.length === 0 && <p className="ed-tip">No military or transport sites are mapped or described here. The battlefield still comes from the place's roads, water and land.</p>}
              {sites?.map((s) => (
                <button key={s.id} type="button" className="es-site" aria-pressed={site?.id === s.id} onClick={() => { setSite(s); map.current?.flyTo({ center: [s.lon, s.lat], zoom: 14, duration: 1600 }); }}>
                  <span className="es-site-th" style={s.thumb ? { backgroundImage: `url("${s.thumb}")` } as CSSProperties : undefined}>{!s.thumb && <MapPin size={20} />}</span>
                  <span className="es-site-body">
                    <b>{s.name}</b>
                    {s.extract && <small>{s.extract}</small>}
                    <span className="es-src">
                      <span className="es-tag">{s.kind}</span>
                      {s.url ? <a href={s.url} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>{s.source}</a> : <span>{s.source}</span>}
                      <span>{(s.dist / 1000).toFixed(1)} km away</span>
                    </span>
                  </span>
                </button>
              ))}
            </div>
            {error && <p className="ed-error">{error}</p>}
            <footer>
              {stage === "place" && <GameButton variant="primary" size="lg" icon={<Globe2 size={16} />} onClick={() => void build()} disabled={sites === null} data-testid="es-build">Build battlefield</GameButton>}
              {stage === "building" && <div className="es-scanning"><LoaderCircle className="menu-spin" size={16} />Building the battlefield…</div>}
              {stage === "built" && built && (
                <div className="es-actions">
                  <div className="es-mission">
                    <span className="menu-eyebrow"><Swords size={12} /> Mission at {site?.name ?? place.name}</span>
                    <div className="es-sides">
                      <label><span>You</span><SearchSelect size="sm" value={fa} onValueChange={setFa} options={nationOptions} aria-label="Your nation" /></label>
                      <label><span>Enemy AI</span><SearchSelect size="sm" value={fb} onValueChange={setFb} options={nationOptions} aria-label="Enemy nation" /></label>
                    </div>
                    <div className="es-role" role="radiogroup" aria-label="Your role">
                      <button type="button" role="radio" aria-checked={youDefend} onClick={() => switchRole(true)}><Shield size={13} />You defend it</button>
                      <button type="button" role="radio" aria-checked={!youDefend} onClick={() => switchRole(false)}><Swords size={13} />You attack it</button>
                    </div>
                    {forces && <p className="es-why">{forceName(forces.defender.id)} holds it: {forces.defender.why}. {forceName(forces.attacker.id)} attacks: {forces.attacker.why}.</p>}
                    <GameButton variant="primary" size="lg" icon={<Swords size={16} />} onClick={startMission} data-testid="es-mission">Start mission</GameButton>
                  </div>
                  <GameButton icon={<Pencil size={14} />} onClick={() => void editor.open({ map: built.id })} data-testid="es-edit">Edit this map</GameButton>
                </div>
              )}
            </footer>
          </aside>
        </>
      )}
    </div>
  );
}
