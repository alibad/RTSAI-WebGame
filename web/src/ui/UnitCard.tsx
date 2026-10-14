// A unit or building as the battle simulator shows it while you pick: its picture, the catalog's story (data/factions.json,
// the same catalog the website's faction viewer reads) and the numbers from the rules this game actually runs (the
// engine's unitinfo: cost, health, armour, speed, each weapon's range, reload and damage).

import { useEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Coins, Crosshair, Eye, Gauge, Heart, Shield } from "lucide-react";
import type { Game } from "../game";
import type { SimUnit } from "../sandbox";
import { useStore } from "../store";
import catalog from "../data/factions.json";
import portraits from "../portraits.json";
import { ENGINE_SIDE_COLORS, SIDE_COLORS } from "../sides";
import { FactionViewerStage } from "./FactionViewerStage";

export interface UnitInfo {
  name: string; label: string; description: string; cost: number; hp: number; armor: string; speed: number; sight: number;
  weapons: { name: string; range: number; reload: number; burst: number; damage: number; targets: string[] }[];
}

type Story = { faction: string; name: string; role: string; story: string; strengths: string; counterplay: string };
const stories = (catalog as { units?: Record<string, Story> }).units ?? {};
const infos = new Map<string, Promise<UnitInfo>>();

/** The engine's numbers for an actor, asked once per page. */
export function unitInfo(game: Game, name: string) {
  let p = infos.get(name);
  if (!p) { p = game.command<UnitInfo>({ cmd: "unitinfo", type: name }); infos.set(name, p); }
  return p;
}

const KIND: Record<string, string> = { infantry: "Infantry", vehicle: "Vehicle", aircraft: "Aircraft", ship: "Ship", building: "Building", defense: "Defence" };

/** `pinned`: the unit picked to place (it stays, and its stage takes the mouse: turn it, play its actions). */
export function UnitCard({ game, unit, faction, side, pinned = false }: { game: Game; unit: SimUnit; faction: string; side: 0 | 1; pinned?: boolean }) {
  const icons = useStore((s) => s.icons);
  const [info, setInfo] = useState<UnitInfo | null>(null);
  useEffect(() => { let live = true; setInfo(null); void unitInfo(game, unit.name).then((i) => { if (live) setInfo(i); }); return () => { live = false; }; }, [game, unit.name]);
  const story = stories[unit.name];
  const portrait = (portraits as Record<string, { file: string }>)[unit.name]?.file;
  const weapons = info?.weapons.filter((w) => w.damage > 0) ?? [];
  // Over the battlefield, beside the panel it was picked in (a portal: the panel clips what overflows it).
  return createPortal(
    <div className={pinned ? "sim-card hud-panel is-pinned" : "sim-card hud-panel"} style={{ "--side": SIDE_COLORS[side] } as CSSProperties} data-testid="sim-card">
      <div className="sim-card-art">
        <FactionViewerStage unit={unit.name} faction={faction} color={ENGINE_SIDE_COLORS[side]} interactive={pinned} fallback={portrait ? `portraits/${portrait}` : icons[unit.name] ?? null} />
      </div>
      <div className="sim-card-body">
        <span className="menu-eyebrow">{story?.role ?? KIND[unit.kind] ?? unit.kind}</span>
        <h3>{story?.name ?? info?.label ?? unit.label}</h3>
        {(story?.story || info?.description) && <p>{story?.story ?? info?.description.split("\n")[0]}</p>}
        <dl className="sim-card-stats digits">
          <div title="Cost"><Coins size={13} /><dd>{(info?.cost ?? unit.cost).toLocaleString()}</dd></div>
          {info && info.hp > 0 && <div title="Health"><Heart size={13} /><dd>{info.hp}</dd></div>}
          {info?.armor && <div title="Armour"><Shield size={13} /><dd>{info.armor}</dd></div>}
          {info && info.speed > 0 && <div title="Speed"><Gauge size={13} /><dd>{info.speed}</dd></div>}
          {info && info.sight > 0 && <div title="Sight (cells)"><Eye size={13} /><dd>{info.sight}</dd></div>}
        </dl>
        {weapons.length > 0 && <ul className="sim-card-weapons">
          {weapons.slice(0, 3).map((w) => (
            <li key={w.name}><Crosshair size={12} /><b>{w.name}</b><span className="digits">{w.damage}{w.burst > 1 ? `×${w.burst}` : ""} · {w.range} cells · {(w.reload / 25).toFixed(1)}s</span><small>{w.targets.join(", ")}</small></li>
          ))}
        </ul>}
        {story?.strengths && <p className="sim-card-tip">{story.strengths}</p>}
      </div>
    </div>,
    document.body,
  );
}
