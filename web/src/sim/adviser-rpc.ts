// Browser companion transport uses the native rl_bridge.proto contract, never renderer actor guesses.
import type { AdviserActor, AdviserCommand, AdviserObservation } from "../adviser";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
type Value = number | Uint8Array;
type Fields = Map<number, Value[]>;

/** Small wire reader for the unary companion messages; unknown fields remain safely skippable. */
function fields(bytes: Uint8Array): Fields {
  const result: Fields = new Map();
  let offset = 0;
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= bytes.length) throw Error("Truncated companion protobuf");
      const byte = bytes[offset++];
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw Error("Invalid companion protobuf varint");
  };
  while (offset < bytes.length) {
    const tag = Number(varint()), field = tag >>> 3, wire = tag & 7;
    if (!field) throw Error("Invalid companion protobuf field");
    let value: Value;
    if (wire === 0) value = Number(BigInt.asIntN(32, varint()));
    else if (wire === 2) {
      const length = Number(varint());
      if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length) throw Error("Truncated companion protobuf bytes");
      value = bytes.subarray(offset, offset + length); offset += length;
    } else if (wire === 5) {
      if (offset + 4 > bytes.length) throw Error("Truncated companion protobuf float");
      value = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getFloat32(0, true); offset += 4;
    } else if (wire === 1) {
      if (offset + 8 > bytes.length) throw Error("Truncated companion protobuf double");
      offset += 8; continue;
    } else throw Error(`Unsupported companion protobuf wire ${wire}`);
    const list = result.get(field) ?? []; list.push(value); result.set(field, list);
  }
  return result;
}
const number = (f: Fields, n: number) => typeof f.get(n)?.[0] === "number" ? f.get(n)![0] as number : 0;
const bytes = (f: Fields, n: number) => f.get(n)?.[0] instanceof Uint8Array ? f.get(n)![0] as Uint8Array : new Uint8Array();
const string = (f: Fields, n: number) => textDecoder.decode(bytes(f, n));
const strings = (f: Fields, n: number) => (f.get(n) ?? []).filter((v): v is Uint8Array => v instanceof Uint8Array).map((v) => textDecoder.decode(v));
const messages = (f: Fields, n: number) => (f.get(n) ?? []).filter((v): v is Uint8Array => v instanceof Uint8Array).map(fields);
/** A repeated uint32: packed (one length-delimited run of varints, proto3's default) or one value per field. */
const uints = (f: Fields, n: number) => (f.get(n) ?? []).flatMap((v) => {
  if (typeof v === "number") return [v >>> 0];
  const out: number[] = [];
  for (let i = 0, value = 0, shift = 0; i < v.length; i++) {
    value += (v[i] & 127) * 2 ** shift; shift += 7;
    if (!(v[i] & 128)) { out.push(value >>> 0); value = 0; shift = 0; }
  }
  return out;
});

function actor(f: Fields, building = false): AdviserActor {
  return { actorId: number(f, 1) >>> 0, kind: string(f, 2), cellX: number(f, building ? 17 : 5), cellY: number(f, building ? 18 : 6),
    idle: building ? false : !!number(f, 8), canAttack: building ? number(f, 22) > 0 : !!number(f, 12),
    hpPercent: number(f, building ? 5 : 7), x: number(f, 3), y: number(f, 4),
    ...(building ? {} : { canDisguise: !!number(f, 22), canInfiltrate: !!number(f, 23), isDisguised: !!number(f, 20), detectsDisguise: !!number(f, 26),
      // Campaign missions (mission-adviser.ts): speed, cargo, the special orders' valid targets and the current target.
      speed: number(f, 16), stance: number(f, 15), passengers: number(f, 18), canCapture: !!number(f, 29), captureTargets: uints(f, 30),
      canDemolish: !!number(f, 27), demolishTargets: uints(f, 28), targetId: number(f, 39) >>> 0 }) };
}

export function decodeAdviserObservation(payload: Uint8Array): AdviserObservation {
  const f = fields(payload), economy = fields(bytes(f, 3)), map = fields(bytes(f, 9));
  const actorNames: Record<string, string> = {};
  for (const entry of messages(f, 27)) actorNames[string(entry, 1)] = string(entry, 2);
  return {
    tick: number(f, 1), harvesterCount: number(economy, 6), missionMode: !!number(f, 24), cash: number(economy, 1) + number(economy, 2), powerProvided: number(economy, 3), powerDrained: number(economy, 4),
    mapWidth: number(map, 1), mapHeight: number(map, 2), exploredPercent: number(f, 17), done: !!number(f, 12), result: string(f, 14),
    units: messages(f, 5).map((a) => actor(a)), buildings: messages(f, 6).map((a) => actor(a, true)),
    visibleEnemies: messages(f, 8).map((a) => actor(a)), visibleEnemyBuildings: messages(f, 16).map((a) => actor(a, true)),
    rememberedEnemyBuildings: messages(f, 21).map((a) => actor(a, true)),
    production: messages(f, 7).map((p) => ({ item: string(p, 2), queueType: string(p, 1), progress: number(p, 3), remainingTicks: number(p, 4) })),
    availableProduction: strings(f, 15), actorNames,
    // The cell grid (terrain, passability, fog, threat), read only by the mission planner: kept as the raw bytes here.
    spatial: { channels: number(f, 11), bytes: bytes(f, 10) },
  };
}

class Writer {
  private output: number[] = [];
  private varint(value: bigint) { do { const byte = Number(value & 127n); value >>= 7n; this.output.push(byte | (value ? 128 : 0)); } while (value); }
  integer(field: number, value: number) {
    if (!Number.isInteger(value) || value < -2147483648 || value > 4294967295) throw Error("Invalid companion command number");
    this.varint(BigInt(field << 3)); this.varint(value < 0 ? BigInt.asUintN(64, BigInt(value)) : BigInt(value)); return this;
  }
  bytes(field: number, value: Uint8Array) { this.varint(BigInt((field << 3) | 2)); this.varint(BigInt(value.length)); this.output.push(...value); return this; }
  string(field: number, value: string) { return this.bytes(field, textEncoder.encode(value)); }
  finish() { return new Uint8Array(this.output); }
}
const actions: Record<string, number> = { move: 1, attack_move: 2, attack: 3, stop: 4, harvest: 5, build: 6, train: 7, deploy: 8, sell: 9, repair: 10, place_building: 11, cancel_production: 12, set_rally_point: 13, guard: 14, set_stance: 15, enter_transport: 16, unload: 17, power_down: 18, set_primary: 19, disguise: 22, infiltrate: 23, demolish: 24, capture: 25, use_support_power: 26 };

export function encodeAdviserActions(id: string, tick: number, commands: AdviserCommand[]) {
  if (id.length < 8 || id.length > 80 || id.trim() !== id || tick <= 0) throw Error("Invalid or stale co-commander proposal");
  if (!commands.length || commands.length > 12) throw Error("A proposal needs 1 to 12 commands");
  const request = new Writer().string(1, id).integer(2, tick);
  for (const command of commands) {
    const action = actions[command.action.toLowerCase()];
    if (!action) throw Error(`Unsupported co-commander action ${command.action}`);
    const c = new Writer().integer(1, action);
    if (command.actor_id !== undefined) c.integer(2, command.actor_id);
    if (command.target_actor_id !== undefined) c.integer(3, command.target_actor_id);
    // The engine uses omitted placement coordinates as its own validated near-base placement search.
    if (command.target_x !== undefined) c.integer(4, command.target_x);
    if (command.target_y !== undefined) c.integer(5, command.target_y);
    if (command.item_type !== undefined) c.string(6, command.item_type);
    if (command.queued) c.integer(7, 1);
    request.bytes(3, c.finish());
  }
  return request.finish();
}

export interface AdviserActionReceipt {
  requestId: string; accepted: boolean; gameTick: number; detail: string;
  results: { index: number; action: number; accepted: boolean; detail: string }[];
}
export function decodeAdviserReceipt(payload: Uint8Array): AdviserActionReceipt {
  const f = fields(payload);
  return { requestId: string(f, 1), accepted: !!number(f, 2), gameTick: number(f, 3), detail: string(f, 5),
    results: messages(f, 4).map((r) => ({ index: number(r, 1), action: number(r, 2), accepted: !!number(r, 3), detail: string(r, 4) })) };
}
export function encodeAdviserStatus(enabled: boolean, message = "Co-commander ready") {
  return new Writer().string(1, enabled ? "ready" : "disabled").string(2, message).integer(3, enabled ? 1 : 0).finish();
}
export function decodeAdviserStatus(payload: Uint8Array) { return !!number(fields(payload), 1); }
