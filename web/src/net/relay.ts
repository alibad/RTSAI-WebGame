// The servers a direct multiplayer connection may use. Players connect browser to browser; when their networks cannot
// reach each other, the connection goes through Cloudflare's TURN relay instead. Its credentials are short-lived and
// come from the website's relay function (RTSAI-Web functions/relay.js), for signed-in players only. Without them
// (signed out, function down, a local build without it) the game connects as before: directly or not at all.
import { currentUser } from "./account";
import { STUN_SERVERS } from "../peer";

const env = import.meta.env;
/** Credentials are reused for later matches while they still have this long to run (they last four hours). */
const FRESH_MS = 3 * 60 * 60_000;
/** After a failure, matches go without a relay for a minute instead of each waiting for the function again. */
const RETRY_MS = 60_000;

function relayUrl() {
  const project = env.VITE_FIREBASE_PROJECT_ID;
  if (!project) return null;
  if (env.VITE_FIREBASE_EMULATORS === "1") {
    // Test builds: only when the run brings a functions emulator ("<auth>,<firestore>,<functions>").
    const functions = (env.VITE_FIREBASE_EMULATOR_PORTS || "").split(",")[2];
    return functions ? `http://127.0.0.1:${Number(functions)}/${project}/europe-west1/relay` : null;
  }
  return `https://europe-west1-${project}.cloudfunctions.net/relay`;
}

let cached: { servers: RTCIceServer[]; until: number } | null = null;
let failedAt = 0;
let pending: Promise<RTCIceServer[]> | null = null;

function valid(list: unknown): RTCIceServer[] {
  if (!Array.isArray(list)) throw Error("No ICE servers");
  const servers = list.filter((s): s is RTCIceServer => !!s && (typeof s.urls === "string" || Array.isArray(s.urls)));
  if (!servers.some(s => typeof s.credential === "string")) throw Error("No relay");
  return servers;
}

/**
 * STUN plus the relay, or STUN alone when the relay can't be had within `waitMs`. Never throws. A host calls it once
 * for every guest, so the answer is shared and reused while the credentials stay fresh.
 */
export function iceServers(waitMs = 6000): Promise<RTCIceServer[]> {
  if (cached && cached.until - Date.now() > FRESH_MS) return Promise.resolve(cached.servers);
  const url = relayUrl();
  if (!url || Date.now() - failedAt < RETRY_MS) return Promise.resolve(STUN_SERVERS);
  return pending ??= (async () => {
    try {
      const user = await currentUser();
      if (!user) return STUN_SERVERS;
      const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${await user.getIdToken()}` }, signal: AbortSignal.timeout(waitMs) });
      if (!response.ok) throw Error(`relay ${response.status}`);
      const answer = await response.json() as { iceServers?: unknown; expires?: unknown };
      const relay = valid(answer.iceServers), expires = typeof answer.expires === "number" ? answer.expires : Date.now() + FRESH_MS;
      cached = { servers: [STUN_SERVERS[0], ...relay.filter(s => s.credential)], until: expires };
      return cached.servers;
    } catch {
      failedAt = Date.now();
      return STUN_SERVERS;
    } finally {
      pending = null;
    }
  })();
}
