// The battle simulator's board (the Board button): what the old website Workshop showed beside its battlefield and the
// owner picked to keep (16 Nov 2026), on real engine numbers.
// - Readout (in battle): each side's units alive, health left, shots fired, damage dealt and units destroyed, as the
//   engine measures them (sim/OpenRA.WebSim/Sandbox.cs, ui.sandbox).
// - Who fell when (in battle): each unit lost, with the battle clock, newest first.
// - Field: everything both sides have on the battlefield, by type, one pip per unit (its health; crossed out when
//   destroyed). A pip or a row jumps the camera there and opens the unit's card (ui/Inspector.tsx).

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Skull, Swords, X } from "lucide-react";
import type { Game } from "../game";
import { useStore } from "../store";
import { battleStats } from "../sandbox";
import { SIDE_COLORS } from "../sides";
import { iconKey } from "../icon-key";
import { Flag } from "./Flag";

export interface FieldUnit { id: number; type: string; side: 0 | 1; hp: number; maxHp: number; x: number; y: number; dead: boolean; building: boolean }
interface Fallen { n: number; at: number; type: string; side: 0 | 1 }

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * Snapshot player index -> simulator side (0: you, side A; 1: the enemy, side B; -1: neither). The scenario's two
 * players are the world's first two playable ones, in slot order (sandbox.ts scenario).
 */
export function sidesOf(cur: { players: { flags: number }[] }) {
  let next = 0;
  return cur.players.map((p) => (p.flags & 4 && next < 2 ? next++ : -1));
}

/**
 * The two sides' actors on the field, read from the engine's snapshot four times a second. Units that leave the field
 * in battle stay listed as destroyed, and their loss is logged with the battle clock. A new world (setup, a run) starts over.
 */
export function useField(game: Game) {
  const info = useStore((s) => s.info);
  const mode = useStore((s) => s.sandbox?.mode);
  const roster = useRef(new Map<number, FieldUnit>());
  const [units, setUnits] = useState<FieldUnit[]>([]);
  const [fallen, setFallen] = useState<Fallen[]>([]);
  useEffect(() => {
    roster.current = new Map();
    setUnits([]);
    setFallen([]);
    if (!info) return;
    const read = () => {
      // The replay's moment while scrubbing: the field as it was then, without touching the battle's log of losses.
      const frame = game.sandbox?.replayFrame()?.[0];
      if (frame) {
        const sides = sidesOf(frame), alive = new Map<number, FieldUnit>();
        for (const a of frame.actors) {
          const side = sides[a.owner];
          if (side < 0 || a.maxHp <= 0 || a.flags & 16 || a.hp <= 0) continue;
          alive.set(a.id, { id: a.id, type: game.client.str(a.type), side: side as 0 | 1, hp: a.hp, maxHp: a.maxHp, x: a.sx, y: a.sy, dead: false, building: (a.flags & 8) !== 0 });
        }
        setUnits([...roster.current.values()].map((u) => alive.get(u.id) ?? { ...u, dead: true, hp: 0 }));
        return;
      }
      const cur = game.client.cur;
      if (!cur) return;
      const sideOf = sidesOf(cur);
      const seen = new Set<number>();
      const lost: Fallen[] = [];
      for (const a of cur.actors) {
        const side = sideOf[a.owner];
        if (side < 0 || a.maxHp <= 0) continue;
        const dead = (a.flags & 16) !== 0 || a.hp <= 0;
        const known = roster.current.get(a.id);
        if (dead) { if (known && !known.dead) { known.dead = true; known.hp = 0; lost.push({ n: seq++, at: elapsed(), type: known.type, side: known.side }); } continue; }
        seen.add(a.id);
        roster.current.set(a.id, { id: a.id, type: game.client.str(a.type), side: side as 0 | 1, hp: a.hp, maxHp: a.maxHp, x: a.sx, y: a.sy, dead: false, building: (a.flags & 8) !== 0 });
      }
      for (const u of roster.current.values()) {
        if (u.dead || seen.has(u.id)) continue;
        // Setup: a unit removed with a right-click simply goes. Battle: it fell.
        if (mode !== "run") { roster.current.delete(u.id); continue; }
        u.dead = true; u.hp = 0;
        lost.push({ n: seq++, at: elapsed(), type: u.type, side: u.side });
      }
      setUnits([...roster.current.values()]);
      if (lost.length) setFallen((f) => [...lost, ...f].slice(0, 60));
    };
    const elapsed = () => useStore.getState().ui?.sandbox?.elapsed ?? 0;
    let seq = 0;
    read();
    const t = setInterval(read, 250);
    return () => clearInterval(t);
  }, [game, info, mode]);
  // The replay's moment: only the losses up to then.
  const at = useStore((s) => (s.sandbox?.replay != null ? s.sandbox.replayStats?.elapsed ?? 0 : null));
  return { units, fallen: at === null ? fallen : fallen.filter((f) => f.at <= at + 0.05) };
}

/** Jump the camera to a unit on the field and open its card. */
export function focusUnit(game: Game, u: FieldUnit) {
  if (!u.dead) game.lookAt(u.x, u.y);
  useStore.getState().set({ inspect: u.id });
}

function Readout() {
  const stats = useStore(battleStats);
  const st = useStore((s) => s.sandbox)!;
  if (!stats) return null;
  const rows: [string, (s: NonNullable<typeof stats>["sides"][number]) => React.ReactNode][] = [
    ["Alive", (s) => <>{s.alive}<small>/{s.total}</small></>],
    ["Health", (s) => <span className="sb-bar"><i style={{ width: `${s.hpStart > 0 ? (s.hp / s.hpStart) * 100 : 0}%` }} /></span>],
    ["Shots", (s) => s.shots.toLocaleString()],
    ["Damage dealt", (s) => s.damageDealt.toLocaleString()],
    ["Destroyed", (s) => s.kills],
  ];
  return (
    <section className="sb-readout" aria-label="Battle readout">
      <div className="sb-readout-head"><span /><Flag id={st.fa} className="h-[14px] w-[22px] rounded-[1px]" /><Flag id={st.fb} className="h-[14px] w-[22px] rounded-[1px]" /></div>
      {rows.map(([label, value]) => (
        <div key={label} className="sb-readout-row">
          <span>{label}</span>
          {([0, 1] as const).map((i) => <b key={i} className="digits" style={{ "--side": SIDE_COLORS[i] } as CSSProperties}>{stats.sides[i] ? value(stats.sides[i]) : "–"}</b>)}
        </div>
      ))}
      <p className="sb-readout-foot digits">
        {clock(stats.elapsed)}
        {stats.firstKill !== null && <> · first loss {clock(stats.firstKill)}</>}
        {stats.sides.map((s, i) => s.eliminatedAt !== null && <span key={i}> · {i === 0 ? "you" : "enemy"} wiped out {clock(s.eliminatedAt)}</span>)}
      </p>
    </section>
  );
}

export function BattleBoard({ game }: { game: Game }) {
  const open = useStore((s) => s.board);
  const st = useStore((s) => s.sandbox)!;
  const icons = useStore((s) => s.icons);
  const inspect = useStore((s) => s.inspect);
  const { units, fallen } = useField(game);
  const run = st.mode === "run";
  const label = (type: string) => st.units.find((u) => u.name === type)?.label ?? type;
  const groups = useMemo(() => ([0, 1] as const).map((side) => {
    const byType = new Map<string, FieldUnit[]>();
    for (const u of units) if (u.side === side) byType.set(u.type, [...(byType.get(u.type) ?? []), u]);
    return [...byType.entries()].sort((a, b) => Number(a[1][0].building) - Number(b[1][0].building) || b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }), [units]);
  useEffect(() => {
    for (const side of [0, 1] as const) {
      const names = groups[side].map(([t]) => t);
      if (names.length) game.requestIcons(names, side === 0 ? st.fa : st.fb);
    }
  }, [game, groups, st.fa, st.fb]);
  if (!open || st.operation) return null;
  const faction = (side: 0 | 1) => (side === 0 ? st.fa : st.fb);
  return (
    <aside className="sb-board hud-panel" aria-label="Battle board" data-ui-sfx data-testid="battle-board" onContextMenu={(e) => e.preventDefault()}>
      <header className="sb-board-head">
        <b><Swords size={14} />{run ? "Battle" : "On the field"}</b>
        <button type="button" aria-label="Hide the battle board" onClick={() => useStore.getState().set({ board: false })}><X size={14} /></button>
      </header>
      {run && <Readout />}
      {run && fallen.length > 0 && (
        <section className="sb-fallen" aria-label="Who fell when">
          <p className="menu-eyebrow"><Skull size={11} />Who fell when</p>
          <ol>
            {fallen.map((f) => (
              <li key={f.n} style={{ "--side": SIDE_COLORS[f.side] } as CSSProperties}>
                <span className="digits">{clock(f.at)}</span><i aria-hidden="true" /><span>{label(f.type)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <section className="sb-field" aria-label="Everything on the field">
        {([0, 1] as const).map((side) => (
          <div key={side} className="sb-field-side" style={{ "--side": SIDE_COLORS[side] } as CSSProperties}>
            <p className="sb-field-title"><Flag id={faction(side)} className="h-[12px] w-[18px] rounded-[1px]" />{side === 0 ? "You" : "Enemy AI"}
              <span className="digits">{units.filter((u) => u.side === side && !u.dead).length}<small>/{units.filter((u) => u.side === side).length}</small></span></p>
            {groups[side].length === 0 && <p className="sb-field-empty">Nothing placed</p>}
            {groups[side].map(([type, list]) => {
              const alive = list.filter((u) => !u.dead);
              const icon = icons[iconKey(type, faction(side))];
              return (
                <div key={type} className={alive.length ? "sb-type" : "sb-type is-gone"}>
                  <button type="button" className="sb-type-main" onClick={() => focusUnit(game, alive[0] ?? list[0])} title={label(type)}>
                    <span className="sb-type-pic">{icon ? <img src={icon} alt="" draggable={false} /> : null}</span>
                    <span className="sb-type-name">{label(type)}</span>
                    <span className="digits sb-type-count">{alive.length}<small>/{list.length}</small></span>
                  </button>
                  <div className="sb-pips">
                    {list.map((u) => (
                      <button key={u.id} type="button" aria-label={`${label(type)} ${u.dead ? "destroyed" : `${Math.round((u.hp / u.maxHp) * 100)}% health`}`}
                        className={u.dead ? "sb-pip is-dead" : "sb-pip"} aria-pressed={inspect === u.id} onClick={() => focusUnit(game, u)}
                        style={{ "--hp": u.dead ? 0 : u.hp / u.maxHp } as CSSProperties} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </section>
    </aside>
  );
}
