// Lays forces out on any map for the battle simulator and the Earth missions: formations around a point facing a
// target, in map cells (MPos), and the simulator's "describe it" planner, which reads a request with the Scenario
// workshop's own interpreter (ai-lab.ts) and places both sides at the map's start positions.

import { interpret, type PracticePlan, type Rosters, type UnitOption } from "./ai-lab";
import type { Placement, SandboxOrder, SimUnit } from "./sandbox";

export type Cell = { u: number; v: number };

/** An isometric MPos as a point on screen (one u is a tile width, two v a tile height); enough for directions. */
const screen = (c: Cell) => ({ x: 2 * c.u + (c.v & 1), y: c.v });

/** The engine facing (WAngle, 0 north, 256 west, 512 south, 768 east) from one cell toward another. */
export function facingToward(from: Cell, to: Cell) {
  const a = screen(from), b = screen(to);
  const dx = b.x - a.x, dy = b.y - a.y;
  if (!dx && !dy) return 512;
  return ((Math.round(-Math.atan2(dx, -dy) / (2 * Math.PI) * 1024) % 1024) + 1024) % 1024;
}

/**
 * `count` cells in ranks around `center`, the front rank toward `toward`, `spacing` cells apart. Ranks run across the
 * line to the target, so the formation faces it on any map orientation.
 */
export function formationAt(center: Cell, toward: Cell, count: number, spacing = 2): Cell[] {
  const a = screen(center), b = screen(toward);
  let fx = b.x - a.x, fy = b.y - a.y;
  const len = Math.hypot(fx, fy) || 1;
  fx /= len; fy /= len;
  // Across the facing direction (screen space: x counts double because two half-tiles make a u step).
  const sx = -fy, sy = fx;
  const perRank = Math.max(1, Math.min(count, Math.ceil(Math.sqrt(count * 2))));
  const cells: Cell[] = [];
  for (let i = 0; i < count; i++) {
    const rank = Math.floor(i / perRank), file = i % perRank, inRank = Math.min(perRank, count - rank * perRank);
    const across = (file - (inRank - 1) / 2) * spacing * 2, back = rank * spacing * 2;
    const x = a.x + sx * across - fx * back, y = a.y + sy * across - fy * back;
    const v = Math.round(y);
    cells.push({ u: Math.round((x - (v & 1)) / 2), v });
  }
  return cells;
}

/** A point `fraction` of the way from `a` to `b`. */
export function between(a: Cell, b: Cell, fraction: number): Cell {
  const v = Math.round(a.v + (b.v - a.v) * fraction);
  return { u: Math.round(a.u + (b.u - a.u) * fraction), v };
}

export interface BattlePlan { fa: string; fb: string; placements: Placement[]; plan: PracticePlan }

/**
 * The simulator's "describe it": the Scenario workshop's interpreter picks each side's nation, unit and count from the
 * engine's own catalog and rosters; both forces are placed a third of the way from their start position toward the
 * other's, facing it. Side A holds (you command it); side B follows the request's order.
 */
export function planBattle(text: string, units: SimUnit[], rosters: Rosters, factions: { id: string; name: string }[], points: Cell[], previous?: PracticePlan): BattlePlan {
  const options: UnitOption[] = units.filter((u) => !["building", "defense"].includes(u.kind)).map((u) => ({ name: u.name, label: u.label, queue: u.queue, modern: u.modern, combat: u.combat }));
  const names = Object.fromEntries(factions.map((f) => [f.id, f.name]));
  const { plan } = interpret(text, options, factions.map((f) => f.id), previous, rosters, names);
  const [a, b] = points.length >= 2 ? [points[0], points[1]] : [{ u: 40, v: 62 }, { u: 88, v: 62 }];
  const fronts = [between(a, b, 0.32), between(b, a, 0.32)];
  const placements: Placement[] = ([0, 1] as const).flatMap((side) => {
    const center = fronts[side], target = fronts[1 - side];
    const unit = side ? plan.enemyUnit : plan.unit, count = side ? plan.enemyCount : plan.count;
    const order: SandboxOrder = side ? plan.enemyOrder : "hold";
    const facing = facingToward(center, target);
    return formationAt(center, target, count).map((c) => ({ id: unit, side, u: c.u, v: c.v, facing, order }));
  });
  return { fa: plan.faction, fb: plan.enemy, placements, plan };
}
