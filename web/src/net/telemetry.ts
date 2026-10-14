// What the game reports (see net/track.ts): loading, each match's start and end, and fatal errors. Multiplayer and
// the AI co-commander report their own events where they happen.
import type { Game } from "../game";
import { useStore } from "../store";
import { track } from "./track";
import { gpuInfo } from "../gpu";

type Scenario = { map?: string; mission?: string; multiplayer?: boolean; sandbox?: boolean; webReplay?: unknown; players?: { client?: number; bot?: string }[] };

export function installTelemetry(game: Game) {
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
