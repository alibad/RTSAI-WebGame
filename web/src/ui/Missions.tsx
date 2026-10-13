import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, CircleCheck, CircleX, Diamond, Film, Lightbulb, LoaderCircle, LocateFixed, MapPin, Play, Rocket, Target, Trophy, X } from "lucide-react";
import type { Game } from "../game";
import { useStore } from "../store";
import { Flag } from "./Flag";
import story from "../campaign-story";
import { EA_NOTICE } from "../legal";
import { EmptyState, GameButton } from "./kit/game";
import { Brackets, Meter, ScreenBackdrop, Segmented } from "./screen-parts";

// The campaign: story arcs as chapters with their maps and progress, the chosen operation's briefing, objectives and
// film, then Start mission (or the film first). MissionHud is the operation's objectives panel during the match.

function progress(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem("rtsai.missions.completed") ?? "{}"); } catch { return {}; }
}

const DIFFICULTIES = [{ value: "easy", label: "Easy" }, { value: "normal", label: "Normal" }, { value: "hard", label: "Hard" }] as const;
type Difficulty = (typeof DIFFICULTIES)[number]["value"];

export function Missions({ game }: { game: Game }) {
  const setup = useStore((s) => s.setup)!;
  const missions = setup.missions ?? [];
  const [selected, setSelected] = useState(() => {
    try { return sessionStorage.getItem("rtsai.campaign.next") ?? missions[0]?.id ?? ""; } catch { return missions[0]?.id ?? ""; }
  });
  const [showFilm, setShowFilm] = useState(false);
  const [filmError, setFilmError] = useState(false);
  const [deployAfterFilm, setDeployAfterFilm] = useState(false);
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const prepared = useStore((s) => s.preparedMap);
  const sheets = useStore((s) => s.sheets);
  const previews = useStore((s) => s.previews);
  const publicShot = useStore((s) => s.publicShot);
  const detail = useRef<HTMLElement>(null);
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
  // Every operation's map, for the chapter list.
  useEffect(() => { for (const m of missions) game.preview(m.id); }, [game, missions]);
  const ready = mission && prepared === mission.id && sheets.uploaded >= sheets.total;
  const deploy = () => {
    if (!ready || !mission) return;
    game.start(JSON.stringify({
      map: mission.id, mission: mission.id, seed: 2026,
      players: [{ slot: mission.slot, faction: mission.faction, color: "2A6FDB" }],
      options: { difficulty, startingcash: "10000", fog: "True", explored: "False" },
    }));
  };
  const choose = (id: string) => {
    setSelected(id);
    // One column: the briefing is below the list, so bring it into view.
    if (innerWidth < 1000) requestAnimationFrame(() => detail.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const preview = (id: string) => (publicShot ? "" : previews[id] ?? "");
  const done = missions.filter((m) => completed[m.id]).length;
  const factionName = (id: string) => setup.factions.find((f) => f.id === id)?.name ?? id;
  const loose = missions.filter((m) => !story.arcs.some((a) => a.missions.includes(m.id)));

  const missionButton = (m: (typeof missions)[number], label: string) => (
    <li key={m.id}>
      <button type="button" className="cp-mission" aria-pressed={selected === m.id} data-sfx-hover onClick={() => choose(m.id)}>
        <span className="cp-mission-art">
          {preview(m.id) ? <img src={preview(m.id)} alt="" draggable={false} /> : null}
          <span className="cp-mission-flag"><Flag id={m.faction} /></span>
        </span>
        <span className="cp-mission-text"><small>{label}</small><b>{m.title}</b></span>
        {completed[m.id] ? <span className="cp-mission-done" title={`Completed on ${completed[m.id]}`}><Check size={13} strokeWidth={3} aria-hidden="true" /><span className="sr-only">Completed</span></span>
          : <ChevronRight className="cp-mission-go" size={16} aria-hidden="true" />}
        <Brackets />
      </button>
    </li>
  );

  return (
    <div className="scr-root cp-root" data-ui-sfx>
      <ScreenBackdrop image={mission && preview(mission.id) ? preview(mission.id) : "menu/campaign.webp"} soft={!!(mission && preview(mission.id))} />
      <div className="scr-topbar" aria-hidden="true" />
      <main className="scr-content cp-layout">
        <aside className="cp-side">
          <header className="scr-head cp-head">
            <span className="menu-eyebrow">Campaign</span>
            <h1>{story.title}</h1>
            {missions.length > 0 && <div className="cp-progress">
              <Meter value={done / missions.length} label="Campaign progress" />
              <span><b>{done}</b> / {missions.length} operations</span>
            </div>}
          </header>
          {story.arcs.map((campaign, index) => {
            const list = campaign.missions.map((id) => missions.find((m) => m.id === id)).filter((m) => !!m);
            if (!list.length) return null;
            const arcDone = campaign.missions.filter((id) => completed[id]).length;
            return (
              <section key={campaign.id} className="cp-arc" aria-label={campaign.title}>
                <header className="cp-arc-head">
                  <span className="cp-arc-index">{index + 1}</span>
                  <div className="cp-arc-title"><span className="menu-eyebrow">Story arc {index + 1}</span><h2>{campaign.title}</h2></div>
                  <span className="cp-arc-pips" aria-label={`${arcDone} of ${campaign.missions.length} complete`}>
                    {campaign.missions.map((id) => <i key={id} data-done={!!completed[id]} />)}
                  </span>
                </header>
                <p className="cp-arc-premise">{campaign.premise}</p>
                <ol className="cp-missions">{list.map((m, i) => missionButton(m, `Chapter ${i + 1}`))}</ol>
              </section>
            );
          })}
          {loose.length > 0 && <section className="cp-arc" aria-label="More operations">
            <ol className="cp-missions">{loose.map((m) => missionButton(m, m.campaign))}</ol>
          </section>}
          {!missions.length && <EmptyState icon={<Target size={20} />} title="No campaign in this game">This game profile has no compatible missions. Use the public RTS AI profile.</EmptyState>}
        </aside>

        {mission && <section ref={detail} className="cp-detail" aria-label="Operation">
          <div className="cp-hero" key={mission.id}>
            <div className="cp-hero-map">
              {preview(mission.id) ? <img src={preview(mission.id)} alt={`${mission.title} map`} draggable={false} /> : <Target size={40} strokeWidth={1.2} aria-hidden="true" />}
              <Brackets className="always" />
            </div>
            <div className="cp-hero-text">
              <span className="menu-eyebrow">{arc ? `${arc.title} · Chapter ${chapterNumber}` : mission.campaign}</span>
              <h2>{mission.title}</h2>
              {chapter && <p className="cp-hero-sub">{chapter.title}</p>}
              <div className="scr-chips">
                <span className="scr-chip"><Flag id={mission.faction} />{factionName(mission.faction)}</span>
                {chapter && <span className="scr-chip"><MapPin size={12} aria-hidden="true" />{chapter.location}</span>}
                {completed[mission.id] && <span className="scr-chip done"><Check size={12} strokeWidth={3} aria-hidden="true" />Completed · {completed[mission.id]}</span>}
              </div>
            </div>
          </div>

          <div className="cp-body">
            {chapter && <>
              <p className="cp-intro">{chapter.intro}</p>
              <div className="cp-film">
                <GameButton size="sm" icon={showFilm ? <X size={14} /> : <Film size={14} />} onClick={() => { setDeployAfterFilm(false); setShowFilm(!showFilm); }}>{showFilm ? "Close story introduction" : "Watch story introduction"}</GameButton>
                {showFilm && <div className="cp-film-player">
                  {!filmError ? <video key={`${mission.id}-${deployAfterFilm}`} controls playsInline autoPlay={deployAfterFilm} preload="metadata" aria-label={`${mission.title} story introduction`} onEnded={() => { if (deployAfterFilm) deploy(); }} onError={() => setFilmError(true)}>
                    <source src={`${import.meta.env.BASE_URL}campaign-video/${mission.id}.mp4`} type="video/mp4" onError={() => setFilmError(true)} />
                    <track kind="captions" src={`${import.meta.env.BASE_URL}campaign-video/${mission.id}.vtt`} srcLang="en" label="English" default />
                  </video> : <p role="status" className="cp-film-error">The video could not load. The complete story is written above; you can still launch the mission.</p>}
                  <div className="cp-film-foot">
                    <span>Narrated operations map · captions available · playback is optional</span>
                    {deployAfterFilm && <GameButton variant="ghost" size="sm" disabled={!ready} onClick={deploy}>Skip introduction and deploy</GameButton>}
                  </div>
                </div>}
              </div>
            </>}

            <div className="cp-cols">
              <section className="cp-card">
                <h3 className="scr-label"><Target size={14} aria-hidden="true" />Objectives</h3>
                <ul className="cp-objectives">
                  {mission.objectives.map((o, i) => <li key={i} data-bonus={o.secondary}><Diamond size={11} aria-hidden="true" /><span>{o.text}</span>{o.secondary && <em>Bonus</em>}</li>)}
                </ul>
              </section>
              {chapter && <section className="cp-card">
                <h3 className="scr-label"><Lightbulb size={14} aria-hidden="true" />Command advice</h3>
                <p className="cp-advice">{chapter.tactics}</p>
              </section>}
            </div>

            <details className="cp-original"><summary>Original mission briefing and background</summary><p>{mission.briefing}</p></details>
            <p className="scr-fine">{mission.adaptation} Original fictional story. Campaign arcs connect perspectives and exercises; they do not transfer armies or resources between missions.</p>
            <p data-testid="ea-notice" className="scr-notice">{EA_NOTICE}</p>
          </div>

          <div className="scr-command cp-command">
            <Segmented label="Difficulty" value={difficulty} options={DIFFICULTIES} onChange={setDifficulty} />
            <span className="cp-launch">
              {chapter && <GameButton size="lg" className="cp-briefing" icon={<Play size={15} aria-hidden="true" />} disabled={!ready} onClick={() => { setFilmError(false); setDeployAfterFilm(true); setShowFilm(true); }}>Play briefing & deploy</GameButton>}
              <GameButton variant="primary" size="lg" className="scr-cta cp-start" disabled={!ready} onClick={deploy}
                icon={ready ? <Rocket size={17} aria-hidden="true" /> : <LoaderCircle className="menu-spin" size={17} aria-hidden="true" />}>{ready ? "Start mission" : "Preparing mission…"}</GameButton>
            </span>
          </div>
        </section>}
      </main>
      <div className="scr-footbar" aria-hidden="true" />
    </div>
  );
}

/** The operation's objectives during the match, and the campaign debrief when it ends. */
export function MissionHud({ game }: { game: Game }) {
  const mission = useStore((s) => s.ui?.mission);
  const win = useStore((s) => s.ui?.win);
  // Phones start with the objectives folded: the battlefield is small enough already.
  const [expanded, setExpanded] = useState(() => innerWidth >= 700 && innerHeight >= 500);
  useEffect(() => {
    if (mission && win === "Won") {
      try { localStorage.setItem("rtsai.missions.completed", JSON.stringify({ ...progress(), [mission.id]: mission.difficulty })); } catch { /* storage unavailable */ }
    }
  }, [mission?.id, mission?.difficulty, win]);
  useEffect(() => { if (win === "Won" || win === "Lost") setExpanded(true); }, [win]);
  if (!mission) return null;
  const chapter = story.chapters[mission.id as keyof typeof story.chapters];
  const arc = story.arcs.find((a) => a.missions.includes(mission.id));
  const next = arc?.missions[(arc.missions.indexOf(mission.id) ?? -1) + 1];
  const returnTo = (id: string) => {
    try { sessionStorage.setItem("rtsai.campaign.next", id); } catch { /* storage unavailable */ }
    game.quit();
  };
  const primary = mission.objectives.filter((o) => !o.secondary);
  const doneCount = primary.filter((o) => o.status === "complete").length;
  const over = win === "Won" || win === "Lost";
  return <aside className="mh-panel" data-ui-sfx data-outcome={over ? win : undefined}>
    <button type="button" className="mh-head" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <span className="mh-icon" aria-hidden="true"><Target size={14} /></span>
      <span className="mh-title">{mission.title}</span>
      <span className="mh-count digits">{doneCount}/{primary.length}</span>
      <ChevronDown className="mh-chevron" size={15} aria-hidden="true" />
    </button>
    {expanded && <ul className="mh-objectives" aria-label="Mission objectives">
      {mission.objectives.map((o, i) => <li key={i} data-status={o.status} data-bonus={o.secondary}>
        <span className="mh-mark" aria-hidden="true">{o.status === "complete" ? <CircleCheck size={14} /> : o.status === "failed" ? <CircleX size={14} /> : <Diamond size={11} />}</span>
        <div className="mh-text">
          <span>{o.text}{o.progress && <b className="mh-progress digits">{o.progress}</b>}{o.secondary && <em>Bonus</em>}</span>
          {o.status === "active" && !!o.markers?.length && <div className="mh-markers">{o.markers.map((m) => <button key={m.name} type="button" onClick={() => game.lookAt(m.x, m.y)}><LocateFixed size={11} aria-hidden="true" />Locate {m.name.replace(/([a-z])([A-Z])/g, "$1 $2")}</button>)}</div>}
        </div>
      </li>)}
    </ul>}
    {over && <section className="mh-debrief" aria-label="Campaign debrief">
      <div className="mh-debrief-head"><span className="mh-debrief-icon" aria-hidden="true">{win === "Won" ? <Trophy size={16} /> : <Target size={16} />}</span><h2>{win === "Won" ? "Operation complete" : "Regroup and retry"}</h2></div>
      <p>{chapter ? (win === "Won" ? chapter.victory : chapter.defeat) : "Return to the campaign to choose an operation."}</p>
      <GameButton variant="primary" size="sm" onClick={() => returnTo(win === "Won" && next ? next : mission.id)}>{win === "Won" && next ? "Continue to next chapter" : win === "Lost" ? "Retry this chapter" : "Return to campaign"}</GameButton>
    </section>}
  </aside>;
}
