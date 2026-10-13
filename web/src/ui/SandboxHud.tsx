// Battle sandbox HUD. Edit: pick a side, its nation, order and veterancy, drag units from the palette onto the
// battlefield (or click a unit then click the field; right-click removes). Run: results readout, timeline
// (scrub, play, step, speed), back to edit, rerun, verify natively.

import { useMemo, useState } from "react";
import { Eraser, MousePointerClick, Pause, Play, Radio, RotateCcw, ShieldCheck, SkipBack, StepForward, Swords, Trash2, Undo2 } from "lucide-react";
import type { Game } from "../game";
import type { Sandbox, SandboxOrder } from "../sandbox";
import { useStore } from "../store";
import { SearchSelect, type Option } from "../components/ui/fields";
import { cn } from "../lib/utils";
import { CommandBar, GameMenu, SelectionPanel } from "./Hud";
import { Flag } from "./Flag";
import { GameButton } from "./kit/game";

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
        <GameButton size="sm" icon={<Eraser size={14} />} onClick={() => sandbox.clearSide(side)}>Clear side</GameButton>
        <GameButton size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => sandbox.clearSide(-1)}>Clear all</GameButton>
      </div>
      <GameButton variant="primary" size="lg" className="sb-fight" icon={<Swords size={18} />} onClick={() => sandbox.run()}>Fight</GameButton>
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
        <GameButton size="sm" icon={<Undo2 size={14} />} onClick={() => sandbox.backToEdit()}>Edit</GameButton>
        <GameButton size="sm" variant="primary" icon={<RotateCcw size={14} />} onClick={() => sandbox.run()}>Rerun</GameButton>
        <GameButton size="sm" icon={<ShieldCheck size={14} />} title="Replay this run headless in the native engine and compare SyncHash" onClick={() => game.requestVerify()}>Verify</GameButton>
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
  const live = st.replay === null;
  const running = live ? !st.paused : st.playing;
  const pct = len > 1 ? (pos / (len - 1)) * 100 : 100;
  return (
    <div className="rp-dock">
      <div className="rp-bar" role="group" aria-label="Battle timeline" data-ui-sfx>
        <button type="button" className="rp-btn" aria-label="Start" data-tip="Start" data-tip-pos="top" onClick={() => sandbox.scrub(0)}><SkipBack /></button>
        <button type="button" className={cn("rp-play", !running && "is-play")} aria-label={running ? "Pause" : "Play"} onClick={() => (live ? sandbox.setPaused(!st.paused) : st.playing ? sandbox.stopPlayback() : sandbox.playReplay())}>
          {running ? <Pause /> : <Play />}
        </button>
        <button type="button" className="rp-btn" aria-label="Step one tick" data-tip="Step one tick" data-tip-pos="top" onClick={() => sandbox.step()}><StepForward /></button>
        <div className="rp-track">
          <div className="rp-rail"><div className="rp-fill" style={{ width: `${pct}%` }} /></div>
          <input className="rp-range" type="range" min={0} max={Math.max(0, len - 1)} value={pos} onChange={(e) => sandbox.scrub(Number(e.target.value))} aria-label="Replay position" />
          <div className="rp-knob" style={{ left: `${pct}%` }} />
        </div>
        <span className="rp-time is-total" style={{ minWidth: 92 }}>{t(pos)} / {t(len)}</span>
        <div className="rp-speeds" role="radiogroup" aria-label="Playback speed">
          {[1, 2, 4].map((s) => (
            <button key={s} type="button" role="radio" aria-checked={st.speed === s} className="rp-speed" onClick={() => sandbox.setSpeed(s)}>{s}×</button>
          ))}
        </div>
        <GameButton size="sm" variant={live ? "primary" : "secondary"} icon={<Radio size={13} />} onClick={() => sandbox.goLive()} title={`Tick ${tick}`}>Live</GameButton>
      </div>
    </div>
  );
}

export function SandboxHud({ game }: { game: Game }) {
  const st = useStore((s) => s.sandbox);
  const sandbox = game.sandbox;
  if (!st || !sandbox) return null;
  return (
    <>
      <nav className="hud-bar" aria-label="Game controls" data-ui-sfx><GameMenu game={game} /></nav>
      {st.mode === "run" && (
        <div className="hud-console" style={{ bottom: 92 }}>
          <div className="hud-console-row">
            <SelectionPanel game={game} />
            <CommandBar game={game} />
          </div>
        </div>
      )}
      {st.mode === "run" && <Timeline sandbox={sandbox} />}
      {st.mode === "edit" && (
        <div className="sb-hint"><div className="hud-card">
          <MousePointerClick />{st.pickDestination !== null ? "Click the battlefield to set the destination" : st.brush ? "Click to place · right-click a unit to remove" : "Drag units onto the battlefield · right-click removes"}
        </div></div>
      )}
      <aside className={cn("hud-panel sb-side", st.mode === "run" && "is-run")} style={{ width: "var(--sidebar-w)" }} onContextMenu={(e) => e.preventDefault()}>
        <div className="sb-side-head">
          <b>Battle sandbox</b>
          <span className="menu-eyebrow">{st.mode === "edit" ? "Setup" : "Live sim"}</span>
        </div>
        {st.mode === "edit" ? <EditPanel game={game} sandbox={sandbox} /> : <Results game={game} sandbox={sandbox} />}
      </aside>
    </>
  );
}
