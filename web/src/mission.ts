// Missions on the fly: a real site (an air base, a port, a garrison) found by the Earth studio's intel becomes the
// defended point of a battle between any two nations. The defender's base stands on the site (its construction yard,
// power, barracks, factory, refinery and two defences, from its own roster); its army holds in front of it; the
// attacker's force comes from the start position farthest from the site. The battle simulator opens with it placed,
// on the map built from the same place, with money to build: you command your side, the engine's AI the other.

import { pickUnit, type Rosters, type UnitOption } from "./ai-lab";
import type { RadioCall } from "./campaign";
import { between, facingToward, formationAt, type Cell } from "./battle-plan";
import type { Placement, SandboxOrder, SimUnit } from "./sandbox";
import { dps, evenScale, type Army } from "./strength";

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
  /** What the Earth studio's analyst found: the site's description and why these sides. */
  intel?: { summary?: string; holds?: string; attacks?: string };
}

/** The start position the attack comes from: the one farthest from the site (on screen). */
export function attackOrigin(spec: MissionSpec, points: Cell[] = spec.points): Cell {
  const site = spec.site;
  const screenDist = (a: Cell, b: Cell) => Math.hypot(2 * (a.u - b.u) + ((a.v & 1) - (b.v & 1)), a.v - b.v);
  return [...points].sort((a, b) => screenDist(b, site) - screenDist(a, site))[0] ?? { u: site.u, v: Math.max(4, site.v - 60) };
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
  const from = attackOrigin(spec, points);
  const options: UnitOption[] = units.filter((u) => !["building", "defense"].includes(u.kind)).map((u) => ({ name: u.name, label: u.label, queue: u.queue, modern: u.modern, combat: u.combat }));
  const placements: Placement[] = [];
  const add = (id: string | undefined, side: 0 | 1, c: Cell, order: SandboxOrder, facing: number, name?: string) => { if (id) placements.push({ id, side, u: c.u, v: c.v, order, facing, ...(name ? { name } : {}) }); };

  // The defender's base on the site, laid out around its construction yard, facing the threat.
  const roster = rosters[faction(defender)] ?? [];
  const toward = between(site, from, 0.14), facing = facingToward(site, from);
  const offset = (du: number, dv: number): Cell => ({ u: site.u + du, v: site.v + dv });
  add(pickBuilding(roster, units, /cnst$/), defender, site, "hold", facing, "ConstructionYard");
  add(pickBuilding(roster, units, /powr$|power/), defender, offset(-5, -8), "hold", facing);
  add(pickBuilding(roster, units, /pile$|hand$|barr/), defender, offset(5, -8), "hold", facing);
  add(pickBuilding(roster, units, /weap$/), defender, offset(-6, 8), "hold", facing, "WarFactory");
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
  // Armies even in strength (strength.ts: the units' health and weapons from the rules), so a classic country's older
  // army gets more units against a modern one, and fewer against a weaker one. Without stats, even in value. The
  // defender's edge is its base, its defences and the money to build more.
  const attack = picks(attacker), defend = picks(defender);
  const attackSizes = [8, 8, 2], defendSizes = [8, 8, 0];
  // Aircraft only against an army that can shoot them down: the defender adds air defence from its roster (an air
  // base would have it), or the attack comes without aircraft. Needs the rules' combat stats.
  const unit = (id: string) => units.find((u) => u.name === id);
  const air = attack[2] ? unit(attack[2]) : undefined;
  if (air?.weapons) {
    const hitsAir = (u: SimUnit | undefined) => !!u && dps(u, air) > 0;
    if (!defend.some((id) => hitsAir(unit(id)))) {
      const aa = (rosters[faction(defender)] ?? []).map(unit)
        .filter((u): u is SimUnit => !!u && !["building", "defense"].includes(u.kind) && u.combat !== false && hitsAir(u))
        .sort((x, y) => Number(y.modern) - Number(x.modern) || x.cost - y.cost)[0];
      if (aa) [defend[2], defendSizes[2]] = [aa.name, 4];
      else [attackSizes[0], attackSizes[2]] = [attackSizes[0] + 2, 0];
    }
  }
  const toArmy = (ids: string[], sizes: number[]): Army =>
    ids.flatMap((id, i) => { const u = units.find((x) => x.name === id); return u && sizes[i] ? [[u, sizes[i]] as [SimUnit, number]] : []; });
  const even = evenScale(toArmy(defend, defendSizes), toArmy(attack, attackSizes)) ?? value(attack, attackSizes) / Math.max(1, value(defend, defendSizes));
  const scale = Math.min(3, Math.max(0.5, even));
  army(defender, defend, between(site, from, 0.24), from, "hold", defendSizes.map((n) => Math.max(n ? 1 : 0, Math.round(n * scale))));
  army(attacker, attack, between(from, site, 0.12), site, "engage", attackSizes);
  return placements;
}

// ------------------------------------------------------------------------------------------------ the operation
// The battle becomes a mission: objectives the campaign's objective code runs (sim Missions.StartOperation; their
// targets are the named placements above), a briefing written from the analyst's intel, reinforcement waves for the
// attacker when you defend, and radio calls (radio.ts) at the start, on a clock, on objectives and at the end.

export interface OperationObjective {
  text: string; kind: "survive" | "protect" | "destroy" | "defeat";
  targets?: string[]; seconds?: number; secondary?: boolean;
}
export interface Operation {
  id: string; title: string;
  /** The briefing: the situation, the forces, the task (one paragraph each). */
  situation: string[];
  objectives: OperationObjective[];
  victory: string; defeat: string;
  /** The attacker's reinforcement waves when you defend: where they enter (MPos) and what they field. */
  waveFrom: number[]; waveUnits: string[];
  radio: RadioCall[];
}

/** Seconds a defence must hold. */
export const HOLD_SECONDS = 300;

/** Where `to` lies seen from `from` on a north-up map (the Earth compiler's): "north", "south-east", ... */
export function direction(from: Cell, to: Cell): string {
  const dx = 2 * (to.u - from.u), dy = to.v - from.v;
  const angle = (Math.atan2(-dy, dx) * 180) / Math.PI;
  const names = ["east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"];
  return names[Math.round(((angle + 360) % 360) / 45) % 8];
}

const sentences = (text: string | undefined, n: number) => (text ?? "").match(/[^.!?]+[.!?]+/g)?.slice(0, n).map((x) => x.trim()).join(" ") ?? "";

/** The operation for a mission: its objectives, briefing, waves and radio, from the placements and the intel. */
export function missionOperation(spec: MissionSpec, placements: Placement[], nameOf: (nation: string) => string): Operation {
  const site = spec.site.name;
  const defender = spec.youDefend ? spec.fa : spec.fb, attacker = spec.youDefend ? spec.fb : spec.fa;
  const D = nameOf(defender), A = nameOf(attacker);
  const from = attackOrigin(spec);
  const dir = direction(spec.site, from);
  const summary = sentences(spec.intel?.summary, 2);
  // "Iran, the regional rival of the United States, is moving on it": a rivalry reads as prose; a source quote doesn't.
  const rival = spec.intel?.attacks && /^the regional rival/.test(spec.intel.attacks) ? `, ${spec.intel.attacks},` : "";
  const forces = `${D} holds ${site}. ${A}${rival} is moving on it from the ${dir}.`;
  const attackerUnits = [...new Set(placements.filter((p) => p.side === (spec.youDefend ? 1 : 0) && p.order === "engage").map((p) => p.id))].slice(0, 2);
  const id = `op-${spec.map}-${spec.youDefend ? "hold" : "strike"}`;
  if (spec.youDefend) {
    const command = `${D} command`;
    return {
      id, title: `Hold ${site}`,
      situation: [summary, forces, `You command the garrison: its base, its army and the money to build more. Hold for ${HOLD_SECONDS / 60} minutes while ${A} sends reinforcements in waves.`].filter(Boolean),
      objectives: [
        { text: `Hold ${site} for ${HOLD_SECONDS / 60}:00`, kind: "survive", seconds: HOLD_SECONDS },
        { text: "Keep the Construction Yard standing", kind: "protect", targets: ["ConstructionYard"] },
        { text: `Destroy ${A}'s attack force`, kind: "defeat", secondary: true },
      ],
      victory: `${site} holds. ${A}'s attack is broken.`,
      defeat: `${site} has fallen to ${A}.`,
      waveFrom: [from.u, from.v], waveUnits: attackerUnits,
      radio: [
        { when: "start", speaker: command, line: `Contact: ${A} armour moving on ${site} from the ${dir}. Hold the base.` },
        { when: { time: 70 }, speaker: command, line: `More ${A} units inbound from the ${dir}. Keep the construction yard covered.` },
        { when: { time: Math.round(HOLD_SECONDS / 2) }, speaker: command, line: "Halfway there. Hold the line." },
        { when: { objective: 0 }, speaker: command, line: `They're breaking off. ${site} holds.` },
        { when: "victory", speaker: command, line: `Well done. ${site} is secure.` },
        { when: "defeat", speaker: command, line: `We've lost ${site}. All units, fall back.` },
      ],
    };
  }
  const command = `${A} command`;
  return {
    id, title: `Strike on ${site}`,
    situation: [summary, `${D} holds ${site}. You lead ${A}'s attack from the ${dir}.`, "Destroy the construction yard at the heart of the base. Its war factory keeps producing until it falls."].filter(Boolean),
    objectives: [
      { text: `Destroy ${D}'s Construction Yard`, kind: "destroy", targets: ["ConstructionYard"] },
      { text: "Knock out the War Factory", kind: "destroy", targets: ["WarFactory"], secondary: true },
    ],
    victory: `${D}'s base at ${site} is down.`,
    defeat: `The attack on ${site} has failed.`,
    waveFrom: [], waveUnits: [],
    radio: [
      { when: "start", speaker: command, line: `${D}'s base at ${site} is in range. Take out its construction yard.` },
      { when: { time: 90 }, speaker: command, line: "Their factory is still producing. Hit it if you can." },
      { when: "victory", speaker: command, line: `The base is down. ${site} is ours.` },
      { when: "defeat", speaker: command, line: `The attack has failed. Pull back.` },
    ],
  };
}
