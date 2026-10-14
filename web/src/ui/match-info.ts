// What a match is, for the in-match UI (saves, replays, the pause menu, the result screen): its name, its sides and
// game time as mm:ss. Read from the scenario JSON the match was started with and the setup the engine sent.

import type { SetupData } from "../sim/protocol";

/** Engine ticks per second of game time (40 ms GameTimestep). */
export const TICKS_PER_SECOND = 25;

/** Game time as m:ss (h:mm:ss past an hour). */
export function clock(ticks: number) {
  const total = Math.max(0, Math.floor(ticks / TICKS_PER_SECOND));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export interface ScenarioLike {
  map?: unknown; mission?: unknown; multiplayer?: unknown; sandbox?: unknown; placements?: unknown[];
  players?: { faction?: string; bot?: string; color?: string; client?: number }[];
  webReplay?: { readonly?: boolean; end?: number; tick?: number };
}

let cache: { json: string; value: ScenarioLike } = { json: "", value: {} };
/** The scenario of a JSON string, parsed once per string (a replay's log makes it large). */
export function parseScenario(json: string): ScenarioLike {
  if (json === cache.json) return cache.value;
  let value: ScenarioLike = {};
  try { value = JSON.parse(json || "{}") ?? {}; } catch { value = {}; }
  cache = { json, value };
  return value;
}

/**
 * "Twin Fords", or the operation's title for a campaign mission. `known`: the name a save recorded, for a map this
 * session's list does not have (a random map is made in the session that plays it).
 */
export function matchTitle(scenario: ScenarioLike, setup: SetupData | null, known?: string) {
  const mission = typeof scenario.mission === "string" ? setup?.missions?.find((m) => m.id === scenario.mission) : undefined;
  if (mission) return mission.title;
  const id = typeof scenario.map === "string" ? scenario.map : "";
  return setup?.maps.find((m) => m.id === id)?.title ?? (known || (id.startsWith("gen-") ? "Random map" : prettify(id)));
}

/** "Skirmish", "Campaign", "Practice battle" or "Multiplayer". */
export function matchKind(scenario: ScenarioLike) {
  if (scenario.multiplayer === true) return "Multiplayer";
  if (typeof scenario.mission === "string") return "Campaign";
  if (scenario.sandbox === true || scenario.placements?.length) return "Practice battle";
  return "Skirmish";
}

export interface Side { faction: string; name: string; color: string; you: boolean; nation: string }
/** Every player of the scenario with its nation, colour and a short name ("You", "Normal AI"). */
export function matchSides(scenario: ScenarioLike, setup: SetupData | null): Side[] {
  const players = Array.isArray(scenario.players) ? scenario.players : [];
  let humanSeen = false;
  return players.map((p, i) => {
    const faction = typeof p.faction === "string" ? p.faction : "random";
    const you = !p.bot && !humanSeen;
    if (!p.bot) humanSeen = true;
    const bot = p.bot ? setup?.bots.find((b) => b.type === p.bot)?.name ?? "AI" : "";
    const nation = setup?.factions.find((f) => f.id === faction)?.name ?? prettify(faction);
    return { faction, nation, color: `#${(typeof p.color === "string" ? p.color : ["2A6FDB", "D83A2E", "3FB950", "E3B341"][i % 4]).replace(/^#/, "")}`, you, name: you ? "You" : p.bot ? bot : `Player ${i + 1}`, };
  });
}

function prettify(id: string) {
  return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim() || "Unknown battlefield";
}
