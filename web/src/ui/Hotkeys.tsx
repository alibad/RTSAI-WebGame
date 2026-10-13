// Hotkey sheet (? or the ? button): every key the page binds, grouped, with the same icons as the buttons. These are
// the desktop game's keys (mods/common/hotkeys and the mod's hotkeys.yaml, as its ingame chrome binds them), doing what
// its widgets do (game.ts keyDown); a key the browser keeps for itself (Ctrl+W, Ctrl+Tab in a tab, F11, F12) is not
// listed.

import { CircleHelp, Crosshair, Hammer, Layers, Monitor, MousePointer2, Gamepad2 } from "lucide-react";
import { useStore } from "../store";
import { preferences } from "../preferences";
import { GameDialog, GameSection, Kbd } from "./kit/game";
import { AttackMoveIcon, DeployIcon, GuardIcon, RepairIcon, ScatterIcon, SellIcon, StopIcon } from "./icons";

type Row = [keys: string[], label: string, Icon?: (p: React.SVGProps<SVGSVGElement>) => React.JSX.Element];

const GROUPS: [string, React.ReactNode, Row[]][] = [
  ["Units", <Crosshair size={14} />, [
    [["A"], "Attack move", AttackMoveIcon],
    [["D"], "Guard", GuardIcon],
    [["F"], "Deploy", DeployIcon],
    [["Ctrl", "X"], "Scatter", ScatterIcon],
    [["S"], "Stop", StopIcon],
    [["⇧", "click"], "Queue orders (⇧F, ⇧Ctrl+X too)"],
    [["Alt", "A S D F"], "Stance: attack · defend · return fire · hold"],
  ]],
  ["Select", <MousePointer2 size={14} />, [
    [["Q"], "All units on screen (again: map)"],
    [["W"], "Same type on screen (again: map)"],
    [["H"], "Next base"],
    [["N"], "Next harvester"],
    [["Home"], "Jump to selection"],
    [["Space"], "Jump to last event"],
  ]],
  ["Groups", <Layers size={14} />, [
    [["1–0"], "Select (twice: jump)"],
    [["Ctrl", "1–0"], "Create"],
    [["Ctrl", "⇧", "1–0"], "Add selection"],
    [["⇧", "1–0"], "Combine with selection"],
    [["Alt", "1–0"], "Jump to"],
  ]],
  ["Build", <Hammer size={14} />, [
    [["E R T Y U I"], "Building · defense · infantry · vehicle · air · naval"],
    [["F1–F10"], "Build the 1st–10th icon (⇧: five)"],
    [["Ctrl", "F1–F10"], "Build the 13th–22nd icon (not F4)"],
    [["Z"], "Sell", SellIcon],
    [["C"], "Repair", RepairIcon],
    [["B"], "Place a beacon"],
    [["RMB"], "Hold, then cancel"],
  ]],
  ["View", <Monitor size={14} />, [
    [["↑ ↓ ← →"], "Scroll (Alt: to the map edge)"],
    [["[", "]"], "Zoom out · in"],
    [["."], "Reset zoom"],
    [["Ctrl", "Q E R"], "Save view 1 · 3 · 4"],
    [["Alt", "Q W E R"], "Back to a saved view"],
    [[","], "Health bars: selected · damaged · all"],
    [["⇧", "="], "Hide the interface"],
  ]],
  ["Game", <Gamepad2 size={14} />, [
    [["Esc"], "Menu (first: cancel a mode)"],
    [["P"], "Pause (or Pause key)"],
    [["M"], "Mute"],
    [["?"], "This sheet"],
    [["G", "or", "J"], "Apply displayed recommendation (Ctrl+⌫ reject)"],
    ...(import.meta.env.VITE_STATIC_BUILD !== "1" ? [
    [["V"], "Co-commander: hold to talk"],
    [["Ctrl", "Space"], "Co-commander: type"],
    ] as [string[], string][] : []),
  ]],
];

export function HotkeySheet() {
  const open = useStore((s) => s.keysOpen);
  const set = useStore((s) => s.set);
  if (!open) return null;
  return (
    <GameDialog eyebrow="Help" title="Controls" size="xl" onClose={() => set({ keysOpen: false })}>
      <div className="hk-grid">
        {GROUPS.map(([title, icon, rows]) => (
          <GameSection key={title} icon={icon} title={title}>
            {rows.map(([keys, label, Icon]) => (
              <div key={label} className="hk-row">
                <span className="hk-keys">{keys.map((k) => k === "or" ? <i key={k}>or</i> : <Kbd key={k}>{keys.length === 1 ? (preferences.bindings[k.toLowerCase()] ?? k).toUpperCase() : k}</Kbd>)}</span>
                <span className="hk-icon">{Icon && <Icon width={15} height={15} />}</span>
                <span>{label}</span>
              </div>
            ))}
          </GameSection>
        ))}
      </div>
    </GameDialog>
  );
}

export function HotkeyButton() {
  const open = useStore((s) => s.keysOpen);
  const set = useStore((s) => s.set);
  return (
    <button type="button" className="hud-tool" aria-label="Hotkeys" aria-pressed={open} data-tip="Controls · ?" onClick={() => set({ keysOpen: !open })}>
      <CircleHelp />
    </button>
  );
}
