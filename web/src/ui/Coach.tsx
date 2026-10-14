// Battlefield review: the last six minutes of the match in two-second samples (army size over time, drag to look
// back), the turning points the engine's statistics recorded, each with a practice exercise, and in a practice battle
// its objective and measured results.

import { useEffect, useState } from "react";
import { Activity, ArrowRight, Coins, Download, Factory, Radio, RotateCcw, Skull, Target, X, Zap } from "lucide-react";
import type { Game } from "../game";
import { useStore } from "../store";
import { GameButton } from "./kit/game";
import { replayOf } from "./Replay";

const time = (tick: number) => `${Math.floor(tick / 1500)}:${String(Math.floor(tick / 25) % 60).padStart(2, "0")}`;
const KIND_ICONS: Record<string, React.ReactNode> = { power: <Zap size={14} />, loss: <Skull size={14} />, production: <Factory size={14} />, cash: <Coins size={14} /> };
const KIND_NAMES: Record<string, string> = { power: "Low power", loss: "Losses", production: "Production idle", cash: "No income" };

export function CoachPanel({ game }: { game: Game }) {
  const open = useStore((s) => s.reviewOpen);
  const setOpen = (reviewOpen: boolean) => useStore.getState().set({ reviewOpen });
  const [, render] = useState(0);
  useEffect(() => { const t = setInterval(() => render(n => n + 1), 1000); return () => clearInterval(t); }, []);
  const c = game.coach;
  const lab = c.lab;
  // After the match the result screen (and a campaign's debrief) own the small screens (hud.css).
  const over = useStore((s) => s.ui?.win === "Won" || s.ui?.win === "Lost");
  useEffect(() => { if (lab?.objective && lab.status !== "active") setOpen(true); }, [lab?.status, lab?.objective]);
  // A replay has its own timeline (Replay.tsx).
  if (replayOf(game)) return null;
  const frames = c.frames;
  const first = frames[0]?.tick ?? 0, last = frames.at(-1)?.tick ?? 0;
  const maxArmy = Math.max(1, ...frames.map((x) => x.army));
  const at = c.review?.tick ?? last;
  const fill = last > first ? ((at - first) / (last - first)) * 100 : 100;
  const pts = frames.map((f, i) => `${((i / Math.max(1, frames.length - 1)) * 400).toFixed(1)},${(70 - (f.army / maxArmy) * 44).toFixed(1)}`).join(" ");
  const back = () => { c.live(); render((n) => n + 1); };
  return (
    <div className={`cv-root${over ? " is-after-match" : ""}`} onKeyDown={(e) => e.stopPropagation()}>
      <button type="button" className="cv-toggle" aria-label={`Battlefield review${c.events.length ? `, ${c.events.length} turning points` : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Activity /><span>Battlefield review</span>{c.events.length > 0 && <span className="cv-count">{c.events.length}</span>}
      </button>
      {open && <section data-coach className="cv-panel hud-card" aria-label="Battlefield review">
        <header className="cv-head">
          <div><span className="menu-eyebrow">Last 6 minutes</span><h2>Evidence & practice</h2></div>
          <button type="button" className="gd-close" aria-label="Close battlefield review" onClick={() => { c.live(); setOpen(false); }}><X size={16} /></button>
        </header>
        <div className="cv-body">
          {frames.length > 0 && <>
            <div className="cv-chart">
              <span className="cv-chart-label">Army<b>{c.review?.army ?? frames.at(-1)?.army ?? 0}</b></span>
              <svg viewBox="0 0 400 74" preserveAspectRatio="none" role="img" aria-label="Recorded army size">
                <defs><linearGradient id="cv-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#f1d28b" stopOpacity=".35" /><stop offset="1" stopColor="#f1d28b" stopOpacity="0" /></linearGradient></defs>
                {frames.length > 1 && <polygon points={`0,74 ${pts} 400,74`} fill="url(#cv-area)" />}
                <polyline fill="none" stroke="#f1d28b" strokeWidth="2" vectorEffect="non-scaling-stroke" points={pts} />
                {c.events.filter((e) => e.tick >= first).map((e, i) => <line key={i} x1={((e.tick - first) / Math.max(1, last - first)) * 400} x2={((e.tick - first) / Math.max(1, last - first)) * 400} y1={0} y2={74} stroke="#ef5b3f" strokeOpacity=".55" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />)}
                {c.review && <line x1={(fill / 100) * 400} x2={(fill / 100) * 400} y1={0} y2={74} stroke="#fff3d2" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
              </svg>
            </div>
            <div className="cv-scrub">
              <input aria-label="Review timeline" type="range" min={first} max={last} value={at} disabled={game.multiplayer} style={{ "--fill": `${fill}%` } as React.CSSProperties}
                onChange={(e) => { c.seek(Number(e.target.value)); render((n) => n + 1); }} />
            </div>
            <div className="cv-status">
              {c.review
                ? <><b><RotateCcw size={13} />Reviewing {time(c.review.tick)}</b><span className="digits">{c.review.army} units · ${c.review.cash} · {c.review.power} power</span></>
                : <><b className="is-live"><i />Live</b><span className="digits">{time(last)}</span></>}
              {c.review && <GameButton size="sm" variant="primary" onClick={back}>Return live</GameButton>}
            </div>
          </>}
          <div className="cv-section">
            <h3><Target />Turning points</h3>
            {!c.events.length && <p className="text-[12px] text-[#8f9886]">Nothing yet. Losses, idle production, low power and stalled income show up here.</p>}
            {[...c.events].reverse().map((e, i) => (
              <article key={i} className="cv-event">
                <button type="button" className="cv-time" disabled={game.multiplayer || e.tick < first} onClick={() => { c.seek(e.tick); render((n) => n + 1); }} aria-label={`Review ${time(e.tick)}`}>{time(e.tick)}</button>
                <span className="cv-event-kind inline-flex items-center gap-1.5 text-[var(--hud-gold)]">{KIND_ICONS[e.kind]}<span className="text-[#f2ecdc]">{KIND_NAMES[e.kind] ?? e.kind}</span></span>
                <p>{e.text}</p>
                <a href={`?profile=public&mode=simulator&prompt=${encodeURIComponent(e.practice)}`} target="_blank" rel="noreferrer">Practice this<ArrowRight /></a>
              </article>
            ))}
          </div>
          {lab?.objective && <div className="cv-section cv-lab">
            <div className="cv-lab-head"><h3 style={{ margin: 0 }}><Target />Practice</h3><span className={`cv-chip${lab.status === "complete" || lab.status === "passed" ? " is-complete" : lab.status === "failed" ? " is-failed" : ""}`}>{lab.status}</span></div>
            <p><span className="digits">{lab.metrics?.elapsed ?? lab.elapsed}s / {lab.duration}s</span> · {lab.objective}</p>
            {lab.metrics && <table className="cv-metrics"><thead><tr><th>Result</th><th>This run</th><th>Previous</th></tr></thead><tbody>
              {([["Survivors", "alive"], ["Damage dealt", "damageDealt"], ["Shots fired", "shots"]] as const).map(([label, key]) =>
                <tr key={key}><td>{label}</td><td>{lab.metrics!.sides[0][key]}</td><td>{c.previousPractice?.sides[0][key] ?? "—"}</td></tr>)}
            </tbody></table>}
            <GameButton size="sm" icon={<RotateCcw size={14} />} onClick={() => { c.live(); game.start(game.scenarioJson); }}>Repeat same seed & forces</GameButton>
            <p className="text-[11px] text-[#8f9886]">Previous results compare the same seed, forces and objective.</p>
          </div>}
          {!!lab?.doctrines.length && <div className="cv-section">
            <h3><Radio />AI doctrine</h3>
            {lab.doctrines.map((d) => <div key={d.player} className="cv-doctrine"><b>{d.player} · {d.doctrine}</b><p>{d.decisions.length} tactical decisions · native execution · no bonus resources</p>
              {d.decisions.slice(-3).map((x, i) => <p key={i}><span className="digits">{time(x.tick)}</span> {x.mode}: {x.units} units, {x.observedEnemies} contacts seen</p>)}</div>)}
          </div>}
        </div>
        <footer className="cv-foot">
          {game.multiplayer ? <small>Live multiplayer review cannot pause or seek.</small> : <small>Reviewing pauses the battle.</small>}
          <GameButton size="sm" variant="ghost" icon={<Download size={14} />} onClick={() => c.export()}>Export evidence</GameButton>
        </footer>
      </section>}
    </div>
  );
}
