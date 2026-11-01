// Game events, by the names the website defines (RTSAI-Web lib/event-registry.ts). Every event goes to Google Analytics
// (the same GA4 property as rtsai.net) unless the player turned it off; the ones the website counts or emails also go to
// its POST /api/event as the signed-in player, whatever the choice (first-party, as /privacy says). Fire and forget:
// analytics never blocks or breaks the game.
import { accountsConfigured, currentUser, firebaseApp, siteApi } from "./account";

/** The player's analytics choice, written on this origin by the website's account page (RTSAI-Web lib/consent.ts):
 * { "analytics": "granted" | "denied", "at": ISO time }. Google Analytics is on unless it says "denied" (owner, 1 Nov
 * 2026: no banner). */
export const CONSENT_KEY = "rtsai.consent.v1";
export function analyticsAllowed(raw: string | null | undefined) {
  try { return (JSON.parse(raw ?? "null") as { analytics?: unknown } | null)?.analytics !== "denied"; } catch { return true; }
}
function storedChoiceAllows() {
  try { return analyticsAllowed(globalThis.localStorage?.getItem(CONSENT_KEY)); } catch { return true; }
}

export type GameEvent = "game_loaded" | "match_started" | "match_ended" | "multiplayer_created" | "multiplayer_joined"
  | "multiplayer_started" | "ai_assist" | "game_error" | "feedback_sent";
type Props = Record<string, string | number | boolean | undefined>;

/** Counted per player and overall, emailed to the event log, or rolled up for the weekly digest (the site's
 * recordEvent/weeklyDigest). Feedback reaches the site through /api/feedback instead. */
export const SERVER_EVENTS = new Set<GameEvent>(["game_loaded", "match_started", "match_ended", "multiplayer_created", "multiplayer_joined",
  "multiplayer_started", "ai_assist", "game_error"]);

let analytics: Promise<((name: string, props: Props) => void) | null> | null = null;
/** Google Analytics, loaded on the first event unless the player turned it off. Consent mode as on the website:
 * analytics storage only, no ads storage or signals; turning it off on the account page (another tab) stops collection. */
function ga() {
  return analytics ??= (async () => {
    if (!import.meta.env.VITE_FIREBASE_MEASUREMENT_ID) return null;
    try {
      const [{ app }, A, user] = await Promise.all([firebaseApp(), import("firebase/analytics"), currentUser()]);
      if (!(await A.isSupported()) || !storedChoiceAllows()) return null;
      const consent = (granted: boolean) => A.setConsent({ analytics_storage: granted ? "granted" : "denied", ad_storage: "denied",
        ad_user_data: "denied", ad_personalization: "denied" });
      consent(true);
      const instance = A.getAnalytics(app);
      if (user) { A.setUserId(instance, user.uid); A.setUserProperties(instance, { account_type: "registered" }); }
      globalThis.addEventListener?.("storage", (event: StorageEvent) => {
        if (event.key !== CONSENT_KEY && event.key !== null) return;
        const allowed = storedChoiceAllows();
        A.setAnalyticsCollectionEnabled(instance, allowed);
        consent(allowed);
      });
      return (name: string, props: Props) => A.logEvent(instance, name, Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined)));
    } catch { return null; }
  })();
}

export function track(name: GameEvent, props: Props = {}) {
  if (!accountsConfigured) return;
  try {
    if (storedChoiceAllows()) void ga().then(log => log?.(name, props)).catch(() => { /* analytics never breaks the game */ });
    // Only a signed-in player sends (siteApi returns without a user); a failed call is dropped.
    if (SERVER_EVENTS.has(name)) void siteApi("/api/event", { name, props }, true).catch(() => null);
  } catch { /* analytics never breaks the game */ }
}
