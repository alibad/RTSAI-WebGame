// The browser co-commander in campaign missions. The engine publishes each mission's definition (the catalog in
// setup.missions: objectives with their kind, targets, routes, gates and deadlines, the sensors and the events) and
// its live state (ui.mission: each objective's status, whether it waits on a gate, its progress, the events fired);
// the mission map (map.yaml, read from the game files) places every named actor. From those and the native,
// fog-respecting observation this planner proposes the next order in the adviser's own form (adviser.ts): send units
// to reach or scout places, escort convoys, defend what must survive, capture with engineers, destroy targets, hold
// for timers, keep heroes alive, cross sensor zones only while they sleep, and spend the money on an army that serves
// the objectives. Skirmish never comes here; a mission's base economy reuses the skirmish adviser.

import { baseType, nextAdvice, type AdviserActor, type AdviserAdvice, type AdviserCommand, type AdviserObservation, type AdviserTechItem } from "./adviser";

export interface MissionObjective {
  text: string; kind: string; target?: string | null; via?: string | null; entry?: string | null;
  targets?: string[]; types?: string[]; route?: string[]; after?: string[]; lanes?: string[][];
  requires?: number[]; area?: number[]; radius?: number; count?: number; seconds?: number; allowed?: number;
  until?: number; limit?: number; secondary?: boolean; deploy?: boolean;
}
export interface MissionSensor { actor: string; radius?: number; sweep?: number[]; offset?: number }
export interface MissionEvent {
  id: string;
  when?: { time?: number; objective?: number; failed?: number; detected?: string | null; killed?: string | null; event?: string | null };
}
/** A mission as the engine's catalog describes it (Missions.Definition, camelCase). */
export interface MissionSpec { id: string; slot: string; enemy?: string; protect?: string[]; objectives: MissionObjective[]; sensors?: MissionSensor[]; events?: MissionEvent[] }
/** ui.mission (Missions.StateJson). */
export interface MissionLive { difficulty: string; events?: string[]; objectives: { status: string; waiting?: boolean; progress?: string }[] }
export interface MapActor { name: string; type: string; owner: string; u: number; v: number; index: number }
export interface MissionMap { actors: MapActor[]; named: Record<string, MapActor> }
/** The production menu's items (ui.catalog): what each item still needs. */
export interface MissionCatalogItem { name: string; label: string; buildable: boolean; requires?: string[] }

export interface MissionContext {
  spec: MissionSpec;
  live: MissionLive;
  map: MissionMap;
  memory: MissionMemory;
  techTree: Record<string, AdviserTechItem>;
  catalog?: { type: string; items: MissionCatalogItem[] }[];
  /** Milliseconds now (the game speed is measured from it); tests pass their own clock. */
  now?: number;
}

/** A recommendation, plus the goal its unit orders serve (remembered once applied, so units en route are left alone;
 * `goals` sets it per unit). */
export interface MissionAdvice extends AdviserAdvice { goal?: string; goals?: Record<number, string>; reactive?: boolean }

interface Pt { u: number; v: number }

// ------------------------------------------------------------------ map

/** The actors of a map.yaml in file order (the engine spawns them in that order), with their cells as MPos. */
export function parseMissionMap(yaml: string): MissionMap {
  const actors: MapActor[] = [];
  let section = "";
  let current: { name: string; type: string; owner?: string; x?: number; y?: number } | null = null;
  const finish = () => {
    if (current && current.x !== undefined && current.y !== undefined) {
      const v = current.x + current.y;
      actors.push({ name: current.name, type: current.type.toLowerCase(), owner: current.owner ?? "", u: (current.x - current.y - (v & 1)) / 2, v, index: actors.length });
    }
    current = null;
  };
  for (const line of yaml.split(/\r?\n/)) {
    if (/^\S/.test(line)) { finish(); section = line.replace(/:.*/, "").trim(); continue; }
    if (section !== "Actors") continue;
    const head = line.match(/^\t([^\t:]+):\s*(\S+)\s*$/);
    if (head) { finish(); current = { name: head[1], type: head[2] }; continue; }
    const owner = line.match(/^\t\tOwner:\s*(.+?)\s*$/);
    if (owner && current) current.owner = owner[1];
    const location = line.match(/^\t\tLocation:\s*(-?\d+)\s*,\s*(-?\d+)/);
    if (location && current) { current.x = +location[1]; current.y = +location[2]; }
  }
  finish();
  return { actors, named: Object.fromEntries(actors.map((a) => [a.name, a])) };
}

// ------------------------------------------------------------------ geometry
// Cells are MPos (u, v), as the observation reports them. Distances are the engine's own (world units / 1024, the unit
// of every radius in the mission definitions). On the campaign's isometric maps a cell is 1448 world units wide and
// 724 tall: its centre sits at ((u + ½ on odd rows) · √2, v · √2 / 2) in those units, and a step to a neighbouring
// cell (x ± 1 or y ± 1 in the engine's cell coordinates) is one unit. Top-down maps have square cells.

const S = Math.SQRT2;
/** The map's grid (set from each observation; the campaign's maps are isometric). */
let iso = true;
const wx = (p: Pt) => iso ? (p.u + (p.v & 1 ? 0.5 : 0)) * S : p.u;
const wy = (p: Pt) => iso ? p.v * S / 2 : p.v;
const dist = (a: Pt, b: Pt) => Math.hypot(wx(a) - wx(b), wy(a) - wy(b));
const cellOf = (a: AdviserActor): Pt => ({ u: a.cellX, v: a.cellY });
const toC = (p: Pt) => iso ? { x: (p.v + 2 * p.u + (p.v & 1)) / 2, y: (p.v - 2 * p.u - (p.v & 1)) / 2 } : { x: p.u, y: p.v };
const fromC = (x: number, y: number): Pt => { if (!iso) return { u: x, v: y }; const v = x + y; return { u: (x - y - (v & 1)) / 2, v }; };
const point = (x: number, y: number): Pt => {
  if (!iso) return { u: Math.round(x), v: Math.round(y) };
  const v = Math.round(y * 2 / S);
  return { u: Math.round(x / S - (v & 1 ? 0.5 : 0)), v };
};
/** An actor's exact centre in the same units (its world position, less the centre of cell 0). */
const exact = (a: AdviserActor) => a.x || a.y ? { x: a.x! / 1024 - (iso ? S / 2 : 0.5), y: a.y! / 1024 - (iso ? S / 2 : 0.5) } : { x: wx(cellOf(a)), y: wy(cellOf(a)) };
const centroid = (list: Pt[]): Pt => list.length ? point(list.reduce((s, p) => s + wx(p), 0) / list.length, list.reduce((s, p) => s + wy(p), 0) / list.length) : { u: 0, v: 0 };
const lerp = (a: Pt, b: Pt, t: number): Pt => point(wx(a) + (wx(b) - wx(a)) * t, wy(a) + (wy(b) - wy(a)) * t);
const byId = (a: AdviserActor, b: AdviserActor) => a.actorId - b.actorId;

/** Passability (for the engine's first locomotor, a land one) and visibility of every cell, from the observation. */
class Grid {
  readonly passable: Uint8Array;
  readonly visible: Uint8Array;
  constructor(readonly w: number, readonly h: number, spatial: { channels: number; bytes: Uint8Array }) {
    this.passable = new Uint8Array(w * h);
    this.visible = new Uint8Array(w * h);
    const c = spatial.channels, data = new DataView(spatial.bytes.buffer, spatial.bytes.byteOffset, spatial.bytes.byteLength);
    for (let i = 0; i < w * h; i++) {
      this.passable[i] = data.getFloat32((i * c + 3) * 4, true) > 0 ? 1 : 0;
      this.visible[i] = data.getFloat32((i * c + 4) * 4, true) >= 1 ? 1 : 0;
    }
  }

  static from(o: AdviserObservation) {
    const s = o.spatial;
    return s && s.channels >= 5 && s.bytes.length >= o.mapWidth * o.mapHeight * s.channels * 4 ? new Grid(o.mapWidth, o.mapHeight, s) : null;
  }

  inside(p: Pt) { return p.u >= 0 && p.v >= 0 && p.u < this.w && p.v < this.h; }
  pass(p: Pt) { return this.inside(p) && this.passable[p.v * this.w + p.u] === 1; }
  seen(p: Pt) { return this.inside(p) && this.visible[p.v * this.w + p.u] === 1; }

  /** The nearest passable cell (searching out in rings), optionally also outside `avoid`. */
  near(p: Pt, max = 14, avoid?: (q: Pt) => boolean): Pt | null {
    if (this.pass(p) && !avoid?.(p)) return p;
    let best: Pt | null = null, bestD = Infinity;
    for (let r = 1; r <= max && !best; r++)
      for (let dv = -2 * r; dv <= 2 * r; dv++)
        for (let du = -r; du <= r; du++) {
          if (Math.max(Math.abs(du), Math.ceil(Math.abs(dv) / 2)) !== r) continue;
          const q = { u: p.u + du, v: p.v + dv };
          if (!this.pass(q) || avoid?.(q)) continue;
          const d = dist(p, q);
          if (d < bestD) { bestD = d; best = q; }
        }
    return best;
  }

  /** A* over the cells (the engine's 8 neighbours); `extra` adds a cost to entering a cell (Infinity: closed). */
  path(from: Pt, to: Pt, extra: (p: Pt) => number = () => 0, limit = 60000): Pt[] | null {
    if (!this.inside(from) || !this.inside(to)) return null;
    const W = this.w, start = from.v * W + from.u, goal = to.v * W + to.u;
    const g = new Float64Array(W * this.h).fill(Infinity), came = new Int32Array(W * this.h).fill(-1);
    const heap: number[][] = [];
    const push = (f: number, i: number) => {
      heap.push([f, i]);
      for (let k = heap.length - 1; k > 0;) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        for (let k = 0; ;) {
          const l = 2 * k + 1, r = l + 1;
          let m = k;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]]; k = m;
        }
      }
      return top;
    };
    g[start] = 0; push(dist(from, to), start);
    const steps = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, S], [-1, -1, S], [1, -1, S], [-1, 1, S]];
    for (let expanded = 0; heap.length && expanded < limit; expanded++) {
      const [f, i] = pop();
      if (i === goal) break;
      const p = { u: i % W, v: (i / W) | 0 };
      if (f - dist(p, to) > g[i] + 1e-9) continue;
      const c = toC(p);
      for (const [dx, dy, cost] of steps) {
        const q = fromC(c.x + dx, c.y + dy);
        if (!this.inside(q)) continue;
        const j = q.v * W + q.u;
        if (j !== goal && !this.passable[j]) continue;
        const add = j === goal ? 0 : extra(q);
        if (add === Infinity) continue;
        const ng = g[i] + cost + add;
        if (ng < g[j]) { g[j] = ng; came[j] = i; push(ng + dist(q, to), j); }
      }
    }
    if (came[goal] < 0 && goal !== start) return null;
    const out: Pt[] = [];
    for (let i = goal; i >= 0; i = came[i]) { out.push({ u: i % W, v: (i / W) | 0 }); if (i === start) break; }
    return out.reverse();
  }
}

// ------------------------------------------------------------------ memory

interface Named { id?: number; at: Pt; seen: number; building?: boolean; dead?: boolean; lost?: number }

/**
 * What the planner keeps between observations: where each unit was last sent (so units en route are left alone),
 * the named actors it has identified, the places scouted, the deployed specialists, the game speed. A recommendation
 * is computed again from the same memory when it is confirmed; orders change the memory once they are applied.
 */
export class MissionMemory {
  heading = new Map<number, { goal: string; key: string; tick: number; reactive: boolean; tries: number; to?: Pt }>();
  named = new Map<string, Named>();
  scouted = new Set<string>();
  deployed = new Map<number, number>();
  /** Convoy routes swept so far (escorts whose trucks the observation does not show). */
  swept = new Map<number, number>();
  /** When each objective was first seen open (a game tick): gated timers count from then. */
  opened = new Map<number, number>();
  /** Contacts a unit of ours has been close enough to verify; places a scout could not get close enough to. */
  verified = new Set<string>();
  unreachable = new Set<string>();
  scoutTries = new Map<string, number>();
  /** Where the army is looking for a target that moved out of sight, and how many places it has tried. */
  search = new Map<string, { spot: Pt; n: number }>();
  /** Units were set to return fire only, while unverified contacts were about; when each stance was last set. */
  calmed = false;
  stanced = new Map<number, number>();
  /** Stance orders a unit has had: one that keeps its stance after two (it has no choice of stance) is left alone. */
  stanceTries = new Map<number, number>();
  offset: number | null = null;
  lastKind: "unit" | "economy" | "" = "";
  /** When something the mission protects (or the base) was last under attack (a game tick). */
  attacked: number | null = null;
  /** The last order for units: its line stays up while they carry it out. */
  said: { text: string; tick: number } | null = null;
  /** Game ticks per real millisecond (the game speed), from consecutive observations. */
  pace = { tick: 0, at: 0, rate: 0.025 };

  /** An order was applied: its units now serve its goal. */
  record(advice: MissionAdvice, tick: number) {
    const units = advice.commands.filter((c) => c.actor_id !== undefined);
    if (advice.commands.length) this.lastKind = units.length ? "unit" : "economy";
    if (units.length) this.said = { text: advice.text, tick };
    for (const c of units) {
      if (c.action === "deploy") { this.deployed.set(c.actor_id!, tick); continue; }
      // A stance is not an errand: the unit keeps the one it has.
      if (c.action === "set_stance") { this.stanced.set(c.actor_id!, tick); this.stanceTries.set(c.actor_id!, (this.stanceTries.get(c.actor_id!) ?? 0) + 1); continue; }
      this.deployed.delete(c.actor_id!);
      const to = c.target_x !== undefined && c.target_y !== undefined ? { u: c.target_x, v: c.target_y } : undefined;
      const before = this.heading.get(c.actor_id!);
      // A route's later waypoints: only where it ends.
      if (c.queued) { if (before && to) before.to = to; continue; }
      const goal = advice.goals?.[c.actor_id!] ?? advice.goal ?? advice.key;
      if (goal.startsWith("scout:")) this.scoutTries.set(goal.slice(6), (this.scoutTries.get(goal.slice(6)) ?? 0) + 1);
      // The same order again (not the next leg of a route): it stopped short last time.
      this.heading.set(c.actor_id!, { goal, key: advice.key, tick, reactive: !!advice.reactive, tries: before?.key === advice.key ? before.tries + 1 : 1, to });
    }
  }
}

// ------------------------------------------------------------------ the world, as the planner sees it

const nonCombat = new Set(["harv", "cmin", "mcv", "amcv", "smcv", "sapc", "lcrf"]);
const passiveKinds = new Set(["protect", "squad", "undetected"]);
/** A map name as a place: "SurvivorsCove" → "the survivors cove", "DomeWest" → "the west dome", "MastVaultNorth" →
 * "the north vault mast", "GenNW" → "the NW generator". */
export function placeName(name: string) {
  const w = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Za-z])(\d)/g, "$1 $2").split(/\s+/).filter(Boolean)
    .map((x) => (x.length <= 2 && x === x.toUpperCase() ? x : x.toLowerCase())).map((x) => (x === "gen" ? "generator" : x));
  if (w.length > 1 && /^(north|south|east|west|nw|ne|sw|se)$/i.test(w[w.length - 1])) w.unshift(w.pop()!);
  // A kind of thing named first ("Mast Bluff") reads last.
  const kind = w.findIndex((x) => /^(mast|dome|generator|scanner|uplink|launcher|pier|checkpoint)$/.test(x));
  if (kind >= 0 && kind < w.length - 1) w.push(...w.splice(kind, 1));
  return `the ${w.join(" ")}`;
}
const capital = (s: string) => s[0].toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const article = (name: string) => `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name}`;
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.max(0, Math.floor(seconds % 60))).padStart(2, "0")}`;
/** The seconds an objective's progress line has left ("4:12 left", "95 seconds remaining"). */
const secondsLeft = (progress?: string) => {
  const m = progress?.match(/(\d+):(\d\d) left/);
  if (m) return +m[1] * 60 + +m[2];
  const s = progress?.match(/(\d+) seconds remaining/);
  return s ? +s[1] : null;
};
const lower = (text: string) => text.replace(/\.$/, "").replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());

interface Objective extends MissionObjective { i: number; status: string; waiting: boolean; progress: string }
interface Sensor { name: string; at: { x: number; y: number }; radius: number; sweep: number[] | null; offset: number; live: boolean; tripped: boolean }

class World {
  readonly grid: Grid | null;
  readonly tick: number;
  readonly units: AdviserActor[];
  readonly enemies: AdviserActor[];
  readonly objectives: Objective[];
  readonly convoyTypes = new Set<string>();
  readonly heroes = new Set<number>();
  readonly sensors: Sensor[] = [];
  readonly difficulty: string;
  readonly hasBase: boolean;
  readonly fighters: AdviserActor[];
  readonly engineers: AdviserActor[];
  readonly memory: MissionMemory;
  private observed = new Map<number, AdviserActor>();
  private enemyIds = new Set<number>();
  private buildingIds = new Set<number>();

  constructor(readonly obs: AdviserObservation, readonly ctx: MissionContext) {
    this.memory = ctx.memory;
    // The grid's shape, from where a unit stands (isometric rows are 724 world units apart, top-down ones 1024).
    const probe = obs.units.find((a) => a.y) ?? obs.buildings.find((a) => a.y);
    if (probe) iso = Math.abs(probe.y! - 724 * (probe.cellY + 1)) < Math.abs(probe.y! - (1024 * probe.cellY + 512));
    this.grid = Grid.from(obs);
    this.tick = obs.tick;
    this.difficulty = ctx.live.difficulty || "normal";
    this.units = obs.units.filter((u) => !u.kind.toLowerCase().includes("husk"));
    this.enemies = obs.visibleEnemies;
    const remembered = obs.rememberedEnemyBuildings ?? [];
    for (const a of [...obs.units, ...obs.buildings, ...obs.visibleEnemies, ...obs.visibleEnemyBuildings, ...remembered])
      if (!this.observed.has(a.actorId)) this.observed.set(a.actorId, a);
    for (const a of [...obs.visibleEnemies, ...obs.visibleEnemyBuildings, ...remembered]) this.enemyIds.add(a.actorId);
    for (const a of [...obs.buildings, ...obs.visibleEnemyBuildings, ...remembered]) this.buildingIds.add(a.actorId);
    this.objectives = ctx.spec.objectives.map((o, i) => ({ ...o, i, status: ctx.live.objectives[i]?.status ?? "active",
      waiting: !!ctx.live.objectives[i]?.waiting, progress: ctx.live.objectives[i]?.progress ?? "" }));
    for (const o of this.objectives) {
      if (o.kind === "escort") this.convoyTypes.add("sapc");
      if (o.kind === "shipping") this.convoyTypes.add("lcrf");
    }
    this.calibrate();
    const keep = new Set([...ctx.spec.protect ?? [], ...this.objectives.filter((o) => o.kind === "protect" || o.kind === "squad").flatMap((o) => o.targets ?? [])]);
    for (const name of keep) {
      const a = this.find(name);
      if (a && this.units.includes(a)) this.heroes.add(a.actorId);
    }
    const fired = new Set(ctx.live.events ?? []), events = ctx.spec.events ?? [];
    for (const s of ctx.spec.sensors ?? []) {
      const found = this.find(s.actor);
      const tripped = events.some((e) => e.when?.detected === s.actor && fired.has(e.id));
      const killed = events.some((e) => e.when?.killed === s.actor && fired.has(e.id)) || !!this.memory.named.get(s.actor)?.dead;
      const p = found ? null : this.where(s.actor);
      this.sensors.push({ name: s.actor, at: found ? exact(found) : p ? { x: wx(p), y: wy(p) } : { x: -999, y: -999 }, radius: s.radius ?? 5,
        sweep: s.sweep && s.sweep.length >= 2 ? s.sweep : null, offset: s.offset ?? 0, live: !killed, tripped });
    }
    this.hasBase = obs.buildings.some((b) => /cnst/.test(baseType(b.kind)) || (ctx.techTree[baseType(b.kind)]?.produces ?? []).length > 0);
    this.engineers = this.units.filter((u) => u.canCapture || baseType(u.kind) === "engineer").sort(byId);
    this.fighters = this.units.filter((u) => u.canAttack && !nonCombat.has(baseType(u.kind)) && !this.convoyTypes.has(baseType(u.kind)) && !this.engineers.includes(u)).sort(byId);
  }

  /**
   * The engine numbers the map's actors in file order after a few of its own, so a map actor's id is its index in
   * map.yaml plus a constant: the offset at which the most actors in sight have the right type (kept once clear).
   */
  private calibrate() {
    if (this.memory.offset !== null) return;
    const byType = new Map<string, number[]>();
    for (const a of this.ctx.map.actors) (byType.get(a.type) ?? byType.set(a.type, []).get(a.type)!).push(a.index);
    const votes = new Map<number, number>();
    for (const a of this.observed.values())
      for (const index of byType.get(baseType(a.kind)) ?? []) votes.set(a.actorId - index, (votes.get(a.actorId - index) ?? 0) + 1);
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length && ranked[0][1] >= 3 && (ranked.length < 2 || ranked[0][1] >= 1.5 * ranked[1][1])) this.memory.offset = ranked[0][0];
  }

  /** A map actor's id: known, or its index plus the offset. */
  idOf(name: string) {
    const m = this.ctx.map.named[name];
    if (!m) return undefined;
    return this.memory.named.get(name)?.id ?? (this.memory.offset !== null ? m.index + this.memory.offset : undefined);
  }

  /** The live actor behind a map name, when in sight (or owned): by id, else the nearest of its type to where it was. */
  find(name: string): AdviserActor | null {
    const m = this.ctx.map.named[name];
    if (!m) return null;
    const known = this.memory.named.get(name);
    if (known?.dead) return null;
    let a: AdviserActor | undefined;
    const id = this.idOf(name);
    if (id !== undefined) { const b = this.observed.get(id); if (b && baseType(b.kind) === m.type) a = b; }
    if (!a && known?.id === undefined) {
      const from: Pt = known?.at ?? m;
      a = [...this.observed.values()].filter((b) => baseType(b.kind) === m.type && dist(cellOf(b), from) <= 6)
        .sort((x, y) => dist(cellOf(x), from) - dist(cellOf(y), from) || x.actorId - y.actorId)[0];
    }
    if (a) { this.memory.named.set(name, { id: a.actorId, at: cellOf(a), seen: this.tick, building: this.buildingIds.has(a.actorId) }); return a; }
    if (known?.id !== undefined) {
      const mine = m.owner === this.ctx.spec.slot;
      // Own actors are always observed; a building whose cell is in sight but is not there is gone. A unit that is
      // not where it was last seen has moved out of sight (it is looked for elsewhere for a while).
      if (mine || (known.building && this.grid?.seen(known.at))) this.memory.named.set(name, { ...known, dead: true });
      else if (!known.building && this.grid?.seen(known.at) && !known.lost) this.memory.named.set(name, { ...known, lost: this.tick });
    }
    return null;
  }

  /** Where a named actor is (or was last seen), or null once it is known to be gone. */
  where(name: string): Pt | null {
    const m = this.ctx.map.named[name];
    if (!m) return null;
    const a = this.find(name);
    if (a) return cellOf(a);
    const known = this.memory.named.get(name);
    if (known?.dead) return null;
    return known?.at ?? { u: m.u, v: m.v };
  }

  /** A map actor is the enemy's (in sight as an enemy, or placed for the enemy and not seen otherwise). */
  hostile(name: string) {
    const id = this.idOf(name);
    if (id !== undefined && this.observed.has(id)) return this.enemyIds.has(id);
    const owner = this.ctx.map.named[name]?.owner;
    return !!owner && owner === this.ctx.spec.enemy;
  }

  sensorOn(s: Sensor, tick: number) {
    if (!s.sweep) return true;
    const cycle = (s.sweep[0] + s.sweep[1]) * 25;
    return ((tick + s.offset * 25) % cycle + cycle) % cycle < s.sweep[0] * 25;
  }

  /** Sensors that can still raise an alarm (alive, not tripped yet) while a stay-undetected objective is active. */
  watching(): Sensor[] {
    const stealth = this.objectives.filter((o) => o.kind === "undetected" && o.status === "active");
    if (!stealth.length) return [];
    const names = new Set(stealth.flatMap((o) => o.targets ?? []));
    return this.sensors.filter((s) => s.live && !s.tripped && (!names.size || names.has(s.name)));
  }

  /** Inside a surveillance area that must be left before its sweep (an open disperse objective), with a margin. */
  forbidden(p: Pt) {
    return this.objectives.some((o) => o.kind === "disperse" && o.status === "active" && !o.waiting && (o.area ?? []).length === 4
      && p.u >= o.area![0] - 2 && p.v >= o.area![1] - 4 && p.u <= o.area![2] + 2 && p.v <= o.area![3] + 4);
  }

  /** The share of the open ground within r of p in sight now (fog may hide guards). */
  inSight(p: Pt, r: number) {
    if (!this.grid) return 1;
    let open = 0, seen = 0;
    for (let dv = -Math.ceil(r * 2); dv <= Math.ceil(r * 2); dv++)
      for (let du = -Math.ceil(r); du <= Math.ceil(r); du++) {
        const q = { u: p.u + du, v: p.v + dv };
        if (dist(p, q) > r || !this.grid.pass(q)) continue;
        open++; if (this.grid.seen(q)) seen++;
      }
    return open ? seen / open : 1;
  }

  /**
   * Contacts: sensors that are enemy units rather than masts or markers. What one is shows only once a unit of ours
   * has been within its radius (Ghosts on the Glass: six of nine are phantoms, and firing on an unverified phantom
   * fails the mission), so until then nothing may fire on it.
   */
  unverified(): Sensor[] {
    return this.sensors.filter((s) => {
      const type = this.ctx.map.named[s.name]?.type ?? "";
      return s.live && !s.tripped && !this.memory.verified.has(s.name) && !["waypoint", "mpspawn"].includes(type)
        && this.ctx.techTree[type]?.kind !== "building" && !this.memory.named.get(s.name)?.dead;
    });
  }

  /** A contact the observation shows (by id, or its type standing where the contact is); only unverified ones if asked. */
  isContact(e: AdviserActor, unverified = false) {
    return (unverified ? this.unverified() : this.sensors).some((s) => this.idOf(s.name) === e.actorId
      || (this.ctx.map.named[s.name]?.type === baseType(e.kind) && Math.hypot(wx(cellOf(e)) - s.at.x, wy(cellOf(e)) - s.at.y) <= 1.5));
  }

  /** Where to look for something last seen at p: the open ground out of sight nearest to it (and to `from`). */
  searchSpot(p: Pt, from: Pt): Pt | null {
    const grid = this.grid;
    if (!grid) return null;
    let best: Pt | null = null, score = Infinity;
    for (let dv = -40; dv <= 40; dv += 2)
      for (let du = -20; du <= 20; du += 2) {
        const q = { u: p.u + du, v: p.v + dv };
        if (!grid.pass(q) || grid.seen(q)) continue;
        const s = dist(q, p) + dist(q, from) * 0.3;
        if (s < score) { score = s; best = q; }
      }
    return best;
  }

  /** An enemy we may fire on: not a contact, or a verified one that is armed (a verified phantom is harmless). */
  mayFire(e: AdviserActor) { return !this.isContact(e) || (!this.isContact(e, true) && e.canAttack); }

  /** Staying out of sight is required (not a bonus objective). */
  strictStealth() { return this.objectives.some((o) => o.kind === "undetected" && o.status === "active" && !o.secondary); }

  /** Units that orders may move: not the convoys the engine drives, not harvesters or construction vehicles. */
  movable() { return this.units.filter((u) => !this.convoyTypes.has(baseType(u.kind)) && !nonCombat.has(baseType(u.kind))); }

  base(): Pt | null {
    const b = this.obs.buildings;
    if (!b.length || !this.hasBase) return null;
    const yard = b.find((x) => /cnst/.test(baseType(x.kind)));
    return yard ? cellOf(yard) : centroid(b.map(cellOf));
  }

  /** A cell units can stand on near p (land for the engine's first locomotor). */
  land(p: Pt, max = 14) { return this.grid?.near(p, max) ?? p; }

  /** A unit on ground the land grid can walk (ships and boats are not). */
  onLand(u: AdviserActor) { return !this.grid || this.grid.pass(cellOf(u)) || this.grid.near(cellOf(u), 1) !== null; }

  /** A unit as the lines name it: "Tanya" (a named hero), "the Engineer". */
  who(u: AdviserActor) {
    const shown = this.name(u.kind);
    const hero = [...this.memory.named.entries()].some(([n, x]) => x.id === u.actorId && n.toLowerCase() === shown.toLowerCase());
    return hero ? shown : `the ${shown}`;
  }

  name(kind: string) {
    const k = baseType(kind);
    return this.obs.actorNames[kind.toLowerCase()] || this.obs.actorNames[k] || this.ctx.techTree[k]?.name || k;
  }
}

// ------------------------------------------------------------------ orders

const MAX = 12;

/** A unit needs this order unless it is there, on its way (still moving, or sent a moment ago and not started yet), or
 * on a reactive errand (defending, leaving a zone) it has not finished. */
function needsOrder(w: World, u: AdviserActor, goal: string, target: Pt, arrive: number) {
  if (dist(cellOf(u), target) <= arrive) return false;
  const h = w.memory.heading.get(u.actorId);
  // Sent there already: again only once it has stopped short (after a few tries, only now and then: it cannot get closer).
  if (h && h.goal === goal) return u.idle && w.tick - h.tick > (h.tries >= 3 ? 750 : 50);
  // Sent somewhere else a moment ago and on the move: not turned round again yet (an errand flipping between two goals
  // would send the army back and forth).
  if (h && !h.reactive && !u.idle && w.tick - h.tick < 100) return false;
  if (h && h.reactive && !u.idle && w.tick - h.tick < 500) return false;
  return true;
}

function sendAll(units: AdviserActor[], action: "move" | "attack_move", to: Pt): AdviserCommand[] {
  return [...units].sort(byId).slice(0, MAX).map((u) => ({ action, actor_id: u.actorId, target_x: to.u, target_y: to.v }));
}

/** A route of waypoints: the first replaces current orders, the rest are queued (at most 12 commands in all). */
function route(units: AdviserActor[], action: "move" | "attack_move", points: Pt[]): AdviserCommand[] {
  const list = [...units].sort(byId).slice(0, MAX);
  const legs = Math.max(1, Math.min(points.length, Math.floor(MAX / list.length)));
  const chosen = points.length <= legs ? points
    : [...Array.from({ length: legs - 1 }, (_, k) => points[Math.floor((k + 1) * points.length / legs) - 1]), points[points.length - 1]];
  return list.flatMap((u) => chosen.map((p, k) => ({ action, actor_id: u.actorId, target_x: p.u, target_y: p.v, ...(k ? { queued: true } : {}) })));
}

function advice(text: string, summary: string, commands: AdviserCommand[], key: string, extra: Partial<MissionAdvice> = {}): MissionAdvice {
  return { text, summary, commands, key: `mission:${key}`, ...extra };
}

// ------------------------------------------------------------------ stealth: crossing sensor zones while they sleep

/** A sensor trips on a unit within its radius of its centre: cells that close, with half a cell to spare. */
const inZone = (s: Sensor, p: Pt) => Math.hypot(wx(p) - s.at.x, wy(p) - s.at.y) <= s.radius + 0.5;

/** Ticks a unit takes per cell (its speed is world units a tick; a cell is 1024), with room for slower ground. */
const ticksPerCell = (u: AdviserActor) => 1024 / Math.max(20, u.speed || 50) * 1.15;

interface Leg { commands: AdviserCommand[]; text: string; summary: string; key: string }

/**
 * Whether a unit sent from a to b keeps to open ground and out of the zones it is not meant to cross. The engine walks
 * its own path between two points: diagonal steps and straight ones, in either order, so both of those bent paths
 * (and the straight line between) must be clear.
 */
function openWay(grid: Grid, sensors: Sensor[], a: Pt, b: Pt, crossing = new Set<Sensor>()) {
  const clear = (q: Pt) => grid.pass(q) && !sensors.some((s) => !crossing.has(s) && inZone(s, q));
  const n = Math.ceil(dist(a, b) * 2);
  for (let k = 1; k < n; k++) if (!clear(lerp(a, b, k / n))) return false;
  const ca = toC(a), cb = toC(b), dx = cb.x - ca.x, dy = cb.y - ca.y;
  const diagonal = Math.min(Math.abs(dx), Math.abs(dy)), rest = Math.abs(Math.abs(dx) - Math.abs(dy)), sx = Math.sign(dx), sy = Math.sign(dy);
  const straight = Math.abs(dx) > Math.abs(dy) ? [sx, 0] : [0, sy];
  for (const first of [true, false]) {
    let x = ca.x, y = ca.y;
    for (let k = 0; k < diagonal + rest; k++) {
      const diag = first ? k < diagonal : k >= rest;
      x += diag ? sx : straight[0]; y += diag ? sy : straight[1];
      if (!clear(fromC(x, y))) return false;
    }
  }
  return true;
}

/** A short step away from an enemy (toward `toward` when given) that walks into no sensor zone. */
function safeStep(w: World, from: Pt, enemy: Pt, toward?: Pt): Pt | null {
  const grid = w.grid, sensors = w.watching();
  if (!grid) return null;
  let best: Pt | null = null, score = -Infinity;
  for (let r = 3; r <= 7; r++)
    for (let k = 0; k < 16; k++) {
      const q = point(wx(from) + r * Math.cos(k * Math.PI / 8), wy(from) + r * Math.sin(k * Math.PI / 8));
      if (!grid.pass(q) || sensors.some((s) => inZone(s, q)) || !openWay(grid, sensors, from, q)) continue;
      const s = dist(q, enemy) - (toward ? dist(q, toward) * 0.5 : 0);
      if (s > score) { score = s; best = q; }
    }
  return best && dist(best, enemy) > dist(from, enemy) ? best : null;
}

/**
 * Moves a group toward `goal` without tripping a sensor: plans a path that never enters a zone that never sleeps and
 * prefers to go round sweeping ones; walks it to the edge of the next zone, and crosses only when every sweep on the
 * way stays asleep until the group is through (the slowest unit, plus the time the order takes to reach the game).
 * Units away from the slowest one (which sets the pace) get routes of their own to the same point.
 */
function stealthLeg(w: World, group: AdviserActor[], goal: Pt, action: "move" | "attack_move", what: string, goalKey: string, closed = new Set<string>()): Leg | null {
  const grid = w.grid, sensors = w.watching();
  group = group.filter((u) => w.onLand(u)).sort(byId);
  if (!grid || !group.length) return null;
  const lead = [...group].sort((a, b) => ticksPerCell(b) - ticksPerCell(a) || a.actorId - b.actorId)[0];
  const end = grid.near(goal, 6) ?? goal;
  // Zones cost extra (sweeping) or are closed (never sleeping, or too wide to cross in one sleep); a band around them
  // costs a little, so the route keeps its distance where it can: units walk the engine's own path between waypoints,
  // which cuts corners.
  const plan = (from: Pt, to: Pt) => {
    const start = grid.near(from, 4) ?? from;
    return grid.path(start, to, (p) => {
      let cost = 0;
      for (const s of sensors) {
        const d = Math.hypot(wx(p) - s.at.x, wy(p) - s.at.y);
        if (d <= s.radius + 0.5) { if ((!s.sweep || closed.has(s.name)) && !inZone(s, to) && !inZone(s, start)) return Infinity; cost += 3; }
        else if (d <= s.radius + 2) cost += 0.6;
      }
      return cost;
    });
  };
  const path = plan(cellOf(lead), end);
  if (!path || path.length < 2) return null;
  const zonesAt = path.map((p) => sensors.filter((s) => inZone(s, p)));
  const first = zonesAt.findIndex((z) => z.length > 0);
  const spread = Math.max(...group.map((u) => dist(cellOf(u), cellOf(lead))));
  // Waypoints: the fewest that keep the way between them on open ground and out of the zones it is not meant to cross.
  // The engine walks its own path between waypoints: diagonal steps and straight ones, in either order, so both of
  // those bent paths (and the straight line between) must be clear.
  const open = (a: Pt, b: Pt, crossing: Set<Sensor>) => openWay(grid, sensors, a, b, crossing);
  const waypoints = (route: Pt[], to: number, crossing: Set<Sensor>) => {
    const out: Pt[] = [];
    for (let i = 0; i < to;) {
      let j = i + 1;
      for (let k = Math.min(to, i + 40); k > i + 1; k--) if (open(route[i], route[k], crossing)) { j = k; break; }
      out.push(route[j]); i = j;
    }
    return out;
  };
  // An order has room for twelve commands: a big group walks fewer waypoints at a time.
  const budget = Math.max(1, Math.floor(MAX / Math.min(MAX, group.length)));
  const orders = (to: number, crossing = new Set<Sensor>(), whole = false) => {
    const mine = waypoints(path, to, crossing);
    const legs = whole ? mine : mine.slice(0, budget);
    const goalCell = legs[legs.length - 1] ?? path[to];
    const commands: AdviserCommand[] = [];
    for (const u of group) {
      let points = legs;
      if (u !== lead && dist(cellOf(u), cellOf(lead)) > 2) {
        const own = plan(cellOf(u), goalCell);
        if (own && own.length > 1) points = waypoints(own, own.length - 1, crossing);
      }
      if (points.length > budget) points = [...points.slice(0, budget - 1), points[points.length - 1]];
      points.forEach((p, k) => { if (commands.length < MAX) commands.push({ action, actor_id: u.actorId, target_x: p.u, target_y: p.v, ...(k ? { queued: true } : {}) }); });
    }
    return { commands, at: goalCell };
  };
  if (first < 0) {
    const leg = orders(path.length - 1);
    return { commands: leg.commands, text: `${what}: the way there is out of the sensors' sight.`,
      summary: `Move ${plural(group.length, "unit")} on`, key: `${goalKey}:walk:${leg.at.u},${leg.at.v}` };
  }
  // Wait two cells before the zone, together.
  const stage = Math.max(0, first - 2);
  if (stage > 2 || spread > 3.5) {
    const leg = orders(stage);
    return { commands: leg.commands, text: `${what}: move up to the edge of the next sensor zone and wait for its sweep.`,
      summary: `Move ${plural(group.length, "unit")} to the zone's edge`, key: `${goalKey}:stage:${leg.at.u},${leg.at.v}` };
  }
  // The crossing: to the first cell past every zone (or the goal).
  let exit = first;
  while (exit < path.length - 1 && (zonesAt[exit].length || zonesAt[exit + 1].length)) exit++;
  exit = Math.min(path.length - 1, exit + 1);
  const along = (k: number) => { let d = 0; for (let j = 1; j <= k; j++) d += dist(path[j - 1], path[j]); return d; };
  // In soonest (the fastest unit at full speed, the order landing at once), out last (the slowest, with room for
  // slower ground, the group's spread and the order taking longer to reach the game at higher speeds).
  const quickest = Math.min(...group.map((u) => 1024 / Math.max(20, u.speed || 50))) * 0.9;
  const slow = Math.max(...group.map(ticksPerCell));
  const latency = 15 + Math.round(w.memory.pace.rate * 150);
  const crossing = [...new Set(zonesAt.slice(stage, exit + 1).flat())];
  const windows = crossing.map((s) => {
    let a = -1, b = -1;
    for (let k = 0; k <= exit; k++) if (inZone(s, path[k])) { if (a < 0) a = k; b = k; }
    return { s, t0: w.tick + Math.max(0, (along(a) - 1) * quickest), t1: w.tick + latency + (along(b) + spread + 1) * slow + 25 };
  });
  // A zone too wide to cross in one sleep: another way round it, if there is one; if not, cross as it falls asleep
  // and hope the last of the group is out in time.
  const tooWide = windows.find((x) => x.s.sweep && x.t1 - x.t0 > x.s.sweep[1] * 25 - 10);
  if (tooWide && !closed.has(tooWide.s.name)) {
    const other = stealthLeg(w, group, goal, action, what, goalKey, new Set([...closed, tooWide.s.name]));
    if (other) return other;
  }
  const blocked = windows.find(({ s, t0, t1 }) => {
    const until = s === tooWide?.s && s.sweep ? Math.min(t1, t0 + s.sweep[1] * 25 - 10) : t1;
    for (let t = t0; t <= until; t += 5) if (w.sensorOn(s, t)) return true;
    return false;
  })?.s;
  if (blocked) return { commands: [], text: `${what}: hold at the edge of ${placeName(blocked.name)}'s zone and cross while it sleeps.`,
    summary: "", key: `${goalKey}:wait:${blocked.name}` };
  const names = crossing.map((s) => placeName(s.name)).join(" and ");
  // The whole crossing in one order, so no one stops inside.
  const leg = orders(exit, new Set(crossing), true);
  return { commands: leg.commands, text: `${what}: cross now, while ${names} ${crossing.length > 1 ? "sleep" : "sleeps"}.`,
    summary: `Cross ${names}'s zone with ${plural(group.length, "unit")}`, key: `${goalKey}:cross:${path[exit].u},${path[exit].v}` };
}

/** Units inside a zone that will sweep before they could walk out: out by the shortest way, now. */
function evade(w: World): MissionAdvice | null {
  const sensors = w.watching(), grid = w.grid;
  if (!sensors.length || !grid) return null;
  const commands: AdviserCommand[] = [];
  let first = "";
  for (const u of w.movable().sort(byId)) {
    const p = cellOf(u);
    const zones = sensors.filter((s) => inZone(s, p));
    if (!zones.length) continue;
    const out = grid.near(p, 14, (q) => sensors.some((s) => inZone(s, q)));
    if (!out) continue;
    const need = (dist(p, out) + 1) * ticksPerCell(u) + 30 + w.memory.pace.rate * 600;
    const h = w.memory.heading.get(u.actorId);
    // Staying hidden as a bonus: a unit on an errand for a required objective keeps going.
    if (!w.strictStealth() && h && !h.reactive && !u.idle) continue;
    // Crossing on a planned route: the crossing was timed; only a sweep about to start sends it out.
    const crossing = h && !u.idle && h.key.includes(":cross:") && w.tick - h.tick < 600;
    const soon = (span: number) => zones.some((s) => { for (let t = w.tick; t <= w.tick + span; t += 5) if (w.sensorOn(s, t)) return true; return false; });
    if (crossing ? !soon(15) : !soon(need)) continue;
    // Already on its way out (to a cell outside every zone) and out in time: leave it be.
    const to = h?.to;
    if (to && !u.idle && !sensors.some((s) => inZone(s, to)) && !soon((dist(p, to) + 1) * ticksPerCell(u) + 30)) continue;
    if (h?.goal === "evade" && !u.idle && w.tick - h.tick < 150) continue;
    first ||= zones[0].name;
    if (commands.length < MAX) commands.push({ action: "move", actor_id: u.actorId, target_x: out.u, target_y: out.v });
  }
  if (!commands.length) return null;
  return advice(`Get out of ${placeName(first)}'s zone before it sweeps: move ${plural(commands.length, "unit")} out now.`,
    `Move ${plural(commands.length, "unit")} out of the sensor zone`, commands, `evade:${commands.map((c) => c.actor_id).join(",")}`, { goal: "evade", reactive: true });
}

// ------------------------------------------------------------------ the planner

/** What must not fall: the mission's protected places and the objectives' (when they are ours), the convoys, the base. */
function assets(w: World) {
  const out: { at: Pt; name: string; vital: boolean }[] = [];
  const names = new Set([...w.ctx.spec.protect ?? [], ...w.objectives.filter((o) => o.kind === "protect" && o.status === "active").flatMap((o) => o.targets ?? [])]);
  for (const name of names) {
    // A marker protected by the rules (Ghosts on the Glass: a strike on a phantom "kills" the picture) is not a place.
    if (w.hostile(name) || ["waypoint", "mpspawn"].includes(w.ctx.map.named[name]?.type ?? "")) continue;
    const a = w.find(name);
    // Units the mission needs alive move with the army and pull back when hurt (heroes) instead.
    if (a && w.units.includes(a)) continue;
    const p = w.where(name);
    if (p) out.push({ at: p, name, vital: true });
  }
  for (const c of w.units.filter((u) => w.convoyTypes.has(baseType(u.kind)))) out.push({ at: cellOf(c), name: "convoy", vital: true });
  if (w.hasBase) for (const b of w.obs.buildings) out.push({ at: cellOf(b), name: "base", vital: false });
  return out;
}

function defend(w: World, busy: Set<number>): MissionAdvice | null {
  const places = assets(w);
  if (!places.length || !w.enemies.length) return null;
  let best: { enemy: AdviserActor; place: (typeof places)[number]; score: number } | null = null;
  // Unverified contacts are not attackers until shown to be real.
  const careful = w.unverified().length > 0;
  for (const enemy of [...w.enemies].sort(byId).filter((e) => w.mayFire(e)))
    for (const place of places) {
      const d = dist(cellOf(enemy), place.at);
      if (d > (place.vital ? 12 : 9)) continue;
      const score = d - (place.vital ? 4 : 0);
      if (!best || score < best.score) best = { enemy, place, score };
    }
  if (!best) return null;
  const contact = cellOf(best.enemy), place = best.place;
  w.memory.attacked = w.tick;
  // A coarse goal: the same fight keeps the same goal while the attackers shift.
  const goal = `defend:${Math.round(contact.u / 8)},${Math.round(contact.v / 16)}`;
  const reach = place.vital ? (w.hasBase ? 34 : 20) : 26;
  // Units on an objective errand turn back only for an attack close to them; the rest answer from further away.
  const errand = (u: AdviserActor) => { const h = w.memory.heading.get(u.actorId); return !!h && !h.reactive && w.tick - h.tick < 1500; };
  const responders = w.fighters.filter((u) => !busy.has(u.actorId) && !w.heroes.has(u.actorId) && dist(cellOf(u), contact) <= (errand(u) ? 12 : reach)
    && needsOrder(w, u, goal, contact, 3));
  if (!responders.length) return null;
  // With unverified contacts about, at that attacker only (an attack-move could open fire on a phantom on the way).
  const commands = careful ? responders.sort(byId).slice(0, MAX).map((u) => ({ action: "attack" as const, actor_id: u.actorId, target_actor_id: best!.enemy.actorId }))
    : sendAll(responders, "attack_move", contact);
  const where = place.name === "base" ? "the base" : place.name === "convoy" ? "the convoy" : placeName(place.name);
  return advice(`Enemies are at ${where}; send ${plural(commands.length, "unit")} at them now.`, `Attack-move ${plural(commands.length, "unit")} to the attackers`, commands, goal, { goal, reactive: true });
}

function disperse(w: World): MissionAdvice | null {
  const o = w.objectives.find((x) => x.kind === "disperse" && x.status === "active" && !x.waiting);
  const grid = w.grid;
  if (!o || (o.area ?? []).length !== 4 || !grid) return null;
  const [u0, v0, u1, v1] = o.area!;
  const inside = (p: Pt) => p.u >= u0 - 1 && p.v >= v0 - 2 && p.u <= u1 + 1 && p.v <= v1 + 2;
  const allowed = o.allowed ?? 1;
  // Every unit out (the allowance is a margin, not a plan), whatever else it was doing: the sweep fails the mission.
  const there = w.movable().filter((u) => inside(cellOf(u))).sort(byId);
  if (!there.length) return null;
  const goal = `disperse:${o.i}`;
  const commands: AdviserCommand[] = [];
  for (const u of there) {
    const p = cellOf(u), h = w.memory.heading.get(u.actorId);
    if (h?.goal === goal && (!u.idle || w.tick - h.tick < 50)) continue;
    // Out through the nearest side, a few cells clear of it.
    const sides: Pt[] = [{ u: u0 - 4, v: p.v }, { u: u1 + 4, v: p.v }, { u: p.u, v: v0 - 8 }, { u: p.u, v: v1 + 8 }].sort((a, b) => dist(p, a) - dist(p, b));
    const to = sides.map((s) => grid.near(s, 8, inside)).find((s): s is Pt => !!s);
    if (to && commands.length < MAX) commands.push({ action: "move", actor_id: u.actorId, target_x: to.u, target_y: to.v });
  }
  if (!commands.length) return null;
  return advice(`Move ${plural(commands.length, "unit")} out of the marked surveillance zone before the sweep; at most ${allowed} may stay.`,
    `Move ${plural(commands.length, "unit")} out of the zone`, commands, goal, { goal, reactive: true });
}

/** How many fighters an attack on a defended objective waits for, in a mission with a base to build them. */
const strength = (w: World) => (w.difficulty === "easy" ? 6 : w.difficulty === "hard" ? 10 : 8);

/** Reach objectives done by particular units (a specialist that deploys, vehicles through a gate), not the army. */
const special = (o: Objective) => o.kind === "reach" && (!!o.deploy || !!o.via || (o.types ?? []).length <= 2);

interface Focus { o: Objective; prepare: boolean }

/** The army's objective: open ones first (primary, under a deadline, nearest); otherwise the next one a gate holds. */
function focusOf(w: World): Focus | null {
  const army = w.fighters.length ? centroid(w.fighters.map(cellOf)) : w.base() ?? { u: 0, v: 0 };
  const far = (o: Objective) => {
    const names = [o.target, ...(o.targets ?? []), o.entry, ...(o.route ?? []).slice(0, 1), ...(o.lanes ?? []).map((l) => l[1])].filter((n): n is string => !!n);
    const p = names.map((n) => w.where(n)).find((x): x is Pt => !!x);
    return p ? dist(p, army) : 999;
  };
  const army0 = (o: Objective) => o.status === "active" && !passiveKinds.has(o.kind) && !["build", "disperse", "scout"].includes(o.kind) && !special(o);
  // Targets all out at sea are for ships: an army with none takes them last.
  const ships = w.fighters.some((u) => w.ctx.techTree[baseType(u.kind)]?.queue === "Ship");
  const atSea = (o: Objective) => !ships && !!w.grid && (o.kind === "destroy" || o.kind === "capture") && (o.targets ?? []).length > 0
    && (o.targets ?? []).every((t) => { const p = w.where(t); return !p || !w.grid!.pass(p); });
  // Targets the army has had to search for again and again (ships that slip out of sight) wait behind the rest.
  const chased = (o: Objective) => (o.targets ?? []).some((t) => (w.memory.search.get(t)?.n ?? 0) >= 3);
  const rank = (o: Objective) => (o.secondary ? 1000 : 0) + (o.kind === "survive" ? 500 : 0) + (atSea(o) || chased(o) ? 400 : 0) + (o.limit ? -100 : 0) + far(o) / 10;
  const open = w.objectives.filter((o) => army0(o) && !o.waiting).sort((a, b) => rank(a) - rank(b) || a.i - b.i);
  const upcoming = w.objectives.filter((o) => army0(o) && o.waiting);
  if (open.length && open[0].kind !== "survive") return { o: open[0], prepare: false };
  if (upcoming.length) return { o: upcoming[0], prepare: true };
  return open.length ? { o: open[0], prepare: false } : null;
}

/**
 * A special unit's errand: reach a place (by way of a gate), deploy there. In a mission without a base, the fighters
 * are its escort and the team moves in step: all of it walks each leg together, the next one once everyone has
 * stopped; enemies in sight near the specialist are the fighters' to clear while it holds, and it steps back from
 * anyone close.
 */
function reachSpecial(w: World, o: Objective, units: AdviserActor[], escorts: AdviserActor[]): MissionAdvice | null {
  const target = o.target ? w.where(o.target) : null;
  if (!target || !units.length) return null;
  const radius = o.radius ?? 3, label = placeName(o.target!);
  const goal = `reach:${o.i}`;
  const close = units.filter((u) => dist(cellOf(u), target) <= Math.max(1, radius - 1));
  if (o.deploy && close.length) {
    const ready = close.filter((u) => !w.memory.deployed.has(u.actorId) && u.idle).sort(byId);
    if (ready.length) return advice(`Your ${w.name(ready[0].kind)} is at ${label}: deploy it there now.`, `Deploy the ${w.name(ready[0].kind)}`,
      [{ action: "deploy", actor_id: ready[0].actorId }], `deploy:${o.i}`, { goal });
    // Deployed a while ago and the objective is still open: not close enough. Step right up (moving packs it up).
    const short = close.filter((u) => w.tick - (w.memory.deployed.get(u.actorId) ?? w.tick) > 150).sort(byId)[0];
    if (!short) return null;
    const to = w.land(target, 4);
    return advice(`The ${w.name(short.kind)} is not quite close enough: step right up to ${label} and deploy again.`, `Move the ${w.name(short.kind)} closer`,
      [{ action: "move", actor_id: short.actorId, target_x: to.u, target_y: to.v }], `closer:${o.i}:${w.memory.deployed.get(short.actorId)}`, { goal: `closer:${o.i}` });
  }
  const lead = [...units].sort((a, b) => dist(cellOf(a), target) - dist(cellOf(b), target) || a.actorId - b.actorId)[0];
  const here = cellOf(lead), name = w.name(lead.kind);
  const what = o.deploy ? `Take the ${name} to ${label} and deploy it` : `Bring the ${name} to ${label}`;
  const team = w.hasBase ? [] : escorts.filter((f) => !units.includes(f) && w.onLand(f));
  if (!team.length) {
    const movers = units.filter((u) => needsOrder(w, u, goal, target, Math.max(1, radius - 1.5)));
    if (!movers.length) return null;
    if (w.watching().length) {
      const leg = stealthLeg(w, movers, target, "move", what, goal);
      return leg ? advice(leg.text, leg.summary, leg.commands, leg.key, { goal }) : null;
    }
    const via = o.via ? w.where(o.via) : null;
    const commands = via ? route(movers, "move", [via, target]) : sendAll(movers, "move", w.land(target, 4));
    return advice(`${what}${o.via ? ` by way of ${placeName(o.via)}` : ""}.`, `Move ${plural(Math.min(MAX, movers.length), "unit")} to ${label}`, commands, goal, { goal });
  }
  const threats = w.enemies.filter((e) => dist(cellOf(e), here) <= 12 || (dist(cellOf(e), target) <= 8 && dist(here, target) <= 18))
    .sort((a, b) => dist(cellOf(a), here) - dist(cellOf(b), here) || a.actorId - b.actorId);
  if (threats.length) {
    const enemy = threats[0], e = cellOf(enemy), clear = `clear:${o.i}`;
    const commands: AdviserCommand[] = [], goals: Record<number, string> = {};
    let text = `Clear the guards near ${label} with your fighters; the ${name} waits back.`, summary = "";
    const free = team.filter((f) => needsOrder(w, f, clear, e, 2) && !(w.memory.heading.get(f.actorId)?.goal === clear && !f.idle));
    if (free.length) {
      const leg = w.watching().length ? stealthLeg(w, free, e, "attack_move", `Clear the guards near ${label}`, clear)
        : { commands: sendAll(free, "attack_move", e), text, summary: "", key: clear };
      if (leg?.commands.length) { commands.push(...leg.commands); text = leg.text; summary = `Attack-move ${plural(free.length, "unit")} at the guards`; }
      else if (leg) text = leg.text;
    }
    for (const u of units) {
      const h = w.memory.heading.get(u.actorId);
      if (dist(cellOf(u), e) <= 8 && !(h?.goal === "back" && !u.idle) && w.grid) {
        // Close: a few cells back (toward the fighters when they are behind), by a way that enters no sensor zone.
        const fighters = centroid(team.map(cellOf)), p = cellOf(u);
        const safe = safeStep(w, p, e, dist(fighters, e) > dist(p, e) + 2 ? fighters : undefined);
        if (!safe || commands.length >= MAX) continue;
        commands.push({ action: "move", actor_id: u.actorId, target_x: safe.u, target_y: safe.v });
        goals[u.actorId] = "back";
        text = `Enemies close to the ${name}: pull it back while your fighters clear them.`;
        summary ||= `Pull the ${name} back`;
      } else if (h?.goal === goal && !u.idle && !h.key.includes(":cross:") && commands.length < MAX) {
        // Walking ahead while the fighters turn to fight: stop and wait for them.
        commands.push({ action: "stop", actor_id: u.actorId });
        goals[u.actorId] = "hold";
      }
    }
    if (!commands.length) return advice(text, "", [], `${clear}:busy`);
    return advice(text, summary || `Hold the ${name} back`, commands, `${clear}:${commands.map((c) => `${c.action[0]}${c.actor_id}`).join(",")}`, { goal: clear, goals });
  }
  // In step: while anyone is still walking the last leg, wait for them.
  const all = [...units, ...team];
  if (all.some((u) => !u.idle && w.memory.heading.get(u.actorId)?.goal === goal)) return w.memory.said ? advice(w.memory.said.text, "", [], `${goal}:walking`) : null;
  if (units.every((u) => dist(cellOf(u), target) <= Math.max(1, radius - 1.5))) return null;
  if (w.watching().length) {
    const leg = stealthLeg(w, all, target, "move", what, goal);
    return leg ? advice(leg.text, leg.summary, leg.commands, leg.key, { goal }) : null;
  }
  return advice(`${what}, with the fighters alongside.`, `Move ${plural(Math.min(MAX, all.length), "unit")} to ${label}`, sendAll(all, "move", w.land(target, 4)), goal, { goal });
}

/**
 * An attack-move by hand, for when attack-moving could open fire on an unverified contact: units near `near` that
 * are not shooting at anything are put onto the nearest armed enemy in sight there, never a contact not verified yet.
 */
function engage(w: World, units: AdviserActor[], near: Pt, goal: string, label: string): MissionAdvice | null {
  const foes = [...w.enemies, ...w.obs.visibleEnemyBuildings.filter((b) => b.canAttack)]
    .filter((e) => w.mayFire(e) && dist(cellOf(e), near) <= 12).sort(byId);
  if (!foes.length) return null;
  const free = units.filter((u) => !u.targetId && !(w.memory.heading.get(u.actorId)?.goal === goal && w.tick - w.memory.heading.get(u.actorId)!.tick < 150)).sort(byId).slice(0, MAX);
  if (!free.length) return null;
  const commands = free.map((u) => {
    const foe = [...foes].sort((a, b) => dist(cellOf(a), cellOf(u)) - dist(cellOf(b), cellOf(u)) || a.actorId - b.actorId)[0];
    return { action: "attack" as const, actor_id: u.actorId, target_actor_id: foe.actorId };
  });
  return advice(`Clear the guards at ${label} one by one (no attack-moves while contacts are unverified): ${plural(commands.length, "unit")} onto them.`,
    `Attack the guards with ${plural(commands.length, "unit")}`, commands, `${goal}:${commands.map((c) => `${c.actor_id}>${c.target_actor_id}`).join(",")}`, { goal });
}

/**
 * Sends the army units that are not there or on their way yet; `say` writes the line from the number sent. Land units
 * go to the nearest ground, ships to the place itself when it is at sea. Strung out with enemies in sight ahead, the
 * army advances in short hops, the front waiting for the rest; units the mission needs alive follow instead of lead.
 */
function go(w: World, army: AdviserActor[], to: Pt, goal: string, say: (n: number) => [string, string], arrive = 4, action: "attack_move" | "move" = "attack_move") {
  // Not into a surveillance area that must be empty at its sweep: to the nearest ground outside it.
  const dest = w.forbidden(to) ? w.grid?.near(to, 16, (q) => w.forbidden(q)) ?? w.land(to) : w.land(to), wet = w.grid ? !w.grid.pass(to) : false;
  const land = army.filter((u) => w.onLand(u)), ships = wet ? army.filter((u) => !w.onLand(u) && needsOrder(w, u, goal, to, arrive + 2)) : [];
  const troops = land.some((u) => !w.heroes.has(u.actorId)) ? land.filter((u) => !w.heroes.has(u.actorId)) : land;
  const followers = land.filter((u) => !troops.includes(u));
  const left = (u: AdviserActor) => dist(cellOf(u), dest);
  const centre = centroid(troops.map(cellOf));
  let step = dest, stepGoal = goal, stepArrive = arrive;
  const sorted = [...troops].sort((a, b) => left(a) - left(b) || a.actorId - b.actorId);
  const front = sorted[0];
  const contact = !!front && w.enemies.some((e) => dist(cellOf(e), cellOf(front)) <= 14 || dist(cellOf(e), dest) <= 10);
  if (troops.length >= 3 && contact && dist(centre, dest) > 10 && left(sorted[sorted.length - 1]) - left(front) > 8) {
    // A coarse point, so the hop holds still while the army shifts a little.
    const hop = lerp(centre, dest, Math.min(1, 8 / dist(centre, dest)));
    step = w.land({ u: Math.round(hop.u / 2) * 2, v: Math.round(hop.v / 4) * 4 }, 6);
    stepGoal = `${goal}:hop`; stepArrive = 3;
  }
  // In a hop, units already past it wait for the rest; followers catch up with the army's middle when behind it.
  const movers = troops.filter((u) => needsOrder(w, u, stepGoal, step, stepArrive) && (step === dest || left(u) > dist(step, dest) - 2));
  const trail = followers.filter((u) => left(u) > dist(centre, dest) + 3 && needsOrder(w, u, `${goal}:follow`, centre, 3));
  if (!movers.length && !ships.length && !trail.length) return null;
  const goals = Object.fromEntries([...movers.map((u) => [u.actorId, stepGoal]), ...trail.map((u) => [u.actorId, `${goal}:follow`])]);
  if (w.watching().length) {
    const lead = movers.length ? stealthLeg(w, movers, step, action, say(movers.length)[0].replace(/[:.;].*$/, ""), stepGoal) : null;
    const back = trail.length ? stealthLeg(w, trail, w.land(centre, 6), action, "Follow the army", `${goal}:follow`) : null;
    const first = lead ?? back;
    if (!first) return null;
    const commands = [...lead?.commands ?? [], ...back?.commands ?? []].slice(0, MAX);
    if (!commands.length) return advice(first.text, "", [], first.key);
    return advice(lead?.commands.length ? lead.text : first.text, lead?.summary || back?.summary || "", commands, `${lead?.key ?? ""}|${back?.key ?? ""}`, { goal, goals });
  }
  const commands = [...sendAll(movers, action, step), ...sendAll(ships, action, to), ...sendAll(trail, action, w.land(centre, 6))].slice(0, MAX);
  const [text, summary] = say(commands.length);
  return advice(text, summary, commands, `${stepGoal}:${step.u},${step.v}`, { goal, goals });
}

/** The army's errand for the focus objective. */
function armyTask(w: World, f: Focus, army: AdviserActor[]): MissionAdvice | null {
  const o = f.o, prepare = f.prepare, fixed = !w.hasBase;
  // Out of money with nothing being built: no more is coming, so the army goes with what it has.
  const broke = w.obs.cash < 500 && !w.obs.production.length && army.length >= 3;
  const units = (n: number) => plural(n, "unit");
  const gather = (target: Pt | null, why: string) => {
    const home = w.base();
    if (!home) return null;
    const rally = target ? lerp(home, target, 0.25) : home;
    return go(w, army, rally, `gather:${o.i}`, (n) => [`Gather the army by the base until it is ${strength(w)} strong (${army.length} now), then ${why}.`,
      `Attack-move ${units(n)} to the rally point`], 6);
  };
  const targetsOf = () => (o.targets ?? []).map((t) => ({ t, p: w.where(t), a: w.find(t) })).filter((x): x is { t: string; p: Pt; a: AdviserActor | null } => !!x.p);
  switch (o.kind) {
    case "reach": {
      const target = o.target ? w.where(o.target) : null;
      if (!target) return null;
      const need = w.difficulty === "easy" ? 1 : o.count ?? 1;
      const label = placeName(o.target!), types = new Set(o.types ?? []);
      if (prepare) return go(w, army, lerp(target, w.base() ?? target, 0.3), `prepare:${o.i}`, (n) => [`Next: ${lower(o.text)}. Move up toward ${label}.`, `Attack-move ${units(n)} toward ${label}`], 8);
      const there = w.units.filter((u) => types.has(baseType(u.kind)) && dist(cellOf(u), target) <= (o.radius ?? 3));
      // Once the place is clear, units of the right type close by step inside the radius.
      if (there.length < need && w.enemies.every((e) => dist(cellOf(e), target) > 8)) {
        const close = w.units.filter((u) => types.has(baseType(u.kind)) && !there.includes(u) && u.idle && dist(cellOf(u), target) <= 14)
          .sort((a, b) => dist(cellOf(a), target) - dist(cellOf(b), target) || a.actorId - b.actorId).slice(0, need - there.length);
        const goal = `reach:${o.i}:in`;
        const steppers = close.filter((u) => needsOrder(w, u, goal, target, (o.radius ?? 3) - 1));
        if (steppers.length) return advice(`Step ${units(steppers.length)} right up to ${label}: ${need} must be there.`, `Move ${units(steppers.length)} to ${label}`,
          sendAll(steppers, "move", w.land(target, 4)), goal, { goal });
      }
      return go(w, army, target, `reach:${o.i}`, (n) => [`${capital(lower(o.text))}: send ${units(n)} there (${need} must reach it).`, `Attack-move ${units(n)} to ${label}`], Math.max(2, (o.radius ?? 3) - 1));
    }
    case "destroy": {
      const all = targetsOf();
      if (!all.length) return null;
      const from = army.length ? centroid(army.map(cellOf)) : w.base() ?? all[0].p;
      // Targets that moved out of sight are looked for after the others.
      const lost = (t: string) => { const l = w.memory.named.get(t)?.lost; return l && w.tick - l < 1500 ? 1 : 0; };
      all.sort((a, b) => lost(a.t) - lost(b.t) || dist(a.p, from) - dist(b.p, from) || a.t.localeCompare(b.t));
      const next = all[0], label = placeName(next.t), left = secondsLeft(o.progress);
      // Charges first: C4 takes a building at once. Each target gets the nearest unit that can charge it and is not on
      // another charge run (one the mission needs alive only when no one else can).
      if (!prepare) {
        const commands: AdviserCommand[] = [], goals: Record<number, string> = {}, taken = new Set<number>();
        // Not a hurt hero (pulling back is its errand now).
        const sappers = w.units.filter((u) => u.canDemolish && !(w.heroes.has(u.actorId) && ((u.hpPercent ?? 1) < 0.5 || w.memory.heading.get(u.actorId)?.goal === "retreat")))
          .sort((a, b) => Number(w.heroes.has(a.actorId)) - Number(w.heroes.has(b.actorId)) || a.actorId - b.actorId);
        for (const x of all) {
          if (!x.a) continue;
          const run = `c4:${x.t}`;
          if (sappers.some((u) => w.memory.heading.get(u.actorId)?.goal === run && !u.idle)) continue;
          const s = sappers.filter((u) => !taken.has(u.actorId) && (u.demolishTargets ?? []).includes(x.a!.actorId)
            && !(w.memory.heading.get(u.actorId)?.goal.startsWith("c4:") && !u.idle))
            .sort((a, b) => Number(w.heroes.has(a.actorId)) - Number(w.heroes.has(b.actorId)) || dist(cellOf(a), x.p) - dist(cellOf(b), x.p) || a.actorId - b.actorId)[0];
          if (!s || commands.length >= MAX) continue;
          taken.add(s.actorId); goals[s.actorId] = run;
          commands.push({ action: "demolish", actor_id: s.actorId, target_actor_id: x.a.actorId });
        }
        // Targets left over: queued after a run already set (the least busy unit that can charge them).
        for (const x of all) {
          if (!x.a || commands.some((c) => c.target_actor_id === x.a!.actorId) || sappers.some((u) => w.memory.heading.get(u.actorId)?.goal === `c4:${x.t}` && !u.idle)) continue;
          const s = sappers.filter((u) => taken.has(u.actorId) && (u.demolishTargets ?? []).includes(x.a!.actorId))
            .sort((a, b) => commands.filter((c) => c.actor_id === a.actorId).length - commands.filter((c) => c.actor_id === b.actorId).length || a.actorId - b.actorId)[0];
          if (s && commands.length < MAX) commands.push({ action: "demolish", actor_id: s.actorId, target_actor_id: x.a.actorId, queued: true });
        }
        if (commands.length) return advice(`Place charges on ${commands.length === 1 ? placeName(Object.values(goals)[0].slice(3)) : `${commands.length} targets`} now${left !== null ? ` (${clock(left)} left)` : ""}.`,
          `Demolish ${plural(commands.length, "target")}`, commands, `c4:${o.i}:${commands.map((c) => `${c.actor_id}>${c.target_actor_id}`).join(",")}`, { goal: `c4:${o.i}`, goals });
      }
      if (prepare || (!fixed && !broke && army.length < strength(w) && !army.some((u) => dist(cellOf(u), next.p) < 14))) return gather(next.p, `strike ${label}`);
      // Unverified contacts about (no attack-moves): near the target, units are put onto the guards in sight first.
      if (w.unverified().length) { const e = engage(w, army.filter((u) => dist(cellOf(u), next.p) <= 14), next.p, `hit:${next.t}`, label); if (e) return e; }
      // A target in sight: units near it that are not shooting at anything are put onto it (attack-move fights what
      // shoots back but walks past a building that does not).
      if (next.a && w.enemies.concat(w.obs.visibleEnemyBuildings).some((e) => e.actorId === next.a!.actorId)) {
        const goal = `hit:${next.t}`;
        // Not a unit on a charge run (its C4 would be called off).
        const busy = (u: AdviserActor) => { const h = w.memory.heading.get(u.actorId); return !!h && ((h.goal === goal && w.tick - h.tick < 250) || (h.goal.startsWith("c4:") && w.tick - h.tick < 500)); };
        const idle = army.filter((u) => dist(cellOf(u), next.p) <= 12 && !u.targetId && !busy(u));
        if (idle.length) return advice(`Focus fire on ${label}: put ${units(Math.min(MAX, idle.length))} on it.`, `Attack ${label} with ${units(Math.min(MAX, idle.length))}`,
          idle.sort(byId).slice(0, MAX).map((u) => ({ action: "attack" as const, actor_id: u.actorId, target_actor_id: next.a!.actorId })), goal, { goal });
      }
      // A target that moved out of sight: search round where it was last seen, the nearest ground not in sight first, one
      // place at a time (kept until reached or in sight), and not for ever.
      if (!next.a && w.memory.named.get(next.t)?.lost !== undefined && army.some((u) => dist(cellOf(u), next.p) <= 6)) {
        let look = w.memory.search.get(next.t);
        if (!look || w.grid?.seen(look.spot) || army.some((u) => dist(cellOf(u), look!.spot) <= 4)) {
          const spot = (look?.n ?? 0) < 6 ? w.searchSpot(next.p, from) : null;
          look = spot ? { spot, n: (look?.n ?? 0) + 1 } : undefined;
          if (look) w.memory.search.set(next.t, look);
        }
        if (look) {
          const spot = look.spot;
          const sent = go(w, army, spot, `search:${next.t}:${spot.u},${spot.v}`, (n) => [`Find ${label}: it moved out of sight; search round where it was seen with ${units(n)}.`,
            `Attack-move ${units(n)} to search for ${label}`], 4);
          if (sent) return sent;
        }
      }
      // Units put onto the target (or charging it) are on it already.
      const onIt = (u: AdviserActor) => { const h = w.memory.heading.get(u.actorId); return !!h && (h.goal === `hit:${next.t}` || h.goal === `c4:${next.t}`) && (!u.idle || w.tick - h.tick < 250); };
      return go(w, army.filter((u) => !onIt(u)), next.p, `destroy:${next.t}`, (n) => [`Destroy ${label}: send ${units(n)}${left !== null ? ` (${clock(left)} left)` : ""}.`, `Attack-move ${units(n)} to ${label}`], 5);
    }
    case "capture": {
      // The places not ours yet: the least defended first (enemy buildings seen around it: taking a power station
      // first can leave the guns at the next one dark), then the nearest to the army.
      const from = army.length ? centroid(army.map(cellOf)) : w.base() ?? { u: 0, v: 0 };
      const guarded = (p: Pt) => [...w.obs.visibleEnemyBuildings, ...w.obs.rememberedEnemyBuildings ?? []].filter((b) => dist(cellOf(b), p) <= 8).length;
      const next = targetsOf().filter((x) => !w.obs.buildings.some((b) => b.actorId === x.a?.actorId))
        .sort((a, b) => guarded(a.p) - guarded(b.p) || dist(a.p, from) - dist(b.p, from) || a.t.localeCompare(b.t))[0];
      if (!next) return null;
      const label = placeName(next.t), id = w.idOf(next.t);
      const guards = w.enemies.filter((e) => dist(cellOf(e), next.p) <= 7);
      const engineers = w.engineers;
      // Clear means the army holds the place (fog hides guards), or an engineer is already at the door.
      const holding = army.filter((u) => dist(cellOf(u), next.p) <= 7).length >= Math.min(3, army.length) && w.inSight(next.p, 7) >= 0.8;
      const atDoor = engineers.some((e) => dist(cellOf(e), next.p) <= 5);
      // One engineer on its way in is enough: the others stay where they are.
      const capturing = engineers.some((e) => w.memory.heading.get(e.actorId)?.goal === `capture:${o.i}` && !e.idle);
      if (!prepare && !guards.length && id !== undefined && (holding || atDoor) && !capturing) {
        const able = engineers.filter((e) => (e.captureTargets ?? []).includes(id)).sort((a, b) => dist(cellOf(a), next.p) - dist(cellOf(b), next.p) || a.actorId - b.actorId);
        const goal = `capture:${o.i}`;
        if (able.length) return advice(`${capital(label)} is clear: send your ${w.name(able[0].kind)} to capture it now.`,
          `Capture ${label} with the ${w.name(able[0].kind)}`, [{ action: "capture", actor_id: able[0].actorId, target_actor_id: id }], goal, { goal });
      }
      // Engineers keep back from the fight, then come up behind the army once it holds the place.
      if (holding && !guards.length && engineers.length && !capturing) {
        const from = centroid(engineers.map(cellOf));
        const stand = w.land(lerp(next.p, from, Math.min(0.6, 6 / Math.max(1, dist(next.p, from)))), 6);
        const goal = `follow:${o.i}`;
        const walkers = engineers.filter((e) => needsOrder(w, e, goal, stand, 3));
        if (walkers.length) return advice(`The army holds ${label}: bring ${plural(walkers.length, w.name(walkers[0].kind))} up behind it.`,
          `Move ${units(walkers.length)} up to ${label}`, sendAll(walkers, "move", stand), goal, { goal });
      }
      if (!fixed && !broke && army.length < strength(w) && !army.some((u) => dist(cellOf(u), next.p) < 14)) return gather(next.p, `clear ${label}`);
      const sealed = o.waiting || prepare;
      return go(w, army, next.p, `clear:${o.i}`, (n) => [sealed ? `Clear the defences around ${label} before it can be taken: send ${units(n)}.`
        : `Clear ${label} for the ${engineers.length ? w.name(engineers[0].kind) : "engineer"}: send ${units(n)}.`, `Attack-move ${units(n)} to ${label}`], 6);
    }
    case "escort": {
      const path = [o.entry ?? "", ...(o.route ?? [])].map((n) => w.where(n)).filter((p): p is Pt => !!p);
      if (!path.length) return null;
      const convoy = w.units.filter((u) => w.convoyTypes.has(baseType(u.kind)));
      let k = 0;
      if (!prepare && convoy.length) {
        // With the convoy in sight: a step ahead of the leading truck.
        const progress = (u: AdviserActor) => path.reduce((best, p, j) => dist(p, cellOf(u)) < dist(path[best], cellOf(u)) ? j : best, 0);
        k = Math.min(path.length - 1, Math.max(...convoy.map(progress)) + 1);
      } else if (!prepare) {
        // Trucks out of the observation (a civilian convoy): sweep the road ahead of them.
        k = Math.min(path.length - 1, Math.max(1, w.memory.swept.get(o.i) ?? 1));
      } else k = Math.min(1, path.length - 1);
      const ahead = path[k];
      return go(w, army, ahead, `escort:${o.i}:${k}`, (n) => [prepare ? `Next: ${lower(o.text)}. Hold the start of the convoy's road: send ${units(n)}.`
        : `Escort the convoy: clear the road ahead of it with ${units(n)}.`, `Attack-move ${units(n)} ${prepare ? "to the convoy road" : "ahead of the convoy"}`], 5);
    }
    case "shipping": {
      const lanes = (o.lanes ?? []).map((l) => l.map((n) => w.where(n)).filter((p): p is Pt => !!p));
      // The ships keep to their lanes: hunt what is in sight near them.
      const near = w.enemies.filter((e) => lanes.some((l) => l.some((p) => dist(p, cellOf(e)) <= 9))).sort(byId);
      if (prepare || !near.length) return hold(w, o, army);
      return go(w, army, cellOf(near[0]), `lane:${o.i}`, (n) => [`Clear the shipping lane: send ${units(n)} at the enemy there.`, `Attack-move ${units(n)} to the lane`], 6);
    }
    case "survive": return hold(w, o, army);
  }
  return null;
}

/** Scouting: one quick unit to each place not seen yet, while the army does the rest. */
function scouting(w: World, army: AdviserActor[]): MissionAdvice | null {
  // Places to see: the scout objectives', and every contact not verified yet (a unit within its radius shows what it is).
  const lists = w.objectives.filter((x) => x.kind === "scout" && x.status === "active" && !x.waiting)
    .map((o) => ({ targets: o.targets ?? [], done: (t: string) => w.memory.scouted.has(t) || w.memory.verified.has(t), verify: false }));
  const contacts = w.unverified().map((s) => s.name);
  if (contacts.length) lists.unshift({ targets: contacts, done: (t: string) => w.memory.verified.has(t), verify: true });
  const allContacts = w.sensors.length - w.sensors.filter((s) => ["waypoint", "mpspawn"].includes(w.ctx.map.named[s.name]?.type ?? "")
    || w.ctx.techTree[w.ctx.map.named[s.name]?.type ?? ""]?.kind === "building").length;
  for (const o of lists) {
    const targets = o.targets;
    const from = w.base() ?? (army.length ? centroid(army.map(cellOf)) : { u: 0, v: 0 });
    const left = targets.filter((t) => !o.done(t) && !w.memory.unreachable.has(t)).map((t) => ({ t, p: w.where(t) })).filter((x): x is { t: string; p: Pt } => !!x.p)
      .sort((a, b) => dist(a.p, from) - dist(b.p, from) || a.t.localeCompare(b.t));
    for (const next of left) {
      const goal = `scout:${next.t}`;
      const sent = w.units.filter((u) => w.memory.heading.get(u.actorId)?.goal === goal);
      if (sent.some((u) => !u.idle)) continue;
      // Got as close as it could and still not there (a contact out at sea): out of reach, not tried again.
      if (sent.some((u) => w.tick - w.memory.heading.get(u.actorId)!.tick > 150) || (w.memory.scoutTries.get(next.t) ?? 0) >= 3) { w.memory.unreachable.add(next.t); continue; }
      // The unit there soonest that is not already looking somewhere: ships for a place at sea.
      const wet = w.grid ? !w.grid.pass(next.p) && !w.grid.near(next.p, 2) : false;
      const eta = (u: AdviserActor) => dist(cellOf(u), next.p) / Math.max(20, u.speed || 50);
      const scout = [...army].filter((u) => !w.heroes.has(u.actorId) && !(w.memory.heading.get(u.actorId)?.goal.startsWith("scout:") && !u.idle) && w.onLand(u) !== wet)
        .sort((a, b) => eta(a) - eta(b) || a.actorId - b.actorId)[0];
      if (!scout) continue;
      const to = wet ? next.p : w.land(next.p);
      const seen = o.verify ? `${allContacts - contacts.length} of ${allContacts} verified` : `${targets.length - left.length} of ${targets.length} seen`;
      return o.verify
        ? advice(`Verify ${placeName(next.t)} before anyone fires on it: send your ${w.name(scout.kind)} close enough to see what it is (${seen}).`,
          `Send 1 ${w.name(scout.kind)} to verify ${placeName(next.t)}`, [{ action: "move", actor_id: scout.actorId, target_x: to.u, target_y: to.v }], goal, { goal })
        : advice(`Scout ${placeName(next.t)}: send your ${w.name(scout.kind)} to look (${seen}).`,
          `Send 1 ${w.name(scout.kind)} to scout ${placeName(next.t)}`, [{ action: "move", actor_id: scout.actorId, target_x: to.u, target_y: to.v }], goal, { goal });
    }
  }
  return null;
}

/** Holding: stragglers come back to the base (or what must survive); the fighting is the defence's. */
function hold(w: World, o: Objective, army: AdviserActor[]): MissionAdvice | null {
  const vital = assets(w).filter((a) => a.vital && a.name !== "convoy");
  const anchor = w.base() ?? vital[0]?.at;
  if (!anchor) return null;
  const goal = `hold:${o.i}`;
  const range = w.hasBase ? 24 : 14;
  const far = army.filter((u) => needsOrder(w, u, goal, anchor, range));
  if (!far.length) return null;
  const name = w.base() ? "the base" : placeName(vital[0].name);
  return advice(`${o.kind === "survive" ? `${capital(lower(o.text))}: bring` : "Hold the line: bring"} ${plural(far.length, "straggler")} back to ${name}.`,
    `Attack-move ${plural(Math.min(MAX, far.length), "unit")} to ${name}`, sendAll(far, "attack_move", w.land(anchor, 8)), goal, { goal });
}

/** Heroes the mission needs alive pull back when badly hurt. */
function heroes(w: World): MissionAdvice | null {
  for (const u of w.units.filter((x) => w.heroes.has(x.actorId)).sort(byId)) {
    if ((u.hpPercent ?? 1) > 0.35) continue;
    const near = w.enemies.filter((e) => dist(cellOf(e), cellOf(u)) <= 7);
    if (!near.length) continue;
    const p = cellOf(u), away = centroid(near.map(cellOf));
    const h = w.memory.heading.get(u.actorId);
    if ((h?.goal === "retreat" || h?.goal === "back") && (!u.idle || w.tick - h.tick < 150)) continue;
    // Away from the enemy, by a way that enters no sensor zone.
    const to = safeStep(w, p, away);
    if (!to) continue;
    return advice(`${capital(w.who(u))} is badly hurt and the mission needs this unit alive: pull back out of the fight.`, `Pull ${w.who(u)} back`,
      [{ action: "move", actor_id: u.actorId, target_x: to.u, target_y: to.v }], `retreat:${u.actorId}`, { goal: "retreat", reactive: true });
  }
  return null;
}

// ------------------------------------------------------------------ economy

function catalogItem(ctx: MissionContext, test: (item: MissionCatalogItem) => boolean) {
  for (const q of ctx.catalog ?? []) for (const item of q.items) if (test(item)) return item;
  return null;
}

/** What the objectives need built or trained: the build objectives (and what they still require), an engineer for a
 * capture, the units a reach objective names. */
function missionProduction(w: World): MissionAdvice | null {
  const o = w.obs, ctx = w.ctx;
  const available = new Set(o.availableProduction.map((x) => x.toLowerCase()));
  const queued = new Set(o.production.map((p) => baseType(p.item)));
  const owned = new Set([...o.buildings, ...o.units].map((a) => baseType(a.kind)));
  const busy = (item: string) => { const q = ctx.techTree[item]?.queue?.toLowerCase(); return o.production.some((p) => p.queueType.toLowerCase() === q); };
  const eco = (text: string, summary: string, commands: AdviserCommand[], key: string) => advice(text, summary, commands, `eco:${key}`);
  const open = w.objectives.filter((x) => x.status === "active");
  for (const b of open.filter((x) => x.kind === "build"))
    for (const type of b.types ?? []) {
      if (owned.has(type) || queued.has(type)) continue;
      if (available.has(type)) { if (!busy(type)) return eco(`Build ${article(w.name(type))}: the objective needs one.`, `Build ${article(w.name(type))}`, [{ action: "build", item_type: type }], `build:${type}`); continue; }
      // Not buildable yet: what it still needs, from the production menu.
      for (const label of catalogItem(ctx, (i) => i.name === type)?.requires ?? []) {
        const req = catalogItem(ctx, (i) => i.label === label && i.buildable);
        if (req && !owned.has(req.name) && !queued.has(req.name) && available.has(req.name) && !busy(req.name))
          return eco(`Build ${article(req.label)} first: the ${w.name(type)} needs it.`, `Build ${article(req.label)}`, [{ action: "build", item_type: req.name }], `build:${req.name}`);
      }
    }
  // An engineer for every place still to capture (an engineer goes into the building it takes), now or behind a gate.
  const toTake = open.filter((x) => x.kind === "capture").flatMap((x) => x.targets ?? [])
    .filter((t) => { const a = w.find(t); return !w.memory.named.get(t)?.dead && !(a && o.buildings.some((b) => b.actorId === a.actorId)); }).length;
  const engineer = [...available].find((x) => baseType(x) === "engineer" || /engineer/i.test(w.name(x)));
  const training = o.production.filter((p) => engineer && baseType(p.item) === baseType(engineer)).length;
  if (engineer && w.engineers.length + training < Math.min(3, toTake) && !training && !busy(engineer))
    return eco(`Train ${article(w.name(engineer))}: only an engineer can capture ${toTake === 1 ? "the objective" : `the ${toTake} places to take`}.`, `Train 1 ${w.name(engineer)}`,
      [{ action: "train", item_type: engineer }], "train:engineer");
  for (const r of open.filter((x) => x.kind === "reach")) {
    const types = r.types ?? [];
    const need = w.difficulty === "easy" ? 1 : r.count ?? 1;
    const have = w.units.filter((u) => types.includes(baseType(u.kind))).length + o.production.filter((p) => types.includes(baseType(p.item))).length;
    const type = types.find((t) => available.has(t));
    if (have < need && type && !busy(type)) return eco(`Train ${need - have === 1 ? article(w.name(type)) : `${need - have} more of the ${w.name(type)}`}: the objective needs ${need}.`,
      `Train ${need - have} ${w.name(type)}`, Array.from({ length: need - have }, () => ({ action: "train" as const, item_type: type })), `train:${type}`);
  }
  return null;
}

/** Ground defences the base can build (not walls, air defence, coastal guns or support buildings), by name. */
const defenceName = /bunker|pill ?box|sentry|guard tower|tesla|prism|emplacement|turret|autocannon|cannon/i;
const notDefence = /\bAA\b|air|flak|patriot|\bsam\b|missile|coastal|wall|relay|workshop|uplink|satellite|sensor|silo|weather|gap|array/i;

/** A base that has to hold (a survive or protect objective, or attacks on it lately) builds a few ground defences. */
function defences(w: World): MissionAdvice | null {
  const o = w.obs, tree = w.ctx.techTree;
  // A gun fires on whatever comes in range: none while unverified contacts are about.
  if (w.unverified().length) return null;
  const holding = w.objectives.some((x) => (x.kind === "survive" || x.kind === "protect") && x.status === "active")
    || w.tick - (w.memory.attacked ?? -9999) < 1500;
  if (!holding || o.cash < 1200) return null;
  const isDefence = (kind: string) => { const n = w.name(kind); return tree[baseType(kind)]?.kind === "building" && defenceName.test(n) && !notDefence.test(n); };
  const have = o.buildings.filter((b) => isDefence(b.kind)).length + o.production.filter((p) => isDefence(p.item)).length;
  const limit = w.difficulty === "easy" ? 2 : w.difficulty === "hard" ? 4 : 3;
  const queue = (item: string) => tree[baseType(item)]?.queue?.toLowerCase();
  const pick = o.availableProduction.map((x) => x.toLowerCase()).filter((x) => isDefence(x) && (tree[baseType(x)]?.cost ?? 9999) <= o.cash / 2
    && !o.production.some((p) => p.queueType.toLowerCase() === queue(x)))
    .sort((a, b) => (tree[baseType(b)]?.cost ?? 0) - (tree[baseType(a)]?.cost ?? 0) || a.localeCompare(b))[0];
  if (have >= limit || !pick) return null;
  return advice(`The base has to hold: build ${article(w.name(pick))} to cover it (${have + 1} of ${limit}).`, `Build ${article(w.name(pick))}`,
    [{ action: "build", item_type: pick }], `eco:build:defence:${pick}`);
}

/** The base: the skirmish adviser's economy and the objectives' needs, then spending what piles up on a bigger army. */
function economy(w: World): MissionAdvice | null {
  const a = economyStep(w);
  // A surveillance sweep due soon over our own factories: nothing new rolls out into it.
  const sweep = w.objectives.find((x) => x.kind === "disperse" && x.status === "active" && !x.waiting && (x.area ?? []).length === 4);
  if (a && sweep && a.commands.some((c) => c.action === "train")) {
    const [u0, v0, u1, v1] = sweep.area!;
    const opened = (sweep.requires ?? []).length || (sweep.after ?? []).length ? w.memory.opened.get(sweep.i) ?? w.tick : 0;
    const inside = w.obs.buildings.some((b) => b.cellX >= u0 && b.cellY >= v0 && b.cellX <= u1 && b.cellY <= v1 && (w.ctx.techTree[baseType(b.kind)]?.produces ?? []).length);
    if (inside && opened + (sweep.seconds ?? 120) * 25 - w.tick < 1750) return null;
  }
  return a;
}

function economyStep(w: World): MissionAdvice | null {
  if (!w.hasBase) return null;
  const o = w.obs, tree = w.ctx.techTree;
  const base = nextAdvice({ ...o, techTree: tree }, { buildFocus: true });
  const ours = (a: AdviserAdvice): MissionAdvice => ({ ...a, key: `mission:eco:${a.key}` });
  if (base && ["deploy", "place", "build:power"].includes(base.key)) return ours(base);
  const need = missionProduction(w);
  if (need) return need;
  const guns = defences(w);
  if (guns) return guns;
  if (base) {
    // Rich: bigger batches.
    if (base.key === "train:tank" && o.cash >= 6000) return ours({ ...base, summary: base.summary.replace(/^Train 3/, "Train 5"), commands: [...base.commands, ...base.commands.slice(0, 2)] });
    return ours(base);
  }
  const available = o.availableProduction.map((x) => x.toLowerCase());
  const busy = new Set(o.production.map((p) => p.queueType.toLowerCase()));
  const produces = (kind: string, what: string) => (tree[baseType(kind)]?.produces ?? []).includes(what);
  const infantry = available.filter((x) => tree[baseType(x)]?.queue === "Infantry" && (tree[baseType(x)]?.cost ?? 9999) <= 400 && !/engineer|dog|spy|medic|technician/i.test(w.name(x)))
    .sort((a, b) => (tree[baseType(a)]?.order ?? 0) - (tree[baseType(b)]?.order ?? 0))[0];
  if (infantry && !busy.has("infantry") && o.cash >= 1500)
    return advice(`Money is piling up ($${Math.round(o.cash / 100) * 100}): train more ${w.name(infantry)}s for the objectives.`, `Train 5 ${w.name(infantry)}s`,
      Array.from({ length: 5 }, () => ({ action: "train" as const, item_type: infantry })), "eco:train:more-infantry");
  const factories = o.buildings.filter((b) => produces(b.kind, "vehicle")).length;
  const factory = available.find((x) => produces(x, "vehicle") && !x.endsWith("f"));
  if (factory && factories > 0 && factories < 3 && o.cash >= 6000 && o.harvesterCount >= 2 && !busy.has("building"))
    return advice(`Money is piling up ($${Math.round(o.cash / 100) * 100}): another ${w.name(factory)} builds the army faster.`, `Build ${article(w.name(factory))}`,
      [{ action: "build", item_type: factory }], "eco:build:factory");
  return null;
}

// ------------------------------------------------------------------ main

/** What the observation adds to memory: places scouted, convoy roads swept, the game speed. The same observation
 * leaves the same memory, so a recommendation recomputed for confirmation comes out the same. */
function observe(w: World, now: number) {
  const memory = w.memory;
  for (const o of w.objectives.filter((x) => x.kind === "scout"))
    for (const t of o.targets ?? []) {
      const p = w.where(t);
      if (p && w.units.some((u) => dist(cellOf(u), p) <= (o.radius ?? 5) - 0.5)) memory.scouted.add(t);
    }
  for (const o of w.objectives.filter((x) => x.kind === "escort" && x.status === "active" && !x.waiting)) {
    const path = [o.entry ?? "", ...(o.route ?? [])].map((n) => w.where(n)).filter((p): p is Pt => !!p);
    const k = memory.swept.get(o.i) ?? 1;
    const p = path[Math.min(k, path.length - 1)];
    if (p && k < path.length - 1 && w.fighters.filter((u) => dist(cellOf(u), p) <= 6).length >= Math.min(3, w.fighters.length)
      && w.enemies.every((e) => dist(cellOf(e), p) > 8)) memory.swept.set(o.i, k + 1);
  }
  if (w.tick > memory.pace.tick && memory.pace.at && now - memory.pace.at > 300) {
    const rate = (w.tick - memory.pace.tick) / (now - memory.pace.at);
    memory.pace.rate = Math.min(0.25, Math.max(0.01, memory.pace.rate * 0.6 + rate * 0.4));
  }
  if (w.tick !== memory.pace.tick) { memory.pace.tick = w.tick; memory.pace.at = now; }
  for (const id of [...memory.deployed.keys()]) if (!w.units.some((u) => u.actorId === id)) memory.deployed.delete(id);
  for (const o of w.objectives) if (o.status === "active" && !o.waiting && !memory.opened.has(o.i)) memory.opened.set(o.i, w.tick);
  for (const s of w.unverified())
    if (w.units.some((u) => Math.hypot(wx(cellOf(u)) - s.at.x, wy(cellOf(u)) - s.at.y) <= s.radius - 0.5)) memory.verified.add(s.name);
}

/** The next recommendation in a campaign mission (null: nothing to say). */
export function missionAdvice(o: AdviserObservation, ctx: MissionContext): MissionAdvice | null {
  if (o.done) return advice(`The mission is over (${o.result || "finished"}); there is nothing left to do.`, "", [], "done");
  const w = new World(o, ctx);
  observe(w, ctx.now ?? Date.now());
  // Unverified contacts about: every armed unit on return fire, so no one opens fire on a phantom by itself, and units
  // move instead of attack-moving (which fires on whatever hostile it meets).
  const careful = w.unverified().length > 0;
  const stance = stances(w, careful);
  if (stance) return stance;
  const a = step(w, o, ctx);
  if (!careful || !a) return a;
  return { ...a, commands: a.commands.map((c) => (c.action === "attack_move" ? { ...c, action: "move" as const } : c)), summary: a.summary.replace(/^Attack-move/, "Move") };
}

/** Armed units to return fire only while unverified contacts are about; back to their usual stance after. */
function stances(w: World, careful: boolean): MissionAdvice | null {
  const armed = w.units.filter((u) => u.canAttack && u.stance !== undefined && !nonCombat.has(baseType(u.kind))).sort(byId);
  const recent = (u: AdviserActor) => w.tick - (w.memory.stanced.get(u.actorId) ?? -999) < 50;
  if (careful) {
    const loose = armed.filter((u) => u.stance! > 1 && !recent(u) && (w.memory.stanceTries.get(u.actorId) ?? 0) < 2).slice(0, MAX);
    if (!loose.length) return null;
    w.memory.calmed = true;
    return advice(`Unverified contacts on the picture: set ${plural(loose.length, "unit")} to return fire only, so no one fires on a contact until it is verified.`,
      `Set ${plural(loose.length, "unit")} to return fire`, loose.map((u) => ({ action: "set_stance" as const, actor_id: u.actorId, target_x: 1 })), `stance:${loose.map((u) => u.actorId).join(",")}`,
      {});
  }
  if (!w.memory.calmed) return null;
  const held = armed.filter((u) => u.stance === 1 && !recent(u)).slice(0, MAX);
  if (!held.length) { w.memory.calmed = false; return null; }
  return advice(`Every contact is verified: let ${plural(held.length, "unit")} fire at will again.`, `Set ${plural(held.length, "unit")} to attack anything`,
    held.map((u) => ({ action: "set_stance" as const, actor_id: u.actorId, target_x: 3 })), `stance:free:${held.map((u) => u.actorId).join(",")}`);
}

function step(w: World, o: AdviserObservation, ctx: MissionContext): MissionAdvice | null {
  // A mission that starts with a construction vehicle and no base: deploy it first.
  if (!o.buildings.length && o.units.some((u) => /mcv$/.test(baseType(u.kind)))) {
    const first = nextAdvice({ ...o, techTree: ctx.techTree }, { buildFocus: true });
    if (first) return { ...first, key: `mission:eco:${first.key}` };
  }
  const urgent = evade(w) ?? disperse(w) ?? heroes(w);
  if (urgent) return urgent;
  // Units with an errand of their own (engineers, specialists, gate runners) are not the army.
  const errands = w.objectives.filter((x) => special(x) && x.status === "active");
  const own = new Set<number>(w.engineers.map((e) => e.actorId));
  for (const r of errands) for (const u of w.units) if ((r.types ?? []).includes(baseType(u.kind))) own.add(u.actorId);
  for (const u of w.units) { const h = w.memory.heading.get(u.actorId); if (h?.goal.startsWith("scout:") && !u.idle) own.add(u.actorId); }
  // A badly hurt unit the mission needs alive stays out of the fighting.
  const army = w.fighters.filter((u) => !own.has(u.actorId) && !(w.heroes.has(u.actorId) && (u.hpPercent ?? 1) < 0.5));
  const guard = defend(w, own);
  if (guard) return guard;
  // A mission with a base alternates between the economy and the army, so neither starves the other.
  const economyFirst = ctx.memory.lastKind === "unit";
  if (economyFirst) { const e = economy(w); if (e) return e; }
  for (const r of errands.filter((x) => !x.waiting)) {
    const a = reachSpecial(w, r, w.units.filter((u) => (r.types ?? []).includes(baseType(u.kind))), w.fighters);
    if (a) return a;
  }
  const scout = scouting(w, army);
  if (scout) return scout;
  const focus = focusOf(w);
  if (focus) { const a = armyTask(w, focus, army); if (a) return a; }
  if (!economyFirst) { const e = economy(w); if (e) return e; }
  return status(w, focus);
}

/** Nothing to change: what the plan is, in a line that stays the same while it holds. */
function status(w: World, focus: Focus | null): MissionAdvice | null {
  const said = w.memory.said;
  if (said && w.tick - said.tick < 750) return advice(said.text, "", [], "status:said");
  const o = focus?.o ?? w.objectives.find((x) => x.status === "active" && !passiveKinds.has(x.kind) && !x.waiting);
  if (!o) return null;
  const text = focus?.prepare ? `Next: ${lower(o.text)}. It opens once the objectives before it are done.` : `On it: ${lower(o.text)}.`;
  return advice(capital(text), "", [], `status:${o.i}:${focus?.prepare ? "next" : "now"}`);
}

/** Internals for tools/mission-adviser-test.mjs. */
export const missionInternals = { Grid, World, stealthLeg, dist };
