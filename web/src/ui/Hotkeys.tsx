// Hotkey sheet (F1 or the ? button): every key the page binds, grouped, with the same icons as the buttons.

import { useStore } from "../store";
import { Kbd } from "./CameoTip";
import { AttackMoveIcon, DeployIcon, GuardIcon, RepairIcon, ScatterIcon, SellIcon, StopIcon } from "./icons";

type Row = [keys: string[], label: string, Icon?: (p: React.SVGProps<SVGSVGElement>) => React.JSX.Element];

const GROUPS: [string, Row[]][] = [
  ["Units", [
    [["A"], "Attack move", AttackMoveIcon],
    [["G"], "Guard", GuardIcon],
    [["D"], "Deploy", DeployIcon],
    [["X"], "Scatter", ScatterIcon],
    [["S"], "Stop", StopIcon],
    [["⇧", "click"], "Queue orders"],
  ]],
  ["Base", [
    [["Z"], "Repair", RepairIcon],
    [["Q"], "Sell", SellIcon],
    [["⇧", "LMB"], "Build five"],
    [["RMB"], "Hold, then cancel"],
  ]],
  ["Groups", [
    [["Ctrl", "1–0"], "Create"],
    [["1–0"], "Select (twice: jump)"],
    [["⇧", "1–0"], "Add selection"],
  ]],
  ["View", [
    [["H"], "Home base"],
    [["P"], "Pause"],
    [["Esc"], "Cancel / deselect"],
    [["F2"], "Engine stats"],
  ]],
  ["Co-commander", [
    [["V"], "Hold to talk"],
  ]],
];

export function HotkeySheet() {
  const open = useStore((s) => s.keysOpen);
  const set = useStore((s) => s.set);
  if (!open) return null;
  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-black/40" style={{ right: "var(--sidebar-w)" }} onMouseDown={() => set({ keysOpen: false })}>
      <div className="hud-panel grid grid-cols-2 gap-x-8 gap-y-4 px-6 py-5 text-[12px]" onMouseDown={(e) => e.stopPropagation()}>
        {GROUPS.map(([title, rows]) => (
          <section key={title} className="min-w-[200px]">
            <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--hud-gold-dim)]">{title}</h3>
            <div className="grid gap-[5px]">
              {rows.map(([keys, label, Icon]) => (
                <div key={label} className="flex items-center gap-2">
                  <span className="flex w-[78px] shrink-0 gap-[3px]">{keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span>
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
    <button type="button" title="Hotkeys (F1)" aria-label="Hotkeys" onClick={() => set({ keysOpen: !open })}
      className="hud-panel grid size-[32px] place-items-center rounded-[3px] text-[14px] font-bold text-[var(--muted-foreground)] hover:text-[var(--hud-gold)]">
      ?
    </button>
  );
}
