// App state shared by the game controller (writes) and the React HUD (reads through selectors, so a 25 Hz UI
// update only re-renders the components whose slice changed).

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
  setup: SetupData | null;
  preparedMap: string | null;
  preparing: string | null;
  previews: Record<string, string>; // map id -> object URL of map.png
  icons: Record<string, string | null>; // actor -> object URL of its cameo (null: none)
  info: StartInfo | null;
  ui: UiState | null;
  catalog: CatalogQueue[];
  tab: string;
  cursor: string;
  statsOpen: boolean;
  menuOpen: boolean;
  /** The hotkey sheet (F1). */
  keysOpen: boolean;
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
  setup: null,
  preparedMap: null,
  preparing: null,
  previews: {},
  icons: {},
  info: null,
  ui: null,
  catalog: [],
  tab: "Building",
  cursor: "default",
  statsOpen: false,
  menuOpen: false,
  keysOpen: false,
  paused: false,
  timings: {},
  downloads: {},
  lazy: null,
  startMs: 0,
  perf: { fps: 0, frameMs: 0, simTickMs: 0, engineTickMs: 0, buildMs: 0, tps: 0, lateTicks: 0, draws: 0, heapMB: 0, managedMB: 0, tick: 0, syncHash: 0, latency: [], missed: 0 },
  verify: "",
  sandbox: null,
  publicShot: new URLSearchParams(typeof location !== "undefined" ? location.search : "").get("shot") === "1",
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
