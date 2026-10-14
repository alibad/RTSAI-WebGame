// App state shared by the game controller (writes) and the React HUD (reads through selectors, so a 25 Hz UI
// update only re-renders the components whose slice changed).

import { initialCoCommander, type CoCommanderState } from "./cocommander";
import { create } from "zustand";
import type { CatalogQueue, LazyStats, SetupData, StartInfo, UiState } from "./sim/protocol";
import type { SandboxState } from "./sandbox";

export type Phase = "boot" | "setup" | "loading" | "playing" | "error";

export interface Perf {
  fps: number;
  frameMs: number;
  simTickMs: number;
  engineTickMs: number;
  buildMs: number;
  tps: number;
  lateTicks: number;
  draws: number;
  heapMB: number;
  managedMB: number;
  tick: number;
  syncHash: number;
  latency: number[]; // input -> first frame drawn from the tick that executed the order (ms)
  missed: number;
}

export interface Store {
  phase: Phase;
  stage: string;
  detail: string;
  error: string;
  runtime: string;
  shared: boolean;
  privateContent: boolean;
  /** "" (the RA2 mod with the player's own files) or "public" (the standalone game). */
  profile: string;
  /**
   * Actor type -> display name, for actors the build menu does not list: every actor's from the mod's messages (the
   * worker's ready message, sim/fluent-names.ts), then the engine's unit names over them (Game.loadActorLabels).
   */
  actorLabels: Record<string, string>;
  setup: SetupData | null;
  preparedMap: string | null;
  preparing: string | null;
  /** Why a saved map couldn't be loaded (shown on the setup screens), by engine map id. */
  mapErrors: Record<string, string>;
  previews: Record<string, string>; // map id -> object URL of map.png
  icons: Record<string, string | null>; // actor -> object URL of its cameo (null: none)
  /** "type@owner" -> an actor drawn from its own sprites, for actors without a real cameo (ui/actor-display.ts); "" none. */
  actorPictures: Record<string, string>;
  info: StartInfo | null;
  ui: UiState | null;
  catalog: CatalogQueue[];
  tab: string;
  cursor: string;
  statsOpen: boolean;
  menuOpen: boolean;
  /** The hotkey sheet (?). */
  keysOpen: boolean;
  /** DisableUserInterface (Shift+=): the HUD hidden, the battlefield only. */
  uiHidden: boolean;
  /** Browser strategy adviser, with an optional local model/voice companion on development servers. */
  cc: CoCommanderState;
  ccAvailable: boolean;
  ccLocalAvailable: boolean;
  /** Prebaked sprite sheets of the prepared map on the GPU (the world waits for them). */
  sheets: { uploaded: number; total: number };
  paused: boolean;
  timings: Record<string, number>;
  downloads: Record<string, number>;
  lazy: LazyStats | null;
  startMs: number;
  perf: Perf;
  verify: string;
  sandbox: SandboxState | null;
  /** ?shot=1: project art only (screenshots that may leave this machine): no terrain, map previews or EA cameos. */
  publicShot: boolean;
  /** The WebGL context: ok; lost (waiting for the browser); restoring (rebuilding, sheets on their way); failed. */
  graphics: "ok" | "lost" | "restoring" | "failed";
  set: (p: Partial<Store>) => void;
}

export const useStore = create<Store>((set) => ({
  phase: "boot",
  stage: "",
  detail: "",
  error: "",
  runtime: "aot",
  shared: false,
  privateContent: false,
  profile: "",
  actorLabels: {},
  setup: null,
  preparedMap: null,
  preparing: null,
  mapErrors: {},
  previews: {},
  icons: {},
  actorPictures: {},
  info: null,
  ui: null,
  catalog: [],
  tab: "Building",
  cursor: "default",
  statsOpen: false,
  menuOpen: false,
  keysOpen: false,
  uiHidden: false,
  cc: initialCoCommander(),
  ccAvailable: false,
  ccLocalAvailable: false,
  sheets: { uploaded: 0, total: 0 },
  paused: false,
  timings: {},
  downloads: {},
  lazy: null,
  startMs: 0,
  perf: { fps: 0, frameMs: 0, simTickMs: 0, engineTickMs: 0, buildMs: 0, tps: 0, lateTicks: 0, draws: 0, heapMB: 0, managedMB: 0, tick: 0, syncHash: 0, latency: [], missed: 0 },
  verify: "",
  sandbox: null,
  publicShot: new URLSearchParams(typeof location !== "undefined" ? location.search : "").get("shot") === "1",
  graphics: "ok",
  set: (p) => set(p),
}));

export const store = {
  get: () => useStore.getState(),
  set: (p: Partial<Store>) => useStore.getState().set(p),
};

export function percentile(v: number[], q: number) {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
