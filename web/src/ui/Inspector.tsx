// The battle simulator's card for one unit or building on the field (owner's pick, 16 Nov 2026: the old Workshop's
// "Inspect" panel). Click it on the battlefield, or in the battle board's list, in setup or in battle. It is the same card
// the palette shows (UnitCard: picture, story, the engine's cost, health, armour, speed, sight and weapons with their
// range, reload, damage and what they can hit), with what this one is doing now: its health left, its rank, and in
// battle what its type has done (shots fired, damage taken, how many are left). Its weapon reach is drawn on the ground
// (Renderer.drawReach). The card stays on a destroyed unit and says so.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Crosshair, HeartCrack, Skull, X } from "lucide-react";
import type { Game } from "../game";
import { battleStats, type SimUnit } from "../sandbox";
import { useStore } from "../store";
import { UnitCard } from "./UnitCard";
import { Rank } from "./Hud";
import { sidesOf } from "./BattleBoard";
import { UnitWhatIfs } from "./UnitWhatIfs";

interface Seen { id: number; type: string; side: 0 | 1; hp: number; maxHp: number; rank: number; building: boolean; dead: boolean }

export function Inspector({ game }: { game: Game }) {
  const id = useStore((s) => s.inspect);
  const st = useStore((s) => s.sandbox)!;
  const info = useStore((s) => s.info);
  const types = useStore((s) => battleStats(s)?.types);
  // The victory or defeat screen covers the battle: the card steps aside with it.
  const over = useStore((s) => s.ui?.win === "Won" || s.ui?.win === "Lost");
  const last = useRef<Seen | null>(null);
  const [seen, setSeen] = useState<Seen | null>(null);
  useEffect(() => {
    last.current = null;
    setSeen(null);
    if (id === null || !info) return;
    const read = () => {
      // The replay's moment while scrubbing, else the live battle.
      const cur = game.sandbox?.replayFrame()?.[0] ?? game.client.cur;
      const a = cur?.actorById.get(id);
      const side = a ? sidesOf(cur!)[a.owner] : -1;
      if (a && (side === 0 || side === 1) && !(a.flags & 16) && a.hp > 0) {
        last.current = { id, type: game.client.str(a.type), side, hp: a.hp, maxHp: a.maxHp, rank: a.rank, building: (a.flags & 8) !== 0, dead: false };
      } else if (last.current) last.current = { ...last.current, hp: 0, dead: true };
      else return;
      setSeen({ ...last.current });
    };
    read();
    const t = setInterval(read, 200);
    return () => clearInterval(t);
  }, [game, id, info]);
  if (id === null || !seen || over) return null;
  const unit: SimUnit = st.units.find((u) => u.name === seen.type)
    ?? { name: seen.type, label: seen.type, queue: "", kind: seen.building ? "building" : "vehicle", cost: 0, modern: false };
  const faction = seen.side === 0 ? st.fa : st.fb;
  const f = seen.maxHp > 0 ? seen.hp / seen.maxHp : 0;
  const stat = st.mode === "run" ? types?.find((t) => t.side === seen.side && t.type === seen.type) : undefined;
  return (
    <UnitCard game={game} unit={unit} faction={faction} side={seen.side} className="is-inspect">
      <div className="sim-inspect" data-testid="sim-inspect">
        <button type="button" className="sim-inspect-close" aria-label="Close the card" onClick={() => useStore.getState().set({ inspect: null })}><X size={14} /></button>
        <p className="menu-eyebrow">{seen.side === 0 ? "Yours" : "Enemy"}{seen.rank > 0 && <Rank rank={seen.rank} />}</p>
        {seen.dead
          ? <p className="sim-inspect-dead"><Skull size={14} />Destroyed</p>
          : <div className="sim-inspect-hp" style={{ "--hp": f } as CSSProperties}>
              <span className="sb-bar"><i style={{ width: `${f * 100}%` }} /></span>
              <span className="digits">{seen.hp.toLocaleString()}<small> / {seen.maxHp.toLocaleString()}</small></span>
            </div>}
        {/* In the setup this one unit can be changed: rank, health, team, its own first order, a copy (UnitWhatIfs). */}
        {st.mode === "edit" && !seen.dead && game.sandbox && <UnitWhatIfs sandbox={game.sandbox} id={seen.id} building={seen.building} />}
        {stat && (
          <dl className="sim-inspect-type digits" aria-label={`Every ${unit.label} on this side`}>
            <div title="Shots fired by this type"><Crosshair size={12} /><dd>{stat.shots.toLocaleString()}</dd><dt>shots</dt></div>
            <div title="Damage this type has taken"><HeartCrack size={12} /><dd>{stat.damageTaken.toLocaleString()}</dd><dt>taken</dt></div>
            <div title="How many of this type are left"><dd>{stat.alive}<small>/{stat.total}</small></dd><dt>left</dt></div>
          </dl>
        )}
      </div>
    </UnitCard>
  );
}
