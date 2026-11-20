// Battle simulator: pick any map, place units and buildings for two sides, run the exact engine simulation with you
// commanding side A against an AI of the chosen skill, read the results, scrub the replay. Editing happens in a paused
// world (real actors, real art); every run is rebuilt from the placements as a scenario, so it is reproducible and can
// be verified against the native engine.

import type { Game } from "./game";
import type { Actor, SandboxStats, Snapshot } from "./sim/protocol";
import { store, useStore, type Store } from "./store";
import { uiTone } from "./ui/feel";
import { ENGINE_SIDE_COLORS } from "./sides";
import type { Operation } from "./mission";
import { setupLink, type BattleSetup } from "./battle-setups";

export const ARENA = "web-arena";
const MAX_RECORDING = 25 * 60 * 8; // 8 minutes of ticks

export type SandboxOrder = "engage" | "hold" | "move";
export type AiSkill = "easy" | "normal" | "hard" | "brutal";

/**
 * The enemy's skill: the engine's own bot (its play style), the mod's handicap multipliers (firepower, armour and
 * production) and extra credits. Nothing here is scripted: the bot plays its normal game from what it is given.
 */
export const AI_SKILLS: Record<AiSkill, { label: string; hint: string; bot: string; handicap: number; cash: number; level: number }> = {
  easy: { label: "Easy", hint: "Steady AI with a handicap: weaker weapons and armour, slower building", bot: "normal", handicap: 50, cash: 0, level: 0 },
  normal: { label: "Normal", hint: "The standard AI on equal terms", bot: "normal", handicap: 0, cash: 0, level: 0 },
  hard: { label: "Hard", hint: "Aggressive AI with 5,000 extra credits", bot: "rush", handicap: 0, cash: 5000, level: 0 },
  brutal: { label: "Brutal", hint: "Aggressive AI with 15,000 extra credits and veteran units", bot: "rush", handicap: 0, cash: 15000, level: 1 },
};

export interface Placement {
  id: string; // actor type
  /** A name an operation's objectives refer to (sim SpawnSpec.Name). */
  name?: string;
  side: 0 | 1;
  u: number;
  v: number;
  level?: number;
  health?: number;
  order?: SandboxOrder;
  destination?: { u: number; v: number };
  facing?: number;
  deploy?: boolean;
}

export interface SandboxConfig {
  fa: string;
  fb: string;
  level: number;
  health: number;
  order?: SandboxOrder;
  autorun: boolean;
  placements: Placement[];
  map?: string;
  skill?: AiSkill;
  money?: number;
  fog?: boolean;
  /** The generator request (JSON) of a random map: made again when this browser doesn't have the map (a copied link). */
  gen?: string;
}

export interface SideSettings { order: SandboxOrder; destination: { u: number; v: number } | null; level: number }
/** One unit's own opening order (it outranks its side's). */
export interface UnitOrder { order: SandboxOrder; destination?: { u: number; v: number } }
/** A unit on the field, for its card's what-ifs. */
export interface PlacedUnit { id: number; type: string; side: 0 | 1; u: number; v: number; level: number; health: number; own: UnitOrder | null }
const unitKey = (type: string, side: number, u: number, v: number) => `${type}|${side}|${u}|${v}`;

/** A placeable actor (Ui.UnitCatalog): `combat` is the engine's answer to "can it fight?" (it attacks with a weapon). */
export interface SimUnit {
  name: string; label: string; queue: string; kind: string; cost: number; modern: boolean; combat?: boolean; footprint?: [number, number];
  /** Combat stats from the rules (Ui.AppendCombat), for balancing armies (strength.ts). */
  hp?: number; armor?: string; targets?: string[];
  weapons?: { dps: Record<string, number>; valid: string[]; invalid: string[] }[];
}

export interface SandboxState {
  mode: "edit" | "run";
  side: 0 | 1;
  brush: string | null; // actor type placed by clicking the battlefield
  count: number;
  sides: [SideSettings, SideSettings];
  fa: string;
  fb: string;
  units: SimUnit[];
  rosters: Record<string, string[]>;
  map: string;
  skill: AiSkill;
  money: number;
  fog: boolean;
  recordLen: number;
  replay: number | null; // index into the recording while scrubbing, null when live
  /** The battle's readout (score, board) at the replay's moment; null when live. */
  replayStats: SandboxStats | null;
  playing: boolean; // replay playback
  speed: number;
  paused: boolean;
  pickDestination: 0 | 1 | null;
  /** A mission from a real place (mission.ts): its objectives, briefing and radio run with the battle. */
  operation: Operation | null;
  /** The last click with the brush: where (world px), how many it placed, or why it placed nothing. */
  placed: { x: number; y: number; created: number; blocked: string; at: number } | null;
  /** The setup's undo and redo (ui/Simulator.tsx, Ctrl+Z and Ctrl+Y): whether there is a step to take. */
  canUndo: boolean;
  canRedo: boolean;
  /** One line the setup has to tell (units that found no room after the map changed), until the next change. */
  notice: string | null;
  /** Units with an opening order of their own, by where they stand ("type|side|u|v"). */
  unitOrders: Record<string, UnitOrder>;
  /** The unit (actor id) whose own destination the next click on the battlefield sets. */
  pickUnit: number | null;
}

function b64urlDecode(s: string) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0)));
}

/** ?mode=sandbox&s=<base64url JSON> or the shorthand &a=type:count,...&b=...&fa=&fb=&level=&order=&autorun=1&map=&skill=. */
export function parseSandboxUrl(params: URLSearchParams): SandboxConfig {
  const cfg: SandboxConfig = { fa: "saudi", fb: "iran", level: 0, health: 100, autorun: false, placements: [] };
  const s = params.get("s");
  if (s) {
    try {
      const j = JSON.parse(b64urlDecode(s));
      Object.assign(cfg, {
        fa: j.fa ?? cfg.fa, fb: j.fb ?? cfg.fb, level: j.level ?? 0, health: j.health ?? 100,
        order: j.order, autorun: !!j.autorun, map: j.map, skill: j.skill, money: j.money, fog: j.fog,
        gen: j.gen && typeof j.gen === "object" ? JSON.stringify(j.gen) : undefined,
        placements: (j.placements ?? []).map((p: Placement & { type?: string; player?: number }) => {
          const side = (p.side ?? p.player ?? 0) as 0 | 1;
          return { ...p, id: p.id ?? p.type, side, facing: p.facing ?? (side === 0 ? 768 : 256) };
        }),
      });
    } catch (e) {
      console.warn("bad sandbox state", e);
    }
  }
  cfg.fa = params.get("fa") ?? cfg.fa;
  cfg.fb = params.get("fb") ?? cfg.fb;
  cfg.map = params.get("map") ?? cfg.map;
  if (params.get("skill") && params.get("skill")! in AI_SKILLS) cfg.skill = params.get("skill") as AiSkill;
  if (params.get("level")) cfg.level = Number(params.get("level"));
  if (params.get("order")) cfg.order = params.get("order") as SandboxOrder;
  if (params.get("autorun")) cfg.autorun = params.get("autorun") === "1" || params.get("autorun") === "true";
  // Shorthand on the flat arena: blocks laid out in each side's deploy zone (A west, B east), facing each other.
  for (const [key, side] of [["a", 0], ["b", 1]] as const) {
    const list = params.get(key);
    if (!list) continue;
    let row = 0;
    for (const item of list.split(",")) {
      const [id, n] = item.split(":");
      const count = Math.max(1, Math.min(50, Number(n ?? 1)));
      const cols = Math.ceil(Math.sqrt(count));
      for (let i = 0; i < count; i++) {
        const u = side === 0 ? 48 - (i % cols) * 2 - row : 80 + (i % cols) * 2 + row;
        const v = 64 + Math.floor(i / cols) * 2 + row * 4;
        cfg.placements.push({ id, side, u, v, facing: side === 0 ? 768 : 256 });
      }
      row++;
    }
  }
  return cfg;
}

/** The battle's readout for the moment on screen: the replay's while scrubbing, else the live game's. */
export const battleStats = (s: Store): SandboxStats | null => (s.sandbox?.replay != null ? s.sandbox.replayStats : s.ui?.sandbox ?? null);

/**
 * The replay. Every tick of a battle is kept as the engine's snapshot of the WHOLE battlefield (game.ts sendView asks
 * for it while a battle runs: a snapshot otherwise holds only what the camera saw), one per tick: a snapshot of a tick
 * already kept (the pause, a camera move while stopped) replaces it rather than lengthening the battle. Beside each
 * tick, the readout (score, money) the HUD had then.
 */
export class Sandbox {
  recording: Snapshot[] = [];
  private readouts: { tick: number; stats: SandboxStats | null; cash: number }[] = [];
  /** The battle's first snapshot: which unit came from which placement (playFromHere keeps their orders and names). */
  private firstFrame: Snapshot | null = null;
  private lastRunScenario = "";
  private placementsAtRun: Placement[] = [];
  private bareAtRun: Placement[] = [];
  private urlPlacements: Placement[];
  private playTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private game: Game, private cfg: SandboxConfig) {
    this.urlPlacements = cfg.placements;
    store.set({
      sandbox: {
        mode: "edit", side: 0, brush: null, count: 1,
        sides: [
          { order: cfg.order ?? "engage", destination: null, level: cfg.level },
          { order: cfg.order ?? "engage", destination: null, level: cfg.level },
        ],
        fa: cfg.fa, fb: cfg.fb, units: [], rosters: {}, map: cfg.map ?? ARENA, skill: cfg.skill ?? "normal", money: cfg.money ?? 0, fog: cfg.fog ?? false,
        recordLen: 0, replay: null, replayStats: null, playing: false, speed: 1, paused: false, pickDestination: null, operation: null, placed: null,
        canUndo: false, canRedo: false, notice: null, unitOrders: {}, pickUnit: null,
      },
    });
    // The readout of every tick of a battle (it comes beside the snapshots, as the HUD's state): the replay shows the
    // score of the moment it shows.
    useStore.subscribe((s, prev) => {
      if (this.game.sandbox !== this || s.ui === prev.ui || !s.ui || s.sandbox?.mode !== "run") return;
      const last = this.readouts.at(-1);
      const entry = { tick: s.ui.tick, stats: s.ui.sandbox ?? null, cash: s.ui.cash ?? 0 };
      if (last && last.tick >= entry.tick) { if (last.tick === entry.tick) this.readouts[this.readouts.length - 1] = entry; return; }
      this.readouts.push(entry);
      if (this.readouts.length > MAX_RECORDING + 50) this.readouts.shift();
    });
    // The engine draws the armed brush at the cursor (sim SandboxPlacement): a building's green and red footprint and
    // its picture, units on their cells. Sent again whenever the brush, the side, the count or the editing world changes.
    let sent = "", world: unknown = null;
    useStore.subscribe((s) => {
      if (this.game.sandbox !== this) return;
      const st = s.sandbox;
      const key = st && st.mode === "edit" && s.phase === "playing" ? `${st.brush ?? ""}|${st.side}|${st.count}` : "";
      if (key === sent && s.info === world) return;
      sent = key;
      world = s.info;
      if (key) void this.game.command({ cmd: "brush", type: st!.brush, player: st!.side, count: st!.count }).then(() => this.game.client.send({ type: "refresh" }));
    });
  }

  private patch(p: Partial<SandboxState>) {
    const s = store.get().sandbox!;
    store.set({ sandbox: { ...s, ...p } });
  }

  get state() { return store.get().sandbox!; }

  /** The map's first two player slots (the arena and generated maps call them Multi0 and Multi1). */
  private slots(): [string, string] {
    const map = store.get().setup?.maps.find((m) => m.id === this.state.map);
    return [map?.slots[0] ?? "Multi0", map?.slots[1] ?? "Multi1"];
  }

  private scenario(placements: Placement[], run: boolean) {
    const st = this.state;
    const ai = AI_SKILLS[st.skill];
    const [slotA, slotB] = this.slots();
    return JSON.stringify({
      map: st.map,
      seed: 1 + Math.floor(Math.random() * 1e9),
      sandbox: run,
      // Only the placed forces: the map's start positions get no construction vehicle.
      bare: true,
      // Editing: both sides are idle bots and the page spectates (sees everything, no shroud). Running: side A is
      // the player's to command; side B is the engine's bot at the chosen skill.
      players: [
        { slot: slotA, faction: st.fa, color: ENGINE_SIDE_COLORS[0], ...(run ? {} : { bot: "webidle" }) },
        { slot: slotB, faction: st.fb, color: ENGINE_SIDE_COLORS[1], ...(run ? { bot: ai.bot, handicap: ai.handicap, cash: ai.cash } : { bot: "webidle" }) },
      ],
      options: {
        explored: run && st.fog ? "False" : "True", fog: run && st.fog ? "True" : "False", crates: "False", shortgame: "False",
        ...(run ? { startingcash: String(st.money), difficulty: st.skill === "easy" ? "easy" : st.skill === "normal" ? "normal" : "hard" } : {}),
      },
      // An operation runs its objectives against the AI's side (the enemy player is that slot).
      ...(run && st.operation ? { operation: { id: st.operation.id, title: st.operation.title, enemy: slotB, objectives: st.operation.objectives, victory: st.operation.victory, defeat: st.operation.defeat, waveFrom: st.operation.waveFrom, waveUnits: st.operation.waveUnits } } : {}),
      placements: placements.map((p) => {
        if (!run) return { ...p, order: undefined, destination: undefined };
        // The AI's veteran bonus at the higher skills.
        return p.side === 1 && ai.level > (p.level ?? 0) ? { ...p, level: ai.level } : p;
      }),
    });
  }

  /** The editing world: paused, the current placements as real actors. */
  async edit(placements: Placement[] = this.urlPlacements) {
    // These placements' names and orders are what collect() keeps (a mission's set after the simulator was made).
    this.urlPlacements = placements;
    this.stopPlayback();
    this.forgetRecording();
    this.patch({ mode: "edit", recordLen: 0, replay: null, replayStats: null, paused: true });
    // A new world: actor ids start again, so the card (ui/Inspector.tsx) lets go of the old one.
    store.set({ inspect: null });
    this.game.start(this.scenario(placements, false), true);
    await this.waitPlaying();
    this.frame(placements);
    if (!this.state.units.length) {
      const c = await this.game.catalog();
      this.patch({ units: c.units, rosters: c.rosters });
    }
    if (this.cfg.autorun) {
      this.cfg.autorun = false;
      this.run();
    }
  }

  /** Camera on the placements, zoomed out enough to show both sides (the map's start when nothing is placed). */
  private frame(placements: Placement[]) {
    const info = store.get().info;
    if (!info) return;
    if (!placements.length) { this.game.cam.zoom = 0.75; return; }
    const [ox, oy] = info.cellOrigin;
    const hw = info.tileSize[0] / 2, hh = info.tileSize[1] / 2;
    const pts = placements.map((p) => [ox + (2 * p.u + (p.v & 1)) * hw, oy + p.v * hh]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const canvas = this.game.canvas;
    const zoom = Math.max(0.35, Math.min(1.5, Math.min(canvas.clientWidth / (x1 - x0 + 500), canvas.clientHeight / (y1 - y0 + 400))));
    this.game.cam.zoom = zoom;
    this.game.lookAt((x0 + x1) / 2, (y0 + y1) / 2);
  }

  private waitPlaying() {
    return new Promise<void>((resolve) => {
      const check = () => (store.get().phase === "playing" && this.game.client.cur ? resolve() : setTimeout(check, 60));
      check();
    });
  }

  /** Placements now in the editing world, with each side's order, destination and the URL's per-unit settings. */
  async collect(bare = false): Promise<Placement[]> {
    const r = await this.game.command<{ spawns: { type: string; player: number; x: number; y: number; facing: number; level: number; health: number }[] }>({ cmd: "placements" });
    const st = this.state;
    return (r.spawns ?? []).map((s) => {
      const side = s.player as 0 | 1;
      // The engine reports a building by its top-left cell, a few cells from where it was asked for (centred).
      const near = (p: Placement) => Math.abs(p.u - s.x) + Math.abs(p.v - s.y);
      const fromUrl = this.urlPlacements.filter((p) => p.id === s.type && p.side === side && near(p) <= 4).sort((a, b) => near(a) - near(b))[0];
      const settings = st.sides[side];
      // The unit's own order (set on its card, or carried by a link or a saved battle) outranks its side's. `bare`
      // leaves the side's order out, so a kept setup still follows the side's order when that is changed later.
      const mine = st.unitOrders[unitKey(s.type, side, s.x, s.y)];
      const own = mine?.order ?? fromUrl?.order;
      const order = own ?? (bare ? undefined : settings.order);
      const destination = (mine ? mine.destination : fromUrl?.destination) ?? (bare && !own ? undefined : settings.destination ?? undefined);
      return {
        id: s.type, ...(fromUrl?.name ? { name: fromUrl.name } : {}), side, u: s.x, v: s.y, facing: s.facing, level: s.level, health: s.health,
        ...(order ? { order: order === "move" && !destination ? "hold" as const : order } : {}), destination, deploy: fromUrl?.deploy,
      };
    });
  }

  async run() {
    const editing = this.state.mode === "edit";
    const placements = editing ? await this.collect() : this.placementsAtRun;
    if (!placements.length) return;
    // Without the sides' orders too: what Edit goes back to, so the side's order can still be changed there.
    if (editing) this.bareAtRun = await this.collect(true);
    this.placementsAtRun = placements;
    this.stopPlayback();
    this.forgetRecording();
    this.lastRunScenario = this.scenario(placements, true);
    const op = this.state.operation;
    this.game.radio.setOperation(op ? op.id : null, op?.radio ?? []);
    this.patch({ mode: "run", recordLen: 0, replay: null, replayStats: null, paused: false, brush: null, pickDestination: null });
    store.set({ inspect: null });
    this.game.start(this.lastRunScenario);
  }

  /** Back to editing with the placements of the last run. */
  backToEdit() {
    const placements = this.bareAtRun.length ? this.bareAtRun : this.placementsAtRun;
    this.urlPlacements = placements;
    this.edit(placements);
  }

  get scenarioJson() { return this.lastRunScenario; }

  private forgetRecording() {
    this.recording = [];
    this.readouts = [];
    this.firstFrame = null;
  }

  /**
   * While a battle runs the engine draws the whole battlefield into every snapshot (game.ts sendView), so the replay
   * can show any moment anywhere: what the camera saw then is not what the field held. Null: the camera's view.
   */
  fieldView(bounds: [number, number, number, number]): number[] | null {
    if (this.state.mode !== "run") return null;
    const m = 512;
    return [bounds[0] - m, bounds[1] - m, bounds[2] + m, bounds[3] + 2 * m];
  }

  record(s: Snapshot) {
    if (this.state.mode !== "run") return;
    const last = this.recording.at(-1);
    // One snapshot per tick: the snapshot of a stopped game (the pause, a camera move, a step back to the same tick)
    // stands in for the tick it shows instead of adding time to the battle.
    if (last && s.header.tick <= last.header.tick) {
      if (s.header.tick === last.header.tick) this.recording[this.recording.length - 1] = s;
      return;
    }
    this.firstFrame ??= s;
    this.recording.push(s);
    if (this.recording.length > MAX_RECORDING) this.recording.shift();
    if (this.recording.length % 5 === 0 || this.recording.length < 5) this.patch({ recordLen: this.recording.length });
  }

  /** The game tick of a recorded moment (the timeline's clock: 25 ticks a second). */
  tickAt(index: number) { return this.recording[Math.max(0, Math.min(this.recording.length - 1, index))]?.header.tick ?? 0; }

  /** The readout (score, money) the HUD had at a tick: the last one at or before it. */
  private readoutAt(tick: number) {
    const r = this.readouts;
    let lo = 0, hi = r.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (r[mid].tick <= tick) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    return found >= 0 ? r[found] : r[0] ?? null;
  }

  /** Places the brush at a world pixel. It answers with a sound and a mark where it landed, or why it couldn't. */
  async spawn(type: string, wx: number, wy: number, side: 0 | 1 = this.state.side) {
    const st = this.state;
    await this.checkpoint();
    const r = await this.game.command<{ created?: number; blocked?: string; x?: number; y?: number }>({ cmd: "spawn", type, player: side, x: Math.round(wx), y: Math.round(wy), count: st.count, level: st.sides[side].level });
    const created = r.created ?? 0;
    if (!created) this.forget();
    this.patch({ placed: { x: r.x ?? wx, y: r.y ?? wy, created, blocked: created ? "" : r.blocked ?? "Can't place it here", at: performance.now() } });
    uiTone(created ? "place" : "deny");
    this.game.client.send({ type: "refresh" });
  }

  /** Disarms the brush (right-click on open ground, Escape). */
  disarm() { if (this.state.brush) this.patch({ brush: null }); }

  private pictures = new Map<string, Promise<string>>();
  /**
   * An actor as the battlefield draws it, composed from its sprites (sim "preview"): the card's picture for buildings,
   * whose art is sprites rather than a 3D model. "" when it has none (voxel units).
   */
  picture(type: string, side: 0 | 1): Promise<string> {
    const key = `${type}|${side}|${side === 0 ? this.state.fa : this.state.fb}`;
    let p = this.pictures.get(key);
    if (!p) {
      p = this.game.command<Parameters<Game["renderer"]["renderTiles"]>[0]>({ cmd: "preview", type, player: side }).then((parts) => new Promise<string>((resolve) => {
        if (!Array.isArray(parts) || !parts.length) return resolve("");
        // Sheets may still be on their way to the GPU: try again shortly.
        let tries = 0;
        const draw = () => { const url = this.game.renderer.renderTiles(parts, true); if (url !== null || ++tries > 40) resolve(url ?? ""); else setTimeout(draw, 120); };
        draw();
      }));
      this.pictures.set(key, p);
    }
    return p;
  }

  /** The map cell (MPos) under a world pixel, from the engine (terrain height included). */
  cellAt(wx: number, wy: number) {
    return this.game.command<{ u: number; v: number }>({ cmd: "cellat", x: Math.round(wx), y: Math.round(wy) });
  }

  async remove(id: number) {
    await this.checkpoint();
    await this.game.command({ cmd: "remove", id });
    this.game.client.send({ type: "refresh" });
  }

  async clearSide(side: 0 | 1 | -1) {
    await this.checkpoint();
    const r = await this.game.command<{ spawns: { id: number; player: number }[] }>({ cmd: "placements" });
    for (const s of r.spawns ?? []) if (side < 0 || s.player === side) await this.game.command({ cmd: "remove", id: s.id });
    this.game.client.send({ type: "refresh" });
  }

  setFaction(side: 0 | 1, faction: string) {
    this.clearHistory();
    this.patch({ ...(side === 0 ? { fa: faction } : { fb: faction }), brush: null, pickDestination: null });
    this.collect().then((p) => this.edit(p));
  }

  /** Another battlefield: the placements belong to the old map's cells, so the new one starts empty. */
  setMap(map: string) {
    if (map === this.state.map) return;
    this.clearHistory();
    this.patch({ map, operation: null, unitOrders: {} });
    this.urlPlacements = [];
    this.game.prepare(map);
    this.edit([]);
  }

  setSkill(skill: AiSkill) { this.patch({ skill }); }
  /** Settings before the first world starts (a mission's map, nations and money). */
  configure(p: Partial<Pick<SandboxState, "map" | "fa" | "fb" | "money" | "skill" | "operation">>) { this.patch(p); }
  /** Back to a free battle: the operation's objectives, briefing and radio are dropped. */
  dropOperation() { this.patch({ operation: null }); }
  setMoney(money: number) { this.patch({ money }); }
  setFog(fog: boolean) { this.patch({ fog }); }

  /** Replaces everything placed with a plan (the "describe it" planner, an Earth mission), then shows it. */
  async plan(fa: string, fb: string, placements: Placement[]) {
    if (fa === this.state.fa && fb === this.state.fb) await this.checkpoint(); else this.clearHistory();
    this.patch({ fa, fb, operation: null });
    this.urlPlacements = placements;
    await this.edit(placements);
  }

  // ---------------------------------------------------------------- undo and redo (the setup only)

  private past: Placement[][] = [];
  private future: Placement[][] = [];
  private stepping = false;

  /** What is on the field now, kept before a change so the change can be taken back. */
  private async checkpoint() {
    if (this.state.mode !== "edit" || store.get().phase !== "playing") return;
    this.past.push(await this.collect(true));
    if (this.past.length > 80) this.past.shift();
    this.future = [];
    this.patch({ canUndo: true, canRedo: false, notice: null });
  }

  /** The last checkpoint's change came to nothing (a refused placement). */
  private forget() {
    this.past.pop();
    this.patch({ canUndo: this.past.length > 0 });
  }

  private clearHistory() {
    this.past = []; this.future = [];
    if (store.get().sandbox) this.patch({ canUndo: false, canRedo: false, notice: null, pickUnit: null });
  }

  async undo() { await this.rewind(this.past, this.future); }
  async redo() { await this.rewind(this.future, this.past); }

  private async rewind(from: Placement[][], to: Placement[][]) {
    if (this.stepping || this.state.mode !== "edit" || store.get().phase !== "playing" || !from.length) return;
    this.stepping = true;
    try {
      to.push(await this.collect(true));
      await this.apply(from.pop()!);
      this.patch({ canUndo: this.past.length > 0, canRedo: this.future.length > 0, placed: null, notice: null });
      uiTone("place");
    } finally { this.stepping = false; }
  }

  /**
   * Brings the field to `target`. Units are taken out and put back in place (no new world, so it is instant); when a
   * building has to come back, the editing world is rebuilt from the placements instead (a building is reported by
   * its corner, and only a scenario placement puts it back exactly there).
   */
  private async apply(target: Placement[]) {
    const r = await this.game.command<{ spawns: { id: number; type: string; player: number; x: number; y: number; level: number; health: number }[] }>({ cmd: "placements" });
    const key = (type: string, side: number, u: number, v: number, level?: number, health?: number) => `${type}|${side}|${u}|${v}|${level ?? 0}|${health ?? 100}`;
    const want = new Map<string, Placement[]>();
    for (const p of target) { const k = key(p.id, p.side, p.u, p.v, p.level, p.health); want.set(k, [...(want.get(k) ?? []), p]); }
    const extra: number[] = [];
    for (const s of r.spawns ?? []) { const left = want.get(key(s.type, s.player, s.x, s.y, s.level, s.health)); if (left?.length) left.pop(); else extra.push(s.id); }
    const missing = [...want.values()].flat();
    const fixed = (id: string) => { const u = this.state.units.find((x) => x.name === id); return !u || u.kind === "building" || u.kind === "defense" || !!u.footprint; };
    this.urlPlacements = target;
    if (missing.some((p) => fixed(p.id))) { await this.edit(target); return; }
    for (const id of extra) await this.game.command({ cmd: "remove", id });
    for (const p of missing) await this.game.command({ cmd: "spawn", type: p.id, player: p.side, u: p.u, v: p.v, count: 1, level: p.level ?? 0, health: p.health ?? 100 });
    this.game.client.send({ type: "refresh" });
  }

  // ---------------------------------------------------------------- one unit's what-ifs (ui/UnitWhatIfs.tsx)

  /** A placed unit as the editing world has it: where it stands, its rank and health, and its own order if it has one. */
  async unit(id: number): Promise<PlacedUnit | null> {
    const r = await this.game.command<{ spawns: { id: number; type: string; player: number; x: number; y: number; level: number; health: number }[] }>({ cmd: "placements" });
    const s = (r.spawns ?? []).find((x) => x.id === id);
    if (!s) return null;
    const side = s.player as 0 | 1;
    return { id, type: s.type, side, u: s.x, v: s.y, level: s.level, health: s.health, own: this.state.unitOrders[unitKey(s.type, side, s.x, s.y)] ?? null };
  }

  /**
   * Another rank, health or team for one unit. The unit is taken out and put back where it stood with the new values
   * (a building through a rebuilt world, which is the only way back onto its exact cells). Answers its new id.
   */
  async changeUnit(id: number, change: { level?: number; health?: number; side?: 0 | 1 }): Promise<number | null> {
    const u = await this.unit(id);
    if (!u || this.state.mode !== "edit") return null;
    await this.checkpoint();
    const side = change.side ?? u.side, level = change.level ?? u.level, health = Math.max(1, Math.min(100, Math.round(change.health ?? u.health)));
    const info = this.state.units.find((x) => x.name === u.type);
    const fixed = !info || info.kind === "building" || info.kind === "defense" || !!info.footprint;
    if (side !== u.side && u.own) this.setOwn(unitKey(u.type, side, u.u, u.v), u.own, unitKey(u.type, u.side, u.u, u.v));
    if (fixed) {
      const all = await this.collect(true);
      const i = all.findIndex((p) => p.id === u.type && p.side === u.side && p.u === u.u && p.v === u.v);
      if (i < 0) { this.forget(); return null; }
      all[i] = { ...all[i], side, level, health, facing: side === u.side ? all[i].facing : side === 0 ? 768 : 256 };
      this.urlPlacements = all;
      await this.edit(all);
    } else {
      await this.game.command({ cmd: "remove", id });
      await this.game.command({ cmd: "spawn", type: u.type, player: side, u: u.u, v: u.v, count: 1, level, health });
      this.game.client.send({ type: "refresh" });
    }
    return this.find(u.type, side, u.u, u.v);
  }

  /** One more of the same, beside it: same type, team, rank and health. Answers the new one's id. */
  async duplicateUnit(id: number): Promise<number | null> {
    const u = await this.unit(id);
    if (!u || this.state.mode !== "edit") return null;
    const before = new Set((await this.game.command<{ spawns: { id: number }[] }>({ cmd: "placements" })).spawns?.map((s) => s.id));
    await this.checkpoint();
    // The engine puts it on the nearest free cell around the original (a building: where it fits, or nowhere).
    const [x, y] = this.cellPx(u.u, u.v);
    const r = await this.game.command<{ created?: number; blocked?: string }>({ cmd: "spawn", type: u.type, player: u.side, x, y, count: 1, level: u.level, health: u.health });
    if (!r.created) { this.forget(); this.patch({ notice: r.blocked ?? "No room for another one here." }); return null; }
    this.game.client.send({ type: "refresh" });
    const after = (await this.game.command<{ spawns: { id: number }[] }>({ cmd: "placements" })).spawns ?? [];
    return after.find((s) => !before.has(s.id))?.id ?? null;
  }

  /** One unit's own opening order: it outranks its side's. `null`: back to the side's order. */
  async setUnitOrder(id: number, order: SandboxOrder | null, destination?: { u: number; v: number }) {
    const u = await this.unit(id);
    if (!u) return;
    this.setOwn(unitKey(u.type, u.side, u.u, u.v), order ? { order, ...(destination ? { destination } : {}) } : null);
    this.patch({ pickUnit: null });
  }

  /** The next click on the battlefield is where this unit moves when the battle starts. */
  pickUnitDestination(id: number | null) { this.patch({ pickUnit: id, pickDestination: null, brush: null }); }

  private setOwn(key: string, own: UnitOrder | null, drop?: string) {
    const next = { ...this.state.unitOrders };
    if (drop) delete next[drop];
    if (own) next[key] = own; else delete next[key];
    this.patch({ unitOrders: next });
  }

  private async find(type: string, side: number, u: number, v: number) {
    const r = await this.game.command<{ spawns: { id: number; type: string; player: number; x: number; y: number }[] }>({ cmd: "placements" });
    const same = (r.spawns ?? []).filter((s) => s.type === type && s.player === side);
    return (same.find((s) => s.x === u && s.y === v) ?? same.sort((a, b) => Math.abs(a.x - u) + Math.abs(a.y - v) - Math.abs(b.x - u) - Math.abs(b.y - v))[0])?.id ?? null;
  }

  /** The middle of a cell in world px (the page's own arithmetic, as frame() uses). */
  private cellPx(u: number, v: number): [number, number] {
    const info = store.get().info!;
    const [ox, oy] = info.cellOrigin, hw = info.tileSize[0] / 2, hh = info.tileSize[1] / 2;
    return [Math.round(ox + (2 * u + (v & 1)) * hw), Math.round(oy + v * hh)];
  }

  /** A line for the setup's hint bar (cleared by the next change). */
  say(notice: string | null) { this.patch({ notice }); }

  /** The setup as it stands, to keep or to share (battle-setups.ts): the map, both sides' settings and every placed unit. */
  async snapshot(): Promise<Omit<BattleSetup, "id" | "name" | "savedAt">> {
    const st = this.state;
    const placements = st.mode === "edit" ? await this.collect(true) : this.bareAtRun;
    const map = store.get().setup?.maps.find((m) => m.id === st.map);
    return {
      map: st.map, mapTitle: map?.title ?? "Open arena", ...(map?.generated && map.gen ? { gen: map.gen } : {}), ...(map?.library || map?.saved ? { own: true } : {}),
      fa: st.fa, fb: st.fb, skill: st.skill, money: st.money, fog: st.fog, sides: st.sides, placements,
    };
  }

  /**
   * Lays a kept setup out again. Its map first: a random one is made again from its request, one of the player's own
   * must still be in this browser. Answers how many units found no room (the map was edited since).
   */
  async restore(s: Pick<BattleSetup, "map" | "gen" | "fa" | "fb" | "skill" | "money" | "fog" | "sides" | "placements">): Promise<{ missing: number }> {
    let map = s.map;
    if (!store.get().setup?.maps.some((m) => m.id === map)) {
      if (!s.gen) throw Error("This battle's map is no longer in this browser.");
      map = await this.game.generateMap(JSON.parse(s.gen));
    }
    this.clearHistory();
    this.patch({ map, fa: s.fa, fb: s.fb, skill: s.skill, money: s.money, fog: s.fog, sides: s.sides, operation: null, brush: null, pickDestination: null, unitOrders: {} });
    this.game.prepare(map);
    await this.edit(s.placements);
    const placed = (await this.collect()).length;
    return { missing: Math.max(0, s.placements.length - placed) };
  }

  /** The map's start positions in the editing world (MPos and world px). */
  spawnPoints() {
    return this.game.command<{ points: { u: number; v: number; x: number; y: number }[] }>({ cmd: "spawnpoints" }).then((r) => r.points ?? []);
  }

  setPaused(paused: boolean) {
    if (this.state.replay !== null && !paused) { this.goLive(); return; }
    this.game.client.send({ type: "pause", paused });
    this.patch({ paused });
    store.set({ paused });
  }

  step() {
    if (this.state.replay !== null) { this.scrub(Math.min(this.recording.length - 1, this.state.replay + 1)); return; }
    if (!this.state.paused) this.setPaused(true);
    this.game.client.send({ type: "step" });
  }

  setSpeed(speed: number) {
    this.game.client.send({ type: "speed", speed });
    this.patch({ speed });
  }

  /**
   * Shows a recorded tick (the live simulation pauses while scrubbing): the whole field as it was, the score of that
   * moment, and, when none of its units is on screen, the camera on them. Playback steps without moving the camera.
   */
  scrub(index: number, follow = true) {
    if (!this.recording.length) return;
    const i = Math.max(0, Math.min(this.recording.length - 1, index));
    if (this.state.replay === null) {
      // The live battle waits (no "Paused" banner: the replay is what is on screen).
      this.game.client.send({ type: "pause", paused: true });
      this.patch({ paused: true });
    }
    const frame = this.recording[i];
    this.patch({ replay: i, replayStats: this.readoutAt(frame.header.tick)?.stats ?? null });
    this.game.renderer.runModels(frame);
    if (follow) this.cameraOnAction(frame);
  }

  /** Both sides' units of a snapshot that still stand (not the neutral players' actors, not the dying). */
  private fighters(frame: Snapshot): (Actor & { side: 0 | 1 })[] {
    const out: (Actor & { side: 0 | 1 })[] = [];
    for (const a of frame.actors) {
      const p = frame.players[a.owner];
      // Player flags (Snapshot.cs): 4 a playable side, 1 the local player (side A in a battle).
      if (!p || !(p.flags & 4) || a.maxHp <= 0 || a.flags & 16) continue;
      out.push({ ...a, side: p.flags & 1 ? 0 : 1 });
    }
    return out;
  }

  /** Where the camera was put on the action last (null: the player has the camera). */
  private framedAt: [number, number] | null = null;

  /**
   * Moves the camera to a moment's units when none of them is on screen (they walked off, or you looked elsewhere), or,
   * while the camera is still where a seek put it, when most of them are off screen: the camera follows the action as
   * you drag the timeline, until you move it yourself.
   */
  private cameraOnAction(frame: Snapshot) {
    const units = this.fighters(frame).filter((a) => !(a.flags & 8));
    const list = units.length ? units : this.fighters(frame);
    if (!list.length) return;
    const cam = this.game.cam;
    const ours = !!this.framedAt && Math.abs(cam.x - this.framedAt[0]) < 1 && Math.abs(cam.y - this.framedAt[1]) < 1;
    const seen = () => { const [x0, y0, x1, y1] = this.game.viewRect(); return list.filter((a) => a.sx >= x0 && a.sx <= x1 && a.sy >= y0 && a.sy <= y1).length; };
    const n = seen();
    if (n > 0 && (!ours || 2 * n >= list.length)) return;
    const cx = list.reduce((s, a) => s + a.sx, 0) / list.length, cy = list.reduce((s, a) => s + a.sy, 0) / list.length;
    this.game.lookAt(cx, cy);
    if (!seen()) {
      // Two groups far apart: the one nearest their middle.
      const near = list.reduce((b, a) => (Math.hypot(a.sx - cx, a.sy - cy) < Math.hypot(b.sx - cx, b.sy - cy) ? a : b));
      this.game.lookAt(near.sx, near.sy);
    }
    this.framedAt = [cam.x, cam.y];
  }

  /** Plays the recording from the scrub position at the chosen speed, then continues live. */
  playReplay() {
    if (this.state.replay === null) return;
    this.stopPlayback();
    this.patch({ playing: true });
    this.playTimer = setInterval(() => {
      const st = this.state;
      if (st.replay === null) return this.stopPlayback();
      if (st.replay >= this.recording.length - 1) { this.stopPlayback(); this.goLive(); return; }
      this.scrub(st.replay + 1, false);
    }, 40 / this.state.speed);
  }

  stopPlayback() {
    if (this.playTimer) clearInterval(this.playTimer);
    this.playTimer = null;
    if (store.get().sandbox?.playing) this.patch({ playing: false });
  }

  /** Back to the newest moment, the battle still being fought, and on with it (the end of the timeline). */
  goLive() {
    this.stopPlayback();
    this.patch({ replay: null, replayStats: null, paused: false });
    store.set({ paused: false });
    this.game.client.send({ type: "pause", paused: false });
  }

  /**
   * A new battle from the moment on screen (the replay's, or the live game's): every unit of both sides where it stands
   * then, with its facing, health, rank and deployed state, its opening order from the battle's setup (a unit made
   * during the battle takes its side's), and the money you had then. It starts at once; Edit opens its setup, and the
   * address becomes its link (?mode=sandbox&s=). Answers how many units it placed.
   *
   * What a page can't know (it needs the engine to report it, a runtime change): the order a unit was carrying out
   * then, the AI's own money, a passenger inside a transport, and an infantryman's place inside a shared cell (the
   * extras stand on the nearest free cells).
   */
  async playFromHere(): Promise<number> {
    if (this.state.mode !== "run" || !this.recording.length) return 0;
    const index = this.state.replay ?? this.recording.length - 1;
    const frame = this.recording[index];
    this.stopPlayback();
    if (this.state.replay === null) this.setPaused(true);
    const st = this.state;
    const kinds = new Map(st.units.map((u) => [u.name, u]));
    const str = (id: number) => this.game.client.str(id);
    const live = (await this.game.command<{ spawns: { id: number; type: string; player: number; x: number; y: number }[] }>({ cmd: "placements" })).spawns ?? [];
    const liveById = new Map(live.map((s) => [s.id, s]));
    const origin = await this.origins();
    // Buildings first: they keep their exact cells; units find room around them.
    const fighters = this.fighters(frame).filter((a) => kinds.has(str(a.type))).sort((a, b) => (b.flags & 8) - (a.flags & 8));
    // Every unit's own cell is spoken for. A scenario puts one infantryman per cell (no sub-cell: Scenario.cs), so the
    // second of two sharing a cell takes the nearest cell nobody stood on, rather than pushing a neighbour along.
    const cellOf = new Map<number, { u: number; v: number }>();
    for (const a of fighters) if (!(a.flags & 8) && !kinds.get(str(a.type))!.footprint) cellOf.set(a.id, await this.cellAt(a.sx, a.sy));
    const taken = new Set([...cellOf.values()].map((c) => `${c.u},${c.v}`)), first = new Set<string>();
    const free = (u: number, v: number) => {
      if (!first.has(`${u},${v}`)) { first.add(`${u},${v}`); return [u, v] as const; }
      // Rings outwards (isometric rows: v steps by 1, a cell's neighbours above and below are two rows away).
      for (let r = 1; r < 6; r++)
        for (let dv = -2 * r; dv <= 2 * r; dv++)
          for (let du = -r; du <= r; du++) {
            if (Math.max(Math.abs(du), Math.ceil(Math.abs(dv) / 2)) !== r) continue;
            const k = `${u + du},${v + dv}`;
            if (!taken.has(k)) { taken.add(k); first.add(k); return [u + du, v + dv] as const; }
          }
      return [u, v] as const;
    };
    const placements: Placement[] = [];
    for (const a of fighters) {
      const type = str(a.type), info = kinds.get(type)!;
      const from = origin.get(a.id);
      const building = !!(a.flags & 8) || !!info.footprint;
      let u: number, v: number;
      if (building) {
        // A building never moves: where it stands now, or where it was placed (reported by its top-left cell).
        const at = liveById.get(a.id) ?? (from ? { x: from.u, y: from.v } : null);
        if (at) { u = at.x; v = at.y; } else {
          const c = await this.cellAt(a.sx, a.sy);
          const [w, h] = info.footprint ?? [1, 1];
          u = c.u - Math.floor((w - 1) / 2); v = c.v - (h - 1);
        }
      } else {
        const c = cellOf.get(a.id)!;
        [u, v] = free(c.u, c.v);
      }
      // An infantryman's body sequence is empty while it is deployed (its sandbag body is drawn instead: Snapshot.cs).
      const deployed = info.kind === "infantry" && !str(a.sequence);
      placements.push({
        id: type, side: a.side, u, v, facing: a.facing,
        ...(a.rank ? { level: a.rank } : {}),
        ...(a.hp < a.maxHp ? { health: Math.max(1, Math.min(99, Math.round((100 * a.hp) / a.maxHp))) } : {}),
        ...(deployed ? { deploy: true } : {}),
        ...(from?.name ? { name: from.name } : {}),
        ...(from?.order ? { order: from.order, ...(from.destination ? { destination: from.destination } : {}) } : {}),
      });
    }
    if (!placements.length) return 0;
    const money = this.readoutAt(frame.header.tick)?.cash ?? st.money;
    // The setup (Edit) keeps each unit's own order only; the battle gives the rest their side's, as collect() does.
    this.bareAtRun = placements;
    this.placementsAtRun = placements.map((p) => {
      if (p.order) return p;
      const s = st.sides[p.side], order = s.order === "move" && !s.destination ? "hold" as const : s.order;
      return { ...p, order, ...(order === "move" && s.destination ? { destination: s.destination } : {}) };
    });
    this.urlPlacements = placements;
    this.clearHistory();
    this.patch({ money, operation: null, unitOrders: {}, notice: null });
    await this.run();
    try { history.replaceState(history.state, "", setupLink(await this.snapshot())); } catch { /* an address the browser refuses */ }
    return placements.length;
  }

  /**
   * Which placement each unit of the battle came from (by actor id), matched on the first snapshot by type, side and
   * nearest cell: its own order, destination and name carry into a battle played from a later moment.
   */
  private async origins(): Promise<Map<number, Placement>> {
    const out = new Map<number, Placement>();
    const frame = this.firstFrame;
    if (!frame) return out;
    const left = [...this.bareAtRun];
    for (const a of this.fighters(frame)) {
      const type = this.game.client.str(a.type);
      const c = await this.cellAt(a.sx, a.sy);
      let best = -1, dist = 5;
      left.forEach((p, i) => {
        if (p.id !== type || p.side !== a.side) return;
        const d = Math.abs(p.u - c.u) + Math.abs(p.v - c.v);
        if (d < dist) { dist = d; best = i; }
      });
      if (best >= 0) out.set(a.id, left.splice(best, 1)[0]);
    }
    return out;
  }

  /** The recorded snapshot to draw instead of the live one (null: live). */
  replayFrame(): [Snapshot, Snapshot | null] | null {
    const i = this.state.replay;
    if (i === null || !this.recording[i]) return null;
    return [this.recording[i], this.recording[i - 1] ?? null];
  }
}
