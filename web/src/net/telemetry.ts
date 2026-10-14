// What the game reports (see net/track.ts): loading, each match's start and end, and fatal errors. Multiplayer and
// the AI co-commander report their own events where they happen.
import type { Game } from "../game";
import { useStore } from "../store";
import { track } from "./track";
import { gpuInfo } from "../gpu";

type Scenario = { map?: string; mission?: string; multiplayer?: boolean; sandbox?: boolean; webReplay?: unknown; players?: { client?: number; bot?: string }[] };

let pageErrorsInstalled = false;
/** Report uncaught page failures without sending exception text, rejected values, URLs or stacks. */
function installPageErrorReporting() {
  if (pageErrorsInstalled) return;
  pageErrorsInstalled = true;
  const seen = new Set<string>();
  const names = new Set(["Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "URIError", "EvalError", "AggregateError"]);
  const report = (where: string, error: unknown, filename?: string, line?: number) => {
    try {
      const kind = error instanceof Error && names.has(error.name) ? error.name : "Error";
      let file = "unknown";
      if (filename) {
        const name = new URL(filename, location.href).pathname.split("/").pop() ?? "";
        if (/^[A-Za-z0-9_.-]{1,80}$/.test(name)) file = name;
      }
      const signature = `${where}:${kind}:${file}:${line ?? 0}`;
      if (seen.has(signature) || seen.size >= 20) return;
      seen.add(signature);
      track("game_error", { where, message: kind, file, line: Number.isFinite(line) ? line : undefined });
    } catch { /* Diagnostics must never cause another page failure. */ }
  };
  window.addEventListener("error", (event) => report("page", event.error, event.filename, event.lineno));
  window.addEventListener("unhandledrejection", (event) => report("promise", event.reason));
}

export function installTelemetry(game: Game) {
  installPageErrorReporting();
  let loaded = false, match: { kind: string; at: number; ended: boolean; map?: string; faction?: string } | null = null;
  const mode = () => useStore.getState().profile === "public-classic" ? "classic" : "isometric";
  const end = (result: string) => {
    if (!match || match.ended) return;
    match.ended = true;
    track("match_ended", { kind: match.kind, result, minutes: Math.round((performance.now() - match.at) / 6000) / 10, mode: mode(),
      map: match.map, faction: match.faction });
  };
  window.addEventListener("rtsai:world-started", () => {
    let s: Scenario = {};
    try { s = JSON.parse(game.scenarioJson || "{}"); } catch { /* reported without details */ }
    if (s.webReplay) return; // watching a replay is not playing a match
    const kind = s.multiplayer ? "multiplayer" : s.mission ? "campaign" : s.sandbox ? "scenario" : "skirmish";
    const info = useStore.getState().info, local = info?.players.find(p => p.name === info.localPlayer);
    const map = s.mission ?? s.map, faction = local?.faction;
    match = { kind, at: performance.now(), ended: false, map, faction };
    track("match_started", { kind, mode: mode(), map, faction, players: s.players?.length });
  });
  useStore.subscribe((s, prev) => {
    if (!loaded && s.phase === "setup") { loaded = true; track("game_loaded", { mode: mode(), seconds: Math.round(performance.now() / 100) / 10, gpu: gpuInfo().software ? "software" : "hardware" }); }
    const win = s.ui?.win, before = prev.ui?.win;
    if (win !== before && (win === "Won" || win === "Lost")) end(win === "Won" ? "won" : "lost");
    if (s.phase === "setup" && prev.phase === "playing") end("left");
    if (s.phase === "error" && prev.phase !== "error") { end("error"); track("game_error", { where: "runtime", message: (s.error || "unknown").split("\n")[0].slice(0, 200) }); }
  });
}
