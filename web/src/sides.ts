// One place for how sides and nations look across the menus, the simulator and the editor: player colours, the modern
// nations and the names of the classic sides. The engine's own lists (factions, bots, maps) come from SetupInfo.

import type { SetupData } from "./sim/protocol";

/** Player colours offered in setup screens (engine hex, no '#'). The first two are side A (blue) and side B (red). */
export const PLAYER_COLORS: readonly string[] = ["2A6FDB", "D83A2E", "3FAE49", "E7B42F", "E8702A", "25A6A6", "8E4FD1", "E05A9C"];

/** The two sides of a battle as the engine takes them, and as CSS colours. */
export const ENGINE_SIDE_COLORS: readonly [string, string] = [PLAYER_COLORS[0], PLAYER_COLORS[1]];
export const SIDE_COLORS = ENGINE_SIDE_COLORS.map((c) => `#${c}`) as [string, string];

/** The modern nations (the mod's modern-factions); the rest are the classic countries. */
export const MODERN_NATIONS = new Set(["saudi", "iran", "china", "turkey", "israel", "yemen", "hezbollah"]);

/** What the classic sides are called in the game's own random picks ("Random Coalition Country"). */
export const SIDE_NAME: Record<string, string> = { Allies: "Coalition", Soviets: "Union" };

/** A nation's group in pickers: Modern, Coalition or Union. */
export const nationGroup = (f: SetupData["factions"][number]) => MODERN_NATIONS.has(f.id) ? "Modern" : SIDE_NAME[f.side] ?? f.side;

/** The nations a player can pick (not the random entries). */
export const playableNations = (setup: SetupData | null | undefined) => (setup?.factions ?? []).filter((f) => !f.random);
