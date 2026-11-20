// One unit's what-ifs, on its card in the simulator's setup (ui/Inspector.tsx): another rank, less health, the other
// team, an opening order of its own (it outranks its side's), one more of the same, or off the field. Each change is
// one undo step (sandbox.ts changeUnit, duplicateUnit, setUnitOrder).
// The owner's pick from the old website Workshop (16 Nov 2026): "per-unit what-ifs". Not here yet, because they need
// the engine: switching a building's power off, and weapon bonuses.

import { useEffect, useState, type CSSProperties } from "react";
import { Copy, Crosshair, MapPin, Shield, Trash2, Users } from "lucide-react";
import type { PlacedUnit, Sandbox, SandboxOrder } from "../sandbox";
import { useStore } from "../store";
import { SIDE_COLORS } from "../sides";
import { Rank } from "./Hud";
import "./maker.css";

const RANKS = ["Rookie", "Veteran", "Elite"];

export function UnitWhatIfs({ sandbox, id, building }: { sandbox: Sandbox; id: number; building: boolean }) {
  const orders = useStore((s) => s.sandbox?.unitOrders);
  const picking = useStore((s) => s.sandbox?.pickUnit === id);
  const sides = useStore((s) => s.sandbox?.sides);
  const [unit, setUnit] = useState<PlacedUnit | null>(null);
  const [health, setHealth] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setHealth(null);
    void sandbox.unit(id).then((u) => { if (live) setUnit(u); });
    return () => { live = false; };
  }, [sandbox, id, orders]);
  if (!unit || unit.id !== id) return null;
  const inspect = (next: number | null) => { if (next !== null) useStore.getState().set({ inspect: next }); };
  const change = async (c: Parameters<Sandbox["changeUnit"]>[1]) => { if (busy) return; setBusy(true); try { inspect(await sandbox.changeUnit(id, c)); } finally { setBusy(false); } };
  const own = unit.own?.order ?? null;
  const sideOrder = sides?.[unit.side].order ?? "engage";
  const shown = health ?? unit.health;
  const order = (o: SandboxOrder | null) => { if (o === "move") sandbox.pickUnitDestination(id); else void sandbox.setUnitOrder(id, o); };
  return (
    <div className="wi" data-testid="unit-whatifs" aria-busy={busy} style={{ "--side": SIDE_COLORS[unit.side] } as CSSProperties}>
      <div className="wi-row">
        <span className="wi-label">Rank</span>
        <div className="wi-seg" role="radiogroup" aria-label="This unit's rank">
          {[0, 1, 2].map((n) => <button key={n} type="button" role="radio" aria-checked={unit.level === n} title={RANKS[n]} aria-label={RANKS[n]} disabled={building} onClick={() => void change({ level: n })} data-rank={n}>{n ? <Rank rank={n} /> : "New"}</button>)}
        </div>
      </div>
      <div className="wi-row">
        <span className="wi-label">Health</span>
        <input className="wi-range" type="range" min={10} max={100} step={5} value={shown} aria-label="This unit's health, percent" style={{ "--v": `${(shown - 10) / 90 * 100}%` } as CSSProperties}
          onChange={(e) => setHealth(Number(e.target.value))}
          onPointerUp={() => { if (health !== null && health !== unit.health) void change({ health }); }}
          onKeyUp={(e) => { if (e.key.startsWith("Arrow") && health !== null && health !== unit.health) void change({ health }); }} data-testid="wi-health" />
        <span className="digits wi-value">{shown}%</span>
      </div>
      <div className="wi-row">
        <span className="wi-label">Team</span>
        <div className="wi-seg" role="radiogroup" aria-label="Whose unit this is">
          <button type="button" role="radio" aria-checked={unit.side === 0} onClick={() => { if (unit.side !== 0) void change({ side: 0 }); }} data-team="0"><Users size={12} />Yours</button>
          <button type="button" role="radio" aria-checked={unit.side === 1} onClick={() => { if (unit.side !== 1) void change({ side: 1 }); }} data-team="1"><Shield size={12} />Enemy</button>
        </div>
      </div>
      {!building && <div className="wi-row is-order">
        <span className="wi-label">First order</span>
        <div className="wi-seg" role="radiogroup" aria-label="This unit's own first order">
          <button type="button" role="radio" aria-checked={own === null} title={`Does what its side does: ${sideOrder}`} onClick={() => order(null)} data-order="side">As its side</button>
          <button type="button" role="radio" aria-checked={own === "engage"} title="Attack-move to the enemy" onClick={() => order("engage")} data-order="engage"><Crosshair size={12} />Engage</button>
          <button type="button" role="radio" aria-checked={own === "hold"} title="Stay and defend" onClick={() => order("hold")} data-order="hold">Hold</button>
          <button type="button" role="radio" aria-checked={own === "move" || picking} title="Move to a point: click the battlefield" onClick={() => order("move")} data-order="move"><MapPin size={12} />{picking ? "Click map" : "Move"}</button>
        </div>
      </div>}
      <div className="wi-acts">
        <button type="button" onClick={() => { if (!busy) void sandbox.duplicateUnit(id).then(inspect); }} data-testid="wi-duplicate"><Copy size={13} />Duplicate</button>
        <button type="button" className="is-danger" onClick={() => { useStore.getState().set({ inspect: null }); void sandbox.remove(id); }} data-testid="wi-remove"><Trash2 size={13} />Remove</button>
      </div>
    </div>
  );
}
