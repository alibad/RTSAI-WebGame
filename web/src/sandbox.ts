// Battle simulator: pick any map, place units and buildings for two sides, run the exact engine simulation with you
// commanding side A against an AI of the chosen skill, read the results, scrub the replay. Editing happens in a paused
// world (real actors, real art); every run is rebuilt from the placements as a scenario, so it is reproducible and can
// be verified against the native engine.

import type { Game } from "./game";
import type { Snapshot } from "./sim/protocol";
import { store } from "./store";
import { ENGINE_SIDE_COLORS } from "./sides";

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
}

export interface SideSettings { order: SandboxOrder; destination: { u: number; v: number } | null; level: number }

/** A placeable actor (Ui.UnitCatalog): `combat` is the engine's answer to "can it fight?" (it attacks with a weapon). */
export interface SimUnit { name: string; label: string; queue: string; kind: string; cost: number; modern: boolean; combat?: boolean; footprint?: [number, number] }

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
  playing: boolean; // replay playback
  speed: number;
  paused: boolean;
  pickDestination: 0 | 1 | null;
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

export class Sandbox {
  recording: Snapshot[] = [];
  private lastRunScenario = "";
  private placementsAtRun: Placement[] = [];
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
        recordLen: 0, replay: null, playing: false, speed: 1, paused: false, pickDestination: null,
      },
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
        ...(run ? { startingcash: String(st.money) } : {}),
      },
      placements: placements.map((p) => {
        if (!run) return { ...p, order: undefined, destination: undefined };
        // The AI's veteran bonus at the higher skills.
        return p.side === 1 && ai.level > (p.level ?? 0) ? { ...p, level: ai.level } : p;
      }),
    });
  }

  /** The editing world: paused, the current placements as real actors. */
  async edit(placements: Placement[] = this.urlPlacements) {
    this.stopPlayback();
    this.recording = [];
    this.patch({ mode: "edit", recordLen: 0, replay: null, paused: true });
    this.game.start(this.scenario(placements, false), true);
    await this.waitPlaying();
    this.frame(placements);
    if (!this.state.units.length) {
      const c = await this.game.catalog();
      this.patch({ units: c.units, rosters: c.rosters });
      this.game.requestIcons(c.units.map((x) => x.name));
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
  async collect(): Promise<Placement[]> {
    const r = await this.game.command<{ spawns: { type: string; player: number; x: number; y: number; facing: number; level: number; health: number }[] }>({ cmd: "placements" });
    const st = this.state;
    return (r.spawns ?? []).map((s) => {
      const side = s.player as 0 | 1;
      const fromUrl = this.urlPlacements.find((p) => p.id === s.type && p.side === side && p.u === s.x && p.v === s.y);
      const settings = st.sides[side];
      const order = fromUrl?.order ?? settings.order;
      const destination = fromUrl?.destination ?? settings.destination ?? undefined;
      return {
        id: s.type, side, u: s.x, v: s.y, facing: s.facing, level: s.level, health: s.health,
        order: order === "move" && !destination ? "hold" : order, destination, deploy: fromUrl?.deploy,
      };
    });
  }

  async run() {
    const placements = this.state.mode === "edit" ? await this.collect() : this.placementsAtRun;
    if (!placements.length) return;
    this.placementsAtRun = placements;
    this.stopPlayback();
    this.recording = [];
    this.lastRunScenario = this.scenario(placements, true);
    this.patch({ mode: "run", recordLen: 0, replay: null, paused: false, brush: null, pickDestination: null });
    this.game.start(this.lastRunScenario);
  }

  /** Back to editing with the placements of the last run. */
  backToEdit() {
    this.urlPlacements = this.placementsAtRun;
    this.edit(this.placementsAtRun);
  }

  get scenarioJson() { return this.lastRunScenario; }

  record(s: Snapshot) {
    if (this.state.mode !== "run") return;
    this.recording.push(s);
    if (this.recording.length > MAX_RECORDING) this.recording.shift();
    if (this.recording.length % 5 === 0 || this.recording.length < 5) this.patch({ recordLen: this.recording.length });
  }

  async spawn(type: string, wx: number, wy: number, side: 0 | 1 = this.state.side) {
    const st = this.state;
    await this.game.command({ cmd: "spawn", type, player: side, x: Math.round(wx), y: Math.round(wy), count: st.count, level: st.sides[side].level });
    this.game.client.send({ type: "refresh" });
  }

  /** The map cell (MPos) under a world pixel, from the engine (terrain height included). */
  cellAt(wx: number, wy: number) {
    return this.game.command<{ u: number; v: number }>({ cmd: "cellat", x: Math.round(wx), y: Math.round(wy) });
  }

  async remove(id: number) {
    await this.game.command({ cmd: "remove", id });
    this.game.client.send({ type: "refresh" });
  }

  async clearSide(side: 0 | 1 | -1) {
    const r = await this.game.command<{ spawns: { id: number; player: number }[] }>({ cmd: "placements" });
    for (const s of r.spawns ?? []) if (side < 0 || s.player === side) await this.game.command({ cmd: "remove", id: s.id });
    this.game.client.send({ type: "refresh" });
  }

  setFaction(side: 0 | 1, faction: string) {
    this.patch(side === 0 ? { fa: faction } : { fb: faction });
    this.collect().then((p) => this.edit(p));
  }

  /** Another battlefield: the placements belong to the old map's cells, so the new one starts empty. */
  setMap(map: string) {
    if (map === this.state.map) return;
    this.patch({ map });
    this.urlPlacements = [];
    this.game.prepare(map);
    this.edit([]);
  }

  setSkill(skill: AiSkill) { this.patch({ skill }); }
  /** Settings before the first world starts (a mission's map, nations and money). */
  configure(p: Partial<Pick<SandboxState, "map" | "fa" | "fb" | "money" | "skill">>) { this.patch(p); }
  setMoney(money: number) { this.patch({ money }); }
  setFog(fog: boolean) { this.patch({ fog }); }

  /** Replaces everything placed with a plan (the "describe it" planner, an Earth mission), then shows it. */
  async plan(fa: string, fb: string, placements: Placement[]) {
    this.patch({ fa, fb });
    this.urlPlacements = placements;
    await this.edit(placements);
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

  /** Shows a recorded tick (the live simulation pauses while scrubbing). */
  scrub(index: number) {
    if (!this.recording.length) return;
    const i = Math.max(0, Math.min(this.recording.length - 1, index));
    if (this.state.replay === null) {
      this.game.client.send({ type: "pause", paused: true });
      this.patch({ paused: true });
    }
    this.patch({ replay: i });
    this.game.renderer.runModels(this.recording[i]);
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
      this.scrub(st.replay + 1);
    }, 40 / this.state.speed);
  }

  stopPlayback() {
    if (this.playTimer) clearInterval(this.playTimer);
    this.playTimer = null;
    if (store.get().sandbox?.playing) this.patch({ playing: false });
  }

  goLive() {
    this.stopPlayback();
    this.patch({ replay: null, paused: false });
    store.set({ paused: false });
    this.game.client.send({ type: "pause", paused: false });
  }

  /** The recorded snapshot to draw instead of the live one (null: live). */
  replayFrame(): [Snapshot, Snapshot | null] | null {
    const i = this.state.replay;
    if (i === null || !this.recording[i]) return null;
    return [this.recording[i], this.recording[i - 1] ?? null];
  }
}
