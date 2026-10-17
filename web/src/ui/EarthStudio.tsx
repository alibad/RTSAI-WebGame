// The Earth studio: a globe to pick any place on, a fly-in to it, a scan of public sources (OpenStreetMap's mapped
// military sites, airfields and ports; Wikipedia's articles around it, each with its source), independently of the battlefield
// built from the place's roads, water and land cover by the website's own Earth compiler (RTSAI-Web
// lib/earth-battlefield.ts, the same file /studio runs). From there: edit the map, or start a mission on the fly at a
// site the scan found, between any two nations.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, Dices, LoaderCircle, MapPin, Pencil, Search, Shield, Swords } from "lucide-react";
import { developerTools } from "../developer-tools";
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
import { elevationGrid } from "../elevation";
import { researchSites, siteDetails, type Place, type Site, type SiteStatus } from "../earth-research";
import { preloadKnownSites } from "../earth-site-catalog";
import { mergeSites, type CoreSite } from "../earth-site-model";
import { overpassFailure, terrainBox, terrainFeatures } from "@site/lib/earth-evidence";
import { acquireTerrain, type TerrainResult } from "../earth-terrain";
import { regionalGeography } from "@site/lib/earth-region";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";
import { searchPlaces, type PlaceResult } from "../place-search";

type DataSource = { setData(data: unknown): void };



const SUGGEST: Place[] = [
  { name: "Al Udeid Air Base, Qatar", lat: 25.1173, lon: 51.3149 },
  { name: "Strait of Hormuz", lat: 26.6, lon: 56.4 },
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
  { radius: 10000, size: 80 as const, label: "20 km" },
  { radius: 30000, size: 80 as const, label: "60 km" },
  { radius: 60000, size: 80 as const, label: "120 km" },
];
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

async function overpass(query: string, signal?: AbortSignal) {
  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]);
  // The local game server relays and keeps answers (server/serve.mjs); the public game asks the mirrors itself.
  const relay = import.meta.env.VITE_STATIC_BUILD !== "1" ? [new URL("api/overpass", new URL("./", location.href)).href] : [];
  for (const url of [...relay, ...OVERPASS]) {
    deadline.throwIfAborted();
    try {
      const r = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(query), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.any([deadline, AbortSignal.timeout(relay.includes(url) ? 45000 : 18000)]) });
      if (r.ok) {
        const payload = await r.json();
        if (!overpassFailure(payload) && !payload.remark && Array.isArray(payload.elements)) return payload;
      }
    } catch { /* the next mirror */ }
  }
  throw Error("OpenStreetMap didn't answer. Try again in a moment.");
}
const box = (p: Place, radius: number) => terrainBox(p.lat, p.lon, radius);
function restoredSelection(): { place: Place; footprint: number } | null {
  try {
    const params = new URLSearchParams(location.search);
    const stored = params.has("earthLat") && params.has("earthLon") ? {
      place: { name: params.get("earthPlace") || "Picked on the map", lat: Number(params.get("earthLat")), lon: Number(params.get("earthLon")) },
      footprint: FOOTPRINTS.findIndex(f => f.radius === Number(params.get("earthRadius"))),
    } : JSON.parse(sessionStorage.getItem("rtsai.earth.selection") || "null");
    if (stored?.place && Number.isFinite(stored.place.lat) && Math.abs(stored.place.lat) <= 84 && Number.isFinite(stored.place.lon) && typeof stored.place.name === "string" && FOOTPRINTS[stored.footprint]) return stored;
  } catch { /* Storage can be disabled. */ }
  return null;
}

export function EarthStudio({ game, editor, close, mission, play }: { game: Game; editor: EditorController; close: () => void; mission: (m: MissionSpec) => void; play: (map: string, you: string, enemy: string) => void }) {
  const setup = useStore((s) => s.setup);
  const [restored] = useState(restoredSelection);
  const restoredOnce = useRef(false);
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const marker = useRef<Marker | null>(null);
  const moveArea = useRef<(lat: number, lon: number) => void>(() => {});
  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState("");
  const [mapAttempt, setMapAttempt] = useState(0);
  const [view, setView] = useState<"3d" | "overhead">("3d");
  const [stage, setStage] = useState<"world" | "place" | "building" | "built">("world");
  const [place, setPlace] = useState<Place | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [searching, setSearching] = useState(false);
  const lookup = useRef<AbortController | null>(null);
  const chooseArea = useRef<(p: Place) => void>(() => {});
  const [basemap, setBasemap] = useState<"satellite" | "streets">("satellite");
  const [footprint, setFootprint] = useState(restored?.footprint ?? 1);
  const [log, setLog] = useState<string[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [scanning, setScanning] = useState(false);
  const [siteStatus, setSiteStatus] = useState<SiteStatus | null>(null);
  const [siteRefresh, setSiteRefresh] = useState(0);
  const consumedRefresh = useRef(0);
  const previousSiteArea = useRef("");
  const [knownSites, setKnownSites] = useState<CoreSite[]>([]);
  const [datasetVersion, setDatasetVersion] = useState("");
  const [catalogReady, setCatalogReady] = useState(false);
  const [sitePage, setSitePage] = useState(1);
  const pickSite = useRef<(site: Site) => void>(() => {});
  const siteSnapshot = useRef<Site[]>([]);
  const research = useRef<AbortController | null>(null);
  const building = useRef<AbortController | null>(null);
  const sidesEdited = useRef(false);
  const [site, setSite] = useState<Site | null>(null);
  const [error, setError] = useState("");
  const [terrain, setTerrain] = useState<TerrainResult | null>(null);
  const [built, setBuilt] = useState<{ id: string; title: string; coastal: boolean; points: { u: number; v: number }[] } | null>(null);
  const nations = playableNations(setup);
  const [fa, setFa] = useState("saudi");
  const [fb, setFb] = useState("iran");
  const [youDefend, setYouDefend] = useState(true);
  const [forces, setForces] = useState<{ defender: Force; attacker: Force } | null>(null);
  const nationOptions: Option[] = nations.map((f) => ({ value: f.id, label: f.name, group: nationGroup(f), leading: <Flag id={f.id} className="h-[12px] w-[18px] rounded-[1px]" /> }));
  const fp = FOOTPRINTS[footprint];
  const say = (s: string) => setLog((l) => [...l, s]);

  // The globe stays still until the player explores it. Imagery is fetched only for the visible view.
  useEffect(() => {
    let disposed = false;
    setReady(false); setMapError("");
    void Promise.all([import("maplibre-gl"), import("maplibre-gl/dist/maplibre-gl.css")]).then(([lib]) => {
      if (disposed || !mapEl.current) return;
      const m = new lib.Map({
        container: mapEl.current, center: [46, 23], zoom: 2.2, maxPitch: 70, attributionControl: false,
        style: {
          version: 8, projection: { type: view === "3d" ? "globe" : "mercator" },
          sources: {
            sat: { type: "raster", tiles: [ESRI], tileSize: 256, maxzoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" },
            streets: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>' },
          },
          layers: [{ id: "sat", type: "raster", source: "sat", paint: { "raster-fade-duration": 250 } }, { id: "streets", type: "raster", source: "streets", layout: { visibility: "none" } }],
          sky: { "sky-color": "#0b1a2b", "horizon-color": "#3b77b0", "fog-color": "#0b1a2b", "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 8, 0] },
        },
      });
      map.current = m;
      m.addControl(new lib.NavigationControl({ showCompass: true, visualizePitch: true }), "bottom-left");
      m.addControl(new lib.AttributionControl({ compact: false }), "bottom-left");
      const pin = document.createElement("div"); pin.className = "es-center-pin"; pin.title = "Drag to move the battlefield";
      marker.current = new lib.Marker({ element: pin, draggable: true }).setLngLat([46, 23]);
      marker.current.on("dragend", () => { const p = marker.current!.getLngLat(); moveArea.current(p.lat, p.lng); });
      m.on("click", e => {
        const layers = ["sites-dot", "sites-clusters"].filter(id => m.getLayer(id));
        if (layers.length && m.queryRenderedFeatures(e.point, { layers }).length) return;
        if (Math.abs(e.lngLat.lat) > 84) return;
        if (stageRef.current === "place") moveArea.current(e.lngLat.lat, e.lngLat.lng);
        if (stageRef.current === "world" && m.isStyleLoaded()) chooseArea.current({ name: "Picked on the map", lat: e.lngLat.lat, lon: ((e.lngLat.lng + 180) % 360 + 360) % 360 - 180 });
      });
      m.on("load", () => { if (!disposed) { setReady(true); setMapError(""); } });
      m.on("webglcontextlost", () => { if (!disposed) { setReady(false); setMapError("The globe lost its graphics connection. Retry to restore it."); } });
      const resize = new ResizeObserver(() => m.resize());
      resize.observe(mapEl.current);
      m.on("remove", () => resize.disconnect());
    }).catch(error => {
      console.error("Earth map initialization failed", error);
      if (!disposed) setMapError("The 3D globe couldn’t start. Retry, or reload the editor to load the current game files.");
    });
    return () => { disposed = true; marker.current?.remove(); marker.current = null; map.current?.remove(); map.current = null; };
  }, [mapAttempt]);
  const stageRef = useRef(stage);
  stageRef.current = stage;

  const drawFootprint = (p: Place, footprint = fp) => {
    const m = map.current!;
    const b = box(p, footprint.radius);
    const data = { type: "FeatureCollection" as const, features: [{ type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [[[b.w, b.n], [b.e, b.n], [b.e, b.s], [b.w, b.s], [b.w, b.n]]] } }] };
    if (m.getSource("fp")) (m.getSource("fp") as unknown as DataSource).setData(data);
    else {
      m.addSource("fp", { type: "geojson", data });
      m.addLayer({ id: "fp-fill", type: "fill", source: "fp", paint: { "fill-color": "#f2b84b", "fill-opacity": 0.06 } });
      m.addLayer({ id: "fp-line", type: "line", source: "fp", paint: { "line-color": "#ffd98a", "line-width": 2, "line-dasharray": [3, 2] } });
    }
    const land = regionalGeography(p.lat, p.lon, footprint.radius);
    const coastline = { type: "FeatureCollection" as const, features: (land ?? []).filter((f: { kind: string }) => f.kind === "land").map((f: { points: [number, number][] }) => ({ type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [[...f.points, f.points[0]].map(([lat, lon]) => [lon, lat])] } })) };
    if (m.getSource("regional-coast")) (m.getSource("regional-coast") as unknown as DataSource).setData(coastline);
    else {
      m.addSource("regional-coast", { type: "geojson", data: coastline });
      m.addLayer({ id: "regional-coast-line", type: "line", source: "regional-coast", paint: { "line-color": "#e4ddb5", "line-width": 1.5, "line-opacity": .7 } }, "fp-fill");
    }
  };
  const fitArea = (p: Place, footprint = fp) => {
    const m = map.current; if (!m) return;
    const b = box(p, footprint.radius), narrow = window.innerWidth <= 700;
    m.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    m.fitBounds([[b.w, b.s], [b.e, b.n]], { padding: narrow ? 35 : 65, pitch: view === "3d" ? 45 : 0, bearing: 0, duration: 900 });
  };
  const relocate = (lat: number, lon: number) => {
    if (!place || stage !== "place" || Math.abs(lat) > 84) return;
    research.current?.abort(); building.current?.abort(); setError(""); setLog([]); setSite(null);
    const p = { ...place, lat, lon: ((lon + 180) % 360 + 360) % 360 - 180 };
    setPlace(p); drawFootprint(p); marker.current?.setLngLat([p.lon, p.lat]);
  };
  moveArea.current = relocate;
  useEffect(() => { marker.current?.setDraggable(stage === "place"); }, [stage]);
  const drawSites = (list: Site[]) => {
    const m = map.current!;
    const data = { type: "FeatureCollection" as const, features: list.map((s) => ({ type: "Feature" as const, properties: { id: s.id, name: s.name, kind: s.kind, source: s.source, url: s.url }, geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] } })) };
    if (m.getSource("sites")) (m.getSource("sites") as unknown as DataSource).setData(data);
    else {
      m.addSource("sites", { type: "geojson", data, cluster: true, clusterRadius: 36, clusterMaxZoom: 11 });
      m.addLayer({ id: "sites-clusters", type: "circle", source: "sites", filter: ["has", "point_count"], paint: { "circle-radius": ["step", ["get", "point_count"], 14, 20, 20, 100, 28], "circle-color": "#11453c", "circle-stroke-color": "#5fe0cb", "circle-stroke-width": 2 } });
      m.addLayer({ id: "sites-halo", type: "circle", source: "sites", filter: ["!", ["has", "point_count"]], paint: { "circle-radius": 16, "circle-color": "#5fe0cb", "circle-opacity": 0.15, "circle-stroke-color": "#5fe0cb", "circle-stroke-width": 1.5 } });
      m.addLayer({ id: "sites-dot", type: "circle", source: "sites", filter: ["!", ["has", "point_count"]], paint: { "circle-radius": 5, "circle-color": "#5fe0cb", "circle-stroke-color": "#03231e", "circle-stroke-width": 2 } });
      m.on("click", "sites-clusters", e => { const f = e.features?.[0]; if (f?.geometry.type === "Point") m.easeTo({ center: f.geometry.coordinates as [number, number], zoom: Math.min(15, m.getZoom() + 3) }); });
      m.on("click", "sites-dot", e => {
        const f = e.features?.[0]; if (f?.geometry.type !== "Point" || !f.properties) return;
        const [lon, lat] = f.geometry.coordinates;
        if (stageRef.current === "world") chooseArea.current({ name: String(f.properties.name), lat, lon });
        else pickSite.current({ ...f.properties, lat, lon, dist: 0 } as Site);
      });
    }
  };
  useEffect(() => {
    let disposed = false;
    void preloadKnownSites().then(catalog => { if (!disposed) { setKnownSites(catalog.sites); setDatasetVersion(catalog.manifest?.version ?? ""); setCatalogReady(true); } });
    return () => { disposed = true; };
  }, []);
  useEffect(() => { if (ready) drawSites(mergeSites(knownSites, sites).map(s => ({ ...s, dist: 0 }))); }, [ready, knownSites, sites]);
  pickSite.current = s => { setSite(s); map.current?.flyTo({ center: [s.lon, s.lat], zoom: fp.radius > 10000 ? map.current.getZoom() : 14, duration: 800 }); };
  siteSnapshot.current = sites;
  useEffect(() => {
    if (!site) return;
    const controller = new AbortController(), selected = site;
    void siteDetails(selected, controller.signal).then(detail => {
      if (controller.signal.aborted || !Object.keys(detail).length) return;
      setSite(s => s?.id === selected.id ? { ...s, ...detail } : s);
      setSites(list => list.map(s => s.id === selected.id ? { ...s, ...detail } : s));
    });
    return () => controller.abort();
  }, [site?.id]);
  const exportSites = () => {
    const data = { schema: 1, dataset: datasetVersion, savedAt: new Date().toISOString(), place, radius: fp.radius, scope: "Known public geographic sites; not a complete inventory or current force positions", attribution: "© OpenStreetMap contributors (ODbL); Wikipedia metadata and linked article licenses", sites: place ? sites : knownSites };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "rtsai-known-sites.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const go = (p: Place) => {
    const m = map.current;
    if (!m) return;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 84) { setError("Choose a place below 84° latitude so the battlefield fits on the map."); return; }
    p = { ...p, lon: ((p.lon + 180) % 360 + 360) % 360 - 180 };
    lookup.current?.abort(); setSearching(false); setResults([]);
    research.current?.abort(); building.current?.abort(); sidesEdited.current = false;
    setPlace(p); setStage("place"); setLog([]); setSites([]); setSite(null); setError(""); setBuilt(null); setForces(null);
    say("Battlefield location selected");
    const next = p.name === "Strait of Hormuz" ? FOOTPRINTS[5] : fp;
    if (p.name === "Strait of Hormuz") setFootprint(5);
    drawFootprint(p, next); fitArea(p, next);
    marker.current?.setLngLat([p.lon, p.lat]).addTo(m);
    if (m.getLayer("built")) m.removeLayer("built");
    if (m.getSource("built")) m.removeSource("built");
  };
  chooseArea.current = go;
  useEffect(() => {
    if (!ready) return;
    if (mapAttempt > 0 && place) { chooseArea.current(place); return; }
    if (restoredOnce.current) return;
    restoredOnce.current = true;
    if (restored) chooseArea.current(restored.place);
  }, [ready, restored]);
  useEffect(() => {
    if (!place) return;
    try { sessionStorage.setItem("rtsai.earth.selection", JSON.stringify({ place, footprint })); } catch { /* Optional continuity across reloads. */ }
  }, [place, footprint]);

  useEffect(() => {
    if (!ready || !map.current) return;
    map.current.setLayoutProperty("sat", "visibility", basemap === "satellite" ? "visible" : "none");
    map.current.setLayoutProperty("streets", "visibility", basemap === "streets" ? "visible" : "none");
  }, [basemap, ready]);

  // Site research enriches missions in the background. It never gates the build action or its terrain request.
  const nationIds = nations.map(n => n.id).join(",");
  useEffect(() => {
    if (!place) return;
    const controller = new AbortController(); research.current = controller;
    const { signal } = controller;
    let found: Site[] = [], country: string | null = null;
    const areaKey = `${place.lat}:${place.lon}:${fp.radius}`;
    setScanning(true);
    if (previousSiteArea.current !== areaKey) { setSites([]); setSite(null); setSitePage(1); setSiteStatus(null); }
    previousSiteArea.current = areaKey;
    const infer = () => {
      if (signal.aborted) return;
      const sources = found.map(s => ({ text: [s.name, s.operator, s.extract].filter(Boolean).join(". "), from: `${s.source}: ${s.name}` }));
      const forces = inferForces(country, sources, nationIds.split(","));
      if (forces && !sidesEdited.current) { setForces(forces); setFa(forces.defender.id); setFb(forces.attacker.id); setYouDefend(true); }
    };
    void countryAt(place.lat, place.lon, signal).then(code => { country = code; infer(); });
    const force = siteRefresh !== consumedRefresh.current; consumedRefresh.current = siteRefresh;
    void researchSites(place, fp.radius, { signal, mapped: overpass, force,
      status: value => { if (!signal.aborted) { setSiteStatus(value); if (value.dataset !== "Local discoveries") setDatasetVersion(value.dataset); } },
      known: list => { if (!signal.aborted) setKnownSites(previous => mergeSites(previous, list)); },
      log: message => { if (!signal.aborted) say(message); },
      update: list => {
        if (signal.aborted) return;
        found = list;
        setSites(previous => list.map(s => {
          const old = previous.find(p => p.id === s.id);
          return old?.extract ? { ...s, extract: old.extract, snapshot: old.snapshot } : s;
        }));
        setSite(selected => selected ? { ...(list.find(s => s.id === selected.id) ?? selected), ...(selected.extract ? { extract: selected.extract, snapshot: selected.snapshot } : {}) }
          : list.find(s => /air base|naval|military|barracks/i.test(s.kind)) ?? list[0] ?? null);
        infer();
      },
    }).finally(() => { if (!signal.aborted) setScanning(false); });
    return () => controller.abort();
  }, [place, fp.radius, nationIds, siteRefresh]); // Cache refresh is independent of map generation.

  useEffect(() => () => { research.current?.abort(); building.current?.abort(); lookup.current?.abort(); }, []);

  const search = async () => {
    const q = query.trim();
    if (!q || searching) return;
    lookup.current?.abort();
    const controller = new AbortController(); lookup.current = controller;
    setSearching(true); setResults([]); setError("");
    try {
      const found = await searchPlaces(q, controller.signal);
      if (!controller.signal.aborted) {
        setResults(found);
        if (!found.length) setError(`Couldn't find “${q}”. Try a city or landmark, or pick a point on the map.`);
      }
    } catch { if (!controller.signal.aborted) setError("Place search is unavailable. Retry, pick a suggestion, or choose directly on the map."); }
    finally { if (lookup.current === controller) setSearching(false); }
  };

  /** The place's roads, water, land cover and buildings, compiled into a map by the website's Earth compiler. */
  const build = async (refresh = false) => {
    if (!place || !map.current) return;
    const controller = new AbortController(); building.current?.abort(); building.current = controller;
    const current = () => !controller.signal.aborted && building.current === controller;
    setStage("building"); setError(""); setTerrain(null); setLog([]);
    try {
      const base = regionalGeography(place.lat, place.lon, fp.radius);
      if (fp.radius > 10000 && !base) throw Error("Regional coastlines are currently available around Hormuz. Choose 20 km or smaller elsewhere.");
      const heights = fp.radius <= 10000 ? elevationGrid(place.lat, place.lon, fp.radius, fp.size).catch(() => null) : Promise.resolve(null);
      say("Reading the place's <b>roads, water and land</b>");
      const evidence = await acquireTerrain(place.lat, place.lon, fp.radius, { title: place.name, signal: controller.signal, refresh,
        request: (query, signal) => overpass(query, AbortSignal.any([signal, AbortSignal.timeout(base ? 12000 : 55000)])) }).catch(error => {
        if (!base || controller.signal.aborted) throw error;
        say("Live road details unavailable; using <b>packaged Natural Earth coastlines</b>."); return null;
      });
      if (!current()) return;
      setTerrain(evidence);
      if (evidence) say(evidence.refreshFailed ? "Live refresh unavailable; kept the <b>saved geography</b>." : evidence.source === "live" ? "Geography downloaded and cached for this area." : "Using <b>saved geography</b>; no live terrain request needed.");
      const payload = evidence?.snapshot.payload ?? { elements: [] };
      if (overpassFailure(payload)) throw Error("This area is too dense; choose a smaller footprint.");
      const mapped = terrainFeatures(payload, terrainBox(place.lat, place.lon, fp.radius));
      const features = base ? [...base, ...mapped.filter((f: { kind: string }) => f.kind !== "water" && f.kind !== "coastline")] : mapped;
      say(`Compiling <b>${features.length}</b> features into terrain`);
      const title = place.name.split(",")[0].slice(0, 40);
      const bf = await compileBattlefield({ latitude: place.lat, longitude: place.lon, radius: fp.radius, seed: 42, size: fp.size, players: 2, title, preserveCoast: !!base, sourceStatus: base ? "Natural Earth v5.1.2 regional coastlines; optional live OpenStreetMap details" : undefined }, features);
      if (!current()) return;
      let files: Record<string, Uint8Array> = { "map.yaml": new TextEncoder().encode(bf.yaml), "map.bin": bf.bin, "map.png": bf.png };
      let id = bf.id;
      // The ground's real hills and valleys (sim Relief.cs), level where the sites a mission may use stand.
      say("Reading the ground's <b>height</b>");
      const grid = await heights;
      if (!current()) return;
      if (grid) {
        const near = [place, ...(sites ?? []).filter((s) => s.dist <= fp.radius)];
        const keep = near.map((s) => ({ ...geoToCell(s.lat, s.lon, place, fp.radius, fp.size), r: 12 }));
        try {
          const shaped = await editor.relief(files, grid, keep);
          if (!current()) return;
          files = shaped.files;
          id = `${bf.id}-h${shaped.levels}`;
          say(shaped.levels
            ? `Ground: <b>${Math.round(grid.highest - grid.lowest)} m</b> from low to high, <b>${shaped.levels}</b> height levels, <b>${shaped.slopes}</b> slopes`
            : "Ground: <b>level</b> (too little relief to show)");
        } catch { say("Ground: kept <b>level</b> (the slopes didn't fit)"); }
      } else say("Ground: kept <b>level</b> (elevation unavailable)");
      files["earth.json"] = new TextEncoder().encode(JSON.stringify(bf.report, null, 2));
      if (evidence) { const { payload: _, ...provenance } = evidence.snapshot; files["geography.json"] = new TextEncoder().encode(JSON.stringify(provenance, null, 2)); }
      files["sites.json"] = new TextEncoder().encode(JSON.stringify({ schema: 1, dataset: datasetVersion, savedAt: new Date().toISOString(), place, radius: fp.radius, attribution: "© OpenStreetMap contributors (ODbL); Wikipedia metadata and linked article licenses", sites: siteSnapshot.current }, null, 2));
      say(bf.report.validation.connectedBases ? "Terrain check: <b>2 land starts, bases connected</b>" : "Terrain check: <b>2 land starts on separate coasts</b>. Sea or air units needed to cross.");
      await editor.addFiles(id, bf.title, bf.players, files);
      if (!current()) return;
      // The battlefield, draped over the place it came from.
      const m = map.current, b = box(place, fp.radius);
      const url = URL.createObjectURL(new Blob([files["map.png"].slice()], { type: "image/png" }));
      if (m.getLayer("built")) m.removeLayer("built");
      if (m.getSource("built")) m.removeSource("built");
      m.addSource("built", { type: "image", url, coordinates: [[b.w, b.n], [b.e, b.n], [b.e, b.s], [b.w, b.s]] });
      m.addLayer({ id: "built", type: "raster", source: "built", paint: { "raster-opacity": 0, "raster-resampling": "nearest" } }, "fp-fill");
      m.setPaintProperty("built", "raster-opacity-transition", { duration: 1800, delay: 0 });
      setTimeout(() => { if (current() && map.current === m && m.getLayer("built")) m.setPaintProperty("built", "raster-opacity", 0.92); }, 50);
      m.easeTo({ pitch: 55, bearing: 45, zoom: m.getZoom() + 0.2, duration: 2400 });
      setBuilt({ id, title: bf.title, coastal: !!base, points: spawnCells(new TextDecoder().decode(files["map.yaml"])) });
      setStage("built");
      await editor.open({ map: id });
      if (editor.state.error) throw Error(editor.state.error);
      close();
    } catch (e) { if (current()) { setError(e instanceof Error ? e.message : String(e)); setStage("place"); } }
  };

  // Switching role keeps the sides on the place: you take the other side's nation.
  const switchRole = (defend: boolean) => {
    if (defend === youDefend) return;
    sidesEdited.current = true;
    setYouDefend(defend); setFa(fb); setFb(fa);
  };

  const startMission = () => {
    if (!built || !place) return;
    const s = site ?? { name: place.name, lat: place.lat, lon: place.lon };
    const cell = geoToCell(s.lat, s.lon, place, fp.radius, fp.size);
    // The analyst's findings go into the briefing: the site's description and why these sides.
    const holder = youDefend ? fa : fb, striker = youDefend ? fb : fa;
    const intel = {
      summary: site?.extract,
      holds: forces?.defender.id === holder ? forces.defender.why : undefined,
      attacks: forces?.attacker.id === striker ? forces.attacker.why : undefined,
    };
    mission({ map: built.id, title: `${s.name}`, site: { ...cell, name: s.name }, fa, fb, youDefend, points: built.points, intel });
  };

  return (
    <div className="es-root" data-stage={stage} role="region" aria-label="Map editor · real-world area">
      <div ref={mapEl} className="es-map" />
      <header className="es-editorbar hud-panel">
        <button type="button" className="hud-tool" aria-label="Back to map editor" onClick={close}><ArrowLeft /></button>
        <div><b>Map editor</b><span>Real-world area</span></div>
        <ol aria-label="Map creation steps"><li aria-current="step">1 · Choose area</li><li>2 · Edit terrain & forces</li></ol>
      </header>
      <div className="es-map-controls">
      <div className="es-basemap" role="group" aria-label="Map appearance">
        <button type="button" aria-pressed={basemap === "satellite"} disabled={!ready} onClick={() => setBasemap("satellite")}>Satellite</button>
        <button type="button" aria-pressed={basemap === "streets"} disabled={!ready} onClick={() => setBasemap("streets")}>Street map</button>
      </div>
      <div className="es-view" role="group" aria-label="Map perspective">
        <button type="button" aria-pressed={view === "3d"} disabled={!ready} onClick={() => { setView("3d"); map.current?.setProjection({ type: "globe" }); map.current?.easeTo({ pitch: stage === "world" ? 0 : 50, duration: 600 }); }}>3D view</button>
        <button type="button" aria-pressed={view === "overhead"} disabled={!ready} onClick={() => { setView("overhead"); map.current?.setProjection({ type: "mercator" }); map.current?.easeTo({ pitch: 0, bearing: 0, duration: 600 }); }}>Overhead</button>
      </div>
      </div>
      {!ready && <div className="es-map-state hud-panel" role={mapError ? "alert" : "status"}>
        {mapError ? <><b>Globe unavailable</b><p>{mapError}</p><div><GameButton onClick={() => setMapAttempt(n => n + 1)}>Retry globe</GameButton><GameButton onClick={() => { const url = new URL(location.href); url.searchParams.set("mode", "map-studio"); location.assign(url.href); }}>Reload editor</GameButton></div></>
          : <><LoaderCircle className="menu-spin" size={22} /><span>Opening the 3D globe…</span></>}
      </div>}
      {stage === "world" && (
        <section className="es-world hud-panel">
          <span className="menu-eyebrow">New map · real-world area</span>
          <h1>Choose a place</h1>
          <p className="es-intro">Explore the 3D globe or search for a place. Choose the area, then shape its terrain in the editor.</p>
          <form className="es-search" role="search" aria-label="Place search" aria-busy={searching} onSubmit={(e) => { e.preventDefault(); void search(); }}>
            <Search size={20} aria-hidden="true" />
            <input value={query} onChange={(e) => { lookup.current?.abort(); setSearching(false); setQuery(e.target.value); setResults([]); setError(""); }} placeholder="Search a city, landmark or coast" aria-label="Find a place" data-testid="es-search" maxLength={160} />
            <GameButton type="submit" variant="primary" disabled={!ready || searching || !query.trim()}>{searching ? "Searching…" : "Search"}</GameButton>
          </form>
          {searching && <p className="es-map-hint" role="status">Searching for places…</p>}
          {results.length > 0 && <div className="es-results" aria-label="Place search results"><p role="status">Choose a place · {results.length} results</p><ul>{results.map((r, i) => <li key={`${r.lat}:${r.lon}:${i}`}><button type="button" onClick={() => go({ name: r.name, lat: r.lat, lon: r.lon })}><MapPin size={18} aria-hidden="true" /><span><b>{r.name}</b><small>{r.detail}</small></span></button></li>)}</ul></div>}
          <p className="es-map-hint">Drag to explore · scroll to zoom · click to choose.</p>
          <button type="button" className="es-center-choice" disabled={!ready} onClick={() => { const c = map.current!.getCenter(); chooseArea.current({ name: "Picked on the map", lat: c.lat, lon: c.lng }); }}>Choose view center</button>
          <h2 className="es-suggestions-title">Places to explore</h2><div className="es-chips">
            {SUGGEST.map((s) => <button key={s.name} type="button" onClick={() => void go(s)} disabled={!ready} data-place={s.name}><i />{s.name}</button>)}
            <button type="button" onClick={() => void go(SURPRISE[Math.floor(Math.random() * SURPRISE.length)])} disabled={!ready}><Dices size={14} />Surprise me</button>
          </div>
          {error && <p className="ed-error" role="alert">{error}</p>}
          <small className="es-search-credit">Place search © OpenStreetMap contributors</small>
          {developerTools && <details className="es-diagnostics"><summary>Source diagnostics</summary><p>{knownSites.length} sites · {datasetVersion || (catalogReady ? "Local discoveries" : "Loading…")}</p><GameButton onClick={exportSites} disabled={!knownSites.length}>Download site dataset</GameButton></details>}
        </section>
      )}
      {place && stage !== "world" && (
        <>
          <div className="es-place hud-panel">
            <button type="button" className="hud-tool" aria-label="Back to the globe" onClick={() => { research.current?.abort(); building.current?.abort(); setPlace(null); setStage("world"); map.current?.setPadding({ top: 0, bottom: 0, left: 0, right: 0 }); map.current?.flyTo({ center: [place.lon, place.lat], zoom: 2.2, pitch: 0, bearing: 0, duration: 1200 }); }}><ArrowLeft /></button>
            <span className="es-live" /><b>{place.name}</b>
            <span className="es-coords digits">{Math.abs(place.lat).toFixed(4)}°{place.lat >= 0 ? "N" : "S"} {Math.abs(place.lon).toFixed(4)}°{place.lon >= 0 ? "E" : "W"}</span>
          </div>
          <aside className="es-intel hud-panel" data-testid="es-intel">
            <div className="es-scroll">
            <section className="es-area" aria-label="Battlefield area">
              <h2>Choose your battlefield area</h2>
              <p>Click the map or drag the center marker to move the square. Drag the map to explore.</p>
              <div className="es-fp" role="radiogroup" aria-label="Battlefield width">
                {FOOTPRINTS.map((f, i) => <button key={f.label} type="button" role="radio" aria-checked={footprint === i} disabled={stage !== "place" || (f.radius > 10000 && !regionalGeography(place.lat, place.lon, f.radius))} onClick={() => { setError(""); setLog([]); setFootprint(i); drawFootprint(place, f); fitArea(place, f); }}>{f.label}</button>)}
              </div>
              <small>{fp.label} × {fp.label} · {fp.size} × {fp.size} game grid · about {Math.round(fp.radius * 2 / fp.size)} m per grid step. Larger areas compress detail.</small>
              <div className="es-area-actions">
                <GameButton disabled={stage !== "place"} onClick={() => { const c = map.current!.getCenter(); relocate(c.lat, c.lng); }}>Use view center</GameButton>
                <GameButton onClick={() => fitArea(place)}>Show whole area</GameButton>
              </div>
              {stage === "built" && <GameButton onClick={() => { building.current?.abort(); setStage("place"); setBuilt(null); setError(""); if (map.current?.getLayer("built")) map.current.removeLayer("built"); if (map.current?.getSource("built")) map.current.removeSource("built"); }}>Change area</GameButton>}
              {terrain && stage === "built" && <div className="es-site-storage" role="status" data-testid="es-terrain-status">
                <b>{terrain.source === "live" ? "Geography downloaded" : "Using saved geography"}</b>
                <small>OpenStreetMap · {new Date(terrain.snapshot.osmBase || terrain.snapshot.fetchedAt).toLocaleDateString()} · {terrain.saved ? "Saved in this browser" : "Available this session"}</small>
                <small>{terrain.refreshFailed ? "Live refresh unavailable. Your saved terrain is ready to play." : "Covered areas build from saved terrain, including when public mapping services are busy."}</small>
                <GameButton size="sm" onClick={() => void build(true)}>Refresh geography</GameButton>
              </div>}
            </section>
            {regionalGeography(place.lat, place.lon, fp.radius) && <details className="es-research"><summary>About this region</summary><section className="es-context" aria-label="Hormuz scenario background">
              <h2>Hormuz · scenario background</h2>
              <p>Shipping routes, attacks on vessels and maritime hazards are relevant here. Nearby map tags are not a conflict database.</p>
              <a href="https://www.imo.org/en/mediacentre/hottopics/pages/middle-east-strait-of-hormuz.aspx" target="_blank" rel="noopener">IMO: shipping routes and conflict updates ↗</a>
              <a href="https://www.ukmto.org/" target="_blank" rel="noopener">UKMTO: maritime security reports ↗</a>
              <a href="https://www.imo.org/en/mediacentre/secretarygeneral/pages/statement-summit-uk-france-strait-of-hormuz.aspx" target="_blank" rel="noopener">IMO, 17 Apr 2026: hazards including mines ↗</a>
              <small>Sources reviewed 16 Oct 2026. This builder imports geography and site names, not verified minefields or live forces. Recreate forces in the map editor.</small>
              <small>Coastlines: <a href="https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-land/" target="_blank" rel="noopener">Natural Earth 1:10 million</a>, generalized for a regional game map.</small>
            </section></details>}
            <details className="es-research"><summary>Nearby places · {sites.length}</summary>
            <div className="es-site-storage" role="status">
              <b>{scanning ? "Finding nearby places…" : "Public map references"}</b>
              {developerTools && <small>Dataset {datasetVersion.slice(0, 8) || "local"} · {siteStatus?.updatedAt ?? "No dated area snapshot"}</small>}
              <small>Public geographic references, not verified current operations. Markers include all known records; article details load when selected.</small>
              <div><GameButton size="sm" disabled={scanning} onClick={() => setSiteRefresh(n => n + 1)}>Refresh places</GameButton>{developerTools && <GameButton size="sm" disabled={!sites.length} onClick={exportSites}>Download sites</GameButton>}</div>
            </div>
            <div className="es-sites">
              {scanning && <div className="es-scanning" role="status"><LoaderCircle className="menu-spin" size={16} />Researching nearby sites… This won’t delay the map.</div>}
              {!scanning && sites.length === 0 && <p className="ed-tip">No nearby site information is available. You can still build the battlefield.</p>}
              {sites.slice(0, sitePage * 30).map((s) => (
                <button key={s.id} type="button" className="es-site" aria-pressed={site?.id === s.id} onClick={() => pickSite.current(s)}>
                  <span className="es-site-th" style={s.thumb ? { backgroundImage: `url("${s.thumb}")` } as CSSProperties : undefined}>{!s.thumb && <MapPin size={20} />}</span>
                  <span className="es-site-body">
                    <b>{s.name}</b>
                    {s.extract && <small>{s.extract}</small>}
                    {s.snapshot && <small>{s.snapshot}</small>}
                    <span className="es-src">
                      <span className="es-tag">{s.kind}</span>
                      {s.url ? <a href={s.url} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>{s.source}</a> : <span>{s.source}</span>}
                      <span>{(s.dist / 1000).toFixed(1)} km away</span>
                    </span>
                  </span>
                </button>
              ))}
              {sites.length > sitePage * 30 && <GameButton onClick={() => setSitePage(n => n + 1)}>Show 30 more sites</GameButton>}
            </div>
            </details>
            {stage === "building" && <div className="es-log" role="status">{log.slice(-2).map((l, i) => <div key={i} dangerouslySetInnerHTML={{ __html: l }} />)}</div>}
            </div>
            {error && <p className="ed-error" role="alert">{error}</p>}
            <footer>
              {stage === "place" && <><GameButton variant="primary" size="lg" icon={<Pencil size={16} />} onClick={() => void build()} data-testid="es-build">Create & edit map</GameButton><small className="es-play-note">Opens this area in the map editor. Add forces, change terrain, then test your map.</small></>}
              {stage === "building" && <div className="es-scanning"><LoaderCircle className="menu-spin" size={16} />Building the battlefield…</div>}
              {stage === "built" && built && (
                <div className="es-actions">
                  <div className="es-sides">
                    <label><span>You</span><SearchSelect size="sm" value={fa} onValueChange={value => { sidesEdited.current = true; setFa(value); }} options={nationOptions} aria-label="Your nation" /></label>
                    <label><span>Enemy AI</span><SearchSelect size="sm" value={fb} onValueChange={value => { sidesEdited.current = true; setFb(value); }} options={nationOptions} aria-label="Enemy nation" /></label>
                  </div>
                  <GameButton variant="primary" size="lg" icon={<Swords size={16} />} onClick={() => play(built.id, fa, fb)} data-testid="es-play">Play skirmish</GameButton>
                  <small className="es-play-note">Start now against the AI. This map is also saved in your browser’s map library.</small>
                  {!built.coastal && <details className="es-mission-extra"><summary>Or create a mission at this place</summary><div className="es-mission">
                    <span className="menu-eyebrow"><Swords size={12} /> Mission at {site?.name ?? place.name}</span>
                    <div className="es-role" role="radiogroup" aria-label="Your role">
                      <button type="button" role="radio" aria-checked={youDefend} onClick={() => switchRole(true)}><Shield size={13} />You defend it</button>
                      <button type="button" role="radio" aria-checked={!youDefend} onClick={() => switchRole(false)}><Swords size={13} />You attack it</button>
                    </div>
                    {forces && forces.defender.id === (youDefend ? fa : fb) && forces.attacker.id === (youDefend ? fb : fa) && <p className="es-why">{forceName(forces.defender.id)} holds it: {forces.defender.why}. {forceName(forces.attacker.id)} attacks: {forces.attacker.why}.</p>}
                    <GameButton variant="primary" size="lg" icon={<Swords size={16} />} onClick={startMission} data-testid="es-mission">Start mission</GameButton>
                  </div></details>}
                  {built.coastal && <p className="ed-tip">Regional terrain is ready. Open the editor to place forces and plan your scenario. The quick land-attack mission does not support this coastal map.</p>}
                  <GameButton variant={built.coastal ? "primary" : "secondary"} icon={<Pencil size={14} />} onClick={() => void editor.open({ map: built.id })} data-testid="es-edit">Edit this map</GameButton>
                </div>
              )}
            </footer>
          </aside>
        </>
      )}
    </div>
  );
}
