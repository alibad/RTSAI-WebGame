// The battlefield's "calculated board" buttons (owner, 16 Nov 2026: the old website Workshop's map felt "like an actual
// calculated thing"):
// - Grid: every cell outlined at its own height (render/grid.ts). Battle bar, simulator setup bar, map editor bar.
// - Ranges: every unit's weapon reach as a ring on the ground (Renderer.drawReach). Battle bar and simulator setup bar.
// - Board: the battle simulator's field panel (ui/BattleBoard.tsx): readout, who fell when, everything on the field.
// Each choice is kept for next time (preferences.ts).

import { Grid3x3, PanelLeft, Radar } from "lucide-react";
import type { Game } from "../game";
import { useStore } from "../store";
import { savePreferences } from "../preferences";

function Toggle({ on, label, show, hide, tipPos, icon, onClick, testId, className = "hud-tool" }: {
  on: boolean; label: string; show: string; hide: string; tipPos?: "right" | "top"; icon: React.ReactNode; onClick: () => void; testId: string; className?: string;
}) {
  return (
    <button type="button" className={className} aria-label={label} aria-pressed={on} data-tip={on ? hide : show} data-tip-pos={tipPos} onClick={onClick} data-testid={testId}>
      {icon}
    </button>
  );
}

export function GridToggle({ game, className, tipPos }: { game: Game; className?: string; tipPos?: "right" | "top" }) {
  const on = useStore((s) => s.grid);
  return <Toggle on={on} label="Grid" show="Show the grid" hide="Hide the grid" tipPos={tipPos} className={className} icon={<Grid3x3 />} testId="grid-toggle"
    onClick={() => { const next = !on; savePreferences({ grid: next }); game.renderer.setGrid(next); useStore.getState().set({ grid: next }); }} />;
}

export function RangesToggle({ className, tipPos }: { className?: string; tipPos?: "right" | "top" }) {
  const on = useStore((s) => s.ranges);
  return <Toggle on={on} label="Weapon ranges" show="Show every unit's weapon range" hide="Hide weapon ranges" tipPos={tipPos} className={className} icon={<Radar />} testId="ranges-toggle"
    onClick={() => { const next = !on; savePreferences({ ranges: next }); useStore.getState().set({ ranges: next }); }} />;
}

export function BoardToggle({ className, tipPos }: { className?: string; tipPos?: "right" | "top" }) {
  const on = useStore((s) => s.board);
  return <Toggle on={on} label="Battle board" show="Show the battle board" hide="Hide the battle board" tipPos={tipPos} className={className} icon={<PanelLeft />} testId="board-toggle"
    onClick={() => { const next = !on; savePreferences({ board: next }); useStore.getState().set({ board: next }); }} />;
}
