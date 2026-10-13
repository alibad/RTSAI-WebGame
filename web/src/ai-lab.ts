import type { Snapshot, UiState, SandboxStats } from "./sim/protocol";
import type { Game } from "./game";
import { store } from "./store";

export interface CoachEvent { tick: number; kind: "power" | "production" | "loss" | "cash"; text: string; practice: string; x?: number; y?: number }
export interface CoachFrame { tick: number; snapshot: Snapshot; cash: number; army: number; power: string; camera: { x: number; y: number; zoom: number } }
export interface LabState { objective: string | null; duration: number; status: string; elapsed: number; metrics?: SandboxStats; doctrines: { player: string; doctrine: string; decisions: { tick: number; mode: string; units: number; observedEnemies: number }[] }[] }

/** Evidence comes only from the player's HUD and visible snapshots. No inferred enemy losses. */
export class Coach {
  events: CoachEvent[] = [];
  frames: CoachFrame[] = [];
  review: CoachFrame | null = null;
  lab: LabState | null = null;
  previousPractice: SandboxStats | null = null;
  private practiceSaved = false;
  private own = new Map<number, { id: number; building: boolean; x: number; y: number }>();
  private losses = 0;
  private power = "Normal";
  private idleSince = 0;
  private cashSince = 0;
  private lastCash = -1;
  private lastTick = -1;
  private lastFrameTick = -50;
  private lastLabTick = -125;
  private beforePaused = false;
  private liveCamera = { x: 0, y: 0, zoom: 1 };
  private polling = false;
  private generation = 0;
  constructor(private game: Game) {}
  reset() { this.generation++; this.events = []; this.frames = []; this.review = null; this.lab = null; this.previousPractice = null; this.practiceSaved = false; this.own.clear(); this.lastTick = -1; this.lastFrameTick = -50; this.lastLabTick = -125; this.power = "Normal"; this.idleSince = this.cashSince = 0; this.lastCash = -1; this.losses = 0; }
  record(s: Snapshot, ui: UiState | null) {
    const tick = s.header.tick;
    if (!ui?.queues || !ui.coach || tick <= this.lastTick || tick - this.lastTick < 25) return;
    this.lastTick = tick;
    const own = new Map(ui.coach.actors.map(a => [a.id, a]));
    const power = ui.power?.state ?? "Normal";
    if (power !== "Normal" && this.power === "Normal") this.add({ tick, kind: "power", text: `Power fell to ${power}: ${ui.power?.provided} supplied / ${ui.power?.drained} used.`, practice: "Practice protecting your force while under pressure." });
    this.power = power;
    const missing = [...this.own.values()].filter(a => !own.has(a.id));
    const dead = ui.coach.losses - this.losses;
    if (dead > 0) this.add({ tick, kind: "loss", text: `${dead} owned unit${dead > 1 ? "s" : ""} lost since the previous sample, confirmed by engine statistics.`, practice: "Practice preserving a smaller force against a larger one.", x: missing[0]?.x, y: missing[0]?.y });
    this.losses = ui.coach.losses;
    this.own = own;
    const enabled = ui.queues.filter(q => q.enabled);
    const idle = enabled.length > 0 && enabled.every(q => q.items.length === 0) && (ui.cash ?? 0) >= 1000;
    if (!idle) this.idleSince = 0;
    else if (!this.idleSince) this.idleSince = tick;
    else if (tick - this.idleSince >= 750) { this.add({ tick, kind: "production", text: `All ${enabled.length} enabled production queues were empty for 30 seconds with at least 1,000 credits.`, practice: "Practice timing reinforcements in a short battle." }); this.idleSince = tick; }
    if (ui.coach.earned !== this.lastCash) { this.cashSince = tick; this.lastCash = ui.coach.earned; }
    else if (tick - this.cashSince >= 750 && !JSON.parse(this.game.scenarioJson).sandbox) { this.add({ tick, kind: "cash", text: `No new income recorded for 30 seconds; total earned remained ${ui.coach.earned}. Check harvesting and resource access.`, practice: "Practice winning with a fixed force and no extra income." }); this.cashSince = tick; }
    if (tick - this.lastFrameTick >= 50 || !this.frames.length) {
      this.lastFrameTick = tick;
      this.frames.push({ tick, snapshot: s, cash: ui.cash ?? 0, army: [...own.values()].filter(a => !a.building).length, power, camera: { ...this.game.cam } });
      while (this.frames.length > 180 || this.frames[0].tick < tick - 9000) this.frames.shift();
    }
    if (!this.polling && tick - this.lastLabTick >= 125) {
      this.lastLabTick = tick;
      this.polling = true; const generation = this.generation;
      this.game.command<LabState>({ cmd: "ai-lab" }).then(l => {
        if (generation !== this.generation || !l || !Array.isArray(l.doctrines)) return;
        this.lab = l;
        if (l.objective && l.status !== "active" && l.metrics && !this.practiceSaved) {
          this.practiceSaved = true; this.game.setPaused(true);
          try { const prior = JSON.parse(localStorage.getItem('rtsai.practice-result') ?? 'null'); this.previousPractice = prior?.scenario === this.game.scenarioJson ? prior.metrics : null; localStorage.setItem('rtsai.practice-result', JSON.stringify({ scenario: this.game.scenarioJson, metrics: l.metrics })); } catch { /* optional local comparison */ }
        }
      }).catch(() => {}).finally(() => { this.polling = false; });
    }
  }
  private add(event: CoachEvent) { this.events.push(event); if (this.events.length > 100) this.events.shift(); }
  seek(tick: number) {
    if (this.game.multiplayer || !this.frames.length) return;
    if (!this.review) { this.beforePaused = store.get().paused; this.liveCamera = { ...this.game.cam }; this.game.setPaused(true); }
    this.review = this.frames.reduce((best, f) => Math.abs(f.tick - tick) < Math.abs(best.tick - tick) ? f : best);
    this.game.renderer.runModels(this.review.snapshot);
    this.game.cam = { ...this.review.camera };
  }
  live() { if (!this.review) return; this.review = null; this.game.cam = { ...this.liveCamera }; this.game.lookAt(this.game.cam.x, this.game.cam.y); this.game.setPaused(this.beforePaused); }
  export() {
    const data = { version: 1, scenario: JSON.parse(this.game.scenarioJson), events: this.events, frames: this.frames.map(({ tick, cash, army, power }) => ({ tick, cash, army, power })), lab: this.lab };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "rtsai-coaching.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

// ---------------------------------------------------------------- scenario workshop (practice battles)

export interface UnitOption {
  name: string; label: string; queue: string; modern: boolean;
  /** The engine's own answer to "can it fight?": what validate-practice counts as a combat unit. Unset until probed. */
  combat?: boolean;
  /** Selection bounds in world px [width, height], measured in the engine; formations are spaced by them. */
  size?: [number, number];
}
/** Faction id -> the units its production palette lists, in palette order. Empty: the palette needs buildings first. */
export type Rosters = Record<string, string[]>;
export interface PracticePlan { title: string; faction: string; enemy: string; unit: string; enemyUnit: string; count: number; enemyCount: number; duration: number; objective: "eliminate" | "survive"; seed: number; enemyOrder: "engage" | "hold" }
export type PlanField = "faction" | "enemy" | "unit" | "enemyUnit" | "count" | "enemyCount" | "duration" | "seed" | "objective" | "enemyOrder";
/** A problem with one field of the plan (null: the plan as a whole), in plain words for the player. */
export interface PlanIssue { field: PlanField | null; message: string }

export const MAX_FORCE = 24;
/** The flat arena: each side's front rank (MPos u, 25 cells apart) and the row the formations are centred on. */
export const ARENA_FRONT: readonly [number, number] = [51, 76];
export const ARENA_ROW = 62;
const DEFAULT_SIZE: [number, number] = [72, 60];
const FORMATION_GAP = 12;

export type UnitClass = "infantry" | "air" | "drone" | "artillery" | "tank" | "vehicle";
const CLASS_WORDS: [UnitClass, RegExp][] = [
  ["tank", /^(tanks?|armou?r)$/],
  ["infantry", /^(infantry|infantrymen|soldiers?|riflem[ae]n|troopers?|troops|men|squads?)$/],
  ["air", /^(aircraft|planes?|jets?|helicopters?|helis?|choppers?|gunships?)$/],
  ["artillery", /^(artillery|howitzers?|launchers?|rockets?)$/],
  ["drone", /^drones?$/],
  ["vehicle", /^(vehicles?|ifvs?|apcs?|trucks?|technicals?)$/],
];
const IS: Record<UnitClass, (u: UnitOption) => boolean> = {
  infantry: u => u.queue === "Infantry",
  air: u => u.queue === "Aircraft" || /\b(apache|gunship|helicopter|aircraft|jet|eagle|airship|interceptor)\b/i.test(u.label),
  drone: u => u.queue !== "Infantry" && /\b(drone|loiter)\b/i.test(u.label),
  artillery: u => /\b(howitzer|artillery|rocket|launcher)\b/i.test(u.label),
  tank: u => u.queue === "Vehicle" && /\btank\b/i.test(u.label),
  vehicle: u => u.queue === "Vehicle",
};
/** The plain front-line pick of a class: a battle tank, a rifleman. */
const MAINLINE: Partial<Record<UnitClass, RegExp>> = { tank: /\bbattle tank\b/i, infantry: /\b(rifle(man|men)?|guard|basij|g\.i\.|conscript|line fighter|infantry)\b/i };
const TIME_WORD = /^(s|secs?|seconds?|m|mins?|minutes?)$/;
/** Words that never name a particular unit on their own. */
const STOP = new Set(["battle", "main", "medium", "heavy", "light", "mobile", "attack", "armed", "strike", "recon", "field", "forward", "portable", "combined", "combined-arms", "network", "phase", "area", "naval", "airborne", "elite", "demolition", "control", "anti-armor", "coastal", "escort", "rifle", "drone", "tank", "team", "rocket", "missile", "siege", "falcon", "line", "mountain", "fighter", "infantry", "vehicle", "carrier", "support", "command", "night", "spectrum", "camouflage", "flak", "mechanized", "precision", "national"]);

/** "Heavy Assault Tank Tank" -> "Heavy Assault Tank" (the tooltip name repeated as its generic noun). */
export const cleanLabel = (label: string) => label.replace(/\b(\w+)\s+\1$/i, "$1");
export const unitClass = (u: UnitOption | undefined): UnitClass | null => u ? (Object.keys(IS) as UnitClass[]).find(c => IS[c](u)) ?? null : null;
const canFight = (u: UnitOption | undefined) => !!u && u.combat !== false && u.queue !== "Ship";

/** Units a faction fields: its palette roster, else (no palette without buildings: original countries) the original units. */
export function factionUnits(faction: string, units: UnitOption[], rosters: Rosters = {}): UnitOption[] {
  const combat = units.filter(canFight), roster = rosters[faction];
  if (!roster) return combat;
  if (!roster.length) return combat.filter(u => !u.modern);
  return roster.map(n => combat.find(u => u.name === n)).filter((u): u is UnitOption => !!u);
}

/** A sensible combat unit of a faction for a class ("tank", "infantry"...; null: a battle tank). Never a non-combat actor. */
export function pickUnit(cls: UnitClass | null, faction: string, units: UnitOption[], rosters: Rosters = {}): string {
  const combat = units.filter(canFight), own = factionUnits(faction, units, rosters), roster = rosters[faction] ?? [];
  const want = cls ?? "tank";
  const rank = (u: UnitOption) => { const i = roster.indexOf(u.name); return i < 0 ? 999 : i; };
  const score = (u: UnitOption) => MAINLINE[want]?.test(u.label) ? 0 : 1;
  const best = (list: UnitOption[]) => [...list].sort((a, b) => score(a) - score(b) || rank(a) - rank(b) || a.label.localeCompare(b.label))[0];
  for (const list of [own.filter(IS[want]), want === "tank" ? own.filter(IS.vehicle) : [], own, combat.filter(IS[want]), combat])
    if (list.length) return best(list).name;
  return "";
}

function wordsOf(s: string) { return [...s.matchAll(/[a-z0-9à-ÿ][\w-]*/g)].map(m => ({ w: m[0], at: m.index ?? 0 })); }
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Reads a battle request ("Defend with 6 tanks against 8 units for 2 minutes") into a plan. The text before
 * "against"/"vs" is your side, the rest the opponent's. Counts, class words (tanks, infantry...) and unit names
 * pick each side's unit from that faction's roster; a generic word ("units") mirrors the other side's class.
 * Only combat units are ever picked. `named` tells which units the text named explicitly.
 */
export function interpret(text: string, units: UnitOption[], factions: string[], previous?: PracticePlan, rosters: Rosters = {}, factionNames: Record<string, string> = {}):
  { plan: PracticePlan; named: { unit: boolean; enemyUnit: boolean } } {
  const combat = units.filter(canFight);
  const find = (name: string) => units.find(u => u.name === name);
  let t = ` ${text.toLowerCase()} `;
  const seconds = t.match(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|s|m)\b/);
  const seedMatch = t.match(/\bseed\s*(\d+)/);
  for (const m of [seconds, seedMatch]) if (m) t = t.replace(m[0], " ".repeat(m[0].length));
  const cut = t.search(/\b(against|versus|vs\.?|facing|opposing)\b/);
  const parts: [string, string] = cut >= 0 ? [t.slice(0, cut), t.slice(cut)] : [t, ""];

  // Faction mentions (id or display name), in text order.
  const factionsIn = (s: string) => factions.map(id => {
    const names = [id, factionNames[id]?.toLowerCase()].filter((n): n is string => !!n);
    const at = Math.min(...names.map(n => s.search(new RegExp(`(^|[^\\p{L}])${escape(n)}($|[^\\p{L}])`, "u"))).map(i => i < 0 ? Infinity : i));
    return { id, at };
  }).filter(f => Number.isFinite(f.at)).sort((a, b) => a.at - b.at).map(f => f.id);
  const factionWords = new Set(factions.flatMap(id => [id, ...(factionNames[id]?.toLowerCase().split(/\s+/) ?? [])]));

  // Unit mentions: the internal name, the full label, or a distinctive label word ("Karrar", "Merkava").
  const unitsIn = (s: string) => combat.map(u => {
    const label = u.label.toLowerCase(), first = label.split(/\s+/)[0];
    const keys = [u.name.toLowerCase(), label, ...(first.length >= 4 && /[a-z]/.test(first) && !STOP.has(first) && !factionWords.has(first) && !CLASS_WORDS.some(([, re]) => re.test(first)) ? [first] : [])];
    const at = Math.min(...keys.map(k => s.search(new RegExp(`(^|[^\\w-])${escape(k)}s?($|[^\\w-])`))).map(i => i < 0 ? Infinity : i));
    return { u, at };
  }).filter(m => Number.isFinite(m.at)).sort((a, b) => a.at - b.at || b.u.label.length - a.u.label.length).map(m => m.u);

  // Counts: a number not followed by a time word, with the word after it.
  const countsIn = (s: string) => [...s.matchAll(/\b(\d{1,4})\b(?:\s*x)?(?:\s+([a-z][\w-]*))?/g)]
    .filter(m => !TIME_WORD.test(m[2] ?? "")).map(m => ({ n: Number(m[1]), noun: m[2] ?? "" }));
  const classOf = (word: string) => CLASS_WORDS.find(([, re]) => re.test(word))?.[0] ?? null;
  const classIn = (s: string) => wordsOf(s).map(w => classOf(w.w)).find(c => c) ?? null;

  const f = cut >= 0 ? [factionsIn(parts[0])[0], factionsIn(parts[1])[0]] : factionsIn(t).slice(0, 2);
  const u = cut >= 0 ? [unitsIn(parts[0])[0], unitsIn(parts[1])[0]] : unitsIn(t).slice(0, 2);
  const c = cut >= 0 ? [countsIn(parts[0])[0], countsIn(parts[1])[0]] : countsIn(t).slice(0, 2);
  const cls = [0, 1].map(i => (c[i] && classOf(c[i]!.noun)) || (cut >= 0 ? classIn(parts[i]) : null));

  const faction = f[0] ?? previous?.faction ?? (factions.includes("saudi") ? "saudi" : factions[0]);
  const enemy = f[1] ?? previous?.enemy ?? (factions.includes("iran") ? "iran" : factions.find(x => x !== faction) ?? factions[0]);
  const keep = (name: string | undefined, side: string, was: string | undefined) => name && side === was && canFight(find(name)) ? name : undefined;
  const unit = u[0]?.name ?? (cls[0] ? pickUnit(cls[0], faction, units, rosters) : keep(previous?.unit, faction, previous?.faction) ?? pickUnit(unitClass(find(previous?.unit ?? "")) ?? "tank", faction, units, rosters));
  // "8 units": the same kind of unit as yours, from the opponent's roster.
  const mirror = unitClass(find(unit));
  const enemyUnit = u[1]?.name ?? (cls[1] ? pickUnit(cls[1], enemy, units, rosters) : (!c[1] && keep(previous?.enemyUnit, enemy, previous?.enemy)) || pickUnit(mirror, enemy, units, rosters));
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));
  const duration = seconds ? clamp(Number(seconds[1]) * (/^m/.test(seconds[2]) ? 60 : 1), 30, 600) : previous?.duration ?? 120;
  const plan: PracticePlan = {
    title: text.trim().slice(0, 100) || previous?.title || "Combined arms practice", faction, enemy, unit, enemyUnit,
    count: c[0] ? clamp(c[0].n, 1, MAX_FORCE) : previous?.count ?? 6, enemyCount: c[1] ? clamp(c[1].n, 1, MAX_FORCE) : previous?.enemyCount ?? 6,
    duration, seed: seedMatch ? clamp(Number(seedMatch[1]), 0, 2147483647) : previous?.seed ?? 42,
    objective: /surviv|\bhold\b|defend|preserv|protect/.test(t) ? "survive" : /eliminat|destroy|\bwin\b|attack|wipe/.test(t) ? "eliminate" : previous?.objective ?? "eliminate",
    enemyOrder: /stationary|hold position|dug in|entrenched/.test(t) ? "hold" : /\b(attacking|advancing|charging|rushing)\b/.test(t) ? "engage" : previous?.enemyOrder ?? "engage",
  };
  return { plan, named: { unit: !!u[0], enemyUnit: !!u[1] } };
}
export function planFromText(text: string, units: UnitOption[], factions: string[], previous?: PracticePlan, rosters: Rosters = {}): PracticePlan {
  return interpret(text, units, factions, previous, rosters).plan;
}

/** Field-level problems the page can show next to the field. Empty: the plan can be built. */
export function validatePlan(p: PracticePlan, units: UnitOption[], factions: string[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const field of ["faction", "enemy"] as const) if (!factions.includes(p[field])) issues.push({ field, message: "Pick a faction." });
  for (const field of ["unit", "enemyUnit"] as const) {
    const u = units.find(x => x.name === p[field]);
    if (!u) issues.push({ field, message: "Pick a unit from the list." });
    else if (!canFight(u)) issues.push({ field, message: `${u.label} can't fight. Pick a combat unit.` });
  }
  for (const field of ["count", "enemyCount"] as const) if (!Number.isInteger(p[field]) || p[field] < 1 || p[field] > MAX_FORCE) issues.push({ field, message: `Use 1–${MAX_FORCE} units.` });
  if (!Number.isInteger(p.duration) || p.duration < 30 || p.duration > 600) issues.push({ field: "duration", message: "Use 30–600 seconds." });
  if (!Number.isInteger(p.seed) || p.seed < 0 || p.seed > 2147483647) issues.push({ field: "seed", message: "Use a whole number from 0." });
  if (!["eliminate", "survive"].includes(p.objective)) issues.push({ field: "objective", message: "Pick a goal." });
  if (!["engage", "hold"].includes(p.enemyOrder)) issues.push({ field: "enemyOrder", message: "Pick an order." });
  return issues;
}

/**
 * The engine's validate-practice errors, moved onto the fields that cause them. `terrainRoutes` (the reply's
 * routes: "terrain") marks runtimes whose route check ignores actors. Older runtimes pathed into the opposing unit's
 * own cell, which a vehicle standing there always blocks: their "no ground route" says nothing when the opponent is
 * a vehicle, so it is only trusted against infantry, which share cells.
 */
export function nativeIssues(errors: string[], p: PracticePlan, units: UnitOption[], terrainRoutes = false): PlanIssue[] {
  const label = (n: string) => units.find(u => u.name === n)?.label ?? n;
  const sides = ["unit", "enemyUnit"] as const;
  const opposing = (f: typeof sides[number]) => units.find(u => u.name === p[f === "unit" ? "enemyUnit" : "unit"]);
  const out: PlanIssue[] = [];
  for (const e of errors) {
    const named = e.match(/^([\w-]+): (.*)$/);
    if (/combat unit/i.test(e)) {
      const bad = sides.filter(f => units.find(u => u.name === p[f])?.combat === false);
      for (const field of bad.length ? bad : sides) out.push({ field, message: `${label(p[field])} can't fight. Pick a combat unit.` });
    } else if (named) {
      const route = /route/.test(named[2]), own = sides.filter(f => p[f] === named[1]);
      const fields = route && !terrainRoutes ? own.filter(f => opposing(f)?.queue === "Infantry") : own;
      if (own.length && !fields.length) continue; // an older runtime's route check against a vehicle: no answer
      const message = /outside/.test(named[2]) ? "Too many to fit. Use fewer." : /terrain/.test(named[2]) ? "Can't stand on this ground." : route ? "Can't reach the opponent over land." : named[2];
      if (fields.length) for (const field of fields) out.push({ field, message });
      else out.push({ field: null, message: e });
    } else out.push({ field: null, message: e });
  }
  return out.filter((x, i) => out.findIndex(y => y.field === x.field && y.message === x.message) === i);
}

/**
 * A side's formation: ranks facing the opponent, files spaced by the unit's on-screen size so no two units (or
 * their selection boxes) overlap, at any force size. Isometric MPos: one u is a tile width, two v a tile height;
 * rows stay on even v so files never stagger. Side 0 stands west of its front rank, side 1 east of its own.
 */
export function formation(count: number, side: 0 | 1, size: [number, number] = DEFAULT_SIZE, tile: [number, number] = [60, 30]) {
  const n = Math.max(0, Math.min(MAX_FORCE, Math.floor(count) || 0));
  const du = Math.max(1, Math.ceil((size[0] + FORMATION_GAP) / tile[0]));
  const rows = Math.max(1, Math.ceil((size[1] + FORMATION_GAP) / tile[1]));
  const perRank = Math.max(1, Math.min(n, Math.ceil(Math.sqrt(n * 2))));
  return Array.from({ length: n }, (_, i) => {
    const rank = Math.floor(i / perRank), file = i % perRank, inRank = Math.min(perRank, n - rank * perRank);
    const row = file * rows - Math.floor((inRank - 1) * rows / 2);
    return { u: side ? ARENA_FRONT[1] + rank * du : ARENA_FRONT[0] - rank * du, v: ARENA_ROW + 2 * row };
  });
}

const ARENA_OPTIONS = { explored: "True", fog: "False", crates: "False", shortgame: "False" };

/**
 * The practice battle. The workshop builds it paused as its preview, so "Start battle" only unpauses the very world
 * that was checked: you command side 0 (Multi0); the opponent is the arena's idle bot under its practice orders.
 */
export function practiceScenario(p: PracticePlan, units: UnitOption[] = []) {
  const size = (name: string) => units.find(u => u.name === name)?.size;
  const placements = ([0, 1] as const).flatMap(side => formation(side ? p.enemyCount : p.count, side, size(side ? p.enemyUnit : p.unit))
    .map(c => ({ id: side ? p.enemyUnit : p.unit, side, u: c.u, v: c.v, facing: side ? 256 : 768, order: side ? p.enemyOrder : "hold" })));
  return { map: "web-arena", seed: p.seed, sandbox: true, objective: p.objective, duration: p.duration, players: [{ slot: "Multi0", faction: p.faction, color: "2A6FDB" }, { slot: "Multi1", faction: p.enemy, color: "D83A2E", bot: "webidle" }], options: ARENA_OPTIONS, placements };
}

// ---- engine probes for the workshop (a paused, empty arena; nothing here changes a game the player plays)

/** Resolves when the world started by game.start is running (or paused and drawn); rejects on an engine error. */
export function waitForWorld(alive: () => boolean = () => true, timeout = 120000) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const s = store.get();
      if (s.phase === "playing") { clearInterval(timer); resolve(); }
      else if (s.phase === "error" || !alive() || Date.now() - started > timeout) { clearInterval(timer); reject(new Error(s.error || (alive() ? "The battle took too long to build." : "Closed."))); }
    }, 60);
  });
}
const until = (test: () => boolean, timeout: number) => new Promise<boolean>(resolve => {
  const started = Date.now();
  const timer = setInterval(() => { const ok = test(); if (ok || Date.now() - started > timeout) { clearInterval(timer); resolve(ok); } }, 30);
});
/** Resolves once the match's sprite sheets are on the GPU: an opponent's art may still be streaming when its world starts. */
export const waitForArt = (timeout = 10000) => until(() => { const s = store.get().sheets; return s.uploaded >= s.total; }, timeout);

/** An empty, paused arena with `faction` as the local player (its production palette lists that faction's roster). */
async function openArena(game: Game, faction: string, other: string, alive: () => boolean) {
  game.start(JSON.stringify({ map: "web-arena", seed: 42, sandbox: true, players: [{ slot: "Multi0", faction, color: "2A6FDB" }, { slot: "Multi1", faction: other, color: "D83A2E", bot: "webidle" }], options: ARENA_OPTIONS }), true);
  await waitForWorld(alive);
}
/** The local player's roster from its production palette (Infantry, Vehicle and Aircraft queues). */
async function readRoster(): Promise<string[]> {
  await until(() => store.get().catalog.length > 0, 4000);
  return store.get().catalog.filter(q => ["Infantry", "Vehicle", "Aircraft"].includes(q.type)).flatMap(q => q.items.filter(i => !i.building).map(i => i.name));
}

let probed: { units: UnitOption[]; rosters: Rosters } | null = null;

/**
 * The workshop's unit catalog, asked of the engine itself: every land and air unit, whether it can fight (one of each
 * is placed and counted by validate-practice, the same test the battle check uses) and its on-screen size. Also
 * returns the rosters of `faction` (the arena's local player) and of `others`. Cached for the session.
 */
export async function loadPracticeCatalog(game: Game, faction: string, others: string[], alive: () => boolean): Promise<{ units: UnitOption[]; rosters: Rosters }> {
  if (!probed) {
    await openArena(game, faction, others.find(f => f !== faction) ?? faction, alive);
    const rosters: Rosters = { [faction]: await readRoster() };
    const r = await game.command<{ units?: UnitOption[] }>({ cmd: "units" });
    const units = (r.units ?? []).filter(u => u.queue !== "Ship").map(u => ({ ...u, label: cleanLabel(u.label) }));
    const info = game.info!;
    const x = info.cellOrigin[0] + 2 * 64 * info.tileSize[0] / 2, y = info.cellOrigin[1] + ARENA_ROW * info.tileSize[1] / 2;
    let fighters = 0;
    for (const u of units) {
      if (!alive()) throw new Error("Closed.");
      await game.command({ cmd: "spawn", type: u.name, player: 0, x, y, count: 1 });
      const v = await game.command<{ units?: number }>({ cmd: "validate-practice" });
      u.combat = (v.units ?? fighters) > fighters; fighters = v.units ?? fighters;
    }
    // A paused world redraws on a view change: the snapshot then carries every probe actor's selection bounds.
    game.lookAt(x, y);
    await until(() => (game.client.cur?.actors.length ?? 0) >= units.length, 3000);
    const cur = game.client.cur;
    for (const a of cur?.actors ?? []) {
      const u = units.find(x => x.name === game.client.str(a.type));
      if (u && a.bw > 0 && a.bh > 0) u.size = [Math.max(u.size?.[0] ?? 0, a.bw), Math.max(u.size?.[1] ?? 0, a.bh)];
    }
    probed = { units, rosters };
  }
  for (const f of others) await probeRoster(game, f, faction, alive);
  return { units: probed.units, rosters: { ...probed.rosters } };
}
/** A faction's roster (cached): an empty arena with that faction as the local player. */
export async function probeRoster(game: Game, faction: string, other: string, alive: () => boolean): Promise<string[]> {
  if (!probed) throw new Error("The unit catalog is not loaded.");
  if (!(faction in probed.rosters)) {
    await openArena(game, faction, other, alive);
    probed.rosters[faction] = await readRoster();
  }
  return probed.rosters[faction];
}
