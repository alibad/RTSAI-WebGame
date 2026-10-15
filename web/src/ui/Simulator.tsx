// Battle simulator. Setup: pick any map (or make a random one), your nation and the enemy's with its AI skill, then drag
// anything from your nation's roster onto the battlefield (units, buildings, defences; right-click removes), or
// describe the battle in words. Fight: the real engine runs it; you command your side with the full game HUD while the
// engine's bot plays the enemy. A timeline records the battle for scrubbing; Edit goes back to the setup.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Anchor, ArrowLeft, Building2, Castle, Coins, Diamond, Eraser, EyeOff, Map as MapIcon, MousePointerClick, Pause, Plane, Play, Radio, RotateCcw, Shield, ShieldCheck, SkipBack, Sparkles, StepForward, Swords, Target, Trash2, Truck, Undo2, Users, X } from "lucide-react";
import type { Game } from "../game";
import { AI_SKILLS, type AiSkill, type Sandbox, type SandboxOrder, type SimUnit } from "../sandbox";
import { planBattle } from "../battle-plan";
import { useStore } from "../store";
import { SearchSelect, type Option } from "../components/ui/fields";
import { cn } from "../lib/utils";
import { SIDE_COLORS, nationGroup, playableNations } from "../sides";
import { GameMenu, Hud, Rank } from "./Hud";
import { Flag } from "./Flag";
import { GameButton } from "./kit/game";
import { MapStrip } from "./MapStrip";
import { UnitCard } from "./UnitCard";
import { iconKey } from "../icon-key";

const KINDS: { id: string; label: string; icon: React.ReactNode }[] = [
  { id: "infantry", label: "Infantry", icon: <Users size={15} /> },
  { id: "vehicle", label: "Vehicles", icon: <Truck size={15} /> },
  { id: "aircraft", label: "Aircraft", icon: <Plane size={15} /> },
  { id: "ship", label: "Ships", icon: <Anchor size={15} /> },
  { id: "building", label: "Buildings", icon: <Building2 size={15} /> },
  { id: "defense", label: "Defences", icon: <Castle size={15} /> },
];
const MONEY = [0, 5000, 10000, 25000];

/** A mission from a real place (mission.ts): its briefing and objectives before the battle; it can go back to a free battle. */
function OperationCard({ sandbox }: { sandbox: Sandbox }) {
  const op = useStore((s) => s.sandbox?.operation);
  if (!op) return null;
  const [summary, ...rest] = op.situation.length > 2 ? op.situation : ["", ...op.situation];
  return (
    <section className="sim-op hud-inset" aria-label="Operation briefing" data-testid="sim-operation">
      <header><Target size={14} aria-hidden="true" /><span className="menu-eyebrow">Operation</span>
        <button type="button" onClick={() => sandbox.dropOperation()} title="Keep the forces, drop the objectives">Free battle</button></header>
      <h3>{op.title}</h3>
      {rest.map((p, i) => <p key={i}>{p}</p>)}
      {summary && <details><summary>About the place</summary><p>{summary}</p></details>}
      <ul aria-label="Objectives">
        {op.objectives.map((o, i) => <li key={i} data-bonus={o.secondary || undefined}><Diamond size={9} aria-hidden="true" />{o.text}{o.secondary && <em>Bonus</em>}</li>)}
      </ul>
    </section>
  );
}

function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: React.ReactNode; title?: string }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="hud-inset flex p-[2px]" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={value === o.value} title={o.title} onClick={() => onChange(o.value)}
          className={cn("grid h-[26px] flex-1 place-items-center rounded-[2px] px-2 text-[12px] text-[var(--muted-foreground)]",
            value === o.value && "bg-[rgba(241,210,139,0.14)] text-[var(--hud-gold)] shadow-[inset_0_0_0_1px_var(--hud-gold-dim)]")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The battlefield: its preview and name; Change opens the map strip (any map, or a new random one). */
function MapCard({ game, sandbox }: { game: Game; sandbox: Sandbox }) {
  const st = useStore((s) => s.sandbox)!;
  const setup = useStore((s) => s.setup);
  const previews = useStore((s) => s.previews);
  const [open, setOpen] = useState(false);
  const map = setup?.maps.find((m) => m.id === st.map);
  useEffect(() => { game.preview(st.map); }, [game, st.map]);
  return (
    <>
      <button type="button" className="sim-map hud-inset" onClick={() => setOpen(true)} data-testid="sim-map">
        <span className="sim-map-art">{previews[st.map] ? <img src={previews[st.map]} alt="" draggable={false} /> : <MapIcon size={22} />}</span>
        <span className="sim-map-text"><span className="menu-eyebrow">Battlefield</span><b>{map?.title ?? "Open arena"}</b></span>
        <span className="sim-map-change">Change</span>
      </button>
      {open && (
        <div className="sim-maps" role="dialog" aria-label="Choose a battlefield" onClick={() => setOpen(false)}>
          <div className="sim-maps-panel hud-panel" onClick={(e) => e.stopPropagation()}>
            <header><b>Choose a battlefield</b><button type="button" aria-label="Close" onClick={() => setOpen(false)}><X size={16} /></button></header>
            <MapStrip game={game} value={st.map} onChange={(id) => { setOpen(false); sandbox.setMap(id); }} className="sim-maps-grid" />
          </div>
        </div>
      )}
    </>
  );
}

function EditPanel({ game, sandbox }: { game: Game; sandbox: Sandbox }) {
  const st = useStore((s) => s.sandbox)!;
  const icons = useStore((s) => s.icons);
  const phase = useStore((s) => s.phase);
  const setup = useStore((s) => s.setup);
  const set = useStore((s) => s.set);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("vehicle");
  const [hover, setHover] = useState<SimUnit | null>(null);
  // ?prompt= (the coach's "Practice this", old Scenario workshop links) fills the request.
  const [request, setRequest] = useState(() => new URLSearchParams(location.search).get("prompt") ?? "");
  const [planning, setPlanning] = useState(false);
  const patch = (p: Partial<typeof st>) => set({ sandbox: { ...st, ...p } });
  const side = st.side;
  const settings = st.sides[side];
  const setSide = (p: Partial<typeof settings>) => {
    const sides = [...st.sides] as typeof st.sides;
    sides[side] = { ...settings, ...p };
    patch({ sides });
  };
  const nations = useMemo(() => playableNations(setup), [setup]);
  const nationOptions: Option[] = useMemo(() => nations.map((f) => ({
    value: f.id, label: f.name, group: nationGroup(f), leading: <Flag id={f.id} className="h-[12px] w-[18px] rounded-[1px]" />,
  })), [nations]);
  const faction = side === 0 ? st.fa : st.fb;
  const roster = st.rosters[faction];
  useEffect(() => { setHover(null); }, [faction, side]);
  useEffect(() => {
    if (phase === "playing" && roster) game.requestIcons(st.units.filter((u) => roster.includes(u.name)).map((u) => u.name), faction);
  }, [game, faction, phase, st.units, roster]);
  const units = st.units
    .filter((u) => (!roster || roster.includes(u.name)) && (query ? u.label.toLowerCase().includes(query.toLowerCase()) || u.name.includes(query.toLowerCase()) : u.kind === kind))
    .sort((a, b) => Number(b.modern) - Number(a.modern) || a.cost - b.cost || a.label.localeCompare(b.label));
  const kinds = KINDS.filter((k) => st.units.some((u) => u.kind === k.id && (!roster || roster.includes(u.name))));

  const describe = async () => {
    if (!request.trim() || planning) return;
    setPlanning(true);
    try {
      const points = await sandbox.spawnPoints();
      const p = planBattle(request, st.units, st.rosters, nations, points);
      await sandbox.plan(p.fa, p.fb, p.placements);
    } finally { setPlanning(false); }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <MapCard game={game} sandbox={sandbox} />
      {st.operation && <OperationCard sandbox={sandbox} />}
      <div className="grid grid-cols-2 gap-2">
        {([0, 1] as const).map((s) => (
          <button key={s} type="button" onClick={() => patch({ side: s, brush: null, pickDestination: null })} data-testid={`sim-side-${s}`}
            className={cn("sim-side hud-inset", side === s ? "is-on" : "opacity-70 hover:opacity-100")} style={{ "--side": SIDE_COLORS[s] } as CSSProperties}>
            <Flag id={s === 0 ? st.fa : st.fb} className="h-[26px] w-[42px] rounded-[1px] shadow-[0_0_0_1px_#000]" />
            <span className="sim-side-text"><b>{s === 0 ? "You" : "Enemy AI"}</b><small>{nations.find((n) => n.id === (s === 0 ? st.fa : st.fb))?.name}</small></span>
          </button>
        ))}
      </div>
      <SearchSelect size="sm" value={faction} onValueChange={(v) => sandbox.setFaction(side, v)} options={nationOptions} aria-label="Nation" />
      <div className="sim-row" title={AI_SKILLS[st.skill].hint}>
        <span className="sim-row-label">Enemy skill</span>
        <Seg<AiSkill> label="Enemy AI skill" value={st.skill} onChange={(v) => sandbox.setSkill(v)} options={(Object.keys(AI_SKILLS) as AiSkill[]).map((k) => ({ value: k, label: AI_SKILLS[k].label, title: AI_SKILLS[k].hint }))} />
      </div>

      <div className="sim-kinds" role="tablist" aria-label="What to place">
        {kinds.map((k) => (
          <button key={k.id} type="button" role="tab" aria-selected={!query && kind === k.id} title={k.label} onClick={() => { setKind(k.id); setQuery(""); }}>{k.icon}<span>{k.label}</span></button>
        ))}
      </div>
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a unit or building…"
        className="h-8 rounded-md border border-input bg-field px-2.5 text-[13px] outline-none focus-visible:border-ring" />
      <div className="sim-roster no-scrollbar grid min-h-0 flex-1 auto-rows-max content-start grid-cols-3 gap-[3px] overflow-y-auto" onMouseLeave={() => setHover(null)}>
        {units.map((u) => (
          <button key={u.name} type="button" title={u.label} draggable data-unit={u.name}
            onDragStart={(e) => { e.dataTransfer.setData("application/x-rtsai-unit", u.name); e.dataTransfer.effectAllowed = "copy"; }}
            onMouseEnter={() => setHover(u)}
            onClick={() => patch({ brush: st.brush === u.name ? null : u.name })}
            className={cn("cameo sim-unit hud-inset", st.brush === u.name && "ring-2 ring-[var(--hud-gold)]")}>
            {icons[iconKey(u.name, faction)] ? <img src={icons[iconKey(u.name, faction)]!} alt="" draggable={false} /> : <div className="grid aspect-[60/48] w-full place-items-center px-1 text-center text-[9px] leading-tight text-[var(--muted-foreground)]">{u.label}</div>}
            <span className="sim-cost digits">{u.cost > 0 ? u.cost.toLocaleString() : "Free"}</span>
          </button>
        ))}
      </div>
      {(hover || st.brush) && <UnitCard game={game} unit={(hover ?? st.units.find((u) => u.name === st.brush))!} faction={faction} side={side} pinned={!hover} />}
      <div className="grid grid-cols-2 gap-2">
        <Seg<number> label="Rank" value={settings.level} onChange={(level) => setSide({ level })} options={[0, 1, 2].map((n) => ({ value: n, label: n ? <Rank rank={n} /> : "–", title: ["Rookie", "Veteran", "Elite"][n] }))} />
        <Seg<number> label="How many" value={st.count} onChange={(count) => patch({ count })} options={[1, 3, 5, 10].map((n) => ({ value: n, label: `×${n}` }))} />
      </div>
      <Seg<SandboxOrder> label="Opening order" value={settings.order} onChange={(order) => {
        if (order === "move") patch({ pickDestination: side, sides: Object.assign([...st.sides], { [side]: { ...settings, order } }) as typeof st.sides });
        else setSide({ order });
      }} options={[
        { value: "engage", label: "Engage", title: "Attack-move to the enemy" },
        { value: "hold", label: "Hold", title: "Stay and defend" },
        { value: "move", label: st.pickDestination === side ? "Click map" : "Move", title: "Move to a point (click the battlefield)" },
      ]} />
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <Seg<number> label="Starting money" value={st.money} onChange={(m) => sandbox.setMoney(m)} options={MONEY.map((m) => ({ value: m, label: m ? `${m / 1000}k` : <Coins size={13} />, title: m ? `${m.toLocaleString()} credits each to build with` : "No money: only what you place" }))} />
        <button type="button" className={cn("sim-fog hud-inset", st.fog && "is-on")} aria-pressed={st.fog} title="Fog of war" onClick={() => sandbox.setFog(!st.fog)}><EyeOff size={14} /></button>
      </div>
      <form className="sim-describe" onSubmit={(e) => { e.preventDefault(); void describe(); }}>
        <input value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Describe it: 8 Karrar tanks attack 6 Abrams" aria-label="Describe the battle" data-testid="sim-describe" />
        <button type="submit" aria-label="Plan it" title="Plan it" disabled={planning}>{planning ? <span className="spinner" /> : <Sparkles size={15} />}</button>
      </form>
      <div className="grid grid-cols-2 gap-2">
        <GameButton size="sm" icon={<Eraser size={14} />} onClick={() => sandbox.clearSide(side)}>Clear side</GameButton>
        <GameButton size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => sandbox.clearSide(-1)}>Clear all</GameButton>
      </div>
      <GameButton variant="primary" size="lg" className="sb-fight" icon={<Swords size={18} />} onClick={() => sandbox.run()} data-testid="sim-fight">{st.operation ? "Begin operation" : "Fight"}</GameButton>
    </div>
  );
}

/** The battle's score while it runs: each side's survivors and health, shots and kills. */
function Score() {
  const stats = useStore((s) => s.ui?.sandbox);
  const st = useStore((s) => s.sandbox)!;
  return (
    <div className="sim-score">
      {([0, 1] as const).map((s) => {
        const side = stats?.sides[s];
        const hpf = side && side.hpStart > 0 ? side.hp / side.hpStart : 0;
        return (
          <div key={s} className="sim-score-side" style={{ "--side": SIDE_COLORS[s] } as CSSProperties}>
            <Flag id={s === 0 ? st.fa : st.fb} className="h-[16px] w-[26px] rounded-[1px]" />
            <span className="digits sim-score-alive">{side?.alive ?? 0}<small>/{side?.total ?? 0}</small></span>
            <span className="sim-score-hp"><i style={{ width: `${hpf * 100}%` }} /></span>
            <span className="digits sim-score-kills" title="Kills">{side?.kills ?? 0}<Swords size={11} /></span>
          </div>
        );
      })}
    </div>
  );
}

function Timeline({ game, sandbox }: { game: Game; sandbox: Sandbox }) {
  const st = useStore((s) => s.sandbox)!;
  const tick = useStore((s) => s.perf.tick);
  const verify = useStore((s) => s.verify);
  const len = st.recordLen;
  const pos = st.replay ?? Math.max(0, len - 1);
  const t = (i: number) => { const s = Math.floor(i * 0.04); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const live = st.replay === null;
  const running = live ? !st.paused : st.playing;
  const pct = len > 1 ? (pos / (len - 1)) * 100 : 100;
  return (
    <div className="rp-dock sim-dock">
      <div className="rp-bar" role="group" aria-label="Battle timeline" data-ui-sfx>
        <GameButton size="sm" icon={<Undo2 size={14} />} onClick={() => sandbox.backToEdit()} data-testid="sim-edit">Edit</GameButton>
        <Score />
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
        <span className="rp-time is-total" style={{ minWidth: 74 }}>{t(pos)} / {t(len)}</span>
        <div className="rp-speeds" role="radiogroup" aria-label="Playback speed">
          {[1, 2, 4].map((s) => (
            <button key={s} type="button" role="radio" aria-checked={st.speed === s} className="rp-speed" onClick={() => sandbox.setSpeed(s)}>{s}×</button>
          ))}
        </div>
        <GameButton size="sm" variant={live ? "primary" : "secondary"} icon={<Radio size={13} />} onClick={() => sandbox.goLive()} title={`Tick ${tick}`}>Live</GameButton>
        <GameButton size="sm" icon={<RotateCcw size={14} />} onClick={() => sandbox.run()}>Rerun</GameButton>
        {import.meta.env.VITE_STATIC_BUILD !== "1" && <GameButton size="sm" icon={<ShieldCheck size={14} />} title={verify || "Replay this run in the native engine and compare"} onClick={() => game.requestVerify()}>Verify</GameButton>}
      </div>
    </div>
  );
}

export function Simulator({ game, exit }: { game: Game; exit: () => void }) {
  const st = useStore((s) => s.sandbox);
  const sandbox = game.sandbox;
  if (!st || !sandbox) return null;
  if (st.mode === "run") return (
    <>
      <Hud game={game} />
      <Timeline game={game} sandbox={sandbox} />
    </>
  );
  return (
    <>
      <nav className="hud-bar" aria-label="Game controls" data-ui-sfx>
        <button type="button" className="hud-tool" aria-label="Main menu" data-tip="Main menu" onClick={exit}><ArrowLeft /></button>
        <GameMenu game={game} />
      </nav>
      <div className="sb-hint"><div className="hud-card">
        <MousePointerClick />{st.pickDestination !== null ? "Click the battlefield to set the destination" : st.brush ? "Click to place · right-click a unit to remove" : "Drag anything onto the battlefield · right-click removes"}
      </div></div>
      <aside className="hud-panel sb-side sim-panel" style={{ width: "var(--sidebar-w)" }} onContextMenu={(e) => e.preventDefault()}>
        <div className="sb-side-head">
          <b>Battle simulator</b>
          <span className="menu-eyebrow"><Shield size={11} /> Real engine</span>
        </div>
        <EditPanel game={game} sandbox={sandbox} />
      </aside>
    </>
  );
}
