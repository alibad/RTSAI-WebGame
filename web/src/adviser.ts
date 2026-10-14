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
  passengers?: number;
  /** Units: whether they can capture or demolish (C4), and the visible actors they can do it to now. */
  canCapture?: boolean;
  captureTargets?: number[];
  canDemolish?: boolean;
  demolishTargets?: number[];
  /** Units: the actor they are attacking (0: none). */
  targetId?: number;
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
  action: "deploy" | "place_building" | "build" | "train" | "attack_move" | "move" | "attack" | "capture" | "demolish" | "stop";
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
  const basicUnit = (items: string[], queue: string, word: "tank" | "infantry") => items.find(item => {
    const entry = tree[baseType(item)];
    // A queue must be known from native/generated metadata. Avoid guessing that
    // a cheap structure is infantry when metadata is unavailable.
    if (entry?.queue?.toLowerCase() !== queue.toLowerCase()) return false;
    const shown = name(item).toLowerCase();
    return word === "tank" ? shown.includes("tank") : !["engineer", "dog", "spy", "medic", "technician"].some(skip => shown.includes(skip))
      && ((entry.cost ?? Infinity) <= 400 || ["e1", "e2"].includes(baseType(item)));
  });
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
  if (ready) return advise(`Place the finished ${name(ready.item)} first; the build queue waits until it's down.`,
    `Place the ${name(ready.item)}`, [{ action: "place_building", item_type: ready.item.toLowerCase() }], "place");
  if (!options.buildFocus && (snapshot.threatHeated ?? assessThreat(snapshot).heated) && snapshot.visibleEnemies.length) {
    const assets = [...snapshot.buildings, ...units];
    const proximity = (enemy: AdviserActor) => assets.length ? Math.min(...assets.map(asset => distanceSquared(enemy, asset))) : 0;
    const contact = [...snapshot.visibleEnemies].sort((a, b) => proximity(a) - proximity(b))[0];
    const defenders = units.filter(unit => unit.idle && unit.canAttack).sort((a, b) => distanceSquared(a, contact) - distanceSquared(b, contact)).slice(0, 6);
    if (defenders.length) return advise(`Enemies are at your base; send your ${defenders.length} idle fighter${defenders.length === 1 ? "" : "s"} at them now.`,
      `Attack-move ${defenders.length} idle unit${defenders.length === 1 ? "" : "s"} to the attackers`,
      defenders.map(unit => ({ action: "attack_move", actor_id: unit.actorId, target_x: contact.cellX, target_y: contact.cellY })), "defend");
  }
  if (snapshot.buildings.length && snapshot.powerDrained > snapshot.powerProvided && !queued.has("power")) {
    const item = availableFor("power");
    if (item) return advise(`Power is short by ${snapshot.powerDrained - snapshot.powerProvided}; build another ${name(item)} so production runs at full speed.`,
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
  if (!owned.has("radar") && !queued.has("radar")) {
    const item = availableFor("radar");
    if (item) return advise(`Build ${article(name(item))} next: it lights up the minimap and unlocks advanced units.`,
      `Build ${article(name(item))}`, build(item), "build:radar");
  }
  const fighters = units.filter(unit => unit.canAttack && !nonCombatTypes.has(baseType(unit.kind)));
  const busy = new Set(snapshot.production.map(entry => entry.queueType.toLowerCase()));
  const tank = basicUnit(available, "Vehicle", "tank"), infantry = basicUnit(available, "Infantry", "infantry");
  if (tank && !busy.has("vehicle")) return advise(`Build up the army: train ${plural(tank)}; you have ${fighters.length} combat unit${fighters.length === 1 ? "" : "s"}.`,
    `Train 3 ${plural(tank)}`, train(tank, 3), "train:tank");
  if (infantry && !busy.has("infantry") && fighters.length < 8) return advise(`Train more ${plural(infantry)} to protect the base while it grows.`,
    `Train 3 ${plural(infantry)}`, train(infantry, 3), "train:infantry");
  if (options.buildFocus) return null;
  const targets = snapshot.visibleEnemyBuildings.length ? snapshot.visibleEnemyBuildings : snapshot.rememberedEnemyBuildings ?? [];
  if (fighters.length && !targets.length) return advise(`We haven't found the enemy base yet; send a scout to explore the ${100 - Math.round(snapshot.exploredPercent)}% of the map still in fog.`, "", [], "scout");
  if (fighters.length >= 8 && targets.length) {
    const target = targets[0];
    const attackers = [...fighters].sort((a, b) => Number(!a.idle) - Number(!b.idle) || a.actorId - b.actorId).slice(0, 12);
    return advise(`Your ${fighters.length} combat units can push now; attack-move them to the enemy base.`,
      `Attack-move ${attackers.length} units to the enemy base`, attackers.map(unit => ({ action: "attack_move", actor_id: unit.actorId, target_x: target.cellX, target_y: target.cellY })), "attack");
  }
  return null;
}
