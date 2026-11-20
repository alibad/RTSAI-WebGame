// A battle setup that outlives the page: everything the battle simulator needs to lay a fight out again (the map, the
// two nations, the enemy's skill, money and fog, and every placed unit with its own rank, health and order).
// - Saved: "My battles", kept in this browser (localStorage), newest first.
// - Copied: a link in the simulator's own format (?mode=sandbox&s=<base64url JSON>, sandbox.ts parseSandboxUrl), so it
//   opens on rtsai.net/play for anyone. A random map travels as the request that made it (the generator is
//   deterministic: MapGen.cs); a map made in the editor or from a real place lives in this browser only, and its
//   link says so.

import type { AiSkill, Placement, SideSettings } from "./sandbox";

export interface BattleSetup {
  id: string;
  name: string;
  savedAt: number;
  map: string;
  mapTitle: string;
  /** The generator request of a random map (game.ts GenerateRequest as JSON): the map can be made again anywhere. */
  gen?: string;
  /** The map is one of the player's own (editor, real place): it exists only in this browser's library. */
  own?: boolean;
  fa: string;
  fb: string;
  skill: AiSkill;
  money: number;
  fog: boolean;
  sides: [SideSettings, SideSettings];
  placements: Placement[];
}

const KEY = "rtsai.sim-setups", LIMIT = 40;

export function savedSetups(): BattleSetup[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((s) => s && typeof s.id === "string" && Array.isArray(s.placements)) : [];
  } catch { return []; }
}

function write(list: BattleSetup[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, LIMIT))); return true; } catch { return false; }
}

/** Keeps a setup (a new one, or the same id again after a rename). False when the browser refuses storage. */
export function keepSetup(setup: BattleSetup) {
  return write([setup, ...savedSetups().filter((s) => s.id !== setup.id)]);
}

export function removeSetup(id: string) { write(savedSetups().filter((s) => s.id !== id)); }

export const setupId = () => `battle-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

/** How many units each side has placed. */
export const setupCounts = (s: Pick<BattleSetup, "placements">): [number, number] =>
  [s.placements.filter((p) => p.side === 0).length, s.placements.filter((p) => p.side === 1).length];

function b64url(text: string) {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The setup as a link into the battle simulator. Placements keep only what differs from the defaults, to stay short. */
export function setupLink(s: Omit<BattleSetup, "id" | "name" | "savedAt" | "mapTitle">, href = location.href) {
  const url = new URL(href);
  const keep = new URLSearchParams();
  // The page's own switches (the game profile, a developer runtime) stay; everything about the battle is in `s`.
  for (const k of ["profile", "game", "runtime"]) if (url.searchParams.has(k)) keep.set(k, url.searchParams.get(k)!);
  keep.set("mode", "sandbox");
  keep.set("s", b64url(JSON.stringify({
    v: 2, fa: s.fa, fb: s.fb, map: s.map, ...(s.gen ? { gen: JSON.parse(s.gen) } : {}), skill: s.skill, money: s.money, fog: s.fog,
    placements: s.placements.map((p) => ({
      id: p.id, side: p.side, u: p.u, v: p.v,
      ...(p.name ? { name: p.name } : {}), ...(p.level ? { level: p.level } : {}), ...(p.health !== undefined && p.health < 100 ? { health: p.health } : {}),
      ...(p.facing !== undefined ? { facing: p.facing } : {}), ...(p.order ? { order: p.order } : {}), ...(p.destination ? { destination: p.destination } : {}),
      ...(p.deploy ? { deploy: true } : {}),
    })),
  })));
  url.search = keep.toString();
  url.hash = "";
  return url.href;
}
