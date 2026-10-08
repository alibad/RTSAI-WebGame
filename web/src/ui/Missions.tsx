import { useEffect, useState } from "react";
import type { Game } from "../game";
import { useStore } from "../store";
import { Button } from "../components/ui/button";
import { Flag } from "./Flag";
import { cn } from "../lib/utils";

function progress(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem("rtsai.missions.completed") ?? "{}"); } catch { return {}; }
}

export function Missions({ game }: { game: Game }) {
  const setup = useStore((s) => s.setup)!;
  const missions = setup.missions ?? [];
  const [selected, setSelected] = useState(missions[0]?.id ?? "");
  const [difficulty, setDifficulty] = useState("normal");
  const prepared = useStore((s) => s.preparedMap);
  const sheets = useStore((s) => s.sheets);
  const previews = useStore((s) => s.previews);
  const completed = progress();
  const mission = missions.find((m) => m.id === selected);
  useEffect(() => {
    if (!mission) return;
    game.wantFactions(null, mission.faction);
    game.preview(mission.id);
    game.prepare(mission.id);
  }, [game, mission]);
  const ready = mission && prepared === mission.id && sheets.uploaded >= sheets.total;
  return (
    <div className="absolute inset-x-0 bottom-0 top-[64px] overflow-y-auto bg-[#070907] p-6">
      <div className="mx-auto grid max-w-[1200px] grid-cols-[minmax(260px,0.8fr)_minmax(0,1.4fr)] gap-5 max-[800px]:grid-cols-1">
        <section className="hud-panel p-4">
          <h1 className="mb-2 text-[25px] font-black text-[var(--hud-gold)]">Missions</h1>
          <p className="mb-5 text-sm text-[var(--muted-foreground)]">Choose an operation. Every mission is available from the start.</p>
          {[...new Set(missions.map((m) => m.campaign))].map((campaign) => (
            <div key={campaign} className="mb-5">
              <h2 className="mb-2 text-xs uppercase tracking-widest text-[var(--hud-gold-dim)]">{campaign}</h2>
              {missions.filter((m) => m.campaign === campaign).map((m) => (
                <button type="button" key={m.id} onClick={() => setSelected(m.id)} aria-pressed={selected === m.id}
                  className={cn("mb-2 flex w-full items-center gap-3 rounded border border-white/10 p-3 text-left hover:bg-white/5", selected === m.id && "border-[var(--hud-gold)] bg-white/5")}>
                  <Flag id={m.faction} className="h-6 w-10 rounded-sm" />
                  <span className="flex-1 text-sm">{m.title}</span>
                  {completed[m.id] && <span className="text-xs text-[var(--hud-green)]" title={`Completed on ${completed[m.id]}`}>✓</span>}
                </button>
              ))}
            </div>
          ))}
          {!missions.length && <p className="text-sm">This game profile has no compatible missions. Use the public RTS AI profile.</p>}
        </section>
        {mission && <section className="hud-panel p-5">
          {previews[mission.id] && <img src={previews[mission.id]} alt={`${mission.title} map`} className="mb-5 h-[240px] w-full bg-black object-contain [image-rendering:pixelated]" />}
          <h2 className="mb-3 text-xl font-bold text-[var(--hud-gold)]">{mission.title}</h2>
          <p className="mb-5 whitespace-pre-line text-sm leading-relaxed text-[var(--muted-foreground)]">{mission.briefing}</p>
          <h3 className="mb-2 text-sm font-bold">Objectives</h3>
          <ul className="mb-5 space-y-2 text-sm">
            {mission.objectives.map((o, i) => <li key={i}>◇ {o.text}{o.secondary && <span className="text-[var(--muted-foreground)]"> (bonus)</span>}</li>)}
          </ul>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <label htmlFor="mission-difficulty" className="text-sm">Difficulty</label>
            <select id="mission-difficulty" value={difficulty} onChange={(e) => setDifficulty(e.target.value)} className="hud-inset rounded p-2">
              <option value="easy">Easy</option><option value="normal">Normal</option><option value="hard">Hard</option>
            </select>
            <Button disabled={!ready} onClick={() => game.start(JSON.stringify({
              map: mission.id, mission: mission.id, seed: 2026,
              players: [{ slot: mission.slot, faction: mission.faction, color: "2A6FDB" }],
              options: { difficulty, startingcash: "10000", fog: "True", explored: "False" },
            }))}>{ready ? "Start mission" : "Preparing mission…"}</Button>
          </div>
          <p className="text-xs text-[var(--muted-foreground)]">{mission.adaptation}</p>
        </section>}
      </div>
    </div>
  );
}

export function MissionHud({ game }: { game: Game }) {
  const mission = useStore((s) => s.ui?.mission);
  const win = useStore((s) => s.ui?.win);
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    if (mission && win === "Won") {
      try { localStorage.setItem("rtsai.missions.completed", JSON.stringify({ ...progress(), [mission.id]: mission.difficulty })); } catch { /* storage unavailable */ }
    }
  }, [mission?.id, mission?.difficulty, win]);
  if (!mission) return null;
  return <aside className="hud-panel absolute left-3 top-3 z-20 w-[min(370px,calc(100vw-var(--sidebar-w)-24px))] p-3">
    <button type="button" className="flex w-full items-center justify-between text-left text-sm font-bold text-[var(--hud-gold)]" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {mission.title}<span>{expanded ? "−" : "+"}</span>
    </button>
    {expanded && <ul className="mt-3 max-h-[35vh] space-y-2 overflow-auto text-xs leading-relaxed" aria-label="Mission objectives">
      {mission.objectives.map((o, i) => <li key={i} className={cn(o.status === "complete" && "text-[var(--hud-green)]", o.status === "failed" && "text-[var(--hud-red)]")}>
        {o.status === "complete" ? "✓" : o.status === "failed" ? "✕" : "◇"} {o.text} {o.progress && <span className="text-[var(--hud-gold-dim)]">{o.progress}</span>}{o.secondary && " (bonus)"}
        {o.status === "active" && !!o.markers?.length && <div className="mt-1 flex flex-wrap gap-2">{o.markers.map((m) => <button key={m.name} type="button" className="text-[var(--hud-gold-dim)] underline" onClick={() => game.lookAt(m.x, m.y)}>Locate {m.name.replace(/([a-z])([A-Z])/g, "$1 $2")}</button>)}</div>}
      </li>)}
    </ul>}
  </aside>;
}
