// The map strip every screen that picks a battlefield shares (skirmish, the battle simulator, the map editor): a
// "New random map" tile that runs the engine's own map generator in this browser, then every map with its preview.

import { useEffect, useState } from "react";
import { Dices, Map as MapIcon } from "lucide-react";
import type { Game } from "../game";
import { useStore } from "../store";
import type { SetupData } from "../sim/protocol";

type MapEntry = SetupData["maps"][number];

/** Maps made here by the generator first (newest first), then the player's saved maps, then the bundled ones. */
export function orderMaps(maps: MapEntry[]) {
  return [...maps.filter((m) => m.generated), ...maps.filter((m) => m.saved), ...maps.filter((m) => !m.saved && !m.generated)];
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

export function MapStrip({ game, value, onChange, players = 2, filter, className }: {
  game: Game; value: string | undefined; onChange: (id: string) => void; players?: number;
  filter?: (m: MapEntry) => boolean; className?: string;
}) {
  const setup = useStore((s) => s.setup);
  const previews = useStore((s) => s.previews);
  const publicShot = useStore((s) => s.publicShot);
  const random = useRandomMap(game, players, onChange);
  const maps = orderMaps((setup?.maps ?? []).filter((m) => !filter || filter(m)));
  useEffect(() => { for (const m of maps.slice(0, 16)) game.preview(m.id); }, [game, maps.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = (id: string) => (publicShot ? "" : previews[id] ?? "");
  return (
    <div className={className ?? "sk-maps"} role="group" aria-label="Maps">
      <button type="button" className="sk-map-thumb sk-map-random" data-sfx-hover onClick={random.make} aria-busy={random.making} data-testid="random-map">
        <span className="sk-map-thumb-art">{random.making ? <span className="spinner" /> : <Dices size={24} strokeWidth={1.4} aria-hidden="true" />}</span>
        <span className="sk-map-thumb-name">{random.making ? "Making a map…" : "New random map"}</span>
        <small>{random.error || "Lakes, forests, cliffs"}</small>
      </button>
      {maps.map((m) => (
        <button key={m.id} type="button" className="sk-map-thumb" aria-pressed={m.id === value} data-sfx-hover onClick={() => onChange(m.id)}>
          <span className="sk-map-thumb-art">{preview(m.id) ? <img src={preview(m.id)} alt="" draggable={false} /> : <MapIcon size={22} strokeWidth={1.4} aria-hidden="true" />}</span>
          <span className="sk-map-thumb-name">{m.title}</span>
          <small>{m.players} players</small>
        </button>
      ))}
    </div>
  );
}
