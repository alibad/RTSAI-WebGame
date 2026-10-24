// AI Arena decision brain: turns one fog-respecting co-commander observation into a few closed questions ("which
// building next?", "what should the army do?"), each with the options that are possible right now, and turns the
// chosen answers into the same native commands the built-in adviser issues (web/src/adviser.ts). Any decision model
// (TypeSafe Jev, OpenAI Decisions, a local model) or the scripted scorer below answers the same questions, so their
// games differ only in the choices made.
import tree from "../../web/src/adviser-tree.json" with { type: "json" };

/**
 * Recorded with every game, so the ladder keeps each version of the brain apart. Change it with the brain's rules.
 * "24 Oct counters+hunt" is the 23 Oct brain with walls, anti-air and support buildings kept out of its tower choices
 * ("24 Oct towers") and the two experiments that won on the same seeds (ADOPTED). docs/AI-ARENA.md has the record.
 */
export const BRAIN_VERSION = "24 Oct counters+hunt";

/**
 * Experiments: one rule change each, switched on per Arena run (a run's `experiment`, several joined with "+"), so a
 * variant plays the same seeds and factions as the brain without it, and the ladder keeps its games apart
 * ("24 Oct towers + counters"). Each answers one finding from the 24 Oct game logs (docs/AI-ARENA.md). An experiment
 * that wins is ADOPTED: always on, and named in BRAIN_VERSION.
 */
export const ADOPTED = new Set(["counters", "hunt"]);
/** The brain before the adopted experiments: a run with the experiment "before" plays it, under this version. */
export const BEFORE_VERSION = "24 Oct towers";
export const EXPERIMENTS = {
  before: "The brain before the adopted experiments (24 Oct towers), to compare against on new maps or seeds.",
  counters: "Units are picked against what the enemy fields (riflemen against infantry, anti-tank against vehicles, tanks over scout cars and anti-air), not by price.",
  scouting: "Scouts move without stopping to fight, and Defend answers only enemies near our base, not a scout's sighting across the map.",
  budget: "The opening keeps credits for the army: the second refinery and extra harvesters wait for minute 3 or spare credits.",
  hunt: "While the enemy base is unknown, sweeps and scouts work through points across the whole map, not only the mirror of our base.",
  turtle: "Against an early rush: two ground towers from minute 1.5 beside the factory (not before it), and the army waits at home until it is worth 4,000 or minute 8. The economy is left alone.",
};
const on = (opts, name) => {
  const asked = String(opts?.experiment ?? "").split("+");
  return (ADOPTED.has(name) && !asked.includes("before")) || asked.includes(name);
};

export const QUEUES = { Building: "build", Support: "defense", Infantry: "infantry", Vehicle: "vehicle", Aircraft: "aircraft", Ship: "ship" };
const BATCH = { Infantry: 3, Vehicle: 2, Aircraft: 1, Ship: 1 };
const mcvTypes = new Set(["mcv", "amcv", "smcv"]);
const harvesterTypes = new Set(["harv", "cmin", "harvester", "smin"]);
const support = /engineer|spy|dog|medic|technician|chrono legionnaire|psychic|terrorist/i;

export const baseType = (kind) => String(kind).toLowerCase().split("@", 1)[0].split(".", 1)[0];
const info = (item) => tree[baseType(item)] ?? {};
const sq = (a, b) => (a.cellX - b.cellX) ** 2 + (a.cellY - b.cellY) ** 2;
const isMcv = (kind, obs) => mcvTypes.has(baseType(kind)) || /construction vehicle/i.test(nameOf(obs, kind));
const isHarvester = (kind, obs) => harvesterTypes.has(baseType(kind)) || /harvester|miner|ore truck/i.test(nameOf(obs, kind));

export function nameOf(obs, item) {
  return obs.actorNames?.[String(item).toLowerCase()] || obs.actorNames?.[baseType(item)] || info(item).name || item;
}

export function desiredHarvesters(obs) {
  const area = Math.max(0, obs.mapWidth) * Math.max(0, obs.mapHeight);
  return area <= 4096 ? 2 : area <= 9216 ? 3 : area <= 16384 ? 4 : 5;
}

/** Every job a structure does (China's Airforce Command is both the radar and the airfield). */
function rolesOf(item) {
  const i = info(item), provides = i.provides ?? [], produces = i.produces ?? [];
  const roles = [provides.includes("power") && "power", provides.includes("refinery") && "refinery", produces.includes("infantry") && "barracks",
    produces.includes("vehicle") && "factory", provides.includes("radar") && "radar", produces.includes("aircraft") && "airfield", produces.includes("ship") && "shipyard"].filter(Boolean);
  return roles.length ? roles : [i.queue === "Support" ? "defense" : "tech"];
}
const roleOf = (item) => rolesOf(item)[0];

/**
 * What a Support-line structure is for, from its catalog name: "ground" (towers and bunkers that shoot ground units),
 * "air", "coast", "wall" (walls and gates: never worth a turn against an AI), or "support" (no weapon: relays,
 * workshops, sensors, superweapons).
 */
export function defenseKind(obs, item) {
  const n = nameOf(obs, item);
  if (/\bwall\b|\bgate\b|fence/i.test(n)) return "wall";
  if (/\bAA\b|anti-air|air-defense|air defense|flak|patriot|\bsam\b|skyshield|interceptor|zu-23|siper|raad/i.test(n)) return "air";
  if (/coastal|denial missile/i.test(n)) return "coast";
  if (/bunker|sentry|pill ?box|turret|guard tower|bastion|autocannon|anti-armor|\btow\b|tesla|arc coil|spectrum tower|grand cannon|prism|emplacement|cannon/i.test(n)) return "ground";
  return "support";
}
const DEFENSE_TEXT = { ground: "a tower that shoots ground attackers", air: "anti-air defense", coast: "coastal defense against ships", support: "support structure, no weapon" };

/**
 * What a unit is good against, from its catalog name (the "counters" experiment): "antiarmor", "antiinfantry",
 * "tank" (good against both), "antiair", "artillery", "recon" (scouts, spotters, carriers: weak in a fight), or
 * "general".
 */
export function unitClass(obs, item) {
  const n = nameOf(obs, item);
  if (/air defen[cs]e|air shield|anti-air|zu-23|\bAA\b|stinger/i.test(n)) return "antiair";
  if (/recon|scout|spotter|observer|jtac|coordinator|operator|airlift|support (carrier|vehicle)/i.test(n)) return "recon";
  if (/missile team|\bAT\b|anti-armor|anti-tank|ATGM|AT specialist|RPG|toophan|recoilless|tank destroyer|rocket soldier|bazooka/i.test(n)) return "antiarmor";
  if (/artillery|howitzer|rocket battery|missile launcher/i.test(n)) return "artillery";
  if (/battle tank|\btank\b/i.test(n)) return "tank";
  if (/rifle|fighter|guard|basij|conscript|\bGI\b|machine gun|gun truck|technical|flame/i.test(n)) return "antiinfantry";
  return "general";
}
const enemyAircraft = (obs) => obs.visibleEnemies.some((e) => info(e.kind).queue === "Aircraft" || /gunship|apache|aircraft|helicopter|\bjet\b|bomber/i.test(nameOf(obs, e.kind)));
const CLASS_TEXT = { antiarmor: "good against vehicles", antiinfantry: "good against infantry", tank: "main battle tank", antiair: "anti-air", artillery: "long-range artillery", recon: "scout or spotter: weak in a fight", general: "combat unit" };

/**
 * Where to look next while the enemy base is unknown (the "hunt" experiment): the mirror of our base first, then a
 * 3 × 3 grid of points across the map, nearest first, away from our own base. `key` keeps separate rotations for the
 * army's sweep and the scouts. A point is done when half the group reaches it, or after `patience` game seconds (a
 * scout is offered every 45, so each one goes somewhere new).
 */
function huntPoint(obs, memory, base, far, key, group, patience) {
  const pts = (memory.huntPoints ??= [far, ...[0.15, 0.5, 0.85].flatMap((a) => [0.15, 0.5, 0.85].map((b) => ({ cellX: Math.round(obs.mapWidth * a), cellY: Math.round(obs.mapHeight * b) })))
    .filter((p) => sq(p, base) > 25 ** 2 && sq(p, far) > 12 ** 2).sort((a, b) => sq(a, far) - sq(b, far))]);
  const state = (memory[key] ??= { index: 0, since: obs.tick });
  const here = pts[state.index % pts.length];
  const arrived = group.length && group.filter((u) => sq(u, here) <= 12 ** 2).length * 2 >= group.length;
  if (arrived || obs.tick - state.since > 25 * patience) { state.index++; state.since = obs.tick; }
  return pts[state.index % pts.length];
}

/** The infantry share (by value) of the enemy army seen in the last two game minutes, kept in the brain's memory. */
function noteEnemies(obs, memory) {
  const seen = (memory.seenEnemies ??= new Map());
  for (const e of obs.visibleEnemies) if (!isHarvester(e.kind, obs) && !isMcv(e.kind, obs)) seen.set(e.actorId, { infantry: info(e.kind).queue === "Infantry", value: info(e.kind).cost ?? 300, tick: obs.tick });
  for (const [id, e] of seen) if (obs.tick - e.tick > 25 * 120) seen.delete(id);
}
function infantryShare(obs, memory) {
  const seen = [...(memory?.seenEnemies?.values() ?? [])];
  const total = seen.reduce((s, e) => s + e.value, 0);
  // Before any sighting, expect infantry first: the engine's AI opens with it.
  if (total < 600) return obs.tick / 25 / 60 < 6 ? 0.7 : 0.5;
  return seen.filter((e) => e.infantry).reduce((s, e) => s + e.value, 0) / total;
}

const roleText = {
  power: "more power", refinery: "income: comes with a harvester", barracks: "trains infantry", factory: "builds vehicles",
  airfield: "builds aircraft", shipyard: "builds ships", radar: "radar and advanced units", tech: "technology", defense: "base defense",
};

const fighters = (obs) => obs.units.filter((u) => u.canAttack && !isMcv(u.kind, obs) && !isHarvester(u.kind, obs) && !/husk/i.test(u.kind));
const valueOf = (actors) => actors.reduce((s, a) => s + (info(a.kind).cost ?? 300), 0);
const count = (actors, obs) => {
  const c = {};
  for (const a of actors) { const n = nameOf(obs, a.kind); c[n] = (c[n] ?? 0) + 1; }
  return c;
};

function centroid(actors) {
  if (!actors.length) return null;
  return { cellX: Math.round(actors.reduce((s, a) => s + a.cellX, 0) / actors.length), cellY: Math.round(actors.reduce((s, a) => s + a.cellY, 0) / actors.length) };
}

/** Same visible-contact threat scoring as web/src/adviser.ts assessThreat, without its mission branch. */
export function threat(obs) {
  const enemies = obs.visibleEnemies, assets = obs.buildings.length ? obs.buildings : obs.units;
  let score = 0, nearest = null;
  if (enemies.length) {
    score += 8 + Math.min(28, 4 * enemies.length);
    if (assets.length) nearest = Math.sqrt(Math.min(...enemies.flatMap((e) => assets.map((a) => sq(e, a)))));
    if (nearest !== null) score += nearest <= 6 ? 46 : nearest <= 12 ? 34 : nearest <= 20 ? 22 : nearest <= 32 ? 10 : 0;
    const defenders = obs.units.filter((u) => u.canAttack).length;
    score += defenders === 0 ? 12 : enemies.length >= Math.max(3, defenders * 2) ? 10 : 0;
  }
  if (obs.visibleEnemyBuildings.length) score += Math.min(10, 2 * obs.visibleEnemyBuildings.length);
  score = Math.min(100, score);
  return { score, level: score >= 70 ? "critical" : score >= 45 ? "high" : score >= 20 ? "guarded" : "calm", nearest: nearest === null ? null : Math.round(nearest) };
}

/** The shared input every question is asked about: compact, names only, no engine ids. */
export function describe(obs) {
  const t = threat(obs), army = fighters(obs);
  const seconds = Math.round(obs.tick / 25);
  return {
    time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
    credits: obs.cash,
    power: { provided: obs.powerProvided, used: obs.powerDrained },
    harvesters: { have: obs.harvesterCount, mapSupports: desiredHarvesters(obs) },
    buildings: count(obs.buildings, obs),
    army: { units: count(army, obs), value: valueOf(army), idle: army.filter((u) => u.idle).length },
    producing: obs.production.map((p) => `${nameOf(obs, p.item)} ${Math.round(p.progress * 100)}%`),
    enemySeen: { units: count(obs.visibleEnemies, obs), unitValue: valueOf(obs.visibleEnemies), buildings: obs.visibleEnemyBuildings.length, rememberedBuildings: obs.rememberedEnemyBuildings?.length ?? 0 },
    threat: t.nearest === null ? t.level : `${t.level}, nearest enemy ${t.nearest} cells from the base`,
    mapExplored: `${Math.round(obs.exploredPercent)}%`,
  };
}

export const RUBRIC = "You command one side in a real-time strategy match (Red Alert 2 style) against a computer opponent. "
  + "Win by destroying every enemy building. Economy first (power, refineries, harvesters), then production, then a large "
  + "army that attacks together. Defend when the enemy is at the base. Never leave credits unspent for long. "
  + "Answer each question for the state given.";

/**
 * What to do now: commands that need no choice (deploy the construction vehicle, place finished buildings) and the
 * questions worth asking. A question has 2+ options; each option knows the commands it stands for.
 */
export function plan(obs, memory = {}, opts = {}) {
  const auto = [], questions = [];
  if (on(opts, "counters")) noteEnemies(obs, memory);
  const units = obs.units.filter((u) => !/husk/i.test(u.kind));
  const mcv = units.find((u) => isMcv(u.kind, obs));
  if (mcv && !obs.buildings.length) {
    auto.push({ label: `Deploy the ${nameOf(obs, mcv.kind)}`, commands: [{ action: "deploy", actor_id: mcv.actorId }] });
    return { auto, questions };
  }
  for (const p of obs.production)
    if ((p.progress >= 0.999 || p.remainingTicks <= 0) && ["Building", "Support"].includes(info(p.item).queue ?? p.queueType))
      auto.push({ label: `Place the ${nameOf(obs, p.item)}`, commands: [{ action: "place_building", item_type: p.item.toLowerCase() }] });

  // Production questions every 2 game seconds at most (a model call each); placing and deploying never wait.
  const asking = obs.tick - (memory.lastAskTick ?? -1e9) >= 50;
  const busy = new Set(obs.production.map((p) => info(p.item).queue ?? p.queueType));
  const available = [...new Set(obs.availableProduction.map((i) => i.toLowerCase()))].filter((i) => !i.endsWith("f") || !tree[i.slice(0, -1)]);
  const owned = (pred) => obs.buildings.filter((b) => pred(b.kind)).length;
  const t = threat(obs);
  const towers = owned((k) => info(k).queue === "Support" && defenseKind(obs, k) === "ground");
  for (const [queue, name] of Object.entries(QUEUES)) {
    if (!asking || busy.has(queue)) continue;
    // Base defenses are only worth a question under pressure or with credits to spare (with "turtle", also until two
    // towers stand from minute 1.5).
    if (queue === "Support" && t.level === "calm" && obs.cash < 3000 && !(on(opts, "turtle") && obs.tick >= 25 * 90 && towers < 2)) continue;
    // Walls and gates are never worth a turn against the engine's AI.
    const items = available.filter((i) => info(i).queue === queue && !isMcv(i, obs) && !(queue === "Support" && defenseKind(obs, i) === "wall"));
    if (!items.length) continue;
    const options = items.map((item) => {
      const i = info(item), cost = i.cost ?? 0;
      const batch = BATCH[queue] ?? 1, n = isHarvester(item, obs) ? 1 : batch;
      const have = queue === "Building" || queue === "Support" ? owned((k) => baseType(k) === baseType(item)) : obs.units.filter((u) => baseType(u.kind) === baseType(item)).length;
      const what = queue === "Support" ? DEFENSE_TEXT[defenseKind(obs, item)] : queue === "Building" ? roleText[roleOf(item)] : isHarvester(item, obs) ? "more income" : support.test(nameOf(obs, item)) ? "support unit" : "combat unit";
      // With "counters", a combat unit's description says what it is good against, for models as for the scorer.
      const unit = what === "combat unit" && on(opts, "counters") ? unitClass(obs, item) : null;
      return {
        value: item, label: `${n > 1 ? `${n} × ` : ""}${nameOf(obs, item)}`,
        description: `${nameOf(obs, item)}: ${unit ? CLASS_TEXT[unit] : what}; costs ${cost * n}; you have ${have}.`,
        cost: cost * n, have, unit, role: queue === "Support" ? defenseKind(obs, item) : queue === "Building" ? roleOf(item) : what, roles: queue === "Building" || queue === "Support" ? rolesOf(item) : [],
        commands: Array.from({ length: n }, () => ({ action: queue === "Building" || queue === "Support" ? "build" : "train", item_type: item })),
      };
    });
    options.push({ value: "wait", label: "Wait", description: "Build nothing on this line for now and keep the credits.", cost: 0, role: "wait", commands: [] });
    const what = { build: "Which building should we start next?", defense: "Which base defense or support structure should we start next?", infantry: "Which infantry should we train next?", vehicle: "Which vehicle should we build next?", aircraft: "Which aircraft should we build next?", ship: "Which ship should we build next?" }[name];
    questions.push({ name, type: "choice", instructions: what, options });
  }

  const army = fighters(obs);
  const tick = obs.tick;
  if (army.length && tick - (memory.lastArmyTick ?? -1e9) >= 125) {
    const base = centroid(obs.buildings) ?? centroid(units);
    const front = armyFront(obs, base, opts);
    const { targets, target, staging, gathered, home, idle } = front;
    const order = (list, cell, action = "attack_move") => list.map((u) => ({ action, actor_id: u.actorId, target_x: cell.cellX, target_y: cell.cellY }));
    // Units fire at enemy units and defences on their own, not at ordinary buildings: a building in sight gets an
    // explicit attack order (as the engine's own AI gives); one under fog is approached with attack-move.
    const strike = (list, building) => obs.visibleEnemyBuildings.some((b) => b.actorId === building.actorId)
      ? list.map((u) => ({ action: "attack", actor_id: u.actorId, target_actor_id: building.actorId })) : order(list, building);
    const options = [];
    // Units already moving or fighting keep their orders: only idle units are given new ones, so a fight is never
    // interrupted and fresh units never trickle one by one into the enemy's defences.
    if (target && idle.length - home.length > 0)
      options.push({ value: "attack", label: "Attack the enemy base", description: `Send the ${idle.length - home.length} idle units gathered at the front (worth ${valueOf(idle.filter((u) => !home.includes(u)))}) together at the nearest known enemy building; ${targets.length} known enemy buildings remain.`,
        commands: strike(idle.filter((u) => !home.includes(u)), target) });
    if (obs.visibleEnemies.length && base) {
      const contact = [...obs.visibleEnemies].sort((a, b) => sq(a, base) - sq(b, base))[0];
      const near = army.filter((u) => sq(u, base) <= 30 ** 2 && (u.idle || !u.targetId));
      // Without "scouting", any enemy in sight counts, even one a scout sees at the enemy base.
      const atHome = !on(opts, "scouting") || sq(contact, base) <= 32 ** 2;
      if (near.length && atHome) options.push({ value: "defend", label: "Defend the base", description: `Send the ${near.length} units near the base at the closest enemy (${t.nearest ?? "?"} cells away).`,
        commands: order(near, contact) });
    }
    // One scout at a time: offered again 45 game seconds after the last one was sent. With "scouting" it moves without
    // stopping to fight; otherwise it attack-moves and fights the first enemy it meets.
    // With "hunt", the scout and the sweep work through points across the map; otherwise both go to the mirror of our
    // base, where the enemy started (on 24 Oct an army seven times the enemy's swept there for 26 minutes).
    if (!targets.length && front.far && tick - (memory.lastScoutTick ?? -1e9) >= 25 * 45) {
      const scout = [...army].sort((a, b) => (b.speed ?? 0) - (a.speed ?? 0))[0];
      const to = on(opts, "hunt") ? huntPoint(obs, memory, base, front.far, "scoutRoute", [], 40) : front.far;
      options.push({ value: "scout", label: "Scout for the enemy", description: `Send the fastest unit toward ${on(opts, "hunt") ? "the next unsearched part" : "the far side"} of the map to find the enemy base (${Math.round(obs.exploredPercent)}% explored).`,
        commands: order([scout], to, on(opts, "scouting") ? "move" : "attack_move") });
    }
    if (!targets.length && front.far && idle.length >= 8) {
      const to = on(opts, "hunt") ? huntPoint(obs, memory, base, front.far, "sweepRoute", idle, 90) : front.far;
      options.push({ value: "sweep", label: "Sweep toward the enemy side", description: `Move the ${idle.length} idle combat units together toward ${on(opts, "hunt") ? "the next unsearched part" : "the far side"} of the map, fighting what they meet, to find the enemy base.`,
        commands: order(idle, to) });
    }
    // Gathering is not a choice: whatever the army does, idle units at home walk to the staging point (unless the base
    // is under pressure), so new units always join the group instead of piling up at home.
    if (home.length && staging && !["high", "critical"].includes(t.level))
      auto.push({ label: `Gather ${home.length} units at the front`, commands: order(home, staging, "move") });
    options.push({ value: "hold", label: "Hold", description: `Keep the units where they are (${gathered.length} gathered at the front).`, commands: [] });
    if (options.length >= 2) questions.push({ name: "army", type: "choice", instructions: "What should the army do now?", options });
    return { auto, questions, armyTurn: true };
  }
  return { auto, questions, armyTurn: false };
}

/**
 * Where the army stands: the enemy buildings we know of, the one to hit next (the nearest to our base: the enemy's
 * base is worn down from its edge, the way the engine's own AI attacks), a staging point 40% of the way to the enemy
 * base's centre (or toward the far side of the map while it is unknown), and which idle fighters are at home,
 * gathered at the staging point, or anywhere else forward. With "turtle" the staging point is just in front of the base
 * (12% of the way) until the army is worth 4,000 or minute 8, so an early rush meets the army and the towers together.
 */
export function armyFront(obs, base = centroid(obs.buildings) ?? centroid(obs.units), opts = {}) {
  const army = fighters(obs);
  const targets = obs.visibleEnemyBuildings.length ? obs.visibleEnemyBuildings : obs.rememberedEnemyBuildings ?? [];
  const far = base && { cellX: Math.max(1, Math.min(obs.mapWidth - 2, obs.mapWidth - base.cellX)), cellY: Math.max(1, Math.min(obs.mapHeight - 2, obs.mapHeight - base.cellY)) };
  const target = targets.length && base ? [...targets].sort((a, b) => sq(a, base) - sq(b, base))[0] : null;
  const toward = centroid([...obs.visibleEnemyBuildings, ...(obs.rememberedEnemyBuildings ?? [])]) ?? far;
  const reach = on(opts, "turtle") && valueOf(army) < 4000 && obs.tick < 25 * 60 * 8 ? 0.12 : 0.4;
  const staging = base && toward ? { cellX: Math.round(base.cellX + (toward.cellX - base.cellX) * reach), cellY: Math.round(base.cellY + (toward.cellY - base.cellY) * reach) } : null;
  const gatherFrom = base;
  const idle = army.filter((u) => u.idle);
  // At home: idle near the base and not already at the staging point (which can be close by).
  const atStaging = (u) => staging && sq(u, staging) <= 10 ** 2;
  const home = gatherFrom ? idle.filter((u) => sq(u, gatherFrom) <= 16 ** 2 && !atStaging(u)) : [];
  const gathered = staging ? idle.filter((u) => !home.includes(u) && atStaging(u)) : [];
  return { army, targets, target, far, staging, idle, home, gathered };
}

/**
 * The free scripted decision-maker: hand-written scores per option, turned into probabilities (softmax), so its
 * answers look exactly like a decision model's and its games set the bar a model has to beat.
 */
export function scriptedAnswers(obs, questions, opts = {}) {
  const state = describe(obs), army = fighters(obs), t = threat(obs);
  const has = (role) => obs.buildings.some((b) => rolesOf(b.kind).includes(role));
  const queued = (role) => obs.production.some((p) => rolesOf(p.item).includes(role));
  const refineries = obs.buildings.filter((b) => rolesOf(b.kind).includes("refinery")).length;
  const sameType = (item) => obs.buildings.filter((b) => baseType(b.kind) === baseType(item)).length;
  const minutes = obs.tick / 25 / 60, spare = obs.powerProvided - obs.powerDrained;
  const enemyValue = state.enemySeen.unitValue, armyValue = state.army.value;
  // With "budget", expansion waits for minute 3 or spare credits, so the opening's credits go to the army as a rush
  // arrives (a second refinery, a harvester, the factory and a tower started together left 0 credits at minute 2).
  const expand = !on(opts, "budget") || minutes > 3 || obs.cash > 2500;
  // What each structure role is worth now; a building is worth its best role.
  const need = {
    power: spare < 10 ? 6 : spare < 60 && obs.cash > 1500 ? 1.5 : -1,
    refinery: !has("refinery") ? 6 : refineries < 2 && minutes > 2 && expand ? 3.5 : refineries < 3 && minutes > 6 && obs.cash > 2500 ? 2 : -1,
    barracks: !has("barracks") && !queued("barracks") ? 4.5 : -1, factory: !has("factory") && has("refinery") ? 5 : -1,
    radar: !has("radar") && has("factory") ? 3 : -1, airfield: !has("airfield") && has("radar") && obs.cash > 2500 ? 1 : -1,
    tech: has("radar") && obs.cash > 3000 ? 1.5 : -1, shipyard: -2,
  };
  const answers = {};
  for (const q of questions) {
    const score = (o) => {
      if (q.name === "army") {
        const f = armyFront(obs, undefined, opts), forward = f.idle.filter((u) => !f.home.includes(u)), forwardValue = valueOf(forward);
        const atTarget = f.target ? forward.filter((u) => sq(u, f.target) <= 15 ** 2).length : 0;
        // Without "scouting", Defend ties Hold when the base is calm and wins the tie (it comes first).
        if (o.value === "defend") return t.level === "critical" || t.level === "high" ? 6 : on(opts, "scouting") ? 0.5 : 1;
        // Strike with a gathered group, and keep units already at the enemy base pushing on to the next building.
        if (o.value === "attack") return atTarget >= 2 ? 5.5 : forward.length >= 10 && forwardValue >= Math.max(3500, enemyValue * 1.2) ? 5.5 : forward.length >= 18 ? 5 : -1;
        if (o.value === "scout") return army.length >= 2 ? 3 : 0.5;
        if (o.value === "sweep") return f.idle.length >= 12 && armyValue >= 5000 ? 4 : -1;
        return 1;
      }
      if (o.value === "wait") return obs.cash < 300 ? 4 : 0.2;
      const affordable = o.cost <= obs.cash + 200;
      if (q.name === "build") {
        const best = Math.max(...o.roles.map((r) => need[r] ?? 0));
        // A second copy of a production or tech building pays off only when credits pile up.
        const copies = ["power", "refinery"].some((r) => o.roles.includes(r)) ? 0 : sameType(o.value) * (obs.cash > 5000 ? 1 : 3);
        return best - copies + (affordable ? 0 : -3);
      }
      // A tower that shoots ground attackers when the enemy is at the base; anti-air, coast guns and support buildings
      // only with nothing better, since the opponents attack by land.
      if (q.name === "defense") {
        // With "turtle", the first two ground towers from minute 1.5, the strongest affordable.
        const towers = obs.buildings.filter((b) => info(b.kind).queue === "Support" && defenseKind(obs, b.kind) === "ground").length;
        if (on(opts, "turtle") && o.role === "ground" && towers < 2 && minutes >= 1.5 && affordable) return 4 + Math.min(1.5, o.cost / 1000);
        return o.role === "ground" && (t.level === "high" || t.level === "critical") && obs.cash > 1000 && o.cost <= 1500 ? 3 : -2;
      }
      if (o.role === "more income") return obs.harvesterCount < desiredHarvesters(obs) && has("refinery") && (expand || obs.harvesterCount < 2) ? 6 : -2;
      if (o.role === "support unit") return -1.5;
      // Combat units: keep every factory busy with the strongest unit we can afford.
      if (!affordable) return -3;
      const strength = 2 + Math.min(3, o.cost / 700);
      if (!o.unit) return strength;
      // With "counters", what the enemy fields matters more than price.
      const inf = infantryShare(obs, opts.memory), veh = 1 - inf;
      switch (o.unit) {
        case "antiarmor": return strength + (veh - 0.5) * 4;
        case "antiinfantry": return strength + (inf - 0.5) * 4;
        case "tank": return strength + 1;
        case "antiair": return enemyAircraft(obs) ? strength + 2 : strength - 3;
        case "artillery": return o.have >= 2 ? strength - 3 : strength - 0.5;
        case "recon": return strength - 3;
        default: return strength;
      }
    };
    const scores = q.options.map(score);
    const max = Math.max(...scores), exp = scores.map((s) => Math.exp((s - max) * 1.5)), sum = exp.reduce((a, b) => a + b, 0);
    const probabilities = Object.fromEntries(q.options.map((o, i) => [o.value, exp[i] / sum]));
    const choice = q.options[scores.indexOf(max)].value;
    answers[q.name] = { choice, probabilities };
  }
  return answers;
}
