// Matchmaking for direct multiplayer, in Firestore (rtsai-net, rules in RTSAI-Web firestore.rules). It only
// introduces browsers: p2pMatches/{code} names the host, and each guest leaves a WebRTC offer in
// p2pMatches/{code}/joins/{id} that only the host can read and answer. The match itself never touches Firestore.
import { currentUser, firestore } from "./account";

const MATCH_TTL_MS = 110 * 60_000, JOIN_TTL_MS = 30 * 60_000;
// Matches the rules: six characters, no 0/O/1/I/L.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function roomCode() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), b => ALPHABET[b % ALPHABET.length]).join("");
}

async function member() {
  const user = await currentUser();
  if (!user) throw Error("Sign in to play multiplayer.");
  return user;
}

function friendly(error: unknown): Error {
  const code = (error as { code?: string })?.code ?? "";
  if (code === "permission-denied") return Error("This invite has expired or the host closed the match. Ask your host for a new link.");
  if (code === "unavailable" || code === "deadline-exceeded") return Error("Couldn't reach matchmaking. Check your internet connection and try again.");
  return error instanceof Error ? error : Error(String(error));
}

/** Host: reserve a fresh code. */
export async function createMatch(version: string) {
  const [user, db, F] = await Promise.all([member(), firestore(), import("firebase/firestore")]);
  for (let attempt = 0; attempt < 8; attempt++) {
    const room = roomCode(), ref = F.doc(db, "p2pMatches", room);
    try {
      if ((await F.getDoc(ref)).exists()) continue;
      await F.setDoc(ref, { host: user.uid, version, expires: F.Timestamp.fromMillis(Date.now() + MATCH_TTL_MS) });
      return room;
    } catch (e) { if ((e as { code?: string }).code !== "permission-denied") throw friendly(e); }
  }
  throw Error("Couldn't create a match. Try again.");
}

/** Host: every guest offer as it arrives (pushed, no polling). Returns the unsubscribe function. */
export async function watchJoins(room: string, onJoin: (join: { id: string; offer: string }) => void, onError: (e: Error) => void) {
  const [db, F] = await Promise.all([firestore(), import("firebase/firestore")]);
  return F.onSnapshot(F.collection(db, "p2pMatches", room, "joins"), snapshot => {
    for (const change of snapshot.docChanges()) {
      const data = change.doc.data();
      if (change.type === "added" && typeof data.offer === "string") onJoin({ id: change.doc.id, offer: data.offer });
    }
  }, e => onError(friendly(e)));
}

export async function answerJoin(room: string, id: string, answer: string) {
  const [db, F] = await Promise.all([firestore(), import("firebase/firestore")]);
  try { await F.updateDoc(F.doc(db, "p2pMatches", room, "joins", id), { answer }); } catch (e) { throw friendly(e); }
}

/** Host: late joiners can no longer find the match. Best effort; expiry cleans up regardless. */
export async function closeMatch(room: string) {
  try { const [db, F] = await Promise.all([firestore(), import("firebase/firestore")]); await F.deleteDoc(F.doc(db, "p2pMatches", room)); } catch { /* expires anyway */ }
}

/** Guest: post an offer and wait for the host's answer. */
export async function joinMatch(room: string, version: string, offer: string) {
  const [user, db, F] = await Promise.all([member(), firestore(), import("firebase/firestore")]);
  let match;
  try { match = await F.getDoc(F.doc(db, "p2pMatches", room)); } catch (e) { throw friendly(e); }
  if (!match.exists()) throw Error("This invite has expired or the host closed the match. Ask your host for a new link.");
  if (match.data().version !== version) throw Error("You and your host are on different game versions. Both of you reload the page, then try again.");
  const ref = F.doc(F.collection(db, "p2pMatches", room, "joins"));
  try { await F.setDoc(ref, { guest: user.uid, offer, expires: F.Timestamp.fromMillis(Date.now() + JOIN_TTL_MS) }); } catch (e) { throw friendly(e); }
  return {
    answer: (timeoutMs: number) => new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(Error("Your host didn't respond. Check that they still have the match open.")); }, timeoutMs);
      const stop = F.onSnapshot(ref, snapshot => {
        const answer = snapshot.data()?.answer;
        if (typeof answer === "string") { clearTimeout(timer); stop(); resolve(answer); }
      }, e => { clearTimeout(timer); reject(friendly(e)); });
    }),
    cancel: () => F.deleteDoc(ref).catch(() => {}),
  };
}
