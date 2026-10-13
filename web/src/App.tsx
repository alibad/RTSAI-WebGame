import { useEffect, useRef, useState } from "react";
import { EA_NOTICE } from "./legal";
import { Game } from "./game";
import { useStore } from "./store";
import { Hud } from "./ui/Hud";
import { Setup } from "./ui/Setup";
import { Missions, MissionHud } from "./ui/Missions";
import { Multiplayer } from "./ui/Multiplayer";
import { DirectMultiplayer } from "./ui/DirectMultiplayer";
import { MatchLibrary } from "./ui/MatchLibrary";
import { GameSettings } from "./ui/GameSettings";
import { MapWorkshop } from "./ui/MapWorkshop";
import { SandboxHud } from "./ui/SandboxHud";
import { ARENA, Sandbox, parseSandboxUrl } from "./sandbox";
import { Practice } from "./ui/Practice";
import { CoachPanel } from "./ui/Coach";
import { Annotations } from "./ui/Annotations";

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
    return () => g.dispose();
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

  const playing = phase === "playing";
  return (
    <div className="fixed inset-0" style={sandboxMode ? ({ "--sidebar-w": "300px" } as React.CSSProperties) : undefined}>
      <canvas ref={canvasRef} className="stage" tabIndex={0} style={{ right: playing ? "var(--sidebar-w)" : 0, width: playing ? "calc(100% - var(--sidebar-w))" : "100%", visibility: playing ? "visible" : "hidden" }} />
      {game && playing && !uiHidden && !practiceOpen && (sandboxMode ? <SandboxHud game={game} /> : <Hud game={game} />)}
      {game && phase === "setup" && !sandboxMode && !mapStudioOpen && <>
        <div className="absolute bottom-4 left-4 z-20 flex gap-2"><MatchLibrary game={game} /><GameSettings game={game} /></div>
        {mode === "home" ? <div className="absolute inset-0 grid place-items-center overflow-auto bg-[radial-gradient(ellipse_at_40%_30%,#24301b,#070907_75%)] p-6">
          <div className="w-[min(760px,100%)]">
            <h1 className="mb-3 text-5xl font-black tracking-wide text-[var(--hud-gold)]">RTS AI</h1>
            <p className="mb-8 text-[var(--muted-foreground)]">Choose your command.</p>
            <div className="mb-6 flex flex-wrap items-center gap-3" aria-label="Gameplay mode">
              <span className="text-sm">Gameplay mode</span>
              {[{ id: "isometric", name: "Isometric" }, { id: "classic", name: "Classic / top-down" }].filter(item => import.meta.env.VITE_STATIC_BUILD !== "1" || (import.meta.env.VITE_GAME_MODES ?? "public").split(",").includes(item.id === "classic" ? "public-classic" : "public")).map(item => <button key={item.id} type="button" aria-pressed={(useStore.getState().profile === "public-classic" ? "classic" : "isometric") === item.id} className="rounded border border-white/20 px-4 py-2" onClick={() => { const url = new URL(location.href); url.searchParams.set("game", item.id); url.searchParams.set("profile", item.id === "classic" ? "public-classic" : "public"); location.assign(url); }}>{item.name}</button>)}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <button type="button" className="hud-panel p-7 text-left hover:bg-white/5" onClick={() => setMode("skirmish")}>
                <h2 className="mb-2 text-2xl font-bold text-[var(--hud-gold)]">Skirmish</h2>
                <p className="text-sm text-[var(--muted-foreground)]">Choose a faction, build your base, and fight AI opponents.</p>
              </button>
              <button type="button" className="hud-panel p-7 text-left hover:bg-white/5" onClick={() => setMode("missions")}>
                <h2 className="mb-2 text-2xl font-bold text-[var(--hud-gold)]">Campaign</h2>
                <p className="text-sm text-[var(--muted-foreground)]">Lines of Hope: two story arcs, six operations, and narrated introductions.</p>
              </button>
            </div>
            <button type="button" className="hud-panel mt-4 w-full p-5 text-left" onClick={() => setPracticeOpen(true)}><h2 className="text-xl font-bold text-[var(--hud-gold)]">Scenario workshop</h2><p className="text-sm text-[var(--muted-foreground)]">Describe, preview and launch a repeatable practice battle.</p></button>
            {import.meta.env.VITE_STATIC_BUILD !== "1" && <button type="button" className="hud-panel mt-4 w-full p-5 text-left" onClick={() => setMapStudioOpen(true)}><h2 className="text-xl font-bold text-[var(--hud-gold)]">Map studio</h2><p className="text-sm text-[var(--muted-foreground)]">Explore the preserved map library, or turn a real place into a new battlefield.</p></button>}
            <p data-testid="ea-notice" className="mt-6 text-[11px] leading-snug text-[var(--muted-foreground)]">{EA_NOTICE}</p>
          </div>
        </div> : <>
          {mode === "missions" ? <Missions game={game} /> : <Setup game={game} />}
          <nav className="absolute left-4 top-3 z-20 flex gap-3 rounded bg-black/80 p-2 text-sm" aria-label="Game modes">
            <button type="button" onClick={() => setMode("home")} className="text-[var(--hud-gold)]">← Main menu</button>
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
      {game && !mapStudioOpen && import.meta.env.VITE_STATIC_BUILD !== "1" && !sandboxMode && (phase === "setup" || phase === "playing" || phase === "loading") && <Multiplayer game={game} />}
      {game && !mapStudioOpen && !sandboxMode && <DirectMultiplayer game={game} />}
      {(phase === "boot" || phase === "loading" || (phase === "setup" && sandboxMode)) && <Loading />}
      {phase === "error" && <ErrorCard game={game} />}
    </div>
  );
}
