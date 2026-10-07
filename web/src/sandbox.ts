// Battle sandbox: place units for two sides on a flat arena, run the exact engine simulation, read the results,
// scrub the replay. Editing happens in a paused world (real actors, real art); every run is rebuilt from the
// placements as a scenario, so it is reproducible and can be verified against the native engine.

import type { Game } from "./game";
import type { Snapshot } from "./sim/protocol";
import { store } from "./store";

export const ARENA = "web-arena";
const MAX_RECORDING = 25 * 60 * 8; // 8 minutes of ticks

export type SandboxOrder = "engage" | "hold" | "move";

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
}

export interface SideSettings { order: SandboxOrder; destination: { u: number; v: number } | null; level: number }

export interface SandboxState {
  mode: "edit" | "run";
  side: 0 | 1;
  brush: string | null; // actor type placed by clicking the battlefield
  count: number;
  sides: [SideSettings, SideSettings];
  fa: string;
  fb: string;
  units: { name: string; label: string; queue: string; modern: boolean }[];
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

/** ?mode=sandbox&s=<base64url JSON> or the shorthand &a=type:count,...&b=...&fa=&fb=&level=&order=&autorun=1. */
export function parseSandboxUrl(params: URLSearchParams): SandboxConfig {
  const cfg: SandboxConfig = { fa: "saudi", fb: "iran", level: 0, health: 100, autorun: false, placements: [] };
  const s = params.get("s");
  if (s) {
    try {
      const j = JSON.parse(b64urlDecode(s));
      Object.assign(cfg, {
        fa: j.fa ?? cfg.fa, fb: j.fb ?? cfg.fb, level: j.level ?? 0, health: j.health ?? 100,
        order: j.order, autorun: !!j.autorun,
        placements: (j.placements ?? []).map((p: Placement & { type?: string; player?: number }) => ({ ...p, id: p.id ?? p.type, side: (p.side ?? p.player ?? 0) as 0 | 1 })),
      });
    } catch (e) {
      console.warn("bad sandbox state", e);
    }
  }
  cfg.fa = params.get("fa") ?? cfg.fa;
  cfg.fb = params.get("fb") ?? cfg.fb;
  if (params.get("level")) cfg.level = Number(params.get("level"));
  if (params.get("order")) cfg.order = params.get("order") as SandboxOrder;
  if (params.get("autorun")) cfg.autorun = params.get("autorun") === "1" || params.get("autorun") === "true";
  // Shorthand: blocks laid out in each side's deploy zone (A west, B east), facing each other.
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
        cfg.placements.push({ id, side, u, v });
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
        fa: cfg.fa, fb: cfg.fb, units: [], recordLen: 0, replay: null, playing: false, speed: 1, paused: false, pickDestination: null,
      },
    });
  }

  private patch(p: Partial<SandboxState>) {
    const s = store.get().sandbox!;
    store.set({ sandbox: { ...s, ...p } });
  }

  get state() { return store.get().sandbox!; }

  private scenario(placements: Placement[], run: boolean) {
    const st = this.state;
    return JSON.stringify({
      map: ARENA,
      seed: 1 + Math.floor(Math.random() * 1e9),
      sandbox: run,
      players: [
        { slot: "Multi0", faction: st.fa, color: "2A6FDB" },
        { slot: "Multi1", faction: st.fb, bot: "webidle", color: "D83A2E" },
      ],
      options: { explored: "True", fog: "False", crates: "False", shortgame: "False" },
      placements: placements.map((p) => (run ? p : { ...p, order: undefined, destination: undefined })),
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
      const r = await this.game.command<{ units: SandboxState["units"] }>({ cmd: "units" });
      this.patch({ units: r.units ?? [] });
      this.game.requestIcons((r.units ?? []).map((u) => u.name));
    }
    if (this.cfg.autorun) {
      this.cfg.autorun = false;
      this.run();
    }
  }

  /** Camera on the placements, zoomed out enough to show both sides. */
  private frame(placements: Placement[]) {
    const info = store.get().info;
    if (!info || !placements.length) return;
    const [ox, oy] = info.cellOrigin;
    const hw = info.tileSize[0] / 2, hh = info.tileSize[1] / 2;
    const pts = placements.map((p) => [ox + (2 * p.u + (p.v & 1)) * hw, oy + p.v * hh]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const canvas = this.game.canvas;
    const zoom = Math.max(0.5, Math.min(1.5, Math.min(canvas.width / (x1 - x0 + 500), canvas.height / (y1 - y0 + 400))));
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
  private async collect(): Promise<Placement[]> {
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

  async spawn(type: string, wx: number, wy: number) {
    const st = this.state;
    await this.game.command({ cmd: "spawn", type, player: st.side, x: Math.round(wx), y: Math.round(wy), count: st.count, level: st.sides[st.side].level });
    this.game.client.send({ type: "refresh" });
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

  setPaused(paused: boolean) {
    if (this.state.replay !== null && !paused) { this.goLive(); return; }
    this.game.client.send({ type: "pause", paused });
    this.patch({ paused });
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
    this.game.client.send({ type: "pause", paused: false });
  }

  /** The recorded snapshot to draw instead of the live one (null: live). */
  replayFrame(): [Snapshot, Snapshot | null] | null {
    const i = this.state.replay;
    if (i === null || !this.recording[i]) return null;
    return [this.recording[i], this.recording[i - 1] ?? null];
  }
}

/** World px -> arena cell (MPos) on the flat isometric arena. */
export function worldToCell(wx: number, wy: number, origin: [number, number], tile: [number, number]) {
  const hw = tile[0] / 2, hh = tile[1] / 2;
  const v = Math.round((wy - origin[1]) / hh);
  const u = Math.round(((wx - origin[0]) / hw - (v & 1)) / 2);
  return { u, v };
}
