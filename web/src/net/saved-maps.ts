// Players' saved maps, made in the Earth studio on rtsai.net (RTSAI-Web app/studio, lib/earth-battlefield.ts) and kept in
// Firestore (rtsai-net, rules in RTSAI-Web firestore.rules). maps/{id} holds what a list needs (title, place, size,
// seats, the preview picture); mapData/{id} holds the map itself (map.yaml and map.bin), read only when someone plays
// it. Any signed-in player can read a saved map by id, so a host's guests can fetch the map their match uses.
import { accountsConfigured, currentUser, firestore } from "./account";

export interface SavedMap {
  /** Firestore id. */
  saved: string;
  /** Engine map id: earth-<16 hex of the content hash>. */
  id: string;
  title: string;
  place: string;
  players: number;
  size: number;
  preview: Uint8Array;
  created: number;
  mine: boolean;
}

export interface SavedMapFiles { yaml: string; bin: Uint8Array }

const MAP_ID = /^earth-[a-f0-9]{16}$/;
const SAVED_ID = /^[A-Za-z0-9]{20}$/;

function bytes(value: unknown): Uint8Array | null {
  return value && typeof (value as { toUint8Array?: unknown }).toUint8Array === "function" ? (value as { toUint8Array(): Uint8Array }).toUint8Array() : null;
}

function parse(saved: string, data: Record<string, unknown> | undefined, uid: string | undefined): SavedMap | null {
  const preview = bytes(data?.preview);
  if (!data || typeof data.mapId !== "string" || !MAP_ID.test(data.mapId) || !preview || ![2, 4].includes(data.players as number)) return null;
  const created = data.created as { toMillis?: () => number } | undefined;
  return {
    saved, id: data.mapId, title: String(data.title ?? "Earth battlefield").slice(0, 80), place: String(data.place ?? "").slice(0, 120),
    players: data.players as number, size: Number(data.size) || 0, preview, created: created?.toMillis?.() ?? 0, mine: !!uid && data.owner === uid,
  };
}

/** The signed-in player's saved maps, newest first (none when signed out or accounts are off). */
export async function mySavedMaps(max = 40): Promise<SavedMap[]> {
  if (!accountsConfigured) return [];
  const user = await currentUser();
  if (!user) return [];
  const [db, F] = await Promise.all([firestore(), import("firebase/firestore")]);
  // No orderBy: an equality filter alone needs no composite index; the newest come first after sorting here.
  const snapshot = await F.getDocs(F.query(F.collection(db, "maps"), F.where("owner", "==", user.uid), F.limit(max)));
  return snapshot.docs.map(d => parse(d.id, d.data(), user.uid)).filter((m): m is SavedMap => !!m).sort((a, b) => b.created - a.created);
}

/** One saved map by its Firestore id (a link from the studio, or the map a host picked). */
export async function savedMap(saved: string): Promise<SavedMap | null> {
  if (!accountsConfigured || !SAVED_ID.test(saved)) return null;
  const user = await currentUser();
  if (!user) return null;
  const [db, F] = await Promise.all([firestore(), import("firebase/firestore")]);
  const snapshot = await F.getDoc(F.doc(db, "maps", saved));
  return snapshot.exists() ? parse(saved, snapshot.data(), user.uid) : null;
}

/** The map files, checked against the engine id (the first 16 hex of SHA-256 over map.yaml then map.bin). */
export async function savedMapFiles(saved: string, id: string): Promise<SavedMapFiles> {
  const [db, F] = await Promise.all([firestore(), import("firebase/firestore")]);
  const snapshot = await F.getDoc(F.doc(db, "mapData", saved));
  const data = snapshot.data(), bin = bytes(data?.bin);
  if (!data || typeof data.yaml !== "string" || !bin || data.mapId !== id) throw Error("This saved map is missing or damaged.");
  const yaml = new TextEncoder().encode(data.yaml), joined = new Uint8Array(yaml.length + bin.length);
  joined.set(yaml); joined.set(bin, yaml.length);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", joined)), b => b.toString(16).padStart(2, "0")).join("");
  if (`earth-${hash.slice(0, 16)}` !== id) throw Error("This saved map is missing or damaged.");
  return { yaml: data.yaml, bin };
}
