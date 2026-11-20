// "Choose landscape": the random map tile's second door (ui/MapStrip.tsx). The engine's generator (sim MapGen.cs) takes
// a landscape, a size, how much ore and a seed, and the same four always make the same map: so a map you liked can be
// made again, on this PC or a friend's. The tile itself stays one click with everything left to the dice.
// The owner's pick from the old website Workshop (16 Nov 2026): "choose landscape and seed".

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Dices, Sparkles, X } from "lucide-react";
import type { Game, GenerateRequest } from "../game";
import { GameButton } from "./kit/game";
import "./maker.css";

/** The generator's landscapes: MapGen.cs Landscapes (Choice, the name players see). "random" lets the seed pick. */
export const LANDSCAPES: { id: string; name: string; hint: string }[] = [
  { id: "random", name: "Surprise me", hint: "The seed picks the landscape" },
  { id: "Lakes", name: "Lakes", hint: "Open water between the bases" },
  { id: "Puddles", name: "Ponds", hint: "Many small waters" },
  { id: "Plains", name: "Plains", hint: "Open, fast ground" },
  { id: "Parks", name: "Parkland", hint: "Clearings and groves" },
  { id: "Woodlands", name: "Woodlands", hint: "Forest with few roads through" },
  { id: "Rocky", name: "Rocky hills", hint: "Cliffs and high ground" },
  { id: "MountainLakes", name: "Mountain lakes", hint: "Cliffs around water" },
  { id: "Mountains", name: "Mountains", hint: "Passes and plateaus" },
  { id: "Flat", name: "Open ground", hint: "Nothing in the way" },
];
const ORE = ["Low", "Medium", "High"] as const;
type Ore = typeof ORE[number];
/** Cells a side, by how many players the map must seat (MapGen.cs's own default is the middle one). */
const sizesFor = (players: number): [number, number, number] => players <= 2 ? [72, 96, 128] : players <= 4 ? [96, 128, 160] : [128, 160, 192];
const SIZE_NAMES = ["Small", "Medium", "Large"];
const newSeed = () => 1 + Math.floor(Math.random() * 999_999);

interface Choice { terrain: string; size: number; ore: Ore }
const KEY = "rtsai.random-map";
function remembered(): Partial<Choice> {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}

/** What a generated map's entry says under its name: the landscape and the seed that make it again. */
export function generatedNote(map: { landscape?: string; gen?: string }) {
  let seed: number | undefined;
  try { seed = map.gen ? Number((JSON.parse(map.gen) as GenerateRequest).seed) : undefined; } catch { /* an older entry */ }
  return [map.landscape, Number.isFinite(seed) ? `seed ${seed}` : ""].filter(Boolean).join(" · ");
}

export function RandomMapMaker({ game, players, onMade, close }: { game: Game; players: number; onMade: (id: string) => void; close: () => void }) {
  const sizes = sizesFor(players);
  const [choice, setChoice] = useState<Choice>(() => {
    const r = remembered();
    return { terrain: LANDSCAPES.some((l) => l.id === r.terrain) ? r.terrain! : "random", size: sizes.includes(r.size as number) ? r.size! : sizes[1], ore: ORE.includes(r.ore as Ore) ? r.ore! : "Medium" };
  });
  const [seed, setSeed] = useState(() => String(newSeed()));
  const [making, setMaking] = useState(false);
  const [error, setError] = useState("");
  const pick = (p: Partial<Choice>) => { const next = { ...choice, ...p }; setChoice(next); try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ } };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !making) { e.stopPropagation(); close(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close, making]);
  const number = Number(seed);
  const valid = seed.trim() !== "" && Number.isInteger(number) && number >= 0 && number <= 2_000_000_000;
  const make = () => {
    if (making || !valid) return;
    setMaking(true); setError("");
    game.generateMap({ seed: number, players: Math.max(2, players), terrain: choice.terrain, size: choice.size, resources: choice.ore })
      .then((id) => { onMade(id); close(); }, (e: Error) => { setError(e.message); setMaking(false); });
  };
  return createPortal(
    <div className="rm-scrim" role="dialog" aria-modal="true" aria-label="Choose a random map" onClick={() => { if (!making) close(); }} data-ui-sfx>
      <form className="rm-panel hud-panel" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); make(); }} data-testid="random-maker">
        <header><b>New random map</b><button type="button" aria-label="Close" onClick={close} disabled={making}><X size={16} /></button></header>
        <div className="rm-lands" role="radiogroup" aria-label="Landscape">
          {LANDSCAPES.map((l) => (
            <button key={l.id} type="button" role="radio" aria-checked={choice.terrain === l.id} className="rm-land" data-sfx-hover onClick={() => pick({ terrain: l.id })} data-landscape={l.id}>
              <span className="rm-land-art">{l.id === "random" ? <Dices size={26} strokeWidth={1.4} aria-hidden="true" /> : <img src={`menu/landscapes/${l.id.toLowerCase()}.png`} alt="" draggable={false} loading="lazy" />}</span>
              <b>{l.name}</b><small>{l.hint}</small>
            </button>
          ))}
        </div>
        <div className="rm-row">
          <div><span className="rm-label">Size</span>
            <div className="rm-seg" role="radiogroup" aria-label="Map size">{sizes.map((n, i) => <button key={n} type="button" role="radio" aria-checked={choice.size === n} onClick={() => pick({ size: n })}>{SIZE_NAMES[i]}</button>)}</div>
          </div>
          <div><span className="rm-label">Ore</span>
            <div className="rm-seg" role="radiogroup" aria-label="Ore">{ORE.map((o) => <button key={o} type="button" role="radio" aria-checked={choice.ore === o} onClick={() => pick({ ore: o })}>{o}</button>)}</div>
          </div>
          <div className="rm-seed"><label className="rm-label" htmlFor="rm-seed">Seed</label>
            <div><input id="rm-seed" inputMode="numeric" value={seed} onChange={(e) => setSeed(e.target.value.replace(/[^\d]/g, "").slice(0, 10))} aria-invalid={!valid || undefined} data-testid="random-seed" />
              <button type="button" aria-label="Another seed" title="Another seed" onClick={() => setSeed(String(newSeed()))}><Dices size={16} /></button></div>
          </div>
        </div>
        <p className="rm-note">The same landscape, size, ore and seed always make the same map: write the seed down, or send it to a friend.</p>
        {error && <p className="ed-error" role="alert">{error}</p>}
        <footer><GameButton type="submit" variant="primary" size="lg" icon={making ? <span className="spinner" /> : <Sparkles size={16} />} disabled={making || !valid} data-testid="random-make">{making ? "Making the map…" : "Make this map"}</GameButton></footer>
      </form>
    </div>,
    document.body,
  );
}
