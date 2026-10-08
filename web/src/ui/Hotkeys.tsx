// Hotkey sheet (? or the ? button): every key the page binds, grouped, with the same icons as the buttons. These are
// the desktop game's keys (mods/common/hotkeys and the mod's hotkeys.yaml, as its ingame chrome binds them), doing what
// its widgets do (game.ts keyDown); a key the browser keeps for itself (Ctrl+W, Ctrl+Tab in a tab, F11, F12) is not
// listed.

import { useStore } from "../store";
import { Kbd } from "./CameoTip";
import { AttackMoveIcon, DeployIcon, GuardIcon, RepairIcon, ScatterIcon, SellIcon, StopIcon } from "./icons";

type Row = [keys: string[], label: string, Icon?: (p: React.SVGProps<SVGSVGElement>) => React.JSX.Element];

const GROUPS: [string, Row[]][] = [
  ["Units", [
    [["A"], "Attack move", AttackMoveIcon],
    [["D"], "Guard", GuardIcon],
    [["F"], "Deploy", DeployIcon],
    [["Ctrl", "X"], "Scatter", ScatterIcon],
    [["S"], "Stop", StopIcon],
    [["⇧", "click"], "Queue orders (⇧F, ⇧Ctrl+X too)"],
    [["Alt", "A S D F"], "Stance: attack · defend · return fire · hold"],
  ]],
  ["Select", [
    [["Q"], "All units on screen (again: map)"],
    [["W"], "Same type on screen (again: map)"],
    [["H"], "Next base"],
    [["N"], "Next harvester"],
    [["Home"], "Jump to selection"],
    [["Space"], "Jump to last event"],
  ]],
  ["Groups", [
    [["1–0"], "Select (twice: jump)"],
    [["Ctrl", "1–0"], "Create"],
    [["Ctrl", "⇧", "1–0"], "Add selection"],
    [["⇧", "1–0"], "Combine with selection"],
    [["Alt", "1–0"], "Jump to"],
  ]],
  ["Build", [
    [["E R T Y U I"], "Building · defense · infantry · vehicle · air · naval"],
    [["F1–F10"], "Build the 1st–10th icon (⇧: five)"],
    [["Ctrl", "F1–F10"], "Build the 13th–22nd icon (not F4)"],
    [["Z"], "Sell", SellIcon],
    [["C"], "Repair", RepairIcon],
    [["B"], "Place a beacon"],
    [["RMB"], "Hold, then cancel"],
  ]],
  ["View", [
    [["↑ ↓ ← →"], "Scroll (Alt: to the map edge)"],
    [["[", "]"], "Zoom out · in"],
    [["."], "Reset zoom"],
    [["Ctrl", "Q E R"], "Save view 1 · 3 · 4"],
    [["Alt", "Q W E R"], "Back to a saved view"],
    [[","], "Health bars: selected · damaged · all"],
    [["⇧", "="], "Hide the interface"],
  ]],
  ["Game", [
    [["Esc"], "Menu (first: cancel a mode)"],
    [["P"], "Pause (or Pause key)"],
    [["M"], "Mute"],
    [["?"], "This sheet"],
    [["V"], "Co-commander: hold to talk"],
    [["Ctrl", "Space"], "Co-commander: type"],
    [["Ctrl", "Enter"], "Accept its order (Ctrl+⌫ reject)"],
  ]],
];

export function HotkeySheet() {
  const open = useStore((s) => s.keysOpen);
  const set = useStore((s) => s.set);
  if (!open) return null;
  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-black/40" style={{ right: "var(--sidebar-w)" }} onMouseDown={() => set({ keysOpen: false })}>
      <div className="hud-panel grid grid-cols-3 gap-x-8 gap-y-4 px-6 py-5 text-[12px]" onMouseDown={(e) => e.stopPropagation()}>
        {GROUPS.map(([title, rows]) => (
          <section key={title} className="min-w-[200px]">
            <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--hud-gold-dim)]">{title}</h3>
            <div className="grid gap-[5px]">
              {rows.map(([keys, label, Icon]) => (
                <div key={label} className="flex items-center gap-2">
                  <span className="flex w-[96px] shrink-0 flex-wrap gap-[3px]">{keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span>
                  <span className="grid w-[16px] place-items-center text-[var(--hud-gold)]">{Icon && <Icon width={14} height={14} />}</span>
                  <span className="text-[var(--foreground)]">{label}</span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export function HotkeyButton() {
  const open = useStore((s) => s.keysOpen);
  const set = useStore((s) => s.set);
  return (
    <button type="button" title="Hotkeys (?)" aria-label="Hotkeys" onClick={() => set({ keysOpen: !open })}
      className="hud-panel grid size-[32px] place-items-center rounded-[3px] text-[14px] font-bold text-[var(--muted-foreground)] hover:text-[var(--hud-gold)]">
      ?
    </button>
  );
}
