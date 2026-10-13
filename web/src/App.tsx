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
import { installUiFeel } from "./ui/feel";

function Loading() {
  const stage = useStore((s) => s.stage);
  const detail = useStore((s) => s.detail);
  return (
    <div className="absolute inset-0 grid place-items-center bg-[radial-gradient(ellipse_at_50%_40%,#1a2219,#070907_70%)]">
      <div className="flex flex-col items-center gap-4">
        <div className="text-[30px] font-black tracking-wide text-[var(--hud-gold)]">RTS AI</div>
        <div className="flex items-center gap-3 text-[13px]">
          <div className="spinner" />
          <span>{stage}</span>
          {detail && <span className="text-[var(--muted-foreground)]">{detail}</span>}
        </div>
      </div>
    </div>
  );
}

function ErrorCard({ game }: { game: Game | null }) {
  const error = useStore((s) => s.error);
  return (
    <div className="absolute inset-0 grid place-items-center bg-black/80 p-6">
      <div className="hud-panel w-[min(720px,100%)] p-5">
        <div className="mb-2 text-[16px] font-bold text-[var(--hud-red)]">Something went wrong</div>
        <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap text-[11px] text-[var(--muted-foreground)]">{error}</pre>
        <div className="mt-3 flex gap-2">
          <button type="button" className="text-[var(--hud-gold)] underline" onClick={() => location.reload()}>Reload</button>
          {game && <button type="button" className="text-[var(--muted-foreground)] underline" onClick={() => game.quit()}>Back to setup</button>}
        </div>
      </div>
    </div>
  );
}

let autostarted = false;

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

  // The menus use the mod's cursors too: ask for them as soon as the mod is loaded.
  useEffect(() => { if (game && phase === "setup") game.requestCursors(); }, [game, phase]);

  const playing = phase === "playing";
  return (
    <div className="fixed inset-0" style={sandboxMode ? ({ "--sidebar-w": "300px" } as React.CSSProperties) : undefined}>
      <canvas ref={canvasRef} className="stage" tabIndex={0} style={{ right: playing ? "var(--sidebar-w)" : 0, width: playing ? "calc(100% - var(--sidebar-w))" : "100%", visibility: playing ? "visible" : "hidden" }} />
      {game && playing && !uiHidden && !practiceOpen && (sandboxMode ? <SandboxHud game={game} /> : <Hud game={game} />)}
      {game && phase === "setup" && !sandboxMode && !mapStudioOpen && <>
        <div className="menu-utility" data-ui-sfx><MatchLibrary game={game} /><GameSettings game={game} /><Feedback game={game} /></div>
        {mode === "home" ? <MainMenu onSkirmish={() => setMode("skirmish")} onCampaign={() => setMode("missions")} onWorkshop={() => setPracticeOpen(true)} onMapStudio={import.meta.env.VITE_STATIC_BUILD !== "1" ? () => setMapStudioOpen(true) : undefined} /> : <>
          {mode === "missions" ? <Missions game={game} /> : <Setup game={game} />}
          <nav className="menu-subnav" aria-label="Game modes" data-ui-sfx>
            <button type="button" onClick={() => setMode("home")} className="menu-subnav-back">← Main menu</button>
            <button type="button" onClick={() => setMode(mode === "missions" ? "skirmish" : "missions")}>{mode === "missions" ? "Skirmish" : "Campaign"}</button>
            {import.meta.env.VITE_STATIC_BUILD !== "1" && <button type="button" onClick={() => setMapStudioOpen(true)}>Map studio</button>}
          </nav>
        </>}
      </>}
      {game && playing && !sandboxMode && !uiHidden && <MissionHud game={game} />}
      {game && playing && !practiceOpen && !uiHidden && <CoachPanel game={game} />}
      {game && playing && !practiceOpen && !uiHidden && <Annotations game={game} />}
      {game && useStore.getState().setup && practiceOpen && <Practice game={game} close={() => setPracticeOpen(false)} />}
      {game && phase === "setup" && mapStudioOpen && <MapWorkshop game={game} close={() => setMapStudioOpen(false)} />}
      {game && !mapStudioOpen && !sandboxMode && <Multiplayer game={game} />}
      {(phase === "boot" || phase === "loading" || (phase === "setup" && sandboxMode)) && <Loading />}
      {phase === "error" && <ErrorCard game={game} />}
    </div>
  );
}
