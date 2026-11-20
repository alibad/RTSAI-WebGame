// Victory / defeat: the moment itself, then what the match came to (the engine's own player statistics: what each side
// destroyed, lost and earned, and the army value over time, sampled every 30 s of game time), then what to do next:
// continue, watch the match back, or keep its replay.

import { useEffect, useRef, useState } from "react";
import { Building2, Check, Clock, Coins, Crosshair, Film, RotateCcw, Save, Skull, Star, Trophy } from "lucide-react";
import type { Game } from "../game";
import type { GameStats } from "../sim/protocol";
import { useStore } from "../store";
import { Flag, factionIdentity } from "./Flag";
import { GameButton } from "./kit/game";
import { keepRecord, recordMatch, startRecord } from "./MatchLibrary";
import { clock, matchKind, matchTitle, parseScenario, TICKS_PER_SECOND } from "./match-info";

const money = (v: number) => (v >= 10000 ? `${(v / 1000).toFixed(1)}k` : v.toLocaleString("en-US"));

/** A number that rolls up to its value, as score screens do. */
function useCountUp(value: number, delay: number) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now() + delay;
    const step = (now: number) => {
      const f = Math.max(0, Math.min(1, (now - t0) / 900));
      setShown(Math.round(value * (1 - Math.pow(1 - f, 3))));
      if (f < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, delay]);
  return shown;
}

function Tile({ icon, label, value, sub, money: isMoney, delay }: { icon: React.ReactNode; label: string; value: number; sub?: string; money?: boolean; delay: number }) {
  const shown = useCountUp(value, delay);
  return <div className="oc-tile"><span>{icon}{label}</span><b>{isMoney ? `$${money(shown)}` : shown.toLocaleString("en-US")}</b>{sub && <small>{sub}</small>}</div>;
}

/** Army value over time, one line per side in its colour. */
function ArmyChart({ stats }: { stats: GameStats }) {
  const width = 600, height = 84;
  const n = Math.max(2, ...stats.players.map((p) => p.army.length));
  const max = Math.max(1, ...stats.players.flatMap((p) => p.army));
  const x = (i: number) => (i / (n - 1)) * (width - 8) + 4;
  const y = (v: number) => height - 6 - (v / max) * (height - 14);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label="Army value over time">
      {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={0} x2={width} y1={y(max * f)} y2={y(max * f)} stroke="rgba(255,255,255,0.06)" vectorEffect="non-scaling-stroke" />)}
      {stats.players.map((p) => {
        const pts = p.army.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
        return (
          <g key={p.name}>
            <polyline points={pts} fill="none" stroke={`#${p.color}`} strokeWidth={2.2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" style={{ filter: `drop-shadow(0 0 3px #${p.color}88)` }} />
          </g>
        );
      })}
    </svg>
  );
}

export function Outcome({ game }: { game: Game }) {
  const win = useStore((s) => s.ui?.win ?? "Undefined");
  // A campaign operation has its own debrief and next chapter (Missions.tsx): its button leads, ours steps back.
  const mission = useStore((s) => !!s.ui?.mission);
  const setup = useStore((s) => s.setup);
  const [stats, setStats] = useState<GameStats | null>(null);
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const actions = useRef<HTMLDivElement>(null);
  // The simulator's "Look at the battle": the result steps aside for the timeline and the battle board under it.
  const [aside, setAside] = useState(false);
  const over = win === "Won" || win === "Lost";
  useEffect(() => {
    if (!over) { setStats(null); setSaved(""); setError(""); setAside(false); return; }
    const read = () => game.command<GameStats>({ cmd: "stats" }).then(setStats).catch(() => setStats(null));
    void read();
    // A multiplayer match can go on after this player's result (others still fighting): keep its standings current.
    if (!game.multiplayer) return;
    const timer = setInterval(read, 5000);
    return () => clearInterval(timer);
  }, [over, game]);
  useEffect(() => {
    if (!over) return;
    const t = setTimeout(() => actions.current?.querySelector<HTMLButtonElement>(".gbtn-primary")?.focus({ preventScroll: true }), 1200);
    return () => clearTimeout(t);
  }, [over]);
  if (!over || aside) return null;

  const won = win === "Won";
  const scenario = parseScenario(game.scenarioJson);
  const players = stats ? [...stats.players].sort((a, b) => Number(b.local) - Number(a.local)) : [];
  // The engine calls every human "Commander". In a multiplayer match the lobby's "Player 2" tells them apart: each
  // seat has its own colour (peer.ts peerColors).
  const seat = (p: GameStats["players"][number]) => {
    const found = game.multiplayer && !p.bot ? scenario.players?.find((s) => s.client && s.color?.toLowerCase() === p.color.toLowerCase()) : undefined;
    return found ? `Player ${found.client}` : p.name;
  };
  const me = players.find((p) => p.local);
  const ticks = stats ? (stats.tick * stats.timestep) / 1000 * TICKS_PER_SECOND : 0;
  const canKeep = !game.multiplayer && !!game.scenarioJson;
  // Multiplayer with three or more players: this player is out, but others have no result yet. Leaving the match
  // stops it for everyone (multiplayer.ts), so the way out says so.
  const othersPlaying = game.multiplayer && !!stats && stats.players.some((p) => !p.local && !p.bot && p.win !== "Won" && p.win !== "Lost");
  async function watch() {
    setBusy(true); setError("");
    try {
      const why = await startRecord(game, await recordMatch(game), true);
      if (why) setError(why);
    } catch (e) { setError(`The replay could not start: ${String(e)}`); }
    finally { setBusy(false); }
  }
  async function keep() {
    setBusy(true); setError("");
    try { keepRecord(await recordMatch(game)); setSaved("Saved to Saves & replays"); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className={`oc-root ${won ? "is-won" : "is-lost"}${mission ? " has-mission" : ""}`} role="dialog" aria-label={won ? "Victory" : "Defeat"} data-ui-sfx>
      <div className="oc-backdrop" />
      <div className="oc-rays" />
      <div className="oc-stage">
        <div className="oc-emblem" aria-hidden="true">{won ? <Trophy /> : <Skull />}</div>
        <div className="oc-head">
          <span className="menu-eyebrow">{matchKind(scenario)} · {matchTitle(scenario, setup)}</span>
          <h1 className="oc-title">{won ? "Victory" : "Defeat"}</h1>
          <div className="oc-meta">
            {me && <span><Flag id={me.faction} />{factionIdentity(me.faction)?.title ?? setup?.factions.find((f) => f.id === me.faction)?.name ?? ""}</span>}
            {stats && <span><Clock />{clock(ticks)}</span>}
          </div>
        </div>

        {stats && me ? <>
          <div className="oc-tiles">
            <Tile icon={<Crosshair />} label="Units killed" value={me.unitsKilled} sub={`${me.unitsDead} lost`} delay={450} />
            <Tile icon={<Building2 />} label="Buildings razed" value={me.buildingsKilled} sub={`${me.buildingsDead} lost`} delay={520} />
            <Tile icon={<Skull />} label="Value destroyed" value={me.killsCost} money sub={`$${money(me.deathsCost)} lost`} delay={590} />
            <Tile icon={<Coins />} label="Credits earned" value={me.earned} money delay={660} />
          </div>
          <div className="oc-board hud-card">
            <table className="oc-table">
              <thead>
                <tr><th>Side</th><th title="Units destroyed / lost">Units</th><th title="Buildings destroyed / lost">Buildings</th><th title="Value destroyed / lost">Value</th><th className="oc-earned" title="Credits earned">Earned</th></tr>
              </thead>
              <tbody>
                {players.map((p) => (
                  <tr key={p.name} className={p.local ? "is-you" : undefined}>
                    <td>
                      <div className={`oc-player${p.local ? " is-you" : ""}`}>
                        <i style={{ background: `#${p.color}` }} />
                        <Flag id={p.faction} />
                        <div>
                          <b>{p.local ? "You" : seat(p)}{p.win === "Won" && <span className="oc-winner" aria-label="Winner"><Star fill="currentColor" /></span>}</b>
                          {factionIdentity(p.faction) && <small>{factionIdentity(p.faction)!.title}</small>}
                        </div>
                      </div>
                    </td>
                    <td>{p.unitsKilled} <small>/ {p.unitsDead}</small></td>
                    <td>{p.buildingsKilled} <small>/ {p.buildingsDead}</small></td>
                    <td>${money(p.killsCost)} <small>/ ${money(p.deathsCost)}</small></td>
                    <td className="oc-earned">${money(p.earned)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="oc-chart"><span>Army value</span><ArmyChart stats={stats} /></div>
          </div>
        </> : <div className="oc-skeleton" />}

        <div ref={actions} className="oc-actions">
          {/* The simulator replays its own battle on its timeline; a second replay world would sit under that bar. */}
          {canKeep && (game.sandbox && !mission
            ? <GameButton icon={<Film size={16} />} onClick={() => setAside(true)} data-sfx-hover data-testid="oc-look">Look at the battle</GameButton>
            : <GameButton icon={<Film size={16} />} disabled={busy} onClick={() => void watch()} data-sfx-hover>Watch replay</GameButton>)}
          {canKeep && <GameButton variant="ghost" icon={saved ? <Check size={16} /> : <Save size={16} />} disabled={busy || !!saved} onClick={() => void keep()}>{saved || "Save replay"}</GameButton>}
          {mission && game.sandbox
            ? <GameButton onClick={() => void game.sandbox!.backToEdit()}>Back to the simulator</GameButton>
            // A battle in the simulator ends back at its setup, or runs again: "Continue" would close the world under it.
            : game.sandbox
            ? <>
              <GameButton icon={<RotateCcw size={16} />} onClick={() => void game.sandbox!.run()} data-sfx-hover data-testid="oc-rerun">Run again</GameButton>
              <GameButton variant="primary" size="lg" onClick={() => void game.sandbox!.backToEdit()} data-sfx-hover data-testid="oc-setup">Back to setup</GameButton>
            </>
            : mission
            ? <GameButton onClick={() => game.quit()}>Campaign menu</GameButton>
            : <GameButton variant="primary" size="lg" onClick={() => game.quit()} data-sfx-hover>{othersPlaying ? "Leave match" : "Continue"}</GameButton>}
        </div>
        {othersPlaying && <p role="note" className="mp-outcome-note">The other players are still fighting. Leaving now stops the match for all of them: stay on this screen to let them finish.</p>}
        {error && <p role="alert" className="lib-error">{error}</p>}
      </div>
    </div>
  );
}
