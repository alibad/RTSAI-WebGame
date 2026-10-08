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

export interface UnitOption { name: string; label: string; queue: string; modern: boolean }
export interface PracticePlan { title: string; faction: string; enemy: string; unit: string; enemyUnit: string; count: number; enemyCount: number; duration: number; objective: "eliminate" | "survive"; seed: number; enemyOrder: "engage" | "hold" }
export function planFromText(text: string, units: UnitOption[], factions: string[], previous?: PracticePlan): PracticePlan {
  const base: PracticePlan = previous ?? { title: "Combined arms practice", faction: factions.includes("saudi") ? "saudi" : factions[0], enemy: factions.includes("iran") ? "iran" : factions[1] ?? factions[0], unit: units[0]?.name ?? "", enemyUnit: units[0]?.name ?? "", count: 6, enemyCount: 6, duration: 120, objective: "eliminate", seed: 42, enemyOrder: "engage" };
  const t = text.toLowerCase();
  const matching = units.filter(u => t.includes(u.name.toLowerCase()) || t.includes(u.label.toLowerCase()));
  const tank = units.find(u => /tank/i.test(u.label));
  const infantry = units.find(u => /rifle|conscript|infantry/i.test(u.label));
  const picked = matching[0] ?? (/tank/.test(t) ? tank : /infantry/.test(t) ? infantry : undefined);
  const numbers = [...t.matchAll(/\b(\d+)\s+(?:units?|tanks?|infantry|soldiers?)\b/g)].map(m => Number(m[1]));
  const seconds = t.match(/(\d+)\s*(seconds?|minutes?)/);
  const mentioned = factions.filter(f => new RegExp(`\\b${f}\\b`).test(t));
  return { ...base, title: text.trim().slice(0, 100) || base.title, faction: mentioned[0] ?? base.faction, enemy: mentioned[1] ?? base.enemy,
    unit: picked?.name ?? base.unit, enemyUnit: matching[1]?.name ?? base.enemyUnit, count: numbers[0] ?? base.count, enemyCount: numbers[1] ?? base.enemyCount,
    duration: seconds ? Number(seconds[1]) * (/minute/.test(seconds[2]) ? 60 : 1) : base.duration,
    objective: /surviv|hold|defend|preserv/.test(t) ? "survive" : /eliminat|destroy|win|attack/.test(t) ? "eliminate" : base.objective,
    enemyOrder: /stationary|hold position/.test(t) ? "hold" : base.enemyOrder };
}
export function validatePlan(p: PracticePlan, units: UnitOption[], factions: string[]): string[] {
  const errors: string[] = [];
  if (![p.faction, p.enemy].every(f => factions.includes(f))) errors.push("Choose two available factions.");
  if (![p.unit, p.enemyUnit].every(n => units.some(u => u.name === n))) errors.push("Choose units from the engine catalog.");
  if (![p.count, p.enemyCount].every(n => Number.isInteger(n) && n >= 1 && n <= 24)) errors.push("Each force must contain 1–24 units.");
  if (!Number.isInteger(p.duration) || p.duration < 30 || p.duration > 600) errors.push("Duration must be 30–600 seconds.");
  if (!Number.isInteger(p.seed) || p.seed < 0 || p.seed > 2147483647) errors.push("Seed must be a positive 32-bit integer.");
  if (!["eliminate", "survive"].includes(p.objective) || !["engage", "hold"].includes(p.enemyOrder)) errors.push("Choose a supported objective and order.");
  return errors;
}
export function practiceScenario(p: PracticePlan, run: boolean) {
  const placements = [0, 1].flatMap(side => Array.from({ length: side ? p.enemyCount : p.count }, (_, i) => ({ id: side ? p.enemyUnit : p.unit, side, u: (side ? 76 : 48) + i % 4, v: 60 + Math.floor(i / 4) * 2, order: run ? side ? p.enemyOrder : "hold" : "hold" })));
  return { map: "web-arena", seed: p.seed, sandbox: true, ...(run ? { objective: p.objective, duration: p.duration } : {}), players: [{ slot: "Multi0", faction: p.faction, color: "2A6FDB", ...(run ? {} : { bot: "webidle" }) }, { slot: "Multi1", faction: p.enemy, color: "D83A2E", bot: "webidle" }], options: { explored: "True", fog: "False", crates: "False", shortgame: "False" }, placements };
}
