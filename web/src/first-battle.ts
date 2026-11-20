// "Your first battle" (main menu): one press from the menu to a match a newcomer can win by following the built-in
// adviser. On 20 Nov 2026 six filmed first matches against the skirmish default (Normal AI) were lost or never ended;
// the owner chose this guided match from a mock-up the same day.
//
// The match: the player's last nation (Saudi Arabia, the skirmish default, for someone new), a small two-player map,
// and one opponent on the battle simulator's "Easy" (the standard AI with the mod's handicap: weaker weapons and
// armour, slower building; sandbox.ts AI_SKILLS). The adviser is switched on for it.

import { MODERN_NATIONS, PLAYER_COLORS } from "./sides";
import type { SetupData } from "./sim/protocol";

/** Little Big Lake first: the smallest two-player land map in the isometric set. */
const MAPS = ["ra2-little-big-lake", "twin-fords"];
const OPPONENTS = ["iran", "saudi", "turkey"];
/** The opponent's handicap in percent (the simulator's Easy). */
export const FIRST_BATTLE_HANDICAP = 50;

function saved<T>(key: string): T | undefined {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : undefined; } catch { return undefined; }
}

/** Whether this game's content can hold the first battle (the isometric set with its modern nations). */
export function firstBattleOffered(setup: SetupData | null) {
  return !!setup && setup.modId !== "rtsai-classic-core" && MAPS.some((id) => setup.maps.some((m) => m.id === id && m.slots.length >= 2))
    && setup.factions.some((f) => MODERN_NATIONS.has(f.id));
}

/** The first battle's scenario (Game.start), or null when this content cannot hold it. */
export function firstBattleScenario(setup: SetupData) {
  if (!firstBattleOffered(setup)) return null;
  const map = MAPS.map((id) => setup.maps.find((m) => m.id === id && m.slots.length >= 2)).find(Boolean)!;
  const nations = setup.factions.filter((f) => !f.random);
  const has = (id?: string) => !!id && nations.some((f) => f.id === id);
  // The nation the player chose last in a skirmish (Setup.tsx keeps it), else the skirmish's own default.
  const mine = [saved<string>("rtsai.ra2.faction"), saved<string>("rtsai.faction"), "saudi"].find(has) ?? nations.find((f) => MODERN_NATIONS.has(f.id))!.id;
  const enemy = OPPONENTS.find((id) => id !== mine && has(id)) ?? nations.find((f) => f.id !== mine)!.id;
  const myColor = [saved<string>("rtsai.ra2.color"), PLAYER_COLORS[0]].find((c) => !!c && PLAYER_COLORS.includes(c))!;
  const enemyColor = PLAYER_COLORS.find((c) => c !== myColor && c !== PLAYER_COLORS[0]) ?? PLAYER_COLORS[1];
  const bot = setup.bots.find((b) => b.type === "normal")?.type ?? setup.bots[0]?.type ?? "normal";
  const options = { ...Object.fromEntries((setup.options ?? []).map((o) => [o.id, o.default])), cheats: "False", "rtsai-cocommander": "True" };
  return {
    map: map.id,
    seed: Math.floor(Math.random() * 1e9),
    players: [
      { slot: map.slots[0], faction: mine, color: myColor },
      { slot: map.slots[1], faction: enemy, color: enemyColor, bot, doctrine: "standard", handicap: FIRST_BATTLE_HANDICAP },
    ],
    options,
  };
}
