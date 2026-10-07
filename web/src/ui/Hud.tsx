// In-game HUD around the battlefield: selection panel (portraits, health, veterancy), command bar, control
// groups, game menu, victory/defeat and the developer stats panel (F2).

import { useMemo, useState } from "react";
import type { Game } from "../game";
import { percentile, useStore } from "../store";
import { Sidebar } from "./Sidebar";
import { Outcome } from "./Outcome";
import { HotkeyButton, HotkeySheet } from "./Hotkeys";
import { AttackMoveIcon, DeployIcon, GuardIcon, ScatterIcon, StopIcon } from "./icons";
import { Button } from "../components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { cn } from "../lib/utils";

function HealthBar({ hp, max, className }: { hp: number; max: number; className?: string }) {
  const f = max > 0 ? Math.max(0, Math.min(1, hp / max)) : 0;
  const col = f > 0.5 ? "var(--hud-green)" : f > 0.25 ? "var(--hud-yellow)" : "var(--hud-red)";
  return (
    <div className={cn("h-[5px] w-full bg-black/80 p-[1px]", className)}>
      <div className="h-full" style={{ width: `${f * 100}%`, background: col, boxShadow: `0 0 4px ${col}` }} />
    </div>
  );
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
  const labels = useMemo(() => new Map(catalog.flatMap((q) => q.items.map((i) => [i.name, i.label] as const))), [catalog]);
  if (!selection?.length) return null;

  if (selection.length === 1) {
    const a = selection[0];
    return (
      <div className="hud-panel flex w-[220px] gap-2 p-2">
        <div className="cameo hud-inset w-[90px] shrink-0">{icons[a.type] ? <img src={icons[a.type]!} alt="" /> : null}</div>
        <div className="flex min-w-0 flex-1 flex-col justify-between py-[2px]">
          <div className="flex items-start justify-between gap-1">
            <span className="truncate text-[12px] font-medium text-[var(--hud-gold)]">{labels.get(a.type) ?? a.type}</span>
            <Rank rank={a.rank} />
          </div>
          <div>
            <HealthBar hp={a.hp} max={a.maxHp} />
            <div className="digits mt-[2px] text-right text-[10px] text-[var(--muted-foreground)]">{a.hp} / {a.maxHp}</div>
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
    <div className="hud-panel grid max-w-[min(520px,calc(100vw-var(--sidebar-w)-24px))] gap-[4px] p-[6px]" style={{ gridTemplateColumns: `repeat(${Math.min(groups.size, 7)}, 64px)` }}>
      {[...groups].map(([type, g]) => (
        <button key={type} type="button" className="flex flex-col gap-[2px]" title={labels.get(type) ?? type} onClick={() => game.selectType(type)}>
          <div className="cameo hud-inset relative w-[64px]">
            {icons[type] ? <img src={icons[type]!} alt="" /> : <div className="h-full w-full bg-[#111]" />}
            {g.count > 1 && <span className="digits absolute left-[3px] top-[1px] text-[12px] font-bold text-white drop-shadow-[0_1px_1px_#000]">{g.count}</span>}
            <span className="absolute bottom-[1px] right-[1px]"><Rank rank={g.rank} /></span>
          </div>
          <HealthBar hp={g.hp} max={g.max} />
        </button>
      ))}
    </div>
  );
}

export function CommandBar({ game }: { game: Game }) {
  const selection = useStore((s) => s.ui?.selection);
  const mode = useStore((s) => s.ui?.mode ?? "");
  if (!selection?.some((a) => a.own)) return null;
  const btn = (title: string, key: string, active: boolean, onClick: () => void, Icon: (p: React.SVGProps<SVGSVGElement>) => React.JSX.Element) => (
    <button type="button" title={`${title} (${key})`} onClick={onClick}
      className={cn("hud-inset relative grid size-[34px] place-items-center text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
        active && "text-[var(--hud-gold)] shadow-[inset_0_0_0_1px_var(--hud-gold)]")}>
      <Icon width={18} height={18} />
      <span className="digits absolute bottom-0 right-[2px] text-[9px] text-[var(--hud-gold-dim)]">{key}</span>
    </button>
  );
  return (
    <div className="hud-panel flex gap-[3px] p-[4px]">
      {btn("Attack move", "A", mode === "attackmove", () => game.setMode("attackmove"), AttackMoveIcon)}
      {btn("Guard", "G", mode === "guard", () => game.setMode("guard"), GuardIcon)}
      {btn("Deploy", "D", false, () => game.command({ cmd: "deploy" }), DeployIcon)}
      {btn("Scatter", "X", false, () => game.command({ cmd: "scatter" }), ScatterIcon)}
      {btn("Stop", "S", false, () => game.command({ cmd: "stop" }), StopIcon)}
    </div>
  );
}

function GroupBar({ game }: { game: Game }) {
  const groups = useStore((s) => s.ui?.groups);
  if (!groups?.some((n) => n > 0)) return null;
  return (
    <div className="flex gap-[3px]">
      {groups.map((n, i) => n > 0 && (
        <button key={i} type="button" onClick={() => game.group(i, "select")} title={`Group ${(i + 1) % 10}`}
          className="hud-panel flex h-[24px] min-w-[34px] items-center justify-center gap-1 px-1.5 text-[11px]">
          <span className="digits font-bold text-[var(--hud-gold)]">{(i + 1) % 10}</span>
          <span className="digits text-[var(--muted-foreground)]">{n}</span>
        </button>
      ))}
    </div>
  );
}

export function GameMenu({ game }: { game: Game }) {
  const paused = useStore((s) => s.paused);
  const statsOpen = useStore((s) => s.statsOpen);
  const set = useStore((s) => s.set);
  const [sound, setSound] = useState(game.audio.soundOn);
  const [music, setMusic] = useState(game.audio.musicOn);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="icon" className="hud-panel size-[32px] rounded-[3px]" aria-label="Menu" />}>
        <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor"><path d="M4 6h16v2H4Zm0 5h16v2H4Zm0 5h16v2H4Z" /></svg>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[180px]">
        <DropdownMenuItem onClick={() => game.setPaused(!paused)}>{paused ? "Resume" : "Pause"} <span className="ml-auto text-xs text-muted-foreground">P</span></DropdownMenuItem>
        <DropdownMenuItem onClick={() => set({ statsOpen: !statsOpen })}>Engine stats <span className="ml-auto text-xs text-muted-foreground">F2</span></DropdownMenuItem>
        <DropdownMenuCheckboxItem checked={sound} onCheckedChange={(v) => { game.audio.setSoundOn(!!v); setSound(!!v); }}>Sound</DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={music} onCheckedChange={(v) => { game.audio.setMusicOn(!!v); setMusic(!!v); }}>Music</DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {game.sandbox
          ? <DropdownMenuItem onClick={() => game.sandbox!.backToEdit()}>Back to setup</DropdownMenuItem>
          : <DropdownMenuItem variant="destructive" onClick={() => game.quit()}>Leave game</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Stats({ game }: { game: Game }) {
  const p = useStore((s) => s.perf);
  const info = useStore((s) => s.info);
  const runtime = useStore((s) => s.runtime);
  const startMs = useStore((s) => s.startMs);
  const timings = useStore((s) => s.timings);
  const lazy = useStore((s) => s.lazy);
  const verify = useStore((s) => s.verify);
  const row = (k: string, v: string) => (<><dt className="text-[var(--muted-foreground)]">{k}</dt><dd className="digits m-0 text-right">{v}</dd></>);
  return (
    <div className="hud-panel absolute left-3 top-[48px] w-[280px] p-3 text-[12px]">
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-[2px]">
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
      <div className="mt-2 grid grid-cols-3 gap-1">
        <Button size="xs" variant="outline" onClick={() => game.requestVerify()}>Verify</Button>
        <Button size="xs" variant="outline" onClick={() => game.latencyProbe(20)}>Latency</Button>
        <Button size="xs" variant="outline" onClick={() => game.bench(250)}>Bench</Button>
      </div>
      {verify && <p className={cn("mt-2 text-[11px]", verify.startsWith("Identical") ? "text-[var(--hud-green)]" : "text-[var(--muted-foreground)]")}>{verify}</p>}
    </div>
  );
}

export function Hud({ game }: { game: Game }) {
  const statsOpen = useStore((s) => s.statsOpen);
  const paused = useStore((s) => s.paused);
  return (
    <>
      <div className="absolute left-3 top-3 flex items-center gap-2"><GameMenu game={game} /><HotkeyButton /></div>
      {statsOpen && <Stats game={game} />}
      <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col items-start gap-2 [&>*]:pointer-events-auto">
        <GroupBar game={game} />
        <div className="flex items-end gap-2">
          <SelectionPanel game={game} />
          <CommandBar game={game} />
        </div>
      </div>
      {paused && (
        <div className="pointer-events-none absolute left-1/2 top-6 -translate-x-1/2 text-[13px] font-semibold uppercase tracking-[0.3em] text-[var(--hud-gold)] drop-shadow-[0_1px_2px_#000]">Paused</div>
      )}
      <Sidebar game={game} />
      <HotkeySheet />
      <Outcome game={game} />
    </>
  );
}
