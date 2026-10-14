// Snapshot wire format written by sim/OpenRA.WebSim/Snapshot.cs. Little-endian, 4-byte aligned.
// Section order: header, actors, draws, players, new sprites, texture updates, new strings.

export const MAGIC = 0x314e5357; // "WSN1"
export const RESYNC_MAGIC = 0x31525357; // "WSR1": sprite/string tables restart at id 0
export const HEADER_BYTES = 80;
export const CAPTURE_VERTEX_BYTES = 48; // OpenRA.Graphics.Vertex
export const CAPTURE_BATCH_BYTES = 44;
export const MODEL_CMD_BYTES = 136;
export const ACTOR_BYTES = 52;
export const DRAW_BYTES = 48;
export const PLAYER_BYTES = 16;
export const SPRITE_BYTES = 60;
export const TEXTURE_BYTES = 20;

export interface Header {
  tick: number;
  netFrame: number;
  syncHash: number;
  tickMs: number;
  buildMs: number;
  actorCount: number;
  drawCount: number;
  playerCount: number;
  newSprites: number;
  textureCount: number;
  newStrings: number;
  paletteRows: number;
  localPlayer: number;
  unsupported: number;
  selectionHash: number;
  capVertices: number;
  capBatches: number;
  modelCmds: number;
}

/** Engine renderer output recorded by Capture.cs: beams, lines, contrails, voxel model sprites (+ model passes). */
export interface Captured {
  vertices: Uint8Array; // capVertices * 48 bytes (copied)
  batches: { start: number; count: number; blend: number; ui: boolean; ground: boolean; above: boolean; textures: number[] }[];
  modelCmds: DataView; // modelCmds * 136 bytes (copied)
}

export const ACTOR_REPAIR_REQUESTED = 64;
export const ACTOR_REPAIR_ACTIVE = 128;

export interface Actor {
  id: number;
  type: number; // string id
  owner: number; // index into players
  flags: number; // 1 selectable, 2 selected, 4 idle, 8 building, 16 dead, 32 mouse bounds, 64 repair requested, 128 repair active
  facing: number;
  sx: number; // Screen3DPosition of CenterPosition (world px)
  sy: number;
  sz: number;
  hp: number;
  maxHp: number;
  bx: number; // decoration bounds relative to the actor's screen px position
  by: number;
  bw: number;
  bh: number;
  worldZ: number;
  sequence: number; // string id of the body animation sequence
  frame: number;
  rank: number; // veterancy level (0 rookie, 1 veteran, 2 elite)
}

export interface Player {
  name: number;
  faction: number;
  color: number; // ARGB
  flags: number; // 1 local, 2 bot, 4 playable, 8 noncombatant
  winState: number;
}

export interface SpriteInfo {
  tex: number;
  tex2: number;
  channel: number;
  channel2: number;
  blend: number;
  uv: [number, number, number, number];
  uv2: [number, number, number, number];
  size: [number, number, number];
}

export interface TextureUpdate {
  id: number;
  version: number;
  width: number;
  height: number;
  kind: number; // 0 sheet (BGRA bytes), 1 hardware palette
}

/** Draws are kept as a packed typed-array view (48 bytes each) to avoid per-frame object churn. */
export interface Snapshot {
  header: Header;
  actors: Actor[];
  actorById: Map<number, Actor>;
  draws: DataView; // drawCount * DRAW_BYTES
  players: Player[];
  sprites: SpriteInfo[];
  textures: TextureUpdate[];
  strings: string[];
  receivedAt: number;
  resync: boolean;
  captured: Captured;
}

const decoder = new TextDecoder();

export function parseSnapshot(bytes: Uint8Array, receivedAt: number): Snapshot {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== MAGIC && magic !== RESYNC_MAGIC) throw new Error("bad snapshot magic");
  const i = (o: number) => dv.getInt32(o, true);
  const f = (o: number) => dv.getFloat32(o, true);
  const header: Header = {
    tick: i(4), netFrame: i(8), syncHash: i(12), tickMs: f(16), buildMs: f(20),
    actorCount: i(24), drawCount: i(28), playerCount: i(32), newSprites: i(36), textureCount: i(40),
    newStrings: i(44), paletteRows: i(48), localPlayer: i(52), unsupported: i(56), selectionHash: i(60),
    capVertices: i(64), capBatches: i(68), modelCmds: i(72),
  };

  let p = HEADER_BYTES;
  const actors: Actor[] = new Array(header.actorCount);
  const actorById = new Map<number, Actor>();
  for (let k = 0; k < header.actorCount; k++, p += ACTOR_BYTES) {
    const a: Actor = {
      id: dv.getUint32(p, true), type: i(p + 4), owner: dv.getUint8(p + 8), flags: dv.getUint8(p + 9),
      facing: dv.getUint16(p + 10, true), sx: f(p + 12), sy: f(p + 16), sz: f(p + 20), hp: i(p + 24), maxHp: i(p + 28),
      bx: dv.getInt16(p + 32, true), by: dv.getInt16(p + 34, true), bw: dv.getInt16(p + 36, true), bh: dv.getInt16(p + 38, true),
      worldZ: i(p + 40), sequence: i(p + 44), frame: dv.getUint16(p + 48, true), rank: dv.getUint16(p + 50, true),
    };
    actors[k] = a;
    actorById.set(a.id, a);
  }

  // Copy the draw block so the shared ring slot can be reused immediately.
  const drawBytes = header.drawCount * DRAW_BYTES;
  const drawCopy = bytes.slice(p, p + drawBytes);
  const draws = new DataView(drawCopy.buffer);
  p += drawBytes;

  const players: Player[] = [];
  for (let k = 0; k < header.playerCount; k++, p += PLAYER_BYTES)
    players.push({ name: i(p), faction: i(p + 4), color: dv.getUint32(p + 8, true), flags: dv.getUint8(p + 12), winState: dv.getUint8(p + 13) });

  const sprites: SpriteInfo[] = [];
  for (let k = 0; k < header.newSprites; k++, p += SPRITE_BYTES)
    sprites.push({
      tex: i(p), tex2: i(p + 4), channel: dv.getUint8(p + 8), channel2: dv.getUint8(p + 9), blend: dv.getUint8(p + 10),
      uv: [f(p + 12), f(p + 16), f(p + 20), f(p + 24)],
      uv2: [f(p + 28), f(p + 32), f(p + 36), f(p + 40)],
      size: [f(p + 44), f(p + 48), f(p + 52)],
    });

  const textures: TextureUpdate[] = [];
  for (let k = 0; k < header.textureCount; k++, p += TEXTURE_BYTES)
    textures.push({ id: i(p), version: i(p + 4), width: i(p + 8), height: i(p + 12), kind: i(p + 16) });

  const strings: string[] = [];
  for (let k = 0; k < header.newStrings; k++) {
    const len = dv.getUint16(p, true);
    p += 2;
    strings.push(decoder.decode(bytes.subarray(p, p + len)));
    p += len;
  }

  p = (p + 3) & ~3;
  const vEnd = p + header.capVertices * CAPTURE_VERTEX_BYTES;
  const vertices = bytes.slice(p, vEnd);
  p = vEnd;
  const batches: Captured["batches"] = [];
  for (let k = 0; k < header.capBatches; k++, p += CAPTURE_BATCH_BYTES) {
    const tex: number[] = [];
    for (let t = 0; t < 8; t++) tex.push(i(p + 12 + 4 * t));
    batches.push({ start: i(p), count: i(p + 4), blend: dv.getUint8(p + 8), ui: dv.getUint8(p + 9) === 1, ground: dv.getUint8(p + 10) === 1, above: dv.getUint8(p + 11) === 1, textures: tex });
  }
  const mEnd = p + header.modelCmds * MODEL_CMD_BYTES;
  const modelCmds = new DataView(bytes.slice(p, mEnd).buffer);
  const captured = { vertices, batches, modelCmds };
  return { header, actors, actorById, draws, players, sprites, textures, strings, receivedAt, resync: magic === RESYNC_MAGIC, captured };
}

/** Texture section only (the worker uses it to ship changed sheets to the page). */
export function textureUpdates(bytes: Uint8Array): TextureUpdate[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const i = (o: number) => dv.getInt32(o, true);
  const p0 = HEADER_BYTES + i(24) * ACTOR_BYTES + i(28) * DRAW_BYTES + i(32) * PLAYER_BYTES + i(36) * SPRITE_BYTES;
  const out: TextureUpdate[] = [];
  for (let k = 0, p = p0; k < i(40); k++, p += TEXTURE_BYTES)
    out.push({ id: i(p), version: i(p + 4), width: i(p + 8), height: i(p + 12), kind: i(p + 16) });
  return out;
}

export interface StartInfo {
  map: string;
  uid: string;
  tileset: string;
  mapSize: [number, number];
  tileSize: [number, number];
  tileScale: number;
  bounds: [number, number, number, number];
  start: [number, number];
  depthBuffer: boolean;
  depthMargin: number;
  cellOrigin: [number, number];
  mapBounds: [number, number, number, number]; // MPos left, top, right, bottom (exclusive)
  gridType: string;
  terrainSheets: number[];
  terrainVertexCount: number;
  vertexRowStride: number;
  localPlayer: string;
  players: { name: string; label: string; faction: string; color: string; bot: boolean }[];
  timings: Record<string, number>;
}

export interface LazyStats { files: number; bytes: number; fetchedBytes: number; cachedBytes: number; fetches: number }

export interface SetupData {
  multiplayer?: boolean;
  missions?: MissionDefinition[];
  factions: { id: string; name: string; side: string; description: string; random: boolean }[];
  bots: { type: string; name: string }[];
  /** `saved`: a player's map from the Earth studio (its Firestore id), mounted when first used (net/saved-maps.ts). */
  maps: { id: string; uid: string; title: string; players: number; tileset: string; author: string; slots: string[]; saved?: string; place?: string; generated?: boolean; landscape?: string; gen?: string }[];
  options?: { id: string; name: string; default: string; values: { value: string; label: string }[] }[];
}

/** Per-tick game-UI state (sim/OpenRA.WebSim/Ui.cs). `catalog` is present only when it changed. */
export interface UiState {
  coach?: { earned: number; losses: number; actors: { id: number; building: boolean; x: number; y: number }[] };
  mission?: MissionState | null;
  tick: number;
  cash?: number;
  storage?: number;
  power?: { provided: number; drained: number; state: "Normal" | "Low" | "Critical" };
  radar: boolean;
  win: string;
  mode: string; // "", place, sell, repair, attackmove, guard
  queues: { type: string; enabled: boolean; items: QueuedItem[] }[];
  selection: { id: number; type: string; own: boolean; hp: number; maxHp: number; rank: number; maxRank: number; produces?: string[]; primary?: boolean; canPrimary?: boolean; rally?: boolean }[];
  commands?: Record<string, boolean>;
  stances?: string[];
  supportPowers?: { key: string; name: string; description: string; ready: boolean; active: boolean; remaining: number; total: number }[];
  groups?: number[];
  catalog?: CatalogQueue[];
  sandbox?: SandboxStats | null;
  companion?: CompanionHud;
}

export interface MissionDefinition {
  id: string; title: string; faction: string; campaign: string; briefing: string; adaptation: string; slot: string;
  objectives: { text: string; secondary: boolean }[];
}

export interface MissionState {
  id: string; title: string; difficulty: string;
  /** The mission's events that have fired, in order (Missions.cs): the radio's { event: id } calls key off them. */
  events?: string[];
  objectives: {
    text: string; secondary: boolean; status: "active" | "complete" | "failed"; progress: string;
    /** Active but not counting yet: an objective or event it waits for has not happened. */
    waiting?: boolean;
    markers?: { name: string; x: number; y: number }[];
  }[];
}

/** The battle sandbox readout (sim/OpenRA.WebSim/Sandbox.cs). Times in seconds of game time. */
export interface SandboxStats {
  elapsed: number;
  firstKill: number | null;
  sides: { alive: number; total: number; hp: number; hpStart: number; shots: number; kills: number; damageTaken: number; damageDealt: number; eliminatedAt: number | null }[];
  types: { side: number; type: string; total: number; alive: number; shots: number; damageTaken: number }[];
}

export interface QueuedItem { name: string; progress: number; paused: boolean; done: boolean; infinite: boolean; remaining: number }
export interface CatalogItem {
  name: string; label: string; cost: number; time: number; buildable: boolean; building: boolean;
  /** Power provided (+) or drained (-). */
  power: number;
  /** The production tooltip's description (role, strengths and weaknesses), when the mod has one. */
  desc?: string;
  /** What is still missing to build it (actor names), when not buildable. */
  requires?: string[];
}

export type CompanionEngineEvent =
  | { kind: "status"; state: string; message: string }
  | { kind: "threat"; score: number; level: string; reason: string }
  | { kind: "executed"; id: string; accepted: boolean; detail: string }
  | { kind: "link"; connected: boolean };

/** The co-commander's HUD line and threat meter in the UI state (Ui.cs). */
export interface CompanionHud {
  state: string; message: string; enabled: boolean; muted: boolean;
  threat: { score: number; level: string; reason: string };
}

/** End-of-game summary per playing side (Ui.cs GameStats). */
export interface GameStats {
  tick: number;
  timestep: number;
  players: {
    name: string; faction: string; color: string; local: boolean; bot: boolean; win: string;
    unitsKilled: number; unitsDead: number; buildingsKilled: number; buildingsDead: number;
    killsCost: number; deathsCost: number; earned: number;
    /** Army value every 30 s of game time, then the current value. */
    army: number[];
  }[];
}
export interface CatalogQueue { type: string; items: CatalogItem[] }

// Messages between page and worker.
export type ToWorker = (
  | { type: "peerFrame"; frame: number; packets: { client: number; data: string }[] }
  | { type: "peerStop"; error: string }
  | { type: "init"; runtime: string; base: string; sab: SharedArrayBuffer | null; privateContent: boolean; voiceLanguage: string; gcParams?: string; profile?: string; rtBase?: string; dataBase?: string }
  | { type: "prepare"; map: string }
  | { type: "mountMap"; map: string; yaml: string; bin: ArrayBuffer; png: ArrayBuffer }
  /** A random map from the engine's map generator (MapGen.cs), made and mounted in the worker. `request`: JSON. */
  | { type: "generateMap"; request: string }
  | { type: "preview"; map: string }
  | { type: "start"; scenario: string; voiceLanguage: string; paused?: boolean; companion?: boolean | "browser" }
  /** The factions a game will show (null: unknown, all): their sprite sheets are fetched now. */
  | { type: "sheetGroups"; groups: string[] | null; first?: string[] }
  /** Sheets the page drew from but does not have. */
  | { type: "needSheets"; ids: number[] }
  /** The page lost its WebGL context: these shipped sheets are needed again (sent even if sent before). */
  | { type: "resendSheets"; ids: number[] }
  /** The page lost its WebGL context: the engine's pixels of these sheets, where it still has them (textureData). */
  | { type: "resendTextures"; ids: number[] }
  | { type: "refresh" }
  | { type: "step" }
  | { type: "speed"; speed: number }
  | { type: "end" }
  | { type: "pause"; paused: boolean }
  | { type: "view"; x0: number; y0: number; x1: number; y1: number }
  | { type: "select"; ids: number[]; additive: boolean; req: number }
  | { type: "command"; json: string; req: number }
  | { type: "click"; x: number; y: number; button: number; mods: number; t: number }
  | { type: "cursor"; x: number; y: number; mods: number; seq: number }
  | { type: "icons"; names: string[] }
  | { type: "cursorset" }
  | { type: "bench"; ticks: number }
  | { type: "log" }
  | { type: "record"; req: number }
  | { type: "voiceLanguage"; value?: string; req: number }
  | { type: "voicePreview"; req: number }
  | { type: "adviserRpc"; req: number; method: "Observe" | "ExecuteCompanionActions" | "UpdateCompanionStatus"; payload: Uint8Array }
  | { type: "resync" }) & { generation?: number };

export type FromWorker = (
  | { type: "peerOut"; events: import('../peer').PeerEvent[] }
  | { type: "networkStatus"; frame: number; latency: number; error?: string }
  | { type: "progress"; stage: string; detail?: string }
  /** `actorNames`: every actor's display name from the mod's Fluent messages (fluent-names.ts). */
  | { type: "ready"; timings: Record<string, number>; runtimeMs: number; downloadBytes: Record<string, number>; setup: SetupData; privateContent: boolean; actorNames?: Record<string, string> }
  | { type: "prepared"; map: string; ms: number; timings: Record<string, number>; lazy?: LazyStats }
  | { type: "preview"; map: string; png: ArrayBuffer }
  | { type: "mapMounted"; map: string; error?: string }
  | { type: "mapGenerated"; map?: string; title?: string; landscape?: string; players?: number; seed?: number; ms?: number; png?: ArrayBuffer; error?: string }
  | { type: "started"; info: StartInfo; terrain: ArrayBuffer; radarTerrain: ArrayBuffer; startMs: number; lazy?: LazyStats }
  | { type: "snapshot"; bytes: ArrayBuffer; seq: number } // postMessage fallback when SharedArrayBuffer is unavailable
  | { type: "texture"; id: number; version: number; width: number; height: number; kind: number; data: ArrayBuffer }
  /** The AI co-commander: status / threat / executed (CompanionRpc.cs) and the relay link state. */
  | { type: "companion"; event: CompanionEngineEvent }
  /** The engine disposed a texture (e.g. a finished game's sheets): free the GPU copy. */
  | { type: "texturefree"; id: number }
  /** A restored packing's sheets (texture ids) and their pack groups ("" shared, else a faction). */
  | { type: "sheetList"; sheets: { id: number; group: string }[] }
  /** A shipped sheet's used rows, raw (planar: one channel plane after another). */
  | { type: "texturebin"; id: number; width: number; height: number; rows: number; planar: boolean; data: ArrayBuffer }
  /** A prebaked sprite sheet from the cache, gzip-compressed (the page inflates it). */
  | { type: "texturegz"; id: number; width: number; height: number; gz: Blob }
  /** resendTextures: a sheet's pixels again (empty: the engine no longer has them). */
  | { type: "textureData"; id: number; data: ArrayBuffer }
  | { type: "ui"; json: string }
  | { type: "shroud"; cells: ArrayBuffer }
  | { type: "radar"; blips: ArrayBuffer }
  | { type: "reply"; req: number; json: string }
  | { type: "adviserReply"; req: number; code: number; message: string; payload: Uint8Array }
  | { type: "icon"; name: string; info: string }
  | { type: "modelbuffer"; id: number; data: ArrayBuffer }
  | { type: "audio"; op: "source"; id: number; channels: number; bits: number; rate: number; data: ArrayBuffer }
  | { type: "audio"; op: "play"; sound: number; source: number; loop: boolean; relative: boolean; x: number; y: number; volume: number; attenuate: boolean }
  | { type: "audio"; op: "stream"; sound: number; channels: number; bits: number; rate: number; data: ArrayBuffer; end: boolean; volume: number }
  | { type: "audio"; op: "stop"; sound: number }
  | { type: "audio"; op: "volume"; sound: number; volume: number }
  | { type: "audio"; op: "pause"; sound: number; paused: boolean }
  | { type: "cursor"; cursor: string; seq: number }
  | { type: "cursorset"; data: ArrayBuffer }
  | { type: "ordered"; count: number; t: number; tick: number }
  | { type: "bench"; ticks: number; ms: number }
  | { type: "log"; json: string }
  | { type: "stats"; json: string; heapBytes: number; tickMs: number; lateTicks: number; ticksPerSecond: number; lazy?: LazyStats }
  | { type: "error"; message: string }) & { generation?: number };
// Shared ring layout (Int32 slots at the start of the SharedArrayBuffer).
// 32 slots of 1 MB: about 1.3 s of ticks, so a main-thread stall (sheet uploads, GC, a busy frame) does not
// overrun the ring. Snapshots are ~50-150 KB; a larger one falls back to postMessage with its seq.
export const RING_SLOTS = 32;
export const RING_SLOT_BYTES = 1024 * 1024;
/** Int32 header: [0] latest seq, [RING_LEN_AT + slot] length, [RING_SEQ_AT + slot] seq (0 = sent by postMessage). */
export const RING_LEN_AT = 1;
export const RING_SEQ_AT = 1 + RING_SLOTS;
export const RING_GENERATION_AT = 1 + 2 * RING_SLOTS;
export const RING_HEADER_BYTES = 4 * (1 + 3 * RING_SLOTS);
export const RING_BYTES = RING_HEADER_BYTES + RING_SLOTS * RING_SLOT_BYTES;
