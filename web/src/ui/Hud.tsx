// In-game HUD around the battlefield: the top bar (game menu, help, saves, settings, feedback), the command console
// (control groups, selection with health and veterancy, unit commands), the pause menu, the replay controls,
// victory/defeat and the developer stats panel (F2).

import { useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, CornerUpLeft, Crosshair, Flag as FlagIcon, Hand, Keyboard, LogOut, Menu as MenuIcon, MousePointer2, Music, Pause, Play, Shield, Star, Undo2, Volume2, VolumeX } from "lucide-react";
import type { Game } from "../game";
import { percentile, useStore } from "../store";
import { Sidebar } from "./Sidebar";
import { RepairIndicators } from "./RepairIndicators";
import { Outcome } from "./Outcome";
import { HotkeyButton, HotkeySheet } from "./Hotkeys";
import { CoCommander } from "./CoCommander";
import { AttackMoveIcon, DeployIcon, GuardIcon, ScatterIcon, StopIcon } from "./icons";
import { UnitPortrait } from "./UnitPortrait";
import { MatchLibrary } from "./MatchLibrary";
import { GameSettings } from "./GameSettings";
import { keyFor, type Command } from "../preferences";
import { Feedback } from "./Feedback";
import { GameButton, Kbd } from "./kit/game";
import { Flag } from "./Flag";
import { exitReplay, replayOf, ReplayHud } from "./Replay";
import { clock, matchKind, matchSides, matchTitle, parseScenario } from "./match-info";

function HealthBar({ hp, max }: { hp: number; max: number }) {
  const f = max > 0 ? Math.max(0, Math.min(1, hp / max)) : 0;
  const col = f > 0.5 ? "var(--hud-green)" : f > 0.25 ? "var(--hud-yellow)" : "var(--hud-red)";
  return <div className="hud-hp"><div style={{ width: `${f * 100}%`, background: col, boxShadow: `0 0 5px ${col}` }} /></div>;
}

function Rank({ rank }: { rank: number }) {
  if (rank <= 0) return null;
  const color = rank >= 2 ? "#ff8a3d" : "var(--hud-gold)";
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} aria-label={rank >= 2 ? "Elite" : "Veteran"} className="drop-shadow-[0_1px_1px_#000]">
      {Array.from({ length: Math.min(rank, 2) }, (_, i) => (
        <path key={i} d={`M2 ${11 - i * 5} L8 ${6 - i * 5} L14 ${11 - i * 5}`} fill="none" stroke={color} strokeWidth="2.4" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

export function SelectionPanel({ game }: { game: Game }) {
  const selection = useStore((s) => s.ui?.selection);
  const icons = useStore((s) => s.icons);
  const catalog = useStore((s) => s.catalog);
  const actorLabels = useStore((s) => s.actorLabels);
  // The build menu's names first, then every unit's engine name (units you can't build here, in practice battles or missions).
  const labels = useMemo(() => new Map([...Object.entries(actorLabels), ...catalog.flatMap((q) => q.items.map((i) => [i.name, i.label] as const))]), [catalog, actorLabels]);
  if (!selection?.length) return null;

  if (selection.length === 1) {
    const a = selection[0];
    return (
      <div className="hud-sel hud-sel-one">
        <div className="cameo hud-inset"><UnitPortrait type={a.type} label={labels.get(a.type) ?? a.type} icon={icons[a.type]} /></div>
        <div className="hud-sel-info">
          <div className="hud-sel-name"><b>{labels.get(a.type) ?? a.type}</b><Rank rank={a.rank} /></div>
          <div>
            <HealthBar hp={a.hp} max={a.maxHp} />
            <div className="digits hud-sel-hp">{a.hp} / {a.maxHp}</div>
          </div>
        </div>
      </div>
    );
  }

  const groups = new Map<string, { count: number; hp: number; max: number; rank: number }>();
  for (const a of selection) {
    const g = groups.get(a.type) ?? { count: 0, hp: 0, max: 0, rank: 0 };
    g.count++; g.hp += a.hp; g.max += a.maxHp; g.rank = Math.max(g.rank, a.rank);
    groups.set(a.type, g);
  }
  return (
    <div className="hud-sel hud-sel-many" style={{ "--cols": Math.min(groups.size, 7) } as React.CSSProperties}>
      {[...groups].map(([type, g]) => (
        <button key={type} type="button" aria-label={`Select only ${labels.get(type) ?? type}`} data-tip={`${labels.get(type) ?? type}${g.count > 1 ? ` ×${g.count}` : ""}`} data-tip-pos="top" onClick={() => game.selectType(type)}>
          <div className="cameo hud-inset relative">
            <UnitPortrait type={type} label={labels.get(type) ?? type} icon={icons[type]} />
            {g.count > 1 && <span className="digits hud-sel-count">{g.count}</span>}
            <span className="absolute bottom-[1px] right-[1px]"><Rank rank={g.rank} /></span>
          </div>
          <HealthBar hp={g.hp} max={g.max} />
        </button>
      ))}
    </div>
  );
}

const STANCES = [["attackanything", "Aggressive", "A", Crosshair], ["defend", "Defend", "S", Shield], ["returnfire", "Return fire", "D", CornerUpLeft], ["holdfire", "Hold fire", "F", Hand]] as const;

export function CommandBar({ game }: { game: Game }) {
  const commands = useStore((s) => s.ui?.commands);
  const stances = useStore((s) => s.ui?.stances) ?? [];
  const selection = useStore((s) => s.ui?.selection);
  const mode = useStore((s) => s.ui?.mode ?? "");
  if (!selection?.some((a) => a.own)) return null;
  const btn = (title: string, command: Command, active: boolean, onClick: () => void, Icon: (p: React.SVGProps<SVGSVGElement>) => React.JSX.Element, also = "") => (
    <button type="button" className="hud-cmd" aria-label={title} aria-pressed={active} data-tip={`${title} · ${keyFor(command).toUpperCase()}${also}`} data-tip-pos="top" onClick={onClick}>
      <Icon width={19} height={19} />
      <span className="hud-cmd-key">{keyFor(command).toUpperCase()}</span>
    </button>
  );
  const one = selection.length === 1 ? selection[0] : null;
  return (
    <div className="hud-cmds">
      {commands?.attackmove && btn("Attack move", "attackmove", mode === "attackmove", () => game.setMode("attackmove"), AttackMoveIcon, " or Ctrl+Shift+click")}
      {commands?.guard && btn("Guard", "guard", mode === "guard", () => game.setMode("guard"), GuardIcon)}
      {commands?.deploy && btn("Deploy", "deploy", false, () => game.command({ cmd: "deploy" }), DeployIcon)}
      {commands?.scatter && btn("Scatter", "scatter", false, () => game.command({ cmd: "scatter" }), ScatterIcon)}
      {commands?.stop && btn("Stop", "stop", false, () => game.command({ cmd: "stop" }), StopIcon)}
      {stances.length > 0 && <>
        <span className="hud-cmd-sep" aria-hidden="true" />
        <div className="hud-stances" role="group" aria-label="Unit stance">
          {STANCES.map(([stance, label, k, Icon]) => {
            const on = stances.length === 1 && stances[0] === stance;
            return <button key={stance} type="button" className="hud-stance" aria-label={label} aria-pressed={on} data-tip={`${label} · Alt+${k}`} data-tip-pos="top"
              onClick={() => game.command({ cmd: "stance", stance })}><Icon size={17} /></button>;
          })}
        </div>
      </>}
      {one?.canPrimary && <button type="button" className="hud-pill" aria-pressed={!!one.primary} onClick={() => game.command({ cmd: "primary" })}>
        <Star size={14} fill={one.primary ? "currentColor" : "none"} />{one.primary ? "Primary factory" : "Make primary"}
      </button>}
      {one?.rally && <span className="hud-hint"><FlagIcon size={13} />Right-click ground: rally point</span>}
    </div>
  );
}

function GroupBar({ game }: { game: Game }) {
  const groups = useStore((s) => s.ui?.groups);
  if (!groups?.some((n) => n > 0)) return null;
  return (
    <div className="hud-groups" role="group" aria-label="Control groups">
      {groups.map((n, i) => n > 0 && (
        <button key={i} type="button" className="hud-group" onClick={() => game.group(i, "select")} aria-label={`Group ${(i + 1) % 10}, ${n} units`}>
          <b className="digits">{(i + 1) % 10}</b>
          <span className="digits">{n}</span>
        </button>
      ))}
    </div>
  );
}

/** The bottom-left console; its height places the battlefield review above it (Coach.tsx). */
function Console({ game }: { game: Game }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      root.style.setProperty("--hud-console-h", `${h ? h + 8 : 0}px`);
    });
    observer.observe(el);
    return () => { observer.disconnect(); root.style.removeProperty("--hud-console-h"); };
  }, []);
  return (
    <div ref={ref} className="hud-console">
      <GroupBar game={game} />
      <div className="hud-console-row">
        <SelectionPanel game={game} />
        <CommandBar game={game} />
      </div>
    </div>
  );
}

function Toggle({ on, label, icon, onChange }: { on: boolean; label: string; icon: React.ReactNode; onChange: (on: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={on} className="pm-toggle" onClick={() => onChange(!on)}>{icon}{label}</button>;
}

/** The game menu (≡ or Esc): resume, save or load, settings, controls, sound, leave. Opening it pauses a single-player game. */
function PauseMenu({ game }: { game: Game }) {
  const set = useStore((s) => s.set);
  const statsOpen = useStore((s) => s.statsOpen);
  const setup = useStore((s) => s.setup);
  const tick = useStore((s) => s.ui?.tick ?? 0);
  const [sound, setSound] = useState(game.audio.soundOn);
  const [music, setMusic] = useState(game.audio.musicOn);
  const [lock, setLock] = useState(game.lock.enabled);
  const [leaving, setLeaving] = useState(false);
  const resume = useRef<HTMLButtonElement>(null);
  useEffect(() => { resume.current?.focus({ preventScroll: true }); }, []);
  const touch = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
  const replay = !!replayOf(game);
  const scenario = parseScenario(game.scenarioJson);
  const sides = matchSides(scenario, setup);
  const close = () => set({ menuOpen: false });
  const kind = game.sandbox ? "Battle sandbox" : replay ? "Replay" : matchKind(scenario);
  return (
    <div className="pm-overlay" role="dialog" aria-modal="true" aria-label="Game menu" data-ui-sfx onPointerDown={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("pm-scrim")) close(); }}>
      <div className="pm-scrim" />
      <div className="pm-panel">
        <header className="pm-head">
          <span className="menu-eyebrow">{kind}{game.sandbox ? "" : ` · ${matchTitle(scenario, setup)}`}</span>
          <h2>{game.multiplayer ? "Menu" : "Paused"}</h2>
          <p className="inline-flex items-center gap-2">
            <span className="digits">{clock(tick)}</span>
            {sides.length > 1 && !game.sandbox && sides.slice(0, 4).map((s, i) => <span key={i} className="inline-flex items-center gap-1.5">{i > 0 && <span className="lib-vs">VS</span>}<Flag id={s.faction} className="h-[12px] w-[19px] rounded-[2px]" /></span>)}
            {game.multiplayer && <span>· the match goes on</span>}
          </p>
        </header>
        <div className="pm-list">
          <button ref={resume} type="button" className="pm-item is-primary" data-sfx-hover onClick={() => {
            close();
            if (!replay && !game.multiplayer && !game.sandbox && useStore.getState().paused) game.setPaused(false);
          }}><Play />{game.multiplayer ? "Back to battle" : replay ? "Back to replay" : "Resume"}</button>
          {!game.sandbox && <MatchLibrary game={game} variant="item" />}
          <span className="pm-slot"><GameSettings game={game} /></span>
          <button type="button" className="pm-item" data-sfx-hover onClick={() => set({ keysOpen: true })}><Keyboard />Controls<Kbd>?</Kbd></button>
          {leaving ? (
            <div className="pm-confirm" role="alertdialog" aria-label="Leave this match?">
              <b>Leave this match?</b>
              <p>{game.multiplayer ? "You leave the room; the others play on." : "Progress since your last save is lost."}</p>
              <div>
                <GameButton variant="ghost" onClick={() => setLeaving(false)}>Stay</GameButton>
                <GameButton variant="danger" icon={<LogOut size={15} />} onClick={() => game.quit()}>Leave game</GameButton>
              </div>
            </div>
          ) : game.sandbox
            ? <button type="button" className="pm-item" data-sfx-hover onClick={() => { close(); game.sandbox!.backToEdit(); }}><Undo2 />Back to setup</button>
            : replay
              ? <button type="button" className="pm-item is-danger" data-sfx-hover onClick={() => exitReplay(game)}><LogOut />Exit replay</button>
              : <button type="button" className="pm-item is-danger" data-sfx-hover onClick={() => setLeaving(true)}><LogOut />Leave game</button>}
        </div>
        <div className="pm-toggles">
          <Toggle on={sound} label="Sound" icon={sound ? <Volume2 /> : <VolumeX />} onChange={(v) => { game.audio.setSoundOn(v); setSound(v); }} />
          <Toggle on={music} label="Music" icon={<Music />} onChange={(v) => { game.audio.setMusicOn(v); setMusic(v); }} />
          {!touch && <Toggle on={lock} label="Keep the mouse in the game" icon={<MousePointer2 />} onChange={(v) => { game.setMouseLock(v); setLock(v); }} />}
        </div>
        <div className="pm-foot">
          <GameButton variant="ghost" size="sm" icon={<BarChart3 size={13} />} aria-pressed={statsOpen} onClick={() => set({ statsOpen: !statsOpen, menuOpen: false })}>Engine stats</GameButton>
        </div>
      </div>
    </div>
  );
}

/** The ≡ button and the game menu it opens (Esc too, as the desktop game's options menu: game.ts). */
export function GameMenu({ game }: { game: Game }) {
  const menuOpen = useStore((s) => s.menuOpen);
  const set = useStore((s) => s.set);
  // A single-player match waits while the menu is open, and goes on when it closes.
  const pausedByMenu = useRef(false);
  useEffect(() => {
    const s = useStore.getState();
    if (menuOpen) {
      if (!game.multiplayer && !game.sandbox && !s.paused && s.phase === "playing") { pausedByMenu.current = true; game.setPaused(true); }
    } else if (pausedByMenu.current) {
      pausedByMenu.current = false;
      if (s.paused && s.phase === "playing") game.setPaused(false);
    }
  }, [menuOpen, game]);
  return <>
    <button type="button" className="hud-tool is-menu" aria-label="Menu" aria-expanded={menuOpen} data-tip="Menu · Esc" onClick={() => set({ menuOpen: !menuOpen })}><MenuIcon /></button>
    {menuOpen && <PauseMenu game={game} />}
  </>;
}

function Stats({ game }: { game: Game }) {
  const p = useStore((s) => s.perf);
  const info = useStore((s) => s.info);
  const runtime = useStore((s) => s.runtime);
  const startMs = useStore((s) => s.startMs);
  const timings = useStore((s) => s.timings);
  const lazy = useStore((s) => s.lazy);
  const verify = useStore((s) => s.verify);
  const row = (k: string, v: string) => (<><dt>{k}</dt><dd className="digits">{v}</dd></>);
  return (
    <div className="hud-card hud-stats">
      <dl>
        {row("Runtime", runtime === "aot" ? "AOT" : "Interpreter")}
        {row("Map", info?.map ?? "")}
        {row("Tick", `${p.tick} · ${p.tps.toFixed(1)} tps`)}
        {row("SyncHash", (p.syncHash >>> 0).toString(16).padStart(8, "0"))}
        {row("World.Tick", `${p.engineTickMs.toFixed(2)} ms`)}
        {row("Tick + snapshot", `${p.simTickMs.toFixed(2)} ms`)}
        {row("Frame", `${p.fps.toFixed(0)} fps · ${p.frameMs.toFixed(2)} ms · ${p.draws} sprites`)}
        {row("Input → frame", p.latency.length ? `p50 ${percentile(p.latency, 0.5).toFixed(0)} · p95 ${percentile(p.latency, 0.95).toFixed(0)} ms` : "–")}
        {row("WASM heap", `${p.heapMB.toFixed(0)} MB (managed ${p.managedMB.toFixed(0)})`)}
        {row("Lazy reads", lazy ? `${(lazy.fetchedBytes / 1048576).toFixed(0)} of ${(lazy.bytes / 1048576).toFixed(0)} MB` : "–")}
        {row("World start", `${(startMs / 1000).toFixed(2)} s`)}
        {row("Map prepare", timings["prepare.total"] ? `${(timings["prepare.total"] / 1000).toFixed(2)} s` : "–")}
        {row("Late / missed", `${p.lateTicks} / ${p.missed}`)}
      </dl>
      <div className="hud-stats-actions">
        {import.meta.env.VITE_STATIC_BUILD !== "1" && <GameButton size="sm" onClick={() => game.requestVerify()}>Verify</GameButton>}
        <GameButton size="sm" onClick={() => game.latencyProbe(20)}>Latency</GameButton>
        <GameButton size="sm" onClick={() => game.bench(250)}>Bench</GameButton>
      </div>
      {verify && <p className="mt-2 text-[11px]" style={{ color: verify.startsWith("Identical") ? "var(--hud-green)" : "#98a28e" }}>{verify}</p>}
    </div>
  );
}

/** Phones held upright: the battlefield needs landscape. */
function RotateHint() {
  const [portrait, setPortrait] = useState(() => matchMedia("(pointer: coarse)").matches && window.innerWidth < window.innerHeight && window.innerWidth < 700);
  useEffect(() => {
    const r = () => setPortrait(matchMedia("(pointer: coarse)").matches && window.innerWidth < window.innerHeight && window.innerWidth < 700);
    window.addEventListener("resize", r);
    return () => window.removeEventListener("resize", r);
  }, []);
  if (!portrait) return null;
  return (
    <div className="hud-rotate">
      <div>
        <svg viewBox="0 0 64 64" width={76} height={76} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-label="Turn your device sideways">
          <rect x="20" y="8" width="24" height="44" rx="4" />
          <path d="M28 46h8" />
        </svg>
        Turn sideways
      </div>
    </div>
  );
}

function PausedBanner() {
  return <div className="hud-paused" aria-live="polite"><div><Pause />Paused<Kbd>Pause</Kbd></div></div>;
}

export function Hud({ game }: { game: Game }) {
  const statsOpen = useStore((s) => s.statsOpen);
  const paused = useStore((s) => s.paused);
  const menuOpen = useStore((s) => s.menuOpen);
  const over = useStore((s) => s.ui?.win === "Won" || s.ui?.win === "Lost");
  const replay = !!replayOf(game);
  return (
    <>
      <RepairIndicators game={game} />
      <nav className="hud-bar" aria-label="Game controls" data-ui-sfx>
        <GameMenu game={game} />
        <span className="hud-bar-sep" aria-hidden="true" />
        <HotkeyButton />
        <MatchLibrary game={game} variant="hud" />
        <span className="hud-tool-slot" style={{ "--tip": '"Settings"' } as React.CSSProperties}><GameSettings game={game} /></span>
        <span className="hud-tool-slot" style={{ "--tip": '"Feedback"' } as React.CSSProperties}><Feedback game={game} compact /></span>
      </nav>
      {statsOpen && <Stats game={game} />}
      {!replay && <Console game={game} />}
      {paused && !menuOpen && !replay && !over && <PausedBanner />}
      <Sidebar game={game} />
      <CoCommander game={game} />
      {replay && <ReplayHud game={game} />}
      <HotkeySheet />
      {!replay && <Outcome game={game} />}
      <RotateHint />
    </>
  );
}
