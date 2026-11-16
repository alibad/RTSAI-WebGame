// The Grid button: the cell grid over the battlefield (render/grid.ts). Every cell is outlined at its own height, so a
// battle reads as a board you can count and measure, as the old website Workshop's map did (owner, 16 Nov 2026). On the
// battle's top bar, the simulator's setup bar and the map editor's bar; the choice is kept for next time.

import { Grid3x3 } from "lucide-react";
import type { Game } from "../game";
import { useStore } from "../store";
import { savePreferences } from "../preferences";

export function GridToggle({ game, className = "hud-tool", tipPos }: { game: Game; className?: string; tipPos?: "right" | "top" }) {
  const on = useStore((s) => s.grid);
  const toggle = () => {
    const next = !on;
    savePreferences({ grid: next });
    game.renderer.setGrid(next);
    useStore.getState().set({ grid: next });
  };
  return (
    <button type="button" className={className} aria-label="Grid" aria-pressed={on} data-tip={on ? "Hide the grid" : "Show the grid"} data-tip-pos={tipPos} onClick={toggle} data-testid="grid-toggle">
      <Grid3x3 />
    </button>
  );
}
