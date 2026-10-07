// Victory / defeat screen: the result, the game time, and per side what it destroyed, lost and earned, with the
// army value over time (the engine's own player statistics, sampled every 30 s of game time).

import { useEffect, useState } from "react";
import type { Game } from "../game";
import type { GameStats } from "../sim/protocol";
import { useStore } from "../store";
import { Button } from "../components/ui/button";
import { Flag, factionIdentity } from "./Flag";
import { cn } from "../lib/utils";

function clock(seconds: number) {
  const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const money = (v: number) => (v >= 10000 ? `${(v / 1000).toFixed(1)}k` : v.toLocaleString("en-US"));

/** Army value over time, one line per side in its colour. */
function ArmyChart({ stats, width, height }: { stats: GameStats; width: number; height: number }) {
  const n = Math.max(2, ...stats.players.map((p) => p.army.length));
  const max = Math.max(1, ...stats.players.flatMap((p) => p.army));
  const x = (i: number) => (i / (n - 1)) * (width - 2) + 1;
  const y = (v: number) => height - 2 - (v / max) * (height - 6);
  return (
    <svg width={width} height={height} className="block" aria-label="Army value over time">
      {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={0} x2={width} y1={y(max * f)} y2={y(max * f)} stroke="rgba(255,255,255,0.06)" />)}
      {stats.players.map((p) => {
        const pts = p.army.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
        return (
          <g key={p.name}>
            <polyline points={pts} fill="none" stroke={`#${p.color}`} strokeWidth={2} strokeLinejoin="round" style={{ filter: `drop-shadow(0 0 3px #${p.color}88)` }} />
            {p.army.length > 0 && <circle cx={x(p.army.length - 1)} cy={y(p.army[p.army.length - 1])} r={3} fill={`#${p.color}`} />}
          </g>
        );
      })}
    </svg>
  );
}

function Cell({ value, lost, title }: { value: string | number; lost?: string | number; title: string }) {
  return (
    <td className="digits px-2 py-1.5 text-right" title={title}>
      <span className="text-[var(--foreground)]">{value}</span>
      {lost !== undefined && <span className="text-[var(--muted-foreground)]"> / {lost}</span>}
    </td>
  );
}

function Head({ children, title }: { children: React.ReactNode; title: string }) {
  return <th className="px-2 pb-1 text-right text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--hud-gold-dim)]" title={title}>{children}</th>;
}

export function Outcome({ game }: { game: Game }) {
  const win = useStore((s) => s.ui?.win ?? "Undefined");
  const [stats, setStats] = useState<GameStats | null>(null);
  const over = win === "Won" || win === "Lost";
  useEffect(() => {
    if (!over) { setStats(null); return; }
    game.command<GameStats>({ cmd: "stats" }).then(setStats).catch(() => setStats(null));
  }, [over, game]);
  if (!over) return null;

  const won = win === "Won";
  const seconds = stats ? (stats.tick * stats.timestep) / 1000 : 0;
  const players = stats ? [...stats.players].sort((a, b) => Number(b.local) - Number(a.local)) : [];
  return (
    <div className="absolute inset-0 grid place-items-center bg-black/55 backdrop-blur-[2px]" style={{ right: "var(--sidebar-w)" }}>
      <div className="hud-panel flex w-[560px] max-w-[calc(100%-32px)] flex-col items-center gap-4 px-8 py-6">
        <div className="flex flex-col items-center gap-1">
          <div className={cn("text-[44px] font-black uppercase leading-none tracking-[0.22em] drop-shadow-[0_2px_12px_rgba(0,0,0,0.8)]", won ? "text-[var(--hud-gold)]" : "text-[var(--hud-red)]")}>
            {won ? "Victory" : "Defeat"}
          </div>
          {stats && <div className="digits text-[13px] text-[var(--muted-foreground)]">{clock(seconds)}</div>}
        </div>

        {stats && (
          <>
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th />
                  <Head title="Units destroyed / lost">Units</Head>
                  <Head title="Buildings destroyed / lost">Buildings</Head>
                  <Head title="Value destroyed / lost">Value</Head>
                  <Head title="Credits earned">Earned</Head>
                </tr>
              </thead>
              <tbody>
                {players.map((p) => (
                  <tr key={p.name} className={cn("border-t border-white/5", p.local && "bg-white/[0.03]")}>
                    <td className="py-1.5 pr-2">
                      <div className="flex items-center gap-2">
                        <span className="h-[18px] w-[3px] rounded-full" style={{ background: `#${p.color}` }} />
                        <Flag id={p.faction} className="h-[16px] w-[26px] rounded-[1px]" />
                        <span className={cn("truncate", p.local ? "text-[var(--hud-gold)]" : "text-[var(--foreground)]")}>
                          {p.local ? "You" : p.name}
                        </span>
                        {p.win === "Won" && <span className="text-[11px] text-[var(--hud-gold)]" title="Winner">★</span>}
                      </div>
                      {factionIdentity(p.faction) && <div className="pl-[41px] text-[10px] text-[var(--muted-foreground)]">{factionIdentity(p.faction)!.title}</div>}
                    </td>
                    <Cell value={p.unitsKilled} lost={p.unitsDead} title="Units destroyed / lost" />
                    <Cell value={p.buildingsKilled} lost={p.buildingsDead} title="Buildings destroyed / lost" />
                    <Cell value={`$${money(p.killsCost)}`} lost={`$${money(p.deathsCost)}`} title="Value destroyed / lost" />
                    <Cell value={`$${money(p.earned)}`} title="Credits earned" />
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="w-full">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--hud-gold-dim)]">Army value</div>
              <div className="hud-inset p-1"><ArmyChart stats={stats} width={490} height={84} /></div>
            </div>
          </>
        )}

        <Button onClick={() => game.quit()} className="min-w-[160px]">Return</Button>
      </div>
    </div>
  );
}
