// The map strip every screen that picks a battlefield shares (skirmish, the battle simulator, the map editor): a
// "New random map" tile that runs the engine's own map generator in this browser, then every map with its preview.

import { useEffect, useRef, useState } from "react";
import { Dices, Map as MapIcon } from "lucide-react";
import type { Game } from "../game";
import { useStore } from "../store";
import type { SetupData } from "../sim/protocol";

type MapEntry = SetupData["maps"][number];

/** Internal arenas remain addressable by scenarios, but aren't finished battlefields. */
export const isUtilityMap = (m: MapEntry) => !m.saved && !m.generated && /^web-arena(?:-four)?$/.test(m.id);
export const mapCollection = (m: MapEntry) => m.saved ? "Your maps" : m.generated ? "Random maps" : m.id.startsWith("ra2-") ? "Red Alert 2" : "RTS AI";

/** Drafts stay available to their author in the editor; matches require at least two seats. */
export function orderMaps(maps: MapEntry[], includeDrafts = false) {
  const available = maps.filter(m => !isUtilityMap(m) && (includeDrafts || m.players >= 2));
  return [...available.filter(m => m.generated), ...available.filter(m => m.saved && !m.generated),
    ...available.filter(m => !m.saved && !m.generated).sort((a, b) => Number(b.id.startsWith("ra2-")) - Number(a.id.startsWith("ra2-")) || a.players - b.players || a.title.localeCompare(b.title))];
}

function MapCard({ game, map, selected, onChange }: { game: Game; map: MapEntry; selected: boolean; onChange: (id: string) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const preview = useStore(s => s.publicShot ? "" : s.previews[map.id] ?? "");
  // Load pictures when cards approach the viewport, including maps beyond the first 16.
  useEffect(() => {
    const card = ref.current;
    if (!card) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { game.preview(map.id); observer.disconnect(); }
    }, { rootMargin: "200px" });
    observer.observe(card);
    return () => observer.disconnect();
  }, [game, map.id]);
  return <button ref={ref} type="button" className="sk-map-thumb" aria-pressed={selected} data-sfx-hover onClick={() => onChange(map.id)} title={`${map.title} · ${map.author}`}>
    <span className="sk-map-thumb-art">{preview ? <img src={preview} alt="" draggable={false} /> : <MapIcon size={22} strokeWidth={1.4} aria-hidden="true" />}</span>
    <span className="sk-map-thumb-name">{map.title}</span>
    <small>{map.players < 2 ? "Draft · " : ""}{map.players} players · {mapCollection(map)}</small>
  </button>;
}

/** A new random map from the engine's map generator (game.generateMap): a landscape picked at random, sized for `players`. */
export function useRandomMap(game: Game, players: number, onMade: (id: string) => void) {
  const [making, setMaking] = useState(false);
  const [error, setError] = useState("");
  const make = () => {
    if (making) return;
    setMaking(true);
    setError("");
    game.generateMap({ seed: Math.floor(Math.random() * 1e9), players: Math.max(2, players), terrain: "random" })
      .then(onMade, (e: Error) => setError(e.message))
      .finally(() => setMaking(false));
  };
  return { making, error, make };
}

export function MapStrip({ game, value, onChange, players = 2, filter, className, includeDrafts = false }: {
  game: Game; value: string | undefined; onChange: (id: string) => void; players?: number;
  filter?: (m: MapEntry) => boolean; className?: string; includeDrafts?: boolean;
}) {
  const setup = useStore((s) => s.setup);
  const random = useRandomMap(game, players, onChange);
  const maps = orderMaps((setup?.maps ?? []).filter((m) => !filter || filter(m)), includeDrafts);
  return (
    <div className={className ?? "sk-maps"} role="group" aria-label="Maps">
      <button type="button" className="sk-map-thumb sk-map-random" data-sfx-hover onClick={random.make} aria-busy={random.making} data-testid="random-map">
        <span className="sk-map-thumb-art">{random.making ? <span className="spinner" /> : <Dices size={24} strokeWidth={1.4} aria-hidden="true" />}</span>
        <span className="sk-map-thumb-name">{random.making ? "Making a map…" : "New random map"}</span>
        <small>{random.error || "Lakes, forests, cliffs"}</small>
      </button>
      {maps.map(m => <MapCard key={m.id} game={game} map={m} selected={m.id === value} onChange={onChange} />)}
    </div>
  );
}
