// Browser port of OpenRA-AI's deterministic Advisor.next_step and assess_threat.
// Every decision reads the native, fog-respecting CompanionRpc observation. This
// module only proposes commands; the caller holds them for player confirmation
// and the native engine validates them again before execution.

export interface AdviserActor {
  actorId: number;
  kind: string;
  cellX: number;
  cellY: number;
  idle: boolean;
  canAttack: boolean;
  hpPercent?: number;
  canDisguise?: boolean;
  canInfiltrate?: boolean;
  isDisguised?: boolean;
  detectsDisguise?: boolean;
  /** The actor's centre in world units (WPos X, Y). */
  x?: number;
  y?: number;
  /** Units: base speed (world units a tick), passengers carried (-1: not a transport). */
  speed?: number;
  /** Units: 0 hold fire, 1 return fire, 2 defend, 3 attack anything. */
  stance?: number;
  passengers?: number;
  /** Units: whether they can capture or demolish (C4), and the visible actors they can do it to now. */
  canCapture?: boolean;
  captureTargets?: number[];
  canDemolish?: boolean;
  demolishTargets?: number[];
  /** Units: the actor they are attacking (0: none). */
  targetId?: number;
  /** Production buildings: the rally point's cell (-1: none). */
  rallyX?: number;
  rallyY?: number;
}

/** Generated/native catalog metadata, never a separate hand-written roster. */
export interface AdviserTechItem {
  name?: string;
  kind?: string;
  queue?: string;
  cost?: number;
  order?: number;
  provides?: readonly string[];
  produces?: readonly string[];
}

export interface AdviserObservation {
  tick: number;
  /** Spendable cash plus ore, not resource capacity. */
  cash: number;
  powerProvided: number;
  powerDrained: number;
  harvesterCount: number;
  mapWidth: number;
  mapHeight: number;
  exploredPercent: number;
  done: boolean;
  result?: string;
  missionMode?: boolean;
  units: AdviserActor[];
  buildings: AdviserActor[];
  visibleEnemies: AdviserActor[];
  visibleEnemyBuildings: AdviserActor[];
  /** Previously seen, frozen contacts supplied by the engine, never hidden live actors. */
  rememberedEnemyBuildings?: AdviserActor[];
  production: { item: string; queueType: string; progress: number; remainingTicks: number }[];
  availableProduction: string[];
  actorNames: Record<string, string>;
  techTree?: Record<string, AdviserTechItem>;
  threatHeated?: boolean;
  /** The engine's cell grid: mapHeight × mapWidth × channels float32 (terrain, height, ore, passable, fog, ...). */
  spatial?: { channels: number; bytes: Uint8Array };
}

export interface AdviserCommand {
  action: "deploy" | "place_building" | "build" | "train" | "attack_move" | "move" | "attack" | "capture" | "demolish" | "stop" | "set_stance" | "enter_transport" | "unload" | "set_rally_point";
  actor_id?: number;
  /** attack, capture, demolish: the target actor. */
  target_actor_id?: number;
  item_type?: string;
  target_x?: number;
  target_y?: number;
  /** After the unit's current orders instead of replacing them (a route of waypoints). */
  queued?: boolean;
}

export interface AdviserAdvice {
  text: string;
  summary: string;
  commands: AdviserCommand[];
  key: string;
}

export interface AdviserThreat {
  score: number;
  level: "calm" | "guarded" | "high" | "critical";
  reason: string;
  heated: boolean;
}

const opening = ["power", "refinery", "barracks", "factory"];
// The existing Python advisor's Classic type aliases are algorithm inputs, not
// display names; names always come from the native/generated catalog.
const classicRoles: Record<string, string> = {
  powr: "power", apwr: "power", gapowr: "power", napowr: "power",
  proc: "refinery", garefn: "refinery", narefn: "refinery",
  tent: "barracks", barr: "barracks", gapile: "barracks", nahand: "barracks",
  weap: "factory", gaweap: "factory", naweap: "factory",
  dome: "radar", naradr: "radar",
};
const nameRoles: [string, string[]][] = [
  ["power", ["power plant", "reactor", "power station"]],
  ["refinery", ["refinery"]], ["barracks", ["barracks"]],
  ["factory", ["war factory", "vehicle factory"]], ["radar", ["radar"]],
];
const mcvTypes = new Set(["mcv", "amcv", "smcv"]);
const nonCombatTypes = new Set(["harv", "cmin", ...mcvTypes]);
export function baseType(value: string): string { return value.toLowerCase().split("@", 1)[0].split(".", 1)[0]; }
const distanceSquared = (a: AdviserActor, b: AdviserActor) => (a.cellX - b.cellX) ** 2 + (a.cellY - b.cellY) ** 2;
const article = (name: string) => `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name}`;

export function desiredHarvesterCount(width: number, height: number): number {
  const area = Math.max(0, width) * Math.max(0, height);
  return area <= 4096 ? 2 : area <= 9216 ? 3 : area <= 16384 ? 4 : 5;
}

/** Same visible-contact threat scoring as the existing companion service. */
export function assessThreat(snapshot: AdviserObservation): AdviserThreat {
  const result = (score: number, reason: string): AdviserThreat => {
    score = Math.min(100, score);
    const level = score >= 70 ? "critical" : score >= 45 ? "high" : score >= 20 ? "guarded" : "calm";
    return { score, level, reason, heated: level === "high" || level === "critical" };
  };
  if (snapshot.done) return result(0, "Match complete");
  const nearest = (enemies: AdviserActor[], assets: AdviserActor[]) => {
    if (!enemies.length || !assets.length) return null;
    let distance = Infinity;
    for (const enemy of enemies) for (const asset of assets) distance = Math.min(distance, distanceSquared(enemy, asset));
    return Math.sqrt(distance);
  };
  const spies = snapshot.units.filter(unit => unit.canDisguise || unit.canInfiltrate || baseType(unit.kind) === "spy");
  if (snapshot.missionMode && spies.length) {
    const detectors = snapshot.visibleEnemies.filter(enemy => enemy.detectsDisguise || baseType(enemy.kind) === "dog");
    const exposed = spies.filter(spy => !spy.isDisguised);
    const distance = nearest(exposed.length ? snapshot.visibleEnemies : detectors, exposed.length ? exposed : spies);
    if (distance === null) return result(detectors.length ? 5 : 0, "Stealth route clear of visible dog detectors");
    return result(distance <= 5 ? 100 : distance <= 9 ? 70 : distance <= 14 ? 40 : 15,
      `Nearest ${exposed.length ? "enemy contact" : "dog detector"} is ${Math.round(distance)} cells from the Spy`);
  }
  const enemies = snapshot.visibleEnemies;
  let score = 0;
  const reasons: string[] = [];
  if (enemies.length) {
    score += 8 + Math.min(28, 4 * enemies.length);
    reasons.push(`${enemies.length} visible enemy unit${enemies.length === 1 ? "" : "s"}`);
    const distance = nearest(enemies, snapshot.buildings.length ? snapshot.buildings : snapshot.units);
    if (distance !== null) {
      score += distance <= 6 ? 46 : distance <= 12 ? 34 : distance <= 20 ? 22 : distance <= 32 ? 10 : 0;
      reasons.push(`nearest contact ${Math.round(distance)} cells away`);
    }
    const defenders = snapshot.units.filter(unit => unit.canAttack).length;
    score += defenders === 0 ? 12 : enemies.length >= Math.max(3, defenders * 2) ? 10 : 0;
  }
  if (snapshot.visibleEnemyBuildings.length) {
    score += Math.min(10, 2 * snapshot.visibleEnemyBuildings.length);
    if (!reasons.length) reasons.push("visible enemy structures");
  }
  if (snapshot.powerDrained > snapshot.powerProvided && enemies.length) { score += 6; reasons.push("low power"); }
  if ([...snapshot.units, ...snapshot.buildings].some(asset => (asset.hpPercent ?? 1) <= 0.22)) {
    score += enemies.length ? 8 : 12; reasons.push("critically damaged assets");
  }
  return result(score, [...new Set(reasons.slice(0, 2))].join("; ") || "No immediate visible threat");
}

/**
 * Where to look for an enemy base nobody has seen: the far side of the map from our own base (its mirror through the
 * centre), then the mirrors across each axis, then the centre; the first of them never explored. Then any place never
 * explored, the farthest from our base first. Once all of it has been seen, the enemy can only be somewhere out of
 * sight now: a sweep along the rows of the map (every 8 cells, back and forth), from where `from` (the army) stands
 * on to the next place not in sight. Only cells land units can reach. Null: nowhere to look.
 */
export function searchGoal(snapshot: AdviserObservation, from?: { x: number; y: number }): { x: number; y: number } | null {
  const w = snapshot.mapWidth, h = snapshot.mapHeight, own = snapshot.buildings.length ? snapshot.buildings : snapshot.units;
  if (!own.length || w <= 0 || h <= 0) return null;
  const hx = Math.floor(own.reduce((sum, actor) => sum + actor.cellX, 0) / own.length), hy = Math.floor(own.reduce((sum, actor) => sum + actor.cellY, 0) / own.length);
  const map = snapshot.spatial, channels = map?.channels ?? 0;
  const grid = map && channels >= 5 && map.bytes.length >= w * h * channels * 4 ? new DataView(map.bytes.buffer, map.bytes.byteOffset, map.bytes.byteLength) : null;
  // The engine's grid: channel 3 land passable (1), channel 4 fog (0 never seen, 0.5 seen before, 1 in sight now).
  const cell = (x: number, y: number, channel: number) => grid!.getFloat32(((y * w + x) * channels + channel) * 4, true);
  const explored = (x: number, y: number) => grid !== null && cell(x, y, 4) >= 0.5;
  const open = (x: number, y: number) => landReachable(snapshot, x, y);
  for (const [x, y] of [[w - 1 - hx, h - 1 - hy], [w - 1 - hx, hy], [hx, h - 1 - hy], [Math.floor(w / 2), Math.floor(h / 2)]]) {
    const cx = Math.max(0, Math.min(w - 1, x)), cy = Math.max(0, Math.min(h - 1, y));
    if ((cx - hx) ** 2 + (cy - hy) ** 2 > 20 ** 2 && !explored(cx, cy) && open(cx, cy)) return { x: cx, y: cy };
  }
  if (!grid) return null;
  const path: { x: number; y: number }[] = [];
  for (let row = 0, y = 4; y < h; row++, y += 8) for (let i = 0, n = Math.ceil((w - 4) / 8); i < n; i++) path.push({ x: row % 2 ? 4 + (n - 1 - i) * 8 : 4 + i * 8, y });
  let best: { x: number; y: number } | null = null, far = 20 ** 2;
  for (const p of path) {
    const d = (p.x - hx) ** 2 + (p.y - hy) ** 2;
    if (d > far && !explored(p.x, p.y) && open(p.x, p.y)) { far = d; best = p; }
  }
  if (best || !from || !path.length) return best;
  const start = path.reduce((k, p, i) => (p.x - from.x) ** 2 + (p.y - from.y) ** 2 < (path[k].x - from.x) ** 2 + (path[k].y - from.y) ** 2 ? i : k, 0);
  for (let j = 1; j <= path.length; j++) {
    const p = path[(start + j) % path.length];
    if (cell(p.x, p.y, 4) < 1 && open(p.x, p.y) && (p.x - from.x) ** 2 + (p.y - from.y) ** 2 >= 12 ** 2) return p;
  }
  return null;
}

/**
 * The enemy buildings the player has seen, kept after they drop out of sight (the observation's own remembered list
 * comes back empty in skirmish), so an army sent home to defend can go back to the enemy base. One is forgotten once
 * its cell is in sight again without it. One memory per match.
 */
export class EnemyBaseMemory {
  private seen = new Map<number, AdviserActor>();
  private lastTick = -1;
  recall(observation: AdviserObservation): AdviserObservation {
    if (observation.tick < this.lastTick) this.seen.clear();
    this.lastTick = observation.tick;
    const visible = new Set(observation.visibleEnemyBuildings.map(building => building.actorId));
    for (const building of observation.visibleEnemyBuildings) this.seen.set(building.actorId, building);
    for (const [id, building] of this.seen) if (!visible.has(id) && inSight(observation, building.cellX, building.cellY)) this.seen.delete(id);
    const known = new Set([...visible, ...(observation.rememberedEnemyBuildings ?? []).map(building => building.actorId)]);
    const extra = [...this.seen.values()].filter(building => !known.has(building.actorId));
    return extra.length ? { ...observation, rememberedEnemyBuildings: [...(observation.rememberedEnemyBuildings ?? []), ...extra] } : observation;
  }
}

/** Whether a cell is in the player's sight now (the engine's grid, channel 4); false when the grid is not there. */
export function inSight(snapshot: AdviserObservation, x: number, y: number): boolean {
  const w = snapshot.mapWidth, h = snapshot.mapHeight, map = snapshot.spatial, channels = map?.channels ?? 0;
  if (!map || channels < 5 || map.bytes.length < w * h * channels * 4 || x < 0 || y < 0 || x >= w || y >= h) return false;
  return new DataView(map.bytes.buffer, map.bytes.byteOffset, map.bytes.byteLength).getFloat32(((y * w + x) * channels + 4) * 4, true) >= 1;
}

/** Whether land units can stand on a cell (the engine's grid, channel 3); true when the grid is not there. */
export function landReachable(snapshot: AdviserObservation, x: number, y: number): boolean {
  const w = snapshot.mapWidth, h = snapshot.mapHeight, map = snapshot.spatial, channels = map?.channels ?? 0;
  if (!map || channels < 5 || map.bytes.length < w * h * channels * 4 || x < 0 || y < 0 || x >= w || y >= h) return true;
  return new DataView(map.bytes.buffer, map.bytes.byteOffset, map.bytes.byteLength).getFloat32(((y * w + x) * channels + 3) * 4, true) >= 1;
}

/** A faction's basic ground defence (Pill Box, Sentry Gun, Gun Bunker, Guard Tower...): never a wall, AA or superweapon. */
export function isBasicDefence(entry: AdviserTechItem | undefined): boolean {
  const cost = entry?.cost ?? 0;
  return !!entry && entry.queue?.toLowerCase() === "support" && cost > 0 && cost <= 800
    && /pill ?box|sentry|bunker|guard tower|autocannon/i.test(entry.name ?? "") && !/\bair\b|\baa\b|anti-air/i.test(entry.name ?? "");
}

/**
 * Where the next defence goes: on the side of the base that faces the enemy (the known enemy building nearest to the
 * base, else the far side of the map), 8 cells out from the base's middle; each further one 3 cells to one side.
 */
export function frontCell(snapshot: AdviserObservation, index: number, out = 8): { x: number; y: number } | null {
  const own = snapshot.buildings, w = snapshot.mapWidth, h = snapshot.mapHeight;
  if (!own.length || w <= 0 || h <= 0) return null;
  const hx = own.reduce((sum, actor) => sum + actor.cellX, 0) / own.length, hy = own.reduce((sum, actor) => sum + actor.cellY, 0) / own.length;
  const known = [...snapshot.visibleEnemyBuildings, ...(snapshot.rememberedEnemyBuildings ?? [])];
  const near = known.sort((a, b) => (a.cellX - hx) ** 2 + (a.cellY - hy) ** 2 - ((b.cellX - hx) ** 2 + (b.cellY - hy) ** 2))[0];
  let dx = (near ? near.cellX : w - 1 - hx) - hx, dy = (near ? near.cellY : h - 1 - hy) - hy;
  const length = Math.hypot(dx, dy);
  if (length < 1) return null;
  dx /= length; dy /= length;
  const side = [0, 3, -3, 6, -6][index % 5];
  return { x: Math.max(0, Math.min(w - 1, Math.round(hx + dx * out - dy * side))), y: Math.max(0, Math.min(h - 1, Math.round(hy + dy * out + dx * side))) };
}

/** An army worth sending: at least 10 fighters together worth 10,000 credits (about ten tanks and some infantry). */
export const WAVE_UNITS = 10, WAVE_VALUE = 10000;
/** The engine takes at most 12 orders in one request (CompanionBridge MaxCommandsPerRequest). */
export const MAX_ORDERS = 12;

export function nextAdvice(snapshot: AdviserObservation, options: { buildFocus?: boolean } = {}): AdviserAdvice | null {
  const tree = snapshot.techTree ?? {};
  const available = snapshot.availableProduction.map(item => item.toLowerCase());
  const name = (item: string) => snapshot.actorNames[item.toLowerCase()] || snapshot.actorNames[baseType(item)] || tree[baseType(item)]?.name || item;
  const plural = (item: string) => {
    const shown = name(item);
    return /(?:infantry|team|section|s)$/i.test(shown) ? shown : shown.endsWith("man") ? `${shown.slice(0, -3)}men` : `${shown}s`;
  };
  const roles = (kind: string): string[] => {
    kind = baseType(kind);
    const entry = tree[kind];
    if (entry?.provides || entry?.produces) {
      const provides = entry.provides ?? [], produces = entry.produces ?? [];
      return [provides.includes("power") ? "power" : "", provides.includes("refinery") ? "refinery" : "",
        produces.includes("infantry") ? "barracks" : "", produces.includes("vehicle") ? "factory" : "",
        provides.includes("radar") ? "radar" : ""].filter(Boolean);
    }
    if (classicRoles[kind]) return [classicRoles[kind]];
    const shown = name(kind).toLowerCase();
    return nameRoles.filter(([, words]) => words.some(word => shown.includes(word))).map(([role]) => role);
  };
  const owned = new Set(snapshot.buildings.flatMap(building => roles(building.kind)));
  const queued = new Set(snapshot.production.flatMap(item => roles(item.item)));
  const order = (item: string) => tree[baseType(item)]?.order ?? 0;
  const availableFor = (role: string) => available.filter(item => roles(item).includes(role) && !item.endsWith("f"))
    .sort((a, b) => order(a) - order(b) || available.indexOf(a) - available.indexOf(b))[0];
  const basicUnit = (items: string[], queue: string, word: "tank" | "infantry") => {
    const fits = (item: string, test: (shown: string, cost: number) => boolean) => {
      const entry = tree[baseType(item)];
      // A queue must be known from native/generated metadata. Avoid guessing that
      // a cheap structure is infantry when metadata is unavailable.
      return entry?.queue?.toLowerCase() === queue.toLowerCase() && test(name(item).toLowerCase(), entry.cost ?? Infinity);
    };
    if (word === "infantry") return items.find(item => fits(item, (shown, cost) => !["engineer", "dog", "spy", "medic", "technician"].some(skip => shown.includes(skip))
      && (cost <= 400 || ["e1", "e2"].includes(baseType(item)))));
    // Countries without a tank (Lebanon, Yemen) field armed trucks: their first fighting vehicle.
    return items.find(item => fits(item, shown => shown.includes("tank")))
      ?? items.find(item => fits(item, (shown, cost) => cost <= 1000 && !/harvester|miner|construction|\baa\b|drone|carrier|transport/.test(shown)));
  };
  const roster = Object.keys(tree).sort((a, b) => order(a) - order(b));
  const advise = (text: string, summary: string, commands: AdviserCommand[], key: string): AdviserAdvice => ({ text, summary, commands, key });
  const build = (item: string): AdviserCommand[] => [{ action: "build", item_type: item }];
  const train = (item: string, count: number): AdviserCommand[] => Array.from({ length: count }, () => ({ action: "train", item_type: item }));
  if (snapshot.done) return advise(`The match is over (${snapshot.result || "finished"}); there is nothing left to do.`, "", [], "done");
  const units = snapshot.units.filter(unit => !unit.kind.toLowerCase().includes("husk"));
  const mcv = units.find(unit => mcvTypes.has(baseType(unit.kind)) || name(unit.kind).toLowerCase().includes("construction vehicle"));
  if (mcv && !snapshot.buildings.length) return advise(
    `Deploy your ${name(mcv.kind)} first; nothing can be built until the Construction Yard is up.`, `Deploy the ${name(mcv.kind)}`,
    [{ action: "deploy", actor_id: mcv.actorId }], "deploy");
  const ready = snapshot.production.find(entry => (entry.progress >= 0.999 || entry.remainingTicks <= 0)
    && (["building", "defense", "support"].includes(entry.queueType.toLowerCase())
      || (!entry.queueType && (tree[baseType(entry.item)]?.kind === "building" || roles(entry.item).length))));
  const defences = snapshot.buildings.filter(building => isBasicDefence(tree[baseType(building.kind)]));
  if (ready) {
    // A defence goes on the side of the base the enemy comes from; anything else wherever the engine finds room.
    const at = isBasicDefence(tree[baseType(ready.item)]) ? frontCell(snapshot, defences.length) : null;
    return advise(`Place the finished ${name(ready.item)} first; the build queue waits until it's down.`,
      `Place the ${name(ready.item)}`, [{ action: "place_building", item_type: ready.item.toLowerCase(), ...(at ? { target_x: at.x, target_y: at.y } : {}) }], "place");
  }
  if (!options.buildFocus && (snapshot.threatHeated ?? assessThreat(snapshot).heated) && snapshot.visibleEnemies.length) {
    const assets = snapshot.buildings.length ? snapshot.buildings : units;
    const proximity = (enemy: AdviserActor) => assets.length ? Math.min(...assets.map(asset => distanceSquared(enemy, asset))) : 0;
    const contact = [...snapshot.visibleEnemies].sort((a, b) => proximity(a) - proximity(b))[0];
    const defenders = units.filter(unit => unit.idle && unit.canAttack && !nonCombatTypes.has(baseType(unit.kind))).sort((a, b) => distanceSquared(a, contact) - distanceSquared(b, contact)).slice(0, 12);
    // Revealed maps can expose a large army on a distant coast. Strategic threat
    // alone must not interrupt the opening with an immediate base-defense order.
    if (defenders.length && proximity(contact) <= 20 ** 2) return advise(`Enemies are at your base; send your ${defenders.length} idle fighter${defenders.length === 1 ? "" : "s"} at them now.`,
      `Attack-move ${defenders.length} idle unit${defenders.length === 1 ? "" : "s"} to the attackers`,
      defenders.map(unit => ({ action: "attack_move", actor_id: unit.actorId, target_x: contact.cellX, target_y: contact.cellY })), "defend");
  }
  if (snapshot.buildings.length && snapshot.powerDrained > snapshot.powerProvided && !queued.has("power")) {
    const item = availableFor("power");
    if (item) return advise(`Power is short by ${snapshot.powerDrained - snapshot.powerProvided}; build another ${name(item)} so production runs at full speed.`,
      `Build ${article(name(item))}`, build(item), "build:power");
  }
  // Low power makes everything three times slower: a new plant before the next building uses the last of it.
  if (owned.has("power") && owned.has("factory") && snapshot.powerProvided - snapshot.powerDrained < 50 && !queued.has("power")) {
    const item = availableFor("power");
    if (item) return advise(`Power is almost used up (${snapshot.powerProvided - snapshot.powerDrained} left); build another ${name(item)} before the next building.`,
      `Build ${article(name(item))}`, build(item), "build:power");
  }
  for (const role of opening) {
    if (owned.has(role) || queued.has(role)) continue;
    const item = availableFor(role);
    if (!item) continue;
    const roleItem = (wanted: string) => roster.find(candidate => roles(candidate).includes(wanted));
    const barracks = roleItem("barracks"), refinery = roleItem("refinery");
    const infantry = basicUnit(roster, "Infantry", "infantry"), tank = basicUnit(roster, "Vehicle", "tank");
    const reason: Record<string, string> = {
      power: barracks && refinery ? `the ${name(barracks)} and the ${name(refinery)} both need it` : "everything else needs power",
      refinery: "it comes with a harvester and pays for everything else",
      barracks: infantry ? `you can train ${plural(infantry)}` : "it trains your infantry",
      factory: tank ? `it builds ${plural(tank)}` : "it builds your vehicles",
    };
    const first = role === "power" && !owned.size && !snapshot.production.length;
    return advise(`${first ? "Start with" : "Build"} ${article(name(item))}${first ? "" : " next"}: ${reason[role]}.`,
      `Build ${article(name(item))}`, build(item), `build:${role}`);
  }
  if (owned.has("refinery")) {
    const target = desiredHarvesterCount(snapshot.mapWidth, snapshot.mapHeight);
    const harvester = available.find(item => ["harv", "cmin"].includes(baseType(item))
      || ["harvester", "miner", "ore truck"].some(word => name(item).toLowerCase().includes(word)));
    if (snapshot.harvesterCount < target && harvester && !snapshot.production.some(entry => baseType(entry.item) === baseType(harvester))) {
      return advise(`Train another ${name(harvester)}: you have ${snapshot.harvesterCount} and this map supports ${target}.`,
        `Train 1 ${name(harvester)}`, train(harvester, 1), "train:harvester");
    }
  }
  // New units gather on the side of the base the enemy comes from, not at the doors (a crowd there blocks the factory).
  // Only where the engine says where the rally point is: one at the door (within 6 cells) is the default.
  const staging = owned.has("factory") ? frontCell(snapshot, 0, 5) : null;
  const doors = (staging ? snapshot.buildings.filter(building => (roles(building.kind).includes("barracks") || roles(building.kind).includes("factory"))
    && (building.rallyX ?? -1) >= 0 && (building.rallyX! - building.cellX) ** 2 + (building.rallyY! - building.cellY) ** 2 <= 6 ** 2
    && (building.rallyX! - staging.x) ** 2 + (building.rallyY! - staging.y) ** 2 > 2 ** 2) : []).slice(0, MAX_ORDERS);
  if (staging && doors.length) return advise(`Set the rally point of your ${[...new Set(doors.map(building => name(building.kind)))].join(" and ")} toward the enemy, so new units gather at the front instead of crowding the doors.`,
    `Set ${doors.length} rally point${doors.length === 1 ? "" : "s"} toward the enemy`,
    doors.map(building => ({ action: "set_rally_point", actor_id: building.actorId, target_x: staging.x, target_y: staging.y })), "rally");
  // The enemy's first raids come at about minute 4: two defences on the side of the base it comes from.
  const defence = available.filter(item => isBasicDefence(tree[baseType(item)])).sort((a, b) => (tree[baseType(a)]?.cost ?? 0) - (tree[baseType(b)]?.cost ?? 0))[0];
  const defenceQueued = snapshot.production.some(entry => isBasicDefence(tree[baseType(entry.item)]));
  if (defence && owned.has("factory") && defences.length < 2 && !defenceQueued) return advise(
    `Build ${article(name(defence))}: it guards the side of the base the enemy comes from while your army grows.`,
    `Build ${article(name(defence))}`, build(defence), "build:defence");
  if (!owned.has("radar") && !queued.has("radar")) {
    const item = availableFor("radar");
    if (item) return advise(`Build ${article(name(item))} next: it lights up the minimap and unlocks advanced units.`,
      `Build ${article(name(item))}`, build(item), "build:radar");
  }
  const count = (role: string) => snapshot.buildings.filter(building => roles(building.kind).includes(role)).length;
  if (count("refinery") < 2 && !queued.has("refinery")) {
    const item = availableFor("refinery");
    if (item) return advise(`Build a second ${name(item)}: it comes with another harvester, and one refinery can't pay for a factory that never stops.`,
      `Build ${article(name(item))}`, build(item), "build:refinery");
  }
  const fighters = units.filter(unit => unit.canAttack && !nonCombatTypes.has(baseType(unit.kind)));
  const busy = new Set(snapshot.production.map(entry => entry.queueType.toLowerCase()));
  const tank = basicUnit(available, "Vehicle", "tank"), infantry = basicUnit(available, "Infantry", "infantry");
  if (tank && !busy.has("vehicle")) return advise(`Build up the army: train ${plural(tank)}; you have ${fighters.length} combat unit${fighters.length === 1 ? "" : "s"}.`,
    `Train 3 ${plural(tank)}`, train(tank, 3), "train:tank");
  if (infantry && !busy.has("infantry") && (fighters.length < 8 || snapshot.cash >= 1500)) return advise(`Train more ${plural(infantry)} to protect the base while it grows.`,
    `Train 3 ${plural(infantry)}`, train(infantry, 3), "train:infantry");
  // Money piling up: a second factory makes tanks faster; more defences hold the base while the army is away.
  if (snapshot.cash >= 3000 && count("factory") < 2 && !queued.has("factory")) {
    const item = availableFor("factory");
    if (item) return advise(`You have ${snapshot.cash} credits unspent; a second ${name(item)} builds tanks faster.`,
      `Build ${article(name(item))}`, build(item), "build:factory");
  }
  if (defence && snapshot.cash >= 2500 && defences.length < 4 && !defenceQueued) return advise(
    `You have ${snapshot.cash} credits unspent; another ${name(defence)} holds the base while the army is away.`,
    `Build ${article(name(defence))}`, build(defence), "build:defence");
  if (options.buildFocus) return null;
  const targets = snapshot.visibleEnemyBuildings.length ? snapshot.visibleEnemyBuildings : snapshot.rememberedEnemyBuildings ?? [];
  const value = (group: AdviserActor[]) => group.reduce((sum, unit) => sum + (tree[baseType(unit.kind)]?.cost ?? 0), 0);
  if (fighters.length && !targets.length) {
    // Looking for the enemy base is an order like any other: one cheap scout, or, once there is an army of 12, the
    // fighters together. One order at a time: while any fighter is busy (out looking, or fighting), nobody new is sent.
    // A ready army (12 idle fighters worth 10,000 credits) searches whatever a few others are doing; a single scout only
    // goes when nobody is out.
    const waiting = fighters.filter(unit => unit.idle);
    const army = waiting.length >= 12 && value(waiting) >= WAVE_VALUE;
    if (!army && waiting.length < fighters.length) return null;
    const centre = { x: waiting.reduce((sum, unit) => sum + unit.cellX, 0) / waiting.length, y: waiting.reduce((sum, unit) => sum + unit.cellY, 0) / waiting.length };
    // Enemy units in sight away from the base (a harvester on its way home, a raiding party): the army goes after the
    // nearest of them; they lead to the rest.
    const sighted = snapshot.visibleEnemies.filter(enemy => landReachable(snapshot, enemy.cellX, enemy.cellY)).sort((a, b) => (a.cellX - centre.x) ** 2 + (a.cellY - centre.y) ** 2 - ((b.cellX - centre.x) ** 2 + (b.cellY - centre.y) ** 2))[0];
    if (army && sighted) {
      const group = [...waiting].sort((a, b) => a.actorId - b.actorId).slice(0, MAX_ORDERS);
      return advise(`We haven't found the enemy base yet, but there is an enemy ${name(sighted.kind)} in sight; advance ${group.length} units toward it.`,
        `Advance ${group.length} units toward the enemy ${name(sighted.kind)}`, group.map(unit => ({ action: "attack_move", actor_id: unit.actorId, target_x: sighted.cellX, target_y: sighted.cellY })), "hunt");
    }
    const goal = searchGoal(snapshot, centre);
    const price = (unit: AdviserActor) => tree[baseType(unit.kind)]?.cost ?? 99999;
    if (goal && army) {
      const group = [...waiting].sort((a, b) => a.actorId - b.actorId).slice(0, MAX_ORDERS);
      return advise(`We haven't found the enemy base yet; advance ${group.length} units together across the map to find it.`,
        `Advance ${group.length} units to find the enemy base`, group.map(unit => ({ action: "attack_move", actor_id: unit.actorId, target_x: goal.x, target_y: goal.y })), "sweep");
    }
    if (goal) {
      const scout = [...fighters].sort((a, b) => price(a) - price(b) || (b.speed ?? 0) - (a.speed ?? 0) || a.actorId - b.actorId)[0];
      return advise(`We haven't found the enemy base yet; send your ${name(scout.kind)} to scout the far side of the map.`,
        `Send the ${name(scout.kind)} to scout`, [{ action: "move", actor_id: scout.actorId, target_x: goal.x, target_y: goal.y }], "scout");
    }
    return advise(`We haven't found the enemy base yet; send a scout to explore the ${100 - Math.round(snapshot.exploredPercent)}% of the map still in fog.`, "", [], "scout");
  }
  if (!targets.length) return null;
  // The enemy building nearest to a group, leaving out any the group already stands on (a remembered building that is
  // gone, or one they have reached): the same order again would change nothing.
  const nearest = (group: AdviserActor[]) => {
    const cx = group.reduce((sum, unit) => sum + unit.cellX, 0) / group.length, cy = group.reduce((sum, unit) => sum + unit.cellY, 0) / group.length;
    return targets.filter(target => (target.cellX - cx) ** 2 + (target.cellY - cy) ** 2 > 4 ** 2)
      .sort((a, b) => (a.cellX - cx) ** 2 + (a.cellY - cy) ** 2 - ((b.cellX - cx) ** 2 + (b.cellY - cy) ** 2))[0];
  };
  // Fighters standing idle inside the enemy base: an attack-move does not make them shoot buildings, so they attack the
  // nearest building they can see, all together; with none in sight, they go on to the next one remembered.
  const inside = fighters.filter(unit => unit.idle && targets.some(target => distanceSquared(unit, target) <= 14 ** 2));
  const pressing = inside.slice(0, MAX_ORDERS);
  if (pressing.length && snapshot.visibleEnemyBuildings.length) {
    const cx = pressing.reduce((sum, unit) => sum + unit.cellX, 0) / pressing.length, cy = pressing.reduce((sum, unit) => sum + unit.cellY, 0) / pressing.length;
    const building = [...snapshot.visibleEnemyBuildings].sort((a, b) => (a.cellX - cx) ** 2 + (a.cellY - cy) ** 2 - ((b.cellX - cx) ** 2 + (b.cellY - cy) ** 2))[0];
    if ((building.cellX - cx) ** 2 + (building.cellY - cy) ** 2 <= 14 ** 2) {
      const n = pressing.length;
      return advise(`Your ${n} unit${n === 1 ? " is" : "s are"} next to the enemy's ${name(building.kind)}; attack it${n === 1 ? "" : " together"}.`,
        `Attack the ${name(building.kind)} with ${n} unit${n === 1 ? "" : "s"}`,
        pressing.map(unit => ({ action: "attack", actor_id: unit.actorId, target_actor_id: building.actorId })), "press");
    }
  }
  const onward = pressing.length ? nearest(pressing) : undefined;
  if (onward) {
    const target = onward, n = pressing.length;
    return advise(`Your ${n} unit${n === 1 ? " is" : "s are"} standing in the enemy base; send ${n === 1 ? "it" : "them"} on to the next building.`,
      `Attack-move ${n} unit${n === 1 ? "" : "s"} to the next enemy building`,
      pressing.map(unit => ({ action: "attack_move", actor_id: unit.actorId, target_x: target.cellX, target_y: target.cellY })), "press");
  }
  // An attack is a wave: the idle fighters go together once there are 10 or more worth 10,000 credits. A smaller army
  // stays home with the defences; units already fighting are left to it.
  // One card carries at most 12 orders (the engine refuses more): the strongest 12 go first, and the rest join them.
  const wave = fighters.filter(unit => unit.idle && !inside.includes(unit));
  const price = (unit: AdviserActor) => tree[baseType(unit.kind)]?.cost ?? 0;
  const attackers = [...wave].sort((a, b) => price(b) - price(a) || a.actorId - b.actorId).slice(0, MAX_ORDERS), target = attackers.length ? nearest(attackers) : undefined;
  if (target && wave.length >= WAVE_UNITS && value(wave) >= WAVE_VALUE) {
    return advise(`Your ${wave.length} combat units are a real army now (${value(wave)} credits); attack-move them to the enemy base together.`,
      `Attack-move ${attackers.length} units to the enemy base`, attackers.map(unit => ({ action: "attack_move", actor_id: unit.actorId, target_x: target.cellX, target_y: target.cellY })), "attack");
  }
  // An attack under way (4 or more fighters busy nearer the enemy base than our own): the units at home join it rather
  // than wait for a wave of their own, so the attack does not run out.
  const own = snapshot.buildings;
  if (own.length && wave.length >= 3) {
    const hx = own.reduce((sum, b) => sum + b.cellX, 0) / own.length, hy = own.reduce((sum, b) => sum + b.cellY, 0) / own.length;
    const closest = (unit: AdviserActor) => Math.min(...targets.map(target => distanceSquared(unit, target)));
    const out = fighters.filter(unit => !unit.idle && closest(unit) < (unit.cellX - hx) ** 2 + (unit.cellY - hy) ** 2);
    const front = out.length >= 4 ? nearest(out) : undefined;
    if (front) return advise(`Your attack is under way with ${out.length} units; send the ${wave.length} at home to join it.`,
      `Send ${attackers.length} units to join the attack`, attackers.map(unit => ({ action: "attack_move", actor_id: unit.actorId, target_x: front.cellX, target_y: front.cellY })), "join");
  }
  return null;
}
