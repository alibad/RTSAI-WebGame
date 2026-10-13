// The player's RTS AI account. The game is served at rtsai.net/play, the same origin as the website, so the sign-in
// made on rtsai.net (Firebase Auth, rtsai-net project) is visible here without signing in again. Firebase loads
// lazily: nothing is fetched until the gate, multiplayer, events or feedback need it.
import type { FirebaseApp } from "firebase/app";
import type { Auth, User } from "firebase/auth";
import type { Firestore } from "firebase/firestore";

const env = import.meta.env;
const config = {
  apiKey: env.VITE_FIREBASE_API_KEY, authDomain: env.VITE_FIREBASE_AUTH_DOMAIN, projectId: env.VITE_FIREBASE_PROJECT_ID,
  appId: env.VITE_FIREBASE_APP_ID, measurementId: env.VITE_FIREBASE_MEASUREMENT_ID,
};
/** Local tests run against the Firebase emulators (VITE_FIREBASE_EMULATORS=1), never the real project. */
const emulators = env.VITE_FIREBASE_EMULATORS === "1";
export const accountsConfigured = !!(config.apiKey && config.projectId && config.appId);
/** The public build only starts the game (and its ~40 MB first download) for signed-in players. */
export const requireSignIn = env.VITE_REQUIRE_SIGNIN === "1" && accountsConfigured;
/** The website that owns sign-in, events and feedback: this origin on rtsai.net/play, else VITE_SITE_ORIGIN. */
export const siteOrigin = /(^|\.)rtsai\.net$/.test(location.hostname) ? "" : env.VITE_SITE_ORIGIN ?? "";

let app: Promise<{ app: FirebaseApp; auth: Auth }> | null = null;
let db: Promise<Firestore> | null = null;

export function firebaseApp() {
  return app ??= (async () => {
    const [{ initializeApp }, A] = await Promise.all([import("firebase/app"), import("firebase/auth")]);
    const instance = initializeApp(config);
    // The same stores the website's getAuth() uses, without the popup/redirect helper iframe (sign-in itself happens on
    // the website, which is not cross-origin isolated).
    const auth = A.initializeAuth(instance, { persistence: [A.indexedDBLocalPersistence, A.browserLocalPersistence] });
    if (emulators) {
      A.connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
      (window as unknown as { rtsaiTestAccount: unknown }).rtsaiTestAccount = {
        signIn: (email: string, password: string) => A.signInWithEmailAndPassword(auth, email, password).then(c => c.user.uid),
        signUp: (email: string, password: string) => A.createUserWithEmailAndPassword(auth, email, password).then(c => c.user.uid),
      };
    }
    return { app: instance, auth };
  })();
}

export function firestore() {
  return db ??= (async () => {
    const [{ app: instance }, F] = await Promise.all([firebaseApp(), import("firebase/firestore")]);
    const store = F.initializeFirestore(instance, { experimentalAutoDetectLongPolling: true });
    if (emulators) F.connectFirestoreEmulator(store, "127.0.0.1", 8085);
    return store;
  })();
}

/** The signed-in player, once Firebase has restored any saved session (null when signed out or not configured). */
export async function currentUser(): Promise<User | null> {
  if (!accountsConfigured) return null;
  const { auth } = await firebaseApp();
  await auth.authStateReady();
  const user = auth.currentUser;
  return user && !user.isAnonymous ? user : null;
}

export async function onAccountChange(listener: (user: User | null) => void) {
  if (!accountsConfigured) { listener(null); return () => {}; }
  const [{ auth }, { onAuthStateChanged }] = await Promise.all([firebaseApp(), import("firebase/auth")]);
  return onAuthStateChanged(auth, user => listener(user && !user.isAnonymous ? user : null));
}

/** Where a signed-out player goes: the website's sign-in, which brings them back to this exact game URL. */
export function signInUrl() {
  const back = (location.hostname === "rtsai.net" || location.hostname === "www.rtsai.net" ? location.pathname : "/play/") + location.search;
  return `${siteOrigin}/signin?next=${encodeURIComponent(back)}`;
}

/** Calls a website API as the signed-in player (events, feedback). Never throws. */
export async function siteApi(path: string, body: unknown, keepalive = false): Promise<Response | null> {
  try {
    const user = await currentUser();
    if (!user) return null;
    return await fetch(`${siteOrigin}${path}`, { method: "POST", keepalive, headers: { "Content-Type": "application/json", Authorization: `Bearer ${await user.getIdToken()}` }, body: JSON.stringify(body) });
  } catch { return null; }
}
