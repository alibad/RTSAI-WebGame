import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, CircleCheck, CircleX, Clapperboard, Diamond, Film, Lightbulb, LoaderCircle, LocateFixed, Lock, MapPin, Play, Rocket, Target, Trophy, X } from "lucide-react";
import type { Game } from "../game";
import { useStore } from "../store";
import { Flag } from "./Flag";
import { actLabel, campaign as story, castMember, launchable, nextChapter } from "../campaign";
import { EA_NOTICE } from "../legal";
import { EmptyState, GameButton } from "./kit/game";
import { Brackets, Meter, ScreenBackdrop, Segmented } from "./screen-parts";
import { filmLength, useBriefings, useWholeFile } from "../briefings";
import { CastPortrait, LazyImage } from "./Portrait";
import { RadioPanel } from "./Radio";

// The campaign as a story: the prologue's film first, then the acts with their chapters (maps, commanders, progress;
// chapters still in production locked), the epilogue's film after the last act and the next part's locked card; the
// chosen chapter's briefing, objectives and film, then Start mission (or the film first). MissionHud is the operation's
// objectives panel during the match, with its radio calls under it.

function progress(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem("rtsai.missions.completed") ?? "{}"); } catch { return {}; }
}

const DIFFICULTIES = [{ value: "easy", label: "Easy" }, { value: "normal", label: "Normal" }, { value: "hard", label: "Hard" }] as const;
type Difficulty = (typeof DIFFICULTIES)[number]["value"];

/** The first sentence of a chapter's intro: the one line a locked chapter shows. */
const teaser = (text: string) => /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;

export function Missions({ game }: { game: Game }) {
  const setup = useStore((s) => s.setup)!;
  const missions = useMemo(() => setup.missions ?? [], [setup.missions]);
  const ids = useMemo(() => missions.map((m) => m.id), [missions]);
  /** The operations that can start: in this game's catalog and not still in production (campaign.ts). */
  const startable = useMemo(() => missions.filter((m) => launchable(m.id, ids)), [missions, ids]);
  const first = startable[0];
  const [selected, setSelected] = useState(() => {
    try { return sessionStorage.getItem("rtsai.campaign.next") ?? first?.id ?? ""; } catch { return first?.id ?? ""; }
  });
  const [showFilm, setShowFilm] = useState(false);
  const [filmError, setFilmError] = useState(false);
  const [deployAfterFilm, setDeployAfterFilm] = useState(false);
  const playOnOpen = useRef(false);
  const briefings = useBriefings();
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const prepared = useStore((s) => s.preparedMap);
  const sheets = useStore((s) => s.sheets);
  const previews = useStore((s) => s.previews);
  const publicShot = useStore((s) => s.publicShot);
  const detail = useRef<HTMLElement>(null);
  const completed = progress();
  // The prologue and the epilogue show once their films are published (in the briefings index under their ids,
  // "prologue" and "epilogue"); either one open is a film part, not an operation.
  const prologueId = story.prologue?.id ?? "prologue";
  const prologueFilm = story.prologue ? briefings[prologueId] : undefined;
  const prologue = prologueFilm ? story.prologue : undefined;
  const epilogueId = story.epilogue?.id ?? "epilogue";
  const epilogueFilm = story.epilogue ? briefings[epilogueId] : undefined;
  const epilogue = epilogueFilm ? story.epilogue : undefined;
  const part = prologue && selected === prologueId ? prologue : epilogue && selected === epilogueId ? epilogue : undefined;
  const partFilm = part ? briefings[part.id] : undefined;
  const partOpen = !!part;
  const partEyebrow = part?.eyebrow ?? (part === epilogue ? "Epilogue" : "Prologue");
  const mission = partOpen ? undefined : startable.find((m) => m.id === selected) ?? first;
  const chapter = mission ? story.chapters[mission.id] : undefined;
  const arcIndex = story.arcs.findIndex((a) => a.missions.includes(mission?.id ?? ""));
  const arc = story.arcs[arcIndex];
  const chapterNumber = arc ? arc.missions.indexOf(mission?.id ?? "") + 1 : 0;
  const speaker = castMember(chapter?.speaker);
  const filmId = part ? part.id : mission?.id;
  useEffect(() => { setShowFilm(playOnOpen.current); playOnOpen.current = false; setFilmError(false); setDeployAfterFilm(false); }, [filmId]);
  const briefing = filmId ? briefings[filmId] : undefined;
  const filmSrc = useWholeFile(showFilm && briefing ? briefing.video : null);
  // The chosen operation is prepared while its briefing is read; with the prologue open, the first one (Begin is instant).
  const target = mission ?? first;
  useEffect(() => {
    if (!target) return;
    game.wantFactions(null, target.faction);
    game.preview(target.id);
    game.prepare(target.id);
  }, [game, target]);
  // Every operation's map, for the chapter list.
  useEffect(() => { for (const m of startable) game.preview(m.id); }, [game, startable]);
  const ready = mission && prepared === mission.id && sheets.uploaded >= sheets.total;
  const deploy = () => {
    if (!ready || !mission) return;
    game.start(JSON.stringify({
      map: mission.id, mission: mission.id, seed: 2026,
      players: [{ slot: mission.slot, faction: mission.faction, color: "2A6FDB" }],
      options: { difficulty, startingcash: "10000", fog: "True", explored: "False" },
    }));
  };
  /** Opens a chapter's briefing (or the prologue); `play` starts its film at once. */
  const choose = (id: string, play = false) => {
    if (play && id === filmId) { setDeployAfterFilm(false); setFilmError(false); setShowFilm(true); }
    else playOnOpen.current = play;
    setSelected(id);
    // One column: the briefing is below the list, so bring it into view.
    if (innerWidth < 1000) requestAnimationFrame(() => detail.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const preview = (id: string) => (publicShot ? "" : previews[id] ?? "");
  const done = startable.filter((m) => completed[m.id]).length;
  const factionName = (id: string) => setup.factions.find((f) => f.id === id)?.name ?? id;
  const loose = startable.filter((m) => !story.arcs.some((a) => a.missions.includes(m.id)));

  const missionButton = (m: (typeof missions)[number], label: string) => {
    const who = story.chapters[m.id]?.speaker;
    return (
      <li key={m.id}>
        <button type="button" className="cp-mission" aria-pressed={selected === m.id} data-chapter={m.id} data-sfx-hover onClick={() => choose(m.id)}>
          <span className="cp-mission-art">
            {preview(m.id) ? <img src={preview(m.id)} alt="" draggable={false} /> : null}
            <span className="cp-mission-flag"><Flag id={m.faction} /></span>
          </span>
          <span className="cp-mission-text"><small>{label}</small><b>{m.title}</b></span>
          {who && <CastPortrait id={who} className="cp-mission-speaker" />}
          {completed[m.id] ? <span className="cp-mission-done" title={`Completed on ${completed[m.id]}`}><Check size={13} strokeWidth={3} aria-hidden="true" /><span className="sr-only">Completed</span></span>
            : <ChevronRight className="cp-mission-go" size={16} aria-hidden="true" />}
          <Brackets />
        </button>
      </li>
    );
  };
  // A chapter still in production (or whose operation this game does not have yet): title, one line, never launchable.
  const lockedCard = (id: string, label: string) => {
    const ch = story.chapters[id];
    return (
      <li key={id}>
        <div className="cp-mission is-locked" data-chapter={id} aria-disabled="true">
          <span className="cp-mission-art"><Lock size={16} aria-hidden="true" /></span>
          <span className="cp-mission-text">
            <span className="cp-mission-label"><small>{label}</small><span className="cp-mission-soon"><Clapperboard size={10} aria-hidden="true" />In production</span></span>
            <b>{ch?.title ?? id}</b>{ch && <span className="cp-mission-teaser">{teaser(ch.intro)}</span>}
          </span>
          {ch?.speaker && <CastPortrait id={ch.speaker} className="cp-mission-speaker" />}
        </div>
      </li>
    );
  };
  const filmName = partOpen ? `the ${partEyebrow.toLowerCase()}` : "story introduction";
  // The films around the acts: a poster card that opens the part and plays it.
  const partCard = (p: NonNullable<typeof part>, film: NonNullable<typeof partFilm>, fallback: string, className: string) => (
    <button type="button" className={className} aria-pressed={selected === p.id} aria-label={`${p.eyebrow ?? fallback}: ${p.title}`} data-sfx-hover onClick={() => choose(p.id, true)}>
      <LazyImage src={film.poster} crossOrigin="anonymous" className="cp-prologue-art" />
      <span className="cp-prologue-play" aria-hidden="true"><Play size={20} fill="currentColor" /></span>
      <span className="cp-prologue-text"><small>{p.eyebrow ?? fallback}</small><b>{p.title}</b></span>
      <span className="cp-prologue-meta"><Film size={12} aria-hidden="true" />{filmLength(film.seconds)}</span>
      <Brackets />
    </button>
  );
  const sequel = story.sequel;

  return (
    <div className="scr-root cp-root" data-ui-sfx>
      <ScreenBackdrop image={partOpen ? partFilm!.poster : mission && preview(mission.id) ? preview(mission.id) : "menu/campaign.webp"} soft={partOpen || !!(mission && preview(mission.id))} />
      <div className="scr-topbar" aria-hidden="true" />
      <main className="scr-content cp-layout">
        <aside className="cp-side">
          <header className="scr-head cp-head">
            <span className="menu-eyebrow">Campaign</span>
            <h1>{story.title}</h1>
            {startable.length > 0 && <div className="cp-progress">
              <Meter value={done / startable.length} label="Campaign progress" />
              <span><b>{done}</b> / {startable.length} operations</span>
            </div>}
          </header>
          {prologue && partCard(prologue, prologueFilm!, "Prologue", "cp-prologue")}
          {story.arcs.map((part, index) => {
            const chapters = part.missions.filter((id) => story.chapters[id] || ids.includes(id));
            if (!chapters.length) return null;
            const open = chapters.filter((id) => launchable(id, ids));
            const partDone = open.filter((id) => completed[id]).length;
            const act = actLabel(part, index);
            return (
              <section key={part.id} className="cp-arc" data-arc={part.id} aria-label={`${act}: ${part.title}`}>
                <header className="cp-arc-head">
                  <span className="cp-arc-index">{act.replace(/^act\s+/i, "")}</span>
                  <div className="cp-arc-title"><span className="menu-eyebrow">{act}</span><h2>{part.title}</h2></div>
                  <span className="cp-arc-pips" aria-label={`${partDone} of ${open.length} complete`}>
                    {chapters.map((id) => <i key={id} data-done={!!completed[id]} data-locked={!launchable(id, ids) || undefined} />)}
                  </span>
                </header>
                <p className="cp-arc-premise">{part.premise}</p>
                <ol className="cp-missions">{chapters.map((id, i) => {
                  const m = launchable(id, ids) ? missions.find((x) => x.id === id) : undefined;
                  return m ? missionButton(m, `Chapter ${i + 1}`) : lockedCard(id, `Chapter ${i + 1}`);
                })}</ol>
              </section>
            );
          })}
          {epilogue && partCard(epilogue, epilogueFilm!, "Epilogue", "cp-prologue cp-epilogue")}
          {sequel && <section className="cp-arc cp-coda" data-arc={sequel.id} aria-label={`${sequel.eyebrow ?? "Next"}: ${sequel.title}`}>
            <div className="cp-mission is-locked cp-sequel" data-chapter={sequel.id} aria-disabled="true">
              <span className="cp-mission-art"><Lock size={16} aria-hidden="true" /></span>
              <span className="cp-mission-text">
                <span className="cp-mission-label"><small>{sequel.eyebrow ?? "Next"}</small><span className="cp-mission-soon"><Clapperboard size={10} aria-hidden="true" />Coming</span></span>
                <b>{sequel.title}</b><span className="cp-mission-teaser">{teaser(sequel.premise)}</span>
              </span>
            </div>
          </section>}
          {loose.length > 0 && <section className="cp-arc" aria-label="More operations">
            <ol className="cp-missions">{loose.map((m) => missionButton(m, m.campaign))}</ol>
          </section>}
          {!startable.length && <EmptyState icon={<Target size={20} />} title="No campaign in this game">This game profile has no compatible missions. Use the public RTS AI profile.</EmptyState>}
        </aside>

        {(mission || partOpen) && <section ref={detail} className="cp-detail" aria-label={partOpen ? partEyebrow : "Operation"}>
          {part ? <div className="cp-hero" key={part.id}>
            <div className="cp-hero-map cp-hero-poster">
              <LazyImage src={partFilm!.poster} crossOrigin="anonymous" />
              <Brackets className="always" />
            </div>
            <div className="cp-hero-text">
              <span className="menu-eyebrow">{partEyebrow} · {story.title}</span>
              <h2>{part.title}</h2>
              <div className="scr-chips"><span className="scr-chip"><Film size={12} aria-hidden="true" />Film · {filmLength(partFilm!.seconds)}</span></div>
            </div>
          </div> : mission && <div className="cp-hero" key={mission.id}>
            <div className="cp-hero-map">
              {preview(mission.id) ? <img src={preview(mission.id)} alt={`${mission.title} map`} draggable={false} /> : <Target size={40} strokeWidth={1.2} aria-hidden="true" />}
              <Brackets className="always" />
            </div>
            <div className="cp-hero-text">
              <span className="menu-eyebrow">{arc ? `${actLabel(arc, arcIndex)} · ${arc.title} · Chapter ${chapterNumber}` : mission.campaign}</span>
              <h2>{mission.title}</h2>
              {chapter && <p className="cp-hero-sub">{chapter.title}</p>}
              <div className="scr-chips">
                <span className="scr-chip"><Flag id={mission.faction} />{factionName(mission.faction)}</span>
                {chapter && <span className="scr-chip"><MapPin size={12} aria-hidden="true" />{chapter.location}</span>}
                {completed[mission.id] && <span className="scr-chip done"><Check size={12} strokeWidth={3} aria-hidden="true" />Completed · {completed[mission.id]}</span>}
              </div>
            </div>
          </div>}

          <div className="cp-body">
            {(chapter || partOpen) && <>
              <div className="cp-voice" data-speaker={chapter?.speaker}>
                {chapter?.speaker && <CastPortrait id={chapter.speaker} className="cp-voice-portrait" />}
                <div className="cp-voice-text">
                  {speaker && <span className="cp-voice-who"><b>{speaker.name}</b>{speaker.role && <small>{speaker.role}</small>}</span>}
                  <p className="cp-intro">{part ? part.intro : chapter!.intro}</p>
                </div>
              </div>
              <div className="cp-film">
                {briefing && !showFilm
                  ? <button type="button" className="cp-film-card" aria-label={`Watch ${filmName}`} data-sfx-hover onClick={() => { setDeployAfterFilm(false); setShowFilm(true); }}>
                      <img src={briefing.poster} alt="" draggable={false} crossOrigin="anonymous" />
                      <span className="cp-film-card-play" aria-hidden="true"><Play size={26} fill="currentColor" /></span>
                      <span className="cp-film-card-meta"><Film size={13} aria-hidden="true" />{partOpen ? partEyebrow : "Briefing"} · {filmLength(briefing.seconds)}</span>
                    </button>
                  : <GameButton size="sm" icon={showFilm ? <X size={14} /> : <Film size={14} />} onClick={() => { setDeployAfterFilm(false); setShowFilm(!showFilm); }}>{showFilm ? `Close ${filmName}` : `Watch ${filmName}`}</GameButton>}
                {showFilm && filmId && <div className="cp-film-player">
                  {!filmError && briefing && !filmSrc ? <div className="cp-film-loading" role="status"><img src={briefing.poster} alt="" draggable={false} crossOrigin="anonymous" /><span><LoaderCircle size={18} className="spin" aria-hidden="true" /> Loading film…</span></div>
                  : !filmError ? <video key={`${filmId}-${deployAfterFilm}-${briefing ? "cdn" : "local"}`} controls playsInline autoPlay={deployAfterFilm || !!briefing} preload="metadata" crossOrigin={briefing ? "anonymous" : undefined} poster={briefing?.poster} aria-label={part ? `${partEyebrow}: ${part.title}` : `${mission!.title} story introduction`} onEnded={() => { if (deployAfterFilm) deploy(); }} onError={() => setFilmError(true)}>
                    <source src={briefing ? filmSrc! : `${import.meta.env.BASE_URL}campaign-video/${filmId}.mp4`} type="video/mp4" onError={() => setFilmError(true)} />
                    <track kind="captions" src={briefing ? briefing.captions : `${import.meta.env.BASE_URL}campaign-video/${filmId}.vtt`} srcLang="en" label="English" default />
                  </video> : <p role="status" className="cp-film-error">{partOpen ? `The film could not load. The ${partEyebrow.toLowerCase()} is written above.` : "The video could not load. The complete story is written above; you can still launch the mission."}</p>}
                  <div className="cp-film-foot">
                    <span>{briefing ? `${partOpen ? partEyebrow : "Briefing"} · ${filmLength(briefing.seconds)} · captions` : "Narrated operations map · captions available · playback is optional"}</span>
                    {deployAfterFilm ? <GameButton variant="ghost" size="sm" disabled={!ready} onClick={deploy}>Skip introduction and deploy</GameButton>
                      : briefing && <GameButton variant="ghost" size="sm" icon={<X size={14} />} onClick={() => setShowFilm(false)}>Close</GameButton>}
                  </div>
                </div>}
              </div>
            </>}

            {mission && <>
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
            </>}
            <p data-testid="ea-notice" className="scr-notice">{EA_NOTICE}</p>
          </div>

          {mission ? <div className="scr-command cp-command">
            <Segmented label="Difficulty" value={difficulty} options={DIFFICULTIES} onChange={setDifficulty} />
            <span className="cp-launch">
              {chapter && <GameButton size="lg" className="cp-briefing" icon={<Play size={15} aria-hidden="true" />} disabled={!ready} onClick={() => { setFilmError(false); setDeployAfterFilm(true); setShowFilm(true); }}>Play briefing & deploy</GameButton>}
              <GameButton variant="primary" size="lg" className="scr-cta cp-start" disabled={!ready} onClick={deploy}
                icon={ready ? <Rocket size={17} aria-hidden="true" /> : <LoaderCircle className="menu-spin" size={17} aria-hidden="true" />}>{ready ? "Start mission" : "Preparing mission…"}</GameButton>
            </span>
          </div> : part && part === epilogue ? sequel && <div className="scr-command cp-command cp-command-begin">
            <span className="cp-launch">
              <GameButton size="lg" className="cp-next-part" disabled icon={<Lock size={15} aria-hidden="true" />}>
                {sequel.eyebrow ?? "Next"} · {sequel.title} · Coming
              </GameButton>
            </span>
          </div> : first && <div className="scr-command cp-command cp-command-begin">
            <span className="cp-launch">
              <GameButton variant="primary" size="lg" className="scr-cta cp-begin" icon={<ChevronRight size={17} aria-hidden="true" />} onClick={() => choose(first.id)}>
                Begin {story.arcs[0] ? actLabel(story.arcs[0], 0) : "the campaign"}
              </GameButton>
            </span>
          </div>}
        </section>}
      </main>
      <div className="scr-footbar" aria-hidden="true" />
    </div>
  );
}

/** The operation's objectives during the match, its radio calls (radio.ts) under them, and the campaign debrief. */
export function MissionHud({ game }: { game: Game }) {
  const mission = useStore((s) => s.ui?.mission);
  const win = useStore((s) => s.ui?.win);
  const catalog = useStore((s) => s.setup?.missions);
  const briefings = useBriefings();
  // Phones start with the objectives folded: the battlefield is small enough already.
  const [expanded, setExpanded] = useState(() => innerWidth >= 700 && innerHeight >= 500);
  useEffect(() => {
    if (mission && win === "Won") {
      try { localStorage.setItem("rtsai.missions.completed", JSON.stringify({ ...progress(), [mission.id]: mission.difficulty })); } catch { /* storage unavailable */ }
    }
  }, [mission?.id, mission?.difficulty, win]);
  useEffect(() => { if (win === "Won" || win === "Lost") setExpanded(true); }, [win]);
  if (!mission) return null;
  const chapter = story.chapters[mission.id];
  // The story runs on across acts; chapters still in production are skipped. After the last one, the epilogue's film.
  const epilogueNext = story.epilogue && briefings[story.epilogue.id] && story.arcs.at(-1)?.missions.includes(mission.id) ? story.epilogue : undefined;
  const next = nextChapter(mission.id, (catalog ?? []).map((m) => m.id)) ?? epilogueNext?.id;
  const nextLabel = epilogueNext && next === epilogueNext.id ? `Watch the ${(epilogueNext.eyebrow ?? "epilogue").toLowerCase()}` : "Continue to next chapter";
  const returnTo = (id: string) => {
    try { sessionStorage.setItem("rtsai.campaign.next", id); } catch { /* storage unavailable */ }
    game.quit();
  };
  const primary = mission.objectives.filter((o) => !o.secondary);
  const doneCount = primary.filter((o) => o.status === "complete").length;
  const over = win === "Won" || win === "Lost";
  return <div className="mh-stack">
    <aside className="mh-panel" data-ui-sfx data-outcome={over ? win : undefined}>
      <button type="button" className="mh-head" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <span className="mh-icon" aria-hidden="true"><Target size={14} /></span>
        <span className="mh-title">{mission.title}</span>
        <span className="mh-count digits">{doneCount}/{primary.length}</span>
        <ChevronDown className="mh-chevron" size={15} aria-hidden="true" />
      </button>
      {expanded && <ul className="mh-objectives" aria-label="Mission objectives">
        {mission.objectives.map((o, i) => <li key={i} data-status={o.status} data-bonus={o.secondary} data-waiting={o.waiting || undefined}>
          <span className="mh-mark" aria-hidden="true">{o.status === "complete" ? <CircleCheck size={14} /> : o.status === "failed" ? <CircleX size={14} /> : o.waiting ? <Lock size={11} /> : <Diamond size={11} />}</span>
          <div className="mh-text">
            <span>{o.text}{o.progress && <b className="mh-progress digits">{o.progress}</b>}{o.secondary && <em>Bonus</em>}</span>
            {o.status === "active" && !!o.markers?.length && <div className="mh-markers">{o.markers.map((m) => <button key={m.name} type="button" onClick={() => game.lookAt(m.x, m.y)}><LocateFixed size={11} aria-hidden="true" />Locate {m.name.replace(/([a-z])([A-Z])/g, "$1 $2")}</button>)}</div>}
          </div>
        </li>)}
      </ul>}
      {over && <section className="mh-debrief" aria-label="Campaign debrief">
        <div className="mh-debrief-head"><span className="mh-debrief-icon" aria-hidden="true">{win === "Won" ? <Trophy size={16} /> : <Target size={16} />}</span><h2>{win === "Won" ? "Operation complete" : "Regroup and retry"}</h2></div>
        <p>{chapter ? (win === "Won" ? chapter.victory : chapter.defeat) : "Return to the campaign to choose an operation."}</p>
        <GameButton variant="primary" size="sm" onClick={() => returnTo(win === "Won" && next ? next : mission.id)}>{win === "Won" && next ? nextLabel : win === "Lost" ? "Retry this chapter" : "Return to campaign"}</GameButton>
      </section>}
    </aside>
    <RadioPanel game={game} />
  </div>;
}
