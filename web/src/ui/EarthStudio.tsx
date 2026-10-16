// The Earth studio: a globe to pick any place on, a fly-in to it, a scan of public sources (OpenStreetMap's mapped
// military sites, airfields and ports; Wikipedia's articles around it, each with its source), independently of the battlefield
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
import { elevationGrid } from "../elevation";
import { researchSites, type Place, type Site } from "../earth-research";
import { overpassFailure, terrainBox, terrainFeatures, terrainQuery } from "@site/lib/earth-evidence";
import type { Map as MapLibreMap } from "maplibre-gl";

type DataSource = { setData(data: unknown): void };



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

async function overpass(query: string, signal?: AbortSignal) {
  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]);
  // The local game server relays and keeps answers (server/serve.mjs); the public game asks the mirrors itself.
  const relay = import.meta.env.VITE_STATIC_BUILD !== "1" ? [new URL("api/overpass", new URL("./", location.href)).href] : [];
  for (const url of [...relay, ...OVERPASS]) {
    deadline.throwIfAborted();
    try {
      const r = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(query), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.any([deadline, AbortSignal.timeout(20000)]) });
      if (r.ok) return await r.json();
    } catch { /* the next mirror */ }
  }
  throw Error("OpenStreetMap didn't answer. Try again in a moment.");
}
const box = (p: Place, radius: number) => {
  const dy = radius / 110540, dx = radius / (111320 * Math.cos(p.lat * Math.PI / 180));
  return { s: p.lat - dy, w: p.lon - dx, n: p.lat + dy, e: p.lon + dx };
};

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
  const [sites, setSites] = useState<Site[]>([]);
  const [scanning, setScanning] = useState(false);
  const research = useRef<AbortController | null>(null);
  const building = useRef<AbortController | null>(null);
  const sidesEdited = useRef(false);
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

  const go = (p: Place) => {
    const m = map.current;
    if (!m) return;
    research.current?.abort(); building.current?.abort(); sidesEdited.current = false;
    setPlace(p); setStage("place"); setLog([]); setSites([]); setSite(null); setError(""); setBuilt(null); setForces(null);
    say(`Flying to <b>${p.name}</b>`);
    m.setPadding({ top: 0, bottom: 0, left: 0, right: 420 });
    m.flyTo({ center: [p.lon, p.lat], zoom: 12.6, pitch: 50, bearing: -25, duration: 6500, curve: 1.6, essential: true });
    drawFootprint(p);
  };

  // Site research enriches missions in the background. It never gates the build action or its terrain request.
  const nationIds = nations.map(n => n.id).join(",");
  useEffect(() => {
    if (!place) return;
    const controller = new AbortController(); research.current = controller;
    const { signal } = controller;
    let found: Site[] = [], country: string | null = null;
    setScanning(true); setSites([]); setSite(null);
    const infer = () => {
      if (signal.aborted) return;
      const sources = found.map(s => ({ text: [s.name, s.operator, s.extract].filter(Boolean).join(". "), from: `${s.source}: ${s.name}` }));
      const forces = inferForces(country, sources, nationIds.split(","));
      if (forces && !sidesEdited.current) { setForces(forces); setFa(forces.defender.id); setFb(forces.attacker.id); setYouDefend(true); }
    };
    void countryAt(place.lat, place.lon, signal).then(code => { country = code; infer(); });
    void researchSites(place, fp.radius, { signal, mapped: overpass,
      log: message => { if (!signal.aborted) say(message); },
      update: list => {
        if (signal.aborted) return;
        found = list; setSites(list); drawSites(list);
        setSite(selected => selected ? list.find(s => s.id === selected.id) ?? selected
          : list.find(s => /air base|naval|military|barracks/i.test(s.kind)) ?? list[0] ?? null);
        infer();
      },
    }).finally(() => { if (!signal.aborted) setScanning(false); });
    return () => controller.abort();
  }, [place, fp.radius, nationIds]); // Helpers use the current map ref; callbacks are scoped to this lookup.

  useEffect(() => () => { research.current?.abort(); building.current?.abort(); }, []);

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
    const controller = new AbortController(); building.current?.abort(); building.current = controller;
    const current = () => !controller.signal.aborted && building.current === controller;
    setStage("building"); setError("");
    try {
      const heights = elevationGrid(place.lat, place.lon, fp.radius, fp.size).catch(() => null);
      say("Reading the place's <b>roads, water and land</b>");
      const payload = await overpass(terrainQuery(place.lat, place.lon, fp.radius), controller.signal);
      if (!current()) return;
      if (overpassFailure(payload)) throw Error("This area is too dense; choose a smaller footprint.");
      const features = terrainFeatures(payload, terrainBox(place.lat, place.lon, fp.radius));
      say(`Compiling <b>${features.length}</b> features into terrain`);
      const title = place.name.split(",")[0].slice(0, 40);
      const bf = await compileBattlefield({ latitude: place.lat, longitude: place.lon, radius: fp.radius, seed: 42, size: fp.size, players: 2, title }, features);
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
      say("Engine check: <b>2 start positions, bases connected</b>");
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
      setBuilt({ id, title: bf.title, points: spawnCells(new TextDecoder().decode(files["map.yaml"])) });
      setStage("built");
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
            <button type="button" className="hud-tool" aria-label="Back to the globe" onClick={() => { research.current?.abort(); building.current?.abort(); setPlace(null); setStage("world"); map.current?.setPadding({ top: 260, bottom: 0, left: 0, right: 0 }); map.current?.flyTo({ center: [place.lon, place.lat], zoom: 2.2, pitch: 0, bearing: 0, duration: 3000 }); }}><ArrowLeft /></button>
            <span className="es-live" /><b>{place.name}</b>
            <span className="es-coords digits">{Math.abs(place.lat).toFixed(4)}°{place.lat >= 0 ? "N" : "S"} {Math.abs(place.lon).toFixed(4)}°{place.lon >= 0 ? "E" : "W"}</span>
            <span className="es-fp" role="radiogroup" aria-label="Footprint">
              {FOOTPRINTS.map((f, i) => <button key={f.label} type="button" role="radio" aria-checked={footprint === i} disabled={stage !== "place"} onClick={() => { setFootprint(i); drawFootprint(place, f); }}>{f.label}</button>)}
            </span>
          </div>
          <aside className="es-intel hud-panel" data-testid="es-intel">
            <header><span className="es-live" /><span className="menu-eyebrow">Nearby sites · optional research</span></header>
            <p className="ed-tip">Roads, water and land shape the map. Site names and background research load separately for missions.</p>
            <div className="es-log">{log.map((l, i) => <div key={i} dangerouslySetInnerHTML={{ __html: l }} />)}</div>
            <div className="es-sites">
              {scanning && <div className="es-scanning" role="status"><LoaderCircle className="menu-spin" size={16} />Researching nearby sites… This won’t delay the map.</div>}
              {!scanning && sites.length === 0 && <p className="ed-tip">No nearby site information is available. You can still build the battlefield.</p>}
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
              {stage === "place" && <GameButton variant="primary" size="lg" icon={<Globe2 size={16} />} onClick={() => void build()} data-testid="es-build">Build battlefield</GameButton>}
              {stage === "building" && <div className="es-scanning"><LoaderCircle className="menu-spin" size={16} />Building the battlefield…</div>}
              {stage === "built" && built && (
                <div className="es-actions">
                  <div className="es-mission">
                    <span className="menu-eyebrow"><Swords size={12} /> Mission at {site?.name ?? place.name}</span>
                    <div className="es-sides">
                      <label><span>You</span><SearchSelect size="sm" value={fa} onValueChange={value => { sidesEdited.current = true; setFa(value); }} options={nationOptions} aria-label="Your nation" /></label>
                      <label><span>Enemy AI</span><SearchSelect size="sm" value={fb} onValueChange={value => { sidesEdited.current = true; setFb(value); }} options={nationOptions} aria-label="Enemy nation" /></label>
                    </div>
                    <div className="es-role" role="radiogroup" aria-label="Your role">
                      <button type="button" role="radio" aria-checked={youDefend} onClick={() => switchRole(true)}><Shield size={13} />You defend it</button>
                      <button type="button" role="radio" aria-checked={!youDefend} onClick={() => switchRole(false)}><Swords size={13} />You attack it</button>
                    </div>
                    {forces && forces.defender.id === (youDefend ? fa : fb) && forces.attacker.id === (youDefend ? fb : fa) && <p className="es-why">{forceName(forces.defender.id)} holds it: {forces.defender.why}. {forceName(forces.attacker.id)} attacks: {forces.attacker.why}.</p>}
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
