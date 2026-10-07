// Battle sandbox HUD. Edit: pick a side, its nation, order and veterancy, drag units from the palette onto the
// battlefield (or click a unit then click the field; right-click removes). Run: results readout, timeline
// (scrub, play, step, speed), back to edit, rerun, verify natively.

import { useMemo, useState } from "react";
import type { Game } from "../game";
import type { Sandbox, SandboxOrder } from "../sandbox";
import { useStore } from "../store";
import { Button } from "../components/ui/button";
import { SearchSelect, type Option } from "../components/ui/fields";
import { cn } from "../lib/utils";
import { CommandBar, GameMenu, SelectionPanel } from "./Hud";
import { Flag } from "./Flag";

const SIDE_COLORS = ["#2A6FDB", "#D83A2E"];

function Chevrons({ n }: { n: number }) {
  if (n <= 0) return <span className="text-[11px] text-[var(--muted-foreground)]">–</span>;
  return (
    <svg viewBox="0 0 16 16" width={14} height={14}>
      {Array.from({ length: n }, (_, i) => (
        <path key={i} d={`M2 ${11 - i * 5} L8 ${6 - i * 5} L14 ${11 - i * 5}`} fill="none" stroke={n >= 2 ? "#ff8a3d" : "var(--hud-gold)"} strokeWidth="2.4" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: React.ReactNode; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="hud-inset flex p-[2px]">
      {options.map((o) => (
        <button key={String(o.value)} type="button" title={o.title} onClick={() => onChange(o.value)}
          className={cn("grid h-[26px] flex-1 place-items-center rounded-[2px] px-2 text-[12px] text-[var(--muted-foreground)]",
            value === o.value && "bg-[rgba(241,210,139,0.14)] text-[var(--hud-gold)] shadow-[inset_0_0_0_1px_var(--hud-gold-dim)]")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function EditPanel({ game, sandbox }: { game: Game; sandbox: Sandbox }) {
  const st = useStore((s) => s.sandbox)!;
  const icons = useStore((s) => s.icons);
  const setup = useStore((s) => s.setup);
  const set = useStore((s) => s.set);
  const [query, setQuery] = useState("");
  const patch = (p: Partial<typeof st>) => set({ sandbox: { ...st, ...p } });
  const side = st.side;
  const settings = st.sides[side];
  const setSide = (p: Partial<typeof settings>) => {
    const sides = [...st.sides] as typeof st.sides;
    sides[side] = { ...settings, ...p };
    patch({ sides });
  };
  const nations: Option[] = useMemo(() => (setup?.factions ?? []).filter((f) => !f.random).map((f) => ({
    value: f.id, label: f.name, leading: <Flag id={f.id} className="h-[12px] w-[18px] rounded-[1px]" />,
  })), [setup]);
  const units = st.units.filter((u) => !query || u.label.toLowerCase().includes(query.toLowerCase()) || u.name.includes(query.toLowerCase()))
    .sort((a, b) => Number(b.modern) - Number(a.modern) || a.queue.localeCompare(b.queue) || a.label.localeCompare(b.label));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        {([0, 1] as const).map((s) => (
          <button key={s} type="button" onClick={() => patch({ side: s })}
            className={cn("hud-inset flex flex-col items-center gap-1 p-2 transition", side === s ? "shadow-[inset_0_0_0_2px_var(--hud-gold)]" : "opacity-70 hover:opacity-100")}>
            <Flag id={s === 0 ? st.fa : st.fb} className="h-[30px] w-[50px] rounded-[1px] shadow-[0_0_0_1px_#000]" />
            <span className="h-[3px] w-full" style={{ background: SIDE_COLORS[s] }} />
          </button>
        ))}
      </div>
      <SearchSelect size="sm" value={side === 0 ? st.fa : st.fb} onValueChange={(v) => sandbox.setFaction(side, v)} options={nations} aria-label="Nation" />
      <Seg<SandboxOrder> value={settings.order} onChange={(order) => {
        if (order === "move") patch({ pickDestination: side, sides: Object.assign([...st.sides], { [side]: { ...settings, order } }) as typeof st.sides });
        else setSide({ order });
      }} options={[
        { value: "engage", label: "Engage", title: "Attack-move to the enemy" },
        { value: "hold", label: "Hold", title: "Stay and defend" },
        { value: "move", label: st.pickDestination === side ? "Click map" : "Move", title: "Move to a point (click the battlefield)" },
      ]} />
      <div className="grid grid-cols-2 gap-2">
        <Seg<number> value={settings.level} onChange={(level) => setSide({ level })} options={[0, 1, 2].map((n) => ({ value: n, label: <Chevrons n={n} />, title: ["Rookie", "Veteran", "Elite"][n] }))} />
        <Seg<number> value={st.count} onChange={(count) => patch({ count })} options={[1, 3, 5, 10].map((n) => ({ value: n, label: `×${n}` }))} />
      </div>
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a unit…"
        className="h-8 rounded-md border border-input bg-field px-2.5 text-[13px] outline-none focus-visible:border-ring" />
      <div className="no-scrollbar grid min-h-0 flex-1 auto-rows-[72px] content-start grid-cols-3 gap-[3px] overflow-y-auto">
        {units.map((u) => (
          <button key={u.name} type="button" title={u.label} draggable
            onDragStart={(e) => { e.dataTransfer.setData("application/x-rtsai-unit", u.name); e.dataTransfer.effectAllowed = "copy"; }}
            onClick={() => patch({ brush: st.brush === u.name ? null : u.name })}
            className={cn("cameo hud-inset", st.brush === u.name && "ring-2 ring-[var(--hud-gold)]")}>
            {icons[u.name] ? <img src={icons[u.name]!} alt="" draggable={false} /> : <div className="grid h-full place-items-center px-1 text-center text-[9px] leading-tight text-[var(--muted-foreground)]">{u.label}</div>}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" size="sm" onClick={() => sandbox.clearSide(side)}>Clear side</Button>
        <Button variant="outline" size="sm" onClick={() => sandbox.clearSide(-1)}>Clear all</Button>
      </div>
      <Button size="lg" onClick={() => sandbox.run()}
        className="h-[42px] rounded-[3px] bg-[linear-gradient(180deg,#f6dc9c,#c9a253)] text-[15px] font-bold uppercase tracking-[0.18em] text-[#1a160c] hover:brightness-110">
        Fight
      </Button>
    </div>
  );
}

function Results({ game, sandbox }: { game: Game; sandbox: Sandbox }) {
  const stats = useStore((s) => s.ui?.sandbox);
  const st = useStore((s) => s.sandbox)!;
  const icons = useStore((s) => s.icons);
  const verify = useStore((s) => s.verify);
  const fmt = (v: number | null | undefined) => (v == null ? "–" : `${v.toFixed(1)}s`);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        {([0, 1] as const).map((s) => {
          const side = stats?.sides[s];
          const hpf = side && side.hpStart > 0 ? side.hp / side.hpStart : 0;
          return (
            <div key={s} className="hud-inset flex flex-col gap-1 p-2">
              <div className="flex items-center justify-between">
                <Flag id={s === 0 ? st.fa : st.fb} className="h-[20px] w-[32px] rounded-[1px]" />
                <span className="digits text-[20px] font-bold" style={{ color: SIDE_COLORS[s] }}>{side?.alive ?? 0}<span className="text-[12px] text-[var(--muted-foreground)]">/{side?.total ?? 0}</span></span>
              </div>
              <div className="h-[5px] bg-black/80 p-[1px]"><div className="h-full" style={{ width: `${hpf * 100}%`, background: SIDE_COLORS[s] }} /></div>
              <dl className="digits grid grid-cols-[1fr_auto] gap-x-2 text-[11px]">
                <dt className="text-[var(--muted-foreground)]">Shots</dt><dd className="m-0 text-right">{side?.shots ?? 0}</dd>
                <dt className="text-[var(--muted-foreground)]">Kills</dt><dd className="m-0 text-right">{side?.kills ?? 0}</dd>
                <dt className="text-[var(--muted-foreground)]">Damage</dt><dd className="m-0 text-right">{side?.damageDealt ?? 0}</dd>
                <dt className="text-[var(--muted-foreground)]">Wiped out</dt><dd className="m-0 text-right">{fmt(side?.eliminatedAt)}</dd>
              </dl>
            </div>
          );
        })}
      </div>
      <div className="digits flex justify-between px-1 text-[11px] text-[var(--muted-foreground)]">
        <span>First kill {fmt(stats?.firstKill)}</span><span>Time {fmt(stats?.elapsed)}</span>
      </div>
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
        <table className="digits w-full text-[11px]">
          <tbody>
            {stats?.types.map((t) => (
              <tr key={`${t.side}-${t.type}`} className="border-b border-white/5">
                <td className="w-[46px] py-[2px]"><div className="cameo w-[42px]" style={{ boxShadow: `inset 0 -2px 0 ${SIDE_COLORS[t.side]}` }}>{icons[t.type] ? <img src={icons[t.type]!} alt="" /> : null}</div></td>
                <td className="text-right">{t.alive}/{t.total}</td>
                <td className="text-right text-[var(--muted-foreground)]" title="Shots">{t.shots}</td>
                <td className="text-right text-[var(--muted-foreground)]" title="Damage taken">-{t.damageTaken}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid grid-cols-3 gap-1">
        <Button size="sm" variant="outline" onClick={() => sandbox.backToEdit()}>Edit</Button>
        <Button size="sm" variant="outline" onClick={() => sandbox.run()}>Rerun</Button>
        <Button size="sm" variant="outline" title="Replay this run headless in the native engine and compare SyncHash" onClick={() => game.requestVerify()}>Verify</Button>
      </div>
      {verify && <p className={cn("m-0 text-[11px]", verify.startsWith("Identical") ? "text-[var(--hud-green)]" : "text-[var(--muted-foreground)]")}>{verify}</p>}
    </div>
  );
}

function Timeline({ sandbox }: { sandbox: Sandbox }) {
  const st = useStore((s) => s.sandbox)!;
  const tick = useStore((s) => s.perf.tick);
  const len = st.recordLen;
  const pos = st.replay ?? Math.max(0, len - 1);
  const t = (i: number) => (i * 0.04).toFixed(1) + "s";
  const icon = (d: string) => <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor"><path d={d} /></svg>;
  const live = st.replay === null;
  const running = live ? !st.paused : st.playing;
  return (
    <div className="hud-panel absolute bottom-3 left-1/2 flex w-[min(720px,calc(100vw-var(--sidebar-w)-280px))] -translate-x-1/2 items-center gap-2 px-3 py-2" style={{ marginLeft: "calc(var(--sidebar-w) / -2)" }}>
      <Button size="icon-sm" variant="ghost" title="Start" onClick={() => sandbox.scrub(0)}>{icon("M6 5h2v14H6Zm3 7 9-7v14Z")}</Button>
      <Button size="icon-sm" variant="ghost" title={running ? "Pause" : "Play"} onClick={() => (live ? sandbox.setPaused(!st.paused) : st.playing ? sandbox.stopPlayback() : sandbox.playReplay())}>
        {running ? icon("M7 5h4v14H7Zm6 0h4v14h-4Z") : icon("M7 5v14l11-7Z")}
      </Button>
      <Button size="icon-sm" variant="ghost" title="Step one tick" onClick={() => sandbox.step()}>{icon("M6 5v14l9-7Zm10 0h2v14h-2Z")}</Button>
      <input type="range" min={0} max={Math.max(0, len - 1)} value={pos} onChange={(e) => sandbox.scrub(Number(e.target.value))}
        className="h-1 flex-1 cursor-pointer accent-[var(--hud-gold)]" aria-label="Replay position" />
      <span className="digits w-[92px] text-right text-[11px] text-[var(--muted-foreground)]">{t(pos)} / {t(len)}</span>
      <div className="hud-inset flex p-[2px]">
        {[1, 2, 4].map((s) => (
          <button key={s} type="button" onClick={() => sandbox.setSpeed(s)} className={cn("h-[22px] px-1.5 text-[11px] text-[var(--muted-foreground)]", st.speed === s && "text-[var(--hud-gold)]")}>{s}×</button>
        ))}
      </div>
      <Button size="xs" variant={live ? "secondary" : "outline"} onClick={() => sandbox.goLive()} title={`Tick ${tick}`}>Live</Button>
    </div>
  );
}

export function SandboxHud({ game }: { game: Game }) {
  const st = useStore((s) => s.sandbox);
  const sandbox = game.sandbox;
  if (!st || !sandbox) return null;
  return (
    <>
      <div className="absolute left-3 top-3 flex items-center gap-2"><GameMenu game={game} /></div>
      {st.mode === "run" && (
        <div className="pointer-events-none absolute bottom-[64px] left-3 flex items-end gap-2 [&>*]:pointer-events-auto">
          <SelectionPanel game={game} />
          <CommandBar game={game} />
        </div>
      )}
      {st.mode === "run" && <Timeline sandbox={sandbox} />}
      {st.mode === "edit" && (
        <div className="hud-panel pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 px-3 py-1.5 text-[12px] text-[var(--muted-foreground)]" style={{ marginLeft: "calc(var(--sidebar-w) / -2)" }}>
          {st.pickDestination !== null ? "Click the battlefield to set the destination" : st.brush ? "Click to place · right-click a unit to remove" : "Drag units onto the battlefield · right-click removes"}
        </div>
      )}
      <aside className="hud-panel absolute right-0 top-0 flex h-full flex-col gap-2 p-[10px]" style={{ width: "var(--sidebar-w)" }} onContextMenu={(e) => e.preventDefault()}>
        <div className="flex items-baseline justify-between">
          <span className="text-[15px] font-black tracking-wide text-[var(--hud-gold)]">Battle sandbox</span>
          <span className="text-[10px] uppercase tracking-widest text-[var(--muted-foreground)]">{st.mode === "edit" ? "Setup" : "Live sim"}</span>
        </div>
        {st.mode === "edit" ? <EditPanel game={game} sandbox={sandbox} /> : <Results game={game} sandbox={sandbox} />}
      </aside>
    </>
  );
}
