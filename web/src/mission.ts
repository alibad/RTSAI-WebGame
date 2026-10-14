// Missions on the fly: a real site (an air base, a port, a garrison) found by the Earth studio's intel becomes the
// defended point of a battle between any two nations. The defender's base stands on the site (its construction yard,
// power, barracks, factory, refinery and two defences, from its own roster); its army holds in front of it; the
// attacker's force comes from the start position farthest from the site. The battle simulator opens with it placed,
// on the map built from the same place, with money to build: you command your side, the engine's AI the other.

import { pickUnit, type Rosters, type UnitOption } from "./ai-lab";
import { between, facingToward, formationAt, type Cell } from "./battle-plan";
import type { Placement, SandboxOrder, SimUnit } from "./sandbox";

export interface MissionSpec {
  /** The map built from the place (its engine id). */
  map: string;
  title: string;
  /** The defended site, in the map's cells. */
  site: Cell & { name: string };
  /** Side A (you) and side B (the AI). */
  fa: string;
  fb: string;
  /** You defend the site (else you attack it). */
  youDefend: boolean;
  /** The map's start positions (MPos): the attack comes from the one farthest from the site. */
  points: Cell[];
}

/** The start positions in a map.yaml (mpspawn actors' CPos), as MPos on the isometric grid (CPos.ToMPos). */
export function spawnCells(yaml: string): Cell[] {
  const cells: Cell[] = [];
  for (const m of yaml.matchAll(/:\s*mpspawn\s*\n(?:\t\t.*\n)*?\t\tLocation:\s*(-?\d+),\s*(-?\d+)/g)) {
    const x = Number(m[1]), y = Number(m[2]);
    cells.push({ u: Math.trunc((x - y) / 2), v: x + y });
  }
  return cells;
}

/** Latitude/longitude -> the Earth compiler's MPos (RTSAI-Web lib/earth-battlefield.ts: north-up, `size` wide, 2 x size tall). */
export function geoToCell(lat: number, lon: number, center: { lat: number; lon: number }, radius: number, size: number): Cell {
  const span = 2 * radius;
  const x = (lon - center.lon) * 111320 * Math.cos(center.lat * Math.PI / 180);
  const y = (center.lat - lat) * 111320;
  const clamp = (n: number, hi: number) => Math.max(3, Math.min(hi - 4, Math.round(n)));
  return { u: clamp((x / span + 0.5) * size, size), v: clamp((y / span + 0.5) * size * 2, size * 2) };
}

const pickBuilding = (roster: string[], units: SimUnit[], re: RegExp) =>
  roster.find((n) => re.test(n) && units.some((u) => u.name === n && u.kind === "building"));

export function missionPlacements(spec: MissionSpec, units: SimUnit[], rosters: Rosters, points: Cell[] = spec.points): Placement[] {
  const defender: 0 | 1 = spec.youDefend ? 0 : 1, attacker: 0 | 1 = spec.youDefend ? 1 : 0;
  const faction = (side: 0 | 1) => (side === 0 ? spec.fa : spec.fb);
  const site: Cell = { u: spec.site.u, v: spec.site.v };
  const screenDist = (a: Cell, b: Cell) => Math.hypot(2 * (a.u - b.u) + ((a.v & 1) - (b.v & 1)), a.v - b.v);
  const from = [...points].sort((a, b) => screenDist(b, site) - screenDist(a, site))[0] ?? { u: site.u, v: Math.max(4, site.v - 60) };
  const options: UnitOption[] = units.filter((u) => !["building", "defense"].includes(u.kind)).map((u) => ({ name: u.name, label: u.label, queue: u.queue, modern: u.modern, combat: u.combat }));
  const placements: Placement[] = [];
  const add = (id: string | undefined, side: 0 | 1, c: Cell, order: SandboxOrder, facing: number) => { if (id) placements.push({ id, side, u: c.u, v: c.v, order, facing }); };

  // The defender's base on the site, laid out around its construction yard, facing the threat.
  const roster = rosters[faction(defender)] ?? [];
  const toward = between(site, from, 0.14), facing = facingToward(site, from);
  const offset = (du: number, dv: number): Cell => ({ u: site.u + du, v: site.v + dv });
  add(pickBuilding(roster, units, /cnst$/), defender, site, "hold", facing);
  add(pickBuilding(roster, units, /powr$|power/), defender, offset(-5, -8), "hold", facing);
  add(pickBuilding(roster, units, /pile$|hand$|barr/), defender, offset(5, -8), "hold", facing);
  add(pickBuilding(roster, units, /weap$/), defender, offset(-6, 8), "hold", facing);
  add(pickBuilding(roster, units, /refn$|refinery/), defender, offset(6, 8), "hold", facing);
  const defences = roster.filter((n) => units.some((u) => u.name === n && u.kind === "defense")).slice(0, 2);
  formationAt(toward, from, defences.length || 0, 5).forEach((c, i) => add(defences[i], defender, c, "hold", facing));

  // Each side's army: the defenders hold in front of the base, the attackers come from the far start position.
  const picks = (side: 0 | 1) => {
    const f = faction(side);
    return [pickUnit("tank", f, options, rosters), pickUnit("infantry", f, options, rosters), pickUnit("air", f, options, rosters)];
  };
  const value = (ids: string[], sizes: number[]) => ids.reduce((sum, id, i) => sum + (units.find((u) => u.name === id)?.cost ?? 0) * (id ? sizes[i] : 0), 0);
  const army = (side: 0 | 1, ids: string[], center: Cell, target: Cell, order: SandboxOrder, sizes: number[]) => {
    const face = facingToward(center, target);
    let rank = 0;
    ids.forEach((id, i) => {
      if (!id || !sizes[i]) return;
      const c = between(center, target, -0.04 * rank++);
      formationAt(c, target, sizes[i]).forEach((cell) => add(id, side, cell, order, face));
    });
  };
  // Armies of equal value, so an older army (a classic country's) gets more units against a modern one; the
  // defender's edge is its base, its defences and the money to build more.
  const attack = picks(attacker), defend = picks(defender);
  const attackSizes = [8, 8, 2];
  const scale = Math.min(2, Math.max(1, value(attack, attackSizes) / Math.max(1, value(defend, [8, 8, 0]))));
  army(defender, defend, between(site, from, 0.24), from, "hold", [Math.round(8 * scale), Math.round(8 * scale), 0]);
  army(attacker, attack, between(from, site, 0.12), site, "engage", attackSizes);
  return placements;
}
