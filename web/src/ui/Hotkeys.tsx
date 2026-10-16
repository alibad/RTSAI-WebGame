// Hotkey sheet (? or the ? button): every key the page binds, grouped, with the same icons as the buttons. These are
// Red Alert 2's keyboard commands (the RA2 manual) for everything this game has, plus the OpenRA chrome's keys RA2
// leaves free (game.ts keyDown); a key the browser keeps for itself (Ctrl+W, Ctrl+F4, Ctrl+Tab in a tab, F11, F12) is
// not listed. A row whose keys are a command shows the player's own binding (Game settings).

import { CircleHelp, Crosshair, Hammer, Layers, Monitor, MousePointer2, Gamepad2 } from "lucide-react";
import { useStore } from "../store";
import { companionDeveloperTools } from "../companion-policy";
import { keyFor, type Command } from "../preferences";
import { GameDialog, GameSection, Kbd } from "./kit/game";
import { AttackMoveIcon, DeployIcon, GuardIcon, RepairIcon, ScatterIcon, SellIcon, StopIcon } from "./icons";

type Row = [keys: string[] | Command, label: string, Icon?: (p: React.SVGProps<SVGSVGElement>) => React.JSX.Element];

const GROUPS: [string, React.ReactNode, Row[]][] = [
  ["Units", <Crosshair size={14} />, [
    ["deploy", "Deploy (also: leave a building or transport)", DeployIcon],
    ["guard", "Guard", GuardIcon],
    ["stop", "Stop", StopIcon],
    ["scatter", "Scatter", ScatterIcon],
    [["Ctrl", "⇧", "click"], "Attack move", AttackMoveIcon],
    ["attackmove", "Attack move, then click", AttackMoveIcon],
    [["Ctrl", "click"], "Force fire"],
    [["Alt", "click"], "Force move"],
    [["Z", "hold"], "Way points: hold Z and right-click each point"],
    [["⇧", "click"], "Queue orders (⇧D, ⇧X too)"],
    [["Alt", "A S D F"], "Stance: attack · defend · return fire · hold"],
  ]],
  ["Select", <MousePointer2 size={14} />, [
    ["selectall", "Every unit on the battlefield"],
    ["typeselect", "Same type on screen (twice: the whole map)"],
    [["⇧", "click"], "Add or remove a unit"],
    [["F"], "Follow the selected unit (F again: stop)"],
    [["H"], "Centre on your base"],
    [["N"], "Next harvester"],
    [["Home"], "Jump to selection"],
    [["Space"], "Jump to the latest radar event"],
  ]],
  ["Teams", <Layers size={14} />, [
    [["1–0"], "Select team (twice: jump)"],
    [["Ctrl", "1–0"], "Create team"],
    [["Ctrl", "⇧", "1–0"], "Add selection"],
    [["⇧", "1–0"], "Combine with selection"],
    [["Alt", "1–0"], "Jump to"],
  ]],
  ["Build", <Hammer size={14} />, [
    [["Q W E R"], "Structures · armory · infantry · units (R again: aircraft, ships)"],
    ["repair", "Repair", RepairIcon],
    ["sell", "Sell", SellIcon],
    [["B"], "Place a beacon"],
    [["RMB"], "Hold, then cancel"],
  ]],
  ["View", <Monitor size={14} />, [
    [["↑ ↓ ← →"], "Scroll (Alt: to the map edge)"],
    [["F1–F4"], "Go to bookmark"],
    [["Ctrl", "F1–F3"], "Save bookmark (or Ctrl+Q E R; Alt+Q W E R goes back)"],
    [["[", "]"], "Zoom out · in"],
    [["."], "Reset zoom"],
    [[","], "Health bars: selected · damaged · all"],
    [["⇧", "="], "Hide the interface"],
  ]],
  ["Game", <Gamepad2 size={14} />, [
    [["Esc"], "Options menu, pauses (first: cancel a mode)"],
    [["Pause"], "Pause"],
    [["M"], "Mute"],
    [["?"], "This sheet"],
    [["J"], "Apply the adviser's recommended order (Ctrl+⌫ reject)"],
    ...(companionDeveloperTools ? [
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
                <span className="hk-keys">{typeof keys === "string" ? <Kbd>{keyFor(keys).toUpperCase()}</Kbd> : keys.map((k) => k === "or" ? <i key={k}>or</i> : <Kbd key={k}>{k}</Kbd>)}</span>
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
