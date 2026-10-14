import { useEffect, useRef, useState } from "react";
import { Game } from "./game";
import { useStore } from "./store";
import { Hud } from "./ui/Hud";
import { Setup } from "./ui/Setup";
import { Missions, MissionHud } from "./ui/Missions";
import { Multiplayer } from "./ui/Multiplayer";
import { MatchLibrary } from "./ui/MatchLibrary";
import { GameSettings } from "./ui/GameSettings";
import { MapWorkshop } from "./ui/MapWorkshop";
import { SandboxHud } from "./ui/SandboxHud";
import { ARENA, Sandbox, parseSandboxUrl } from "./sandbox";
import { Practice } from "./ui/Practice";
import { CoachPanel } from "./ui/Coach";
import { Annotations } from "./ui/Annotations";
import { installTelemetry } from "./net/telemetry";
import { Feedback } from "./ui/Feedback";
import { MainMenu } from "./ui/MainMenu";
import { GraphicsState } from "./ui/GraphicsState";
import { RESUME_AFTER_RELOAD, savedRecord, startRecord } from "./ui/MatchLibrary";
import { installUiFeel } from "./ui/feel";
import { siteOrigin } from "./net/account";
import { mySavedMaps, savedMap } from "./net/saved-maps";
import { ArrowLeft, Check, Copy, Map as MapIcon, RotateCcw, TriangleAlert } from "lucide-react";
import { GameButton, Kbd } from "./ui/kit/game";
import { Brackets, Meter, ScreenBackdrop } from "./ui/screen-parts";
import { keyFor, type Command } from "./preferences";

// What the engine is doing while it boots or builds a match (the worker's "progress" stages) as the player reads it,
// and roughly how far along that is: the bar never goes back and creeps forward while a step runs.
const LOAD_STEPS: Record<string, [number, string]> = {
  "Starting the engine": [0.04, "Starting the engine"],
  "Downloading game data": [0.18, "Downloading game data"],
  "Mounting game data": [0.6, "Unpacking game data"],
  "Loading rules": [0.68, "Loading the rules"],
  "boot.mods": [0.74, "Loading the armies"],
  "boot.moddata": [0.8, "Loading the armies"],
  "boot.loaders": [0.86, "Preparing the art"],
  "boot.maps": [0.92, "Surveying the battlefields"],
  "Building the world": [0.06, "Building the world"],
  "Loading art": [0.12, "Loading art"],
  "Starting the co-commander": [0.93, "Briefing your co-commander"],
};
const LOAD_TIPS: [Command, string][] = [
  ["deploy", "Deploy: unpack your construction vehicle into a base."],
  ["guard", "Guard: selected units follow and protect another unit."],
  ["attackmove", "Attack move (or Ctrl+Shift+click): your units fight whatever they meet on the way."],
  ["repair", "Repair: click a damaged building to fix it."],
  ["sell", "Sell: click one of your buildings to turn it back into credits."],
  ["stop", "Stop: selected units drop their current orders."],
  ["typeselect", "Type select: every unit of the selected types on screen; twice for the whole map."],
];

function useLoadProgress(phase: string, stage: string, detail: string) {
  const [value, setValue] = useState(0);
  const state = useRef({ phase, value: 0, artSeen: false });
  if (state.current.phase !== phase) state.current = { phase, value: 0, artSeen: false };
  if (stage === "Loading art") state.current.artSeen = true;
  const art = stage === "Loading art" ? /^(\d+)\s*\/\s*(\d+)$/.exec(detail) : null;
  const target = art ? 0.12 + 0.74 * (Number(art[1]) / Math.max(1, Number(art[2])))
    : stage === "Building the world" && state.current.artSeen ? 0.88 : LOAD_STEPS[stage]?.[0] ?? state.current.value;
  state.current.value = Math.max(state.current.value, target);
  useEffect(() => {
    const ceiling = Math.min(0.97, target + (art ? 0.04 : 0.1));
    const timer = setInterval(() => {
      const s = state.current;
      if (s.value < ceiling) s.value += (ceiling - s.value) * 0.025;
      setValue(s.value);
    }, 120);
    return () => clearInterval(timer);
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps
  return Math.max(value, state.current.value);
}

function Loading({ game }: { game: Game | null }) {
  const phase = useStore((s) => s.phase);
  const stage = useStore((s) => s.stage);
  const detail = useStore((s) => s.detail);
  const setup = useStore((s) => s.setup);
  const previews = useStore((s) => s.previews);
  const publicShot = useStore((s) => s.publicShot);
  const progress = useLoadProgress(phase, stage, detail);
  const [tip, setTip] = useState(() => Math.floor(Math.random() * LOAD_TIPS.length));
  useEffect(() => { const t = setInterval(() => setTip((i) => (i + 1) % LOAD_TIPS.length), 6000); return () => clearInterval(t); }, []);
  // Building a match: where the player is going.
  let target: { title: string; preview: string } | null = null;
  if (phase === "loading" && game?.scenarioJson && setup) {
    try {
      const scenario = JSON.parse(game.scenarioJson) as { map?: string; mission?: string };
      const id = scenario.mission ?? scenario.map ?? "";
      const title = setup.missions?.find((m) => m.id === id)?.title ?? setup.maps.find((m) => m.id === id)?.title;
      if (title) target = { title, preview: publicShot ? "" : previews[id] ?? "" };
    } catch { /* no scenario */ }
  }
  const label = LOAD_STEPS[stage]?.[1] ?? (stage.includes(".") || !stage ? "Preparing" : stage);
  const [key, text] = LOAD_TIPS[tip];
  return (
    <div className="ld-root" aria-busy="true">
      <ScreenBackdrop image={target?.preview || "menu/backdrop.webp"} soft={!!target?.preview} />
      <div className="ld-logo">
        <span className="menu-eyebrow">Modern real-time strategy</span>
        <div className="ld-wordmark">RTS <b>AI</b></div>
      </div>
      <div className="ld-panel">
        {target && <div className="ld-deploy">
          {target.preview && <span className="ld-deploy-map"><img src={target.preview} alt="" /><Brackets className="always" /></span>}
          <span className="ld-deploy-text"><span className="menu-eyebrow">Deploying to</span><b>{target.title}</b></span>
        </div>}
        <div className="ld-status" aria-live="polite"><span>{label}</span><span className="digits">{Math.round(progress * 100)}%</span></div>
        <Meter value={progress} label="Loading" className="ld-meter" />
        <p key={tip} className="ld-tip"><Kbd>{keyFor(key).toUpperCase()}</Kbd><span>{text}</span></p>
      </div>
    </div>
  );
}

function ErrorCard({ game }: { game: Game | null }) {
  const error = useStore((s) => s.error);
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(error).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }, () => undefined);
  return (
    <div className="er-root" data-ui-sfx role="alertdialog" aria-modal="true" aria-labelledby="er-title" aria-describedby="er-text">
      <ScreenBackdrop />
      <section className="er-panel">
        <span className="er-icon" aria-hidden="true"><TriangleAlert size={26} /></span>
        <h1 id="er-title">Something went wrong</h1>
        <p id="er-text">The game stopped unexpectedly. Reloading usually fixes it.</p>
        <div className="er-actions">
          <GameButton variant="primary" size="lg" icon={<RotateCcw size={16} />} onClick={() => location.reload()}>Reload</GameButton>
          {game && <GameButton size="lg" onClick={() => game.quit()}>Back to menu</GameButton>}
        </div>
        {error && <details className="er-details">
          <summary>Technical details</summary>
          <pre>{error}</pre>
          <GameButton variant="ghost" size="sm" icon={copied ? <Check size={14} /> : <Copy size={14} />} onClick={() => void copy()}>{copied ? "Copied" : "Copy details"}</GameButton>
        </details>}
      </section>
    </div>
  );
}

let autostarted = false;
let savedMapsLoaded = false;

// The Earth studio lives on the website (RTSAI-Web /studio); its "Play in browser" comes back here with ?saved=<id>.
const studioUrl = `${siteOrigin}/studio`;

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [practiceOpen, setPracticeOpen] = useState(new URLSearchParams(location.search).get("mode") === "practice");
  const [mapStudioOpen, setMapStudioOpen] = useState(new URLSearchParams(location.search).get("mode") === "map-studio");
  const [mode, setMode] = useState<"home" | "skirmish" | "missions">(() => {
    const mode = new URLSearchParams(location.search).get("mode");
    return mode === "missions" ? "missions" : mode === "skirmish" ? "skirmish" : "home";
  });
  const phase = useStore((s) => s.phase);
  const uiHidden = useStore((s) => s.uiHidden);
  const graphics = useStore((s) => s.graphics);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const g = new Game(canvasRef.current!);
    Object.assign(window as object, { game: g, store: useStore });
    const only = params.get("only") ?? (params.get("shot") === "1" ? "r2" : null);
    if (only) g.renderer.actorFilter = (t) => g.client.str(t).startsWith(only);
    setGame(g);
    installTelemetry(g);
    const uninstallFeel = installUiFeel();
    // AOT by default; ?runtime=interp is the developer fallback. ?private=0 runs without the player's own files.
    // A static public build (tools/build-public.mjs) defaults to the standalone game, and so does the installed app

    const requested = params.get("profile") ?? import.meta.env.VITE_DEFAULT_PROFILE ?? "public";
    const profile = params.get("game") === "classic" || requested === "public-classic" ? "public-classic" : "public";
    // The strategy adviser uses the native bridge inside this browser. Local model/voice service is optional.
    useStore.getState().set({ ccAvailable: true, ccLocalAvailable: false });
    if (import.meta.env.VITE_STATIC_BUILD !== "1") fetch(new URL("api/companion/status", new URL("./", location.href)))
      .then((r) => (r.ok ? r.json() : null)).then((s) => {
        const local = !!s && typeof s.running === "boolean";
        useStore.getState().set({ ccLocalAvailable: local });
        if (!local) g.cc.setMode("browser");
      }).catch(() => g.cc.setMode("browser"));
    g.boot(params.get("runtime") ?? "aot", params.get("private") !== "0", profile);
    return () => { uninstallFeel(); g.dispose(); };
  }, []);

  // ?mode=sandbox: the battle sandbox instead of a skirmish (the Studio's Encounter opens it with placements).
  const sandboxMode = new URLSearchParams(location.search).get("mode") === "sandbox";
  useEffect(() => {
    if (!game || !sandboxMode || phase !== "setup" || game.sandbox) return;
    const sb = new Sandbox(game, parseSandboxUrl(new URLSearchParams(location.search)));
    game.sandbox = sb;
    game.prepare(ARENA);
    sb.edit();
  }, [game, phase, sandboxMode]);

  // ?scenario=<name> starts a bundled scenario as soon as the engine is ready (benchmarks, tests).
  useEffect(() => {
    const scenario = new URLSearchParams(location.search).get("scenario");
    if (game && phase === "setup" && scenario && !autostarted) {
      autostarted = true;
      fetch(new URL(`scenarios/${scenario}.json`, new URL("./", location.href))).then((r) => r.text()).then((t) => game.start(t));
    }
  }, [game, phase]);

  // Players' saved Earth maps join the map lists once the engine is ready; ?saved=<id> opens skirmish on that map.
  useEffect(() => {
    if (!game || phase !== "setup" || savedMapsLoaded) return;
    savedMapsLoaded = true;
    void mySavedMaps().then((maps) => game.addSavedMaps(maps)).catch((e) => console.warn("saved maps:", e));
    const saved = new URLSearchParams(location.search).get("saved");
    if (saved) void savedMap(saved).then((map) => {
      const url = new URL(location.href);
      url.searchParams.delete("saved");
      if (map) { game.addSavedMaps([map]); url.searchParams.set("map", map.id); url.searchParams.set("mode", "skirmish"); setMode("skirmish"); }
      history.replaceState(null, "", url);
    }).catch((e) => console.warn("saved map:", e));
  }, [game, phase]);

  // The graphics were reset mid-match and the match saved (GraphicsState): after the reload, carry on from that save.
  useEffect(() => {
    if (!game || phase !== "setup") return;
    let id: string | null = null;
    try { id = sessionStorage.getItem(RESUME_AFTER_RELOAD); sessionStorage.removeItem(RESUME_AFTER_RELOAD); } catch { /* storage unavailable */ }
    const record = id ? savedRecord(id) : null;
    if (record) void startRecord(game, record, false).then((why) => { if (why) console.warn("resume after reload:", why); });
  }, [game, phase]);

  // The menus use the mod's cursors too: ask for them as soon as the mod is loaded.
  useEffect(() => { if (game && phase === "setup") game.requestCursors(); }, [game, phase]);

  const playing = phase === "playing";
  return (
    <div className="fixed inset-0" data-playing={playing || undefined} style={sandboxMode ? ({ "--sidebar-w": "300px" } as React.CSSProperties) : undefined}>
      <canvas ref={canvasRef} className="stage" tabIndex={0} style={{ right: playing ? "var(--sidebar-w)" : 0, width: playing ? "calc(100% - var(--sidebar-w))" : "100%", visibility: playing ? "visible" : "hidden" }} />
      {game && playing && !uiHidden && !practiceOpen && (sandboxMode ? <SandboxHud game={game} /> : <Hud game={game} />)}
      {game && phase === "setup" && !sandboxMode && !mapStudioOpen && <>
        <div className="menu-utility" data-ui-sfx><MatchLibrary game={game} /><GameSettings game={game} /><Feedback game={game} /></div>
        {mode === "home" ? <MainMenu onSkirmish={() => setMode("skirmish")} onCampaign={() => setMode("missions")} onWorkshop={() => setPracticeOpen(true)} onMapStudio={import.meta.env.VITE_STATIC_BUILD !== "1" ? () => setMapStudioOpen(true) : () => location.assign(studioUrl)} /> : <>
          {mode === "missions" ? <Missions game={game} /> : <Setup game={game} />}
          <nav className="menu-subnav scr-subnav" aria-label="Game modes" data-ui-sfx>
            <button type="button" onClick={() => setMode("home")} className="menu-subnav-back" aria-label="Main menu"><ArrowLeft size={15} aria-hidden="true" /><span>Main menu</span></button>
            <div className="scr-tabs">
              <button type="button" aria-current={mode === "skirmish" ? "page" : undefined} onClick={() => setMode("skirmish")}>Skirmish</button>
              <button type="button" aria-current={mode === "missions" ? "page" : undefined} onClick={() => setMode("missions")}>Campaign</button>
            </div>
            <button type="button" className="menu-subnav-studio" aria-label="Map studio" onClick={() => import.meta.env.VITE_STATIC_BUILD !== "1" ? setMapStudioOpen(true) : location.assign(studioUrl)}><MapIcon size={15} aria-hidden="true" /><span>Map studio</span></button>
          </nav>
        </>}
      </>}
      {game && playing && !sandboxMode && !uiHidden && <MissionHud game={game} />}
      {game && playing && !practiceOpen && !uiHidden && <CoachPanel game={game} />}
      {game && playing && !practiceOpen && !uiHidden && <Annotations game={game} />}
      {game && useStore.getState().setup && practiceOpen && <Practice game={game} close={() => setPracticeOpen(false)} />}
      {game && phase === "setup" && mapStudioOpen && <MapWorkshop game={game} close={() => setMapStudioOpen(false)} />}
      {game && !mapStudioOpen && !sandboxMode && <Multiplayer game={game} />}
      {(phase === "boot" || phase === "loading" || (phase === "setup" && sandboxMode)) && <Loading game={game} />}
      {phase === "error" && <ErrorCard game={game} />}
      {game && (playing || phase === "loading" || graphics === "failed") && <GraphicsState game={game} />}
    </div>
  );
}
