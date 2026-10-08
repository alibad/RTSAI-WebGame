import { useEffect, useState } from "react";
import type { Game } from "../game";

const time = (tick: number) => `${Math.floor(tick / 1500)}:${String(Math.floor(tick / 25) % 60).padStart(2, "0")}`;
export function CoachPanel({ game }: { game: Game }) {
  const [open, setOpen] = useState(false);
  const [, render] = useState(0);
  useEffect(() => { const t = setInterval(() => render(n => n + 1), 1000); return () => clearInterval(t); }, []);
  const c = game.coach;
  const lab = c.lab;
  useEffect(() => { if (lab?.objective && lab.status !== "active") setOpen(true); }, [lab?.status, lab?.objective]);
  return <div className="battlefield-review absolute bottom-[110px] left-3 z-30 max-w-[calc(100%-24px)] text-xs" onKeyDown={e => e.stopPropagation()}>
    <button onClick={() => setOpen(!open)} className="hud-panel px-3 py-2 text-[var(--hud-gold)]">Battlefield review {c.events.length ? `· ${c.events.length}` : ""}</button>
    {open && <section data-coach className="hud-panel mt-2 w-[450px] max-w-full max-h-[55vh] overflow-auto p-4">
      <div className="flex items-center justify-between"><h2 className="text-base font-bold text-[var(--hud-gold)]">Evidence & practice</h2><button onClick={() => { c.live(); setOpen(false); }}>✕</button></div>
      <p className="my-2 text-[var(--muted-foreground)]">Review the last six minutes in two-second samples. Observations use your own HUD and visible actors.</p>
      {c.frames.length > 0 && <><svg viewBox="0 0 400 70" role="img" aria-label="Recorded army size" className="h-20 w-full"><polyline fill="none" stroke="#d4b779" strokeWidth="2" points={c.frames.map((f, i) => `${i * 400 / Math.max(1, c.frames.length - 1)},${65 - f.army * 60 / Math.max(1, ...c.frames.map(x => x.army))}`).join(' ')} /></svg>
        <input aria-label="Review timeline" className="w-full" type="range" min={c.frames[0].tick} max={c.frames.at(-1)!.tick} value={c.review?.tick ?? c.frames.at(-1)!.tick} disabled={game.multiplayer} onChange={e => { c.seek(Number(e.target.value)); render(n => n + 1); }} />
        <p>{c.review ? `Reviewing ${time(c.review.tick)} · ${c.review.army} units · ${c.review.cash} credits · ${c.review.power} power` : `Live · ${time(c.frames.at(-1)!.tick)}`} {c.review && <button className="ml-3 text-[var(--hud-gold)]" onClick={() => { c.live(); render(n => n + 1); }}>Return live</button>}</p></>}
      {!c.events.length && <p className="my-3">No turning points recorded yet.</p>}
      {[...c.events].reverse().map((e, i) => <article key={i} className="my-3 border-t border-white/10 pt-2"><button disabled={game.multiplayer || e.tick < (c.frames[0]?.tick ?? 0)} className="text-[var(--hud-gold)]" onClick={() => { c.seek(e.tick); render(n => n + 1); }}>{time(e.tick)} · {e.kind}</button><p className="my-1">{e.text}</p><a className="text-[var(--hud-green)] underline" href={`?profile=public&mode=practice&prompt=${encodeURIComponent(e.practice)}`} target="_blank" rel="noreferrer">Build a practice exercise →</a></article>)}
      {lab?.objective && <div className="my-3 border-t border-white/10 pt-2"><b>Practice: {lab.status}</b><p>{lab.metrics?.elapsed ?? lab.elapsed}s / {lab.duration}s · {lab.objective}</p>
        {lab.metrics && <table className="my-2 w-full text-left"><thead><tr><th>Measured outcome</th><th>This run</th><th>Previous</th></tr></thead><tbody>{([['Survivors', 'alive'], ['Damage dealt', 'damageDealt'], ['Shots fired', 'shots']] as const).map(([label, key]) => <tr key={key}><td>{label}</td><td>{lab.metrics!.sides[0][key]}</td><td>{c.previousPractice?.sides[0][key] ?? '—'}</td></tr>)}</tbody></table>}
        <button onClick={() => { c.live(); game.start(game.scenarioJson); }} className="my-2 text-[var(--hud-gold)]">Repeat same seed & forces</button><p>Previous results compare identical seed, forces and objective.</p></div>}
      {lab?.doctrines.map(d => <article key={d.player} className="my-3 border-t border-white/10 pt-2"><b>{d.player} · {d.doctrine}</b><p>{d.decisions.length} tactical decisions · native execution · no bonus resources</p>{d.decisions.slice(-3).map((x, i) => <p key={i}>{time(x.tick)} {x.mode}: {x.units} units, {x.observedEnemies} observed contacts</p>)}</article>)}
      <button className="mt-2 underline" onClick={() => c.export()}>Export evidence & scenario</button>
      {game.multiplayer && <p className="mt-2 text-[var(--muted-foreground)]">Live multiplayer review cannot pause or seek the simulation.</p>}
    </section>}
  </div>;
}
