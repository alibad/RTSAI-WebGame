import { useEffect, useRef, useState } from "react";
import { Game } from "./game";
import { useStore } from "./store";
import { Hud } from "./ui/Hud";
import { Setup } from "./ui/Setup";
import { SandboxHud } from "./ui/SandboxHud";
import { ARENA, Sandbox, parseSandboxUrl } from "./sandbox";

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
    // ?profile=public: the standalone game (project art and audio only, never the player's files).
    // A static public build (tools/build-public.mjs) defaults to the standalone game, and so does the installed app
    // (its window opens without a query; ?profile=classic there still opens the RA2 game with the player's files).
    const installed = matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: window-controls-overlay)").matches;
    const profile = (params.get("profile") ?? import.meta.env.VITE_DEFAULT_PROFILE ?? (installed ? "public" : "")) === "public" ? "public" : "";
    // The co-commander needs the local server (it starts the companion and relays its RPCs); a static host has none.
    fetch(new URL("api/companion/status", new URL("./", location.href)))
      .then((r) => (r.ok ? r.json() : null)).then((s) => useStore.getState().set({ ccAvailable: !!s && typeof s.running === "boolean" }))
      .catch(() => useStore.getState().set({ ccAvailable: false }));
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
      {game && playing && !uiHidden && (sandboxMode ? <SandboxHud game={game} /> : <Hud game={game} />)}
      {game && phase === "setup" && !sandboxMode && <Setup game={game} />}
      {(phase === "boot" || phase === "loading" || (phase === "setup" && sandboxMode)) && <Loading />}
      {phase === "error" && <ErrorCard game={game} />}
    </div>
  );
}
