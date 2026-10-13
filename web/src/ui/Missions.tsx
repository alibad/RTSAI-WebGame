import { GameSelect } from "../components/ui/fields";
import { useEffect, useState } from "react";
import type { Game } from "../game";
import { useStore } from "../store";
import { Button } from "../components/ui/button";
import { Flag } from "./Flag";
import { cn } from "../lib/utils";
import story from "../campaign-story";
import { EA_NOTICE } from "../legal";

function progress(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem("rtsai.missions.completed") ?? "{}"); } catch { return {}; }
}

export function Missions({ game }: { game: Game }) {
  const setup = useStore((s) => s.setup)!;
  const missions = setup.missions ?? [];
  const [selected, setSelected] = useState(() => {
    try { return sessionStorage.getItem("rtsai.campaign.next") ?? missions[0]?.id ?? ""; } catch { return missions[0]?.id ?? ""; }
  });
  const [showFilm, setShowFilm] = useState(false);
  const [filmError, setFilmError] = useState(false);
  const [deployAfterFilm, setDeployAfterFilm] = useState(false);
  const [difficulty, setDifficulty] = useState("normal");
  const prepared = useStore((s) => s.preparedMap);
  const sheets = useStore((s) => s.sheets);
  const previews = useStore((s) => s.previews);
  const completed = progress();
  const mission = missions.find((m) => m.id === selected) ?? missions[0];
  const chapter = mission ? story.chapters[mission.id as keyof typeof story.chapters] : undefined;
  const arc = story.arcs.find((a) => a.missions.includes(mission?.id ?? ""));
  const chapterNumber = arc ? arc.missions.indexOf(mission?.id ?? "") + 1 : 0;
  useEffect(() => { setShowFilm(false); setFilmError(false); setDeployAfterFilm(false); }, [mission?.id]);
  useEffect(() => {
    if (!mission) return;
    game.wantFactions(null, mission.faction);
    game.preview(mission.id);
    game.prepare(mission.id);
  }, [game, mission]);
  const ready = mission && prepared === mission.id && sheets.uploaded >= sheets.total;
  const deploy = () => {
    if (!ready || !mission) return;
    game.start(JSON.stringify({
      map: mission.id, mission: mission.id, seed: 2026,
      players: [{ slot: mission.slot, faction: mission.faction, color: "2A6FDB" }],
      options: { difficulty, startingcash: "10000", fog: "True", explored: "False" },
    }));
  };
  return (
    <div className="absolute inset-x-0 bottom-0 top-[64px] overflow-y-auto bg-[#070907] p-6">
      <div className="mx-auto grid max-w-[1200px] grid-cols-[minmax(260px,0.8fr)_minmax(0,1.4fr)] gap-5 max-[800px]:grid-cols-1">
        <section className="hud-panel p-4">
          <h1 className="mb-2 text-[25px] font-black text-[var(--hud-gold)]">{story.title}</h1>
          <p className="mb-5 text-sm text-[var(--muted-foreground)]">Two campaign arcs. Six operations. Your progress stays on this device; every chapter is available to replay.</p>
          {story.arcs.map((campaign) => (
            <div key={campaign.id} className="mb-5">
              <h2 className="mb-2 text-sm font-bold text-[var(--hud-gold)]">{campaign.title} · {campaign.missions.filter((id) => completed[id]).length}/{campaign.missions.length}</h2>
              <p className="mb-3 text-xs leading-relaxed text-[var(--muted-foreground)]">{campaign.premise}</p>
              {campaign.missions.map((id) => missions.find((m) => m.id === id)).filter((m) => !!m).map((m, index) => (
                <button type="button" key={m.id} onClick={() => setSelected(m.id)} aria-pressed={selected === m.id}
                  className={cn("mb-2 flex w-full items-center gap-3 rounded border border-white/10 p-3 text-left hover:bg-white/5", selected === m.id && "border-[var(--hud-gold)] bg-white/5")}>
                  <Flag id={m.faction} className="h-6 w-10 rounded-sm" />
                  <span className="flex-1 text-sm"><span className="text-[var(--hud-gold-dim)]">{index + 1}. </span>{m.title}</span>
                  {completed[m.id] && <span className="text-xs text-[var(--hud-green)]" title={`Completed on ${completed[m.id]}`}>✓</span>}
                </button>
              ))}
            </div>
          ))}
          {missions.filter((m) => !story.arcs.some((a) => a.missions.includes(m.id))).map((m) => <button key={m.id} className="mb-2 block text-sm" onClick={() => setSelected(m.id)}>{m.title}</button>)}
          {!missions.length && <p className="text-sm">This game profile has no compatible missions. Use the public RTS AI profile.</p>}
          <p data-testid="ea-notice" className="mt-4 text-[11px] leading-snug text-[var(--muted-foreground)]">{EA_NOTICE}</p>
        </section>
        {mission && <section className="hud-panel p-5">
          <p className="mb-2 text-xs uppercase tracking-widest text-[var(--hud-gold-dim)]">{arc ? `${arc.title} / Chapter ${chapterNumber}` : mission.campaign}</p>
          {previews[mission.id] && <img src={previews[mission.id]} alt={`${mission.title} map`} className="mb-5 h-[240px] w-full bg-black object-contain [image-rendering:pixelated]" />}
          <h2 className="mb-3 text-xl font-bold text-[var(--hud-gold)]">{mission.title}</h2>
          {chapter && <>
            <h3 className="mb-2 text-lg font-semibold">{chapter.title}</h3>
            <p className="mb-4 text-sm leading-relaxed text-[var(--muted-foreground)]">{chapter.intro}</p>
            <button type="button" className="mb-4 text-sm text-[var(--hud-gold)] underline" onClick={() => { setDeployAfterFilm(false); setShowFilm(!showFilm); }}>{showFilm ? "Close story introduction" : "Watch story introduction"}</button>
            {showFilm && <div className="mb-5">
              {!filmError ? <video key={`${mission.id}-${deployAfterFilm}`} controls playsInline autoPlay={deployAfterFilm} preload="metadata" className="w-full rounded bg-black" aria-label={`${mission.title} story introduction`} onEnded={() => { if (deployAfterFilm) deploy(); }} onError={() => setFilmError(true)}>
                <source src={`${import.meta.env.BASE_URL}campaign-video/${mission.id}.mp4`} type="video/mp4" onError={() => setFilmError(true)} />
                <track kind="captions" src={`${import.meta.env.BASE_URL}campaign-video/${mission.id}.vtt`} srcLang="en" label="English" default />
              </video> : <p role="status" className="text-sm">The video could not load. The complete story is written above; you can still launch the mission.</p>}
              <p className="mt-2 text-xs text-[var(--muted-foreground)]">Narrated operations map · captions available · playback is optional</p>
              {deployAfterFilm && <button type="button" disabled={!ready} className="mt-2 text-sm text-[var(--hud-gold)] underline" onClick={deploy}>Skip introduction and deploy</button>}
            </div>}
            <p className="mb-4 text-sm leading-relaxed"><b>Command advice:</b> {chapter.tactics}</p>
          </>}
          <details className="mb-5 text-sm text-[var(--muted-foreground)]"><summary className="cursor-pointer">Original mission briefing and background</summary><p className="mt-3 whitespace-pre-line leading-relaxed">{mission.briefing}</p></details>
          <h3 className="mb-2 text-sm font-bold">Objectives</h3>
          <ul className="mb-5 space-y-2 text-sm">
            {mission.objectives.map((o, i) => <li key={i}>◇ {o.text}{o.secondary && <span className="text-[var(--muted-foreground)]"> (bonus)</span>}</li>)}
          </ul>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <label htmlFor="mission-difficulty" className="text-sm">Difficulty</label>
            <GameSelect id="mission-difficulty" value={difficulty} onChange={(e) => setDifficulty(e.target.value)} className="hud-inset rounded p-2">
              <option value="easy">Easy</option><option value="normal">Normal</option><option value="hard">Hard</option>
            </GameSelect>
            <Button disabled={!ready} onClick={deploy}>{ready ? "Start mission" : "Preparing mission…"}</Button>
            {chapter && <Button disabled={!ready} onClick={() => { setFilmError(false); setDeployAfterFilm(true); setShowFilm(true); }}>Play briefing & deploy</Button>}
          </div>
          <p className="text-xs text-[var(--muted-foreground)]">{mission.adaptation}</p>
          <p className="mt-2 text-xs text-[var(--muted-foreground)]">Original fictional story. Campaign arcs connect perspectives and exercises; they do not transfer armies or resources between missions.</p>
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
  const chapter = story.chapters[mission.id as keyof typeof story.chapters];
  const arc = story.arcs.find((a) => a.missions.includes(mission.id));
  const next = arc?.missions[(arc.missions.indexOf(mission.id) ?? -1) + 1];
  const returnTo = (id: string) => {
    try { sessionStorage.setItem("rtsai.campaign.next", id); } catch { /* storage unavailable */ }
    game.quit();
  };
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
    {(win === "Won" || win === "Lost") && <section className="mt-3 border-t border-white/10 pt-3" aria-label="Campaign debrief">
      <h2 className="text-sm font-bold text-[var(--hud-gold)]">{win === "Won" ? "Operation complete" : "Regroup and retry"}</h2>
      <p className="mt-2 text-xs leading-relaxed">{chapter ? (win === "Won" ? chapter.victory : chapter.defeat) : "Return to the campaign to choose an operation."}</p>
      <button type="button" className="mt-3 text-sm text-[var(--hud-gold)] underline" onClick={() => returnTo(win === "Won" && next ? next : mission.id)}>{win === "Won" && next ? "Continue to next chapter" : win === "Lost" ? "Retry this chapter" : "Return to campaign"}</button>
    </section>}
  </aside>;
}
