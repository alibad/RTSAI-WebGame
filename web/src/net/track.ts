// Game events, by the names the website defines (RTSAI-Web lib/event-registry.ts). Every event goes to Google Analytics
// (the same GA4 property as rtsai.net); the ones the website counts or emails also go to its POST /api/event as the
// signed-in player. Fire and forget: analytics never blocks or breaks the game.
import { accountsConfigured, currentUser, firebaseApp, siteApi } from "./account";

export type GameEvent = "game_loaded" | "match_started" | "match_ended" | "multiplayer_created" | "multiplayer_joined"
  | "multiplayer_started" | "ai_assist" | "game_error" | "feedback_sent";
type Props = Record<string, string | number | boolean | undefined>;

/** Counted per player and overall, or emailed to the event log. */
const SERVER_EVENTS = new Set<GameEvent>(["match_started", "multiplayer_started", "ai_assist", "game_error"]);

let analytics: Promise<((name: string, props: Props) => void) | null> | null = null;
function ga() {
  return analytics ??= (async () => {
    if (!import.meta.env.VITE_FIREBASE_MEASUREMENT_ID) return null;
    try {
      const [{ app }, A, user] = await Promise.all([firebaseApp(), import("firebase/analytics"), currentUser()]);
      if (!(await A.isSupported())) return null;
      const instance = A.getAnalytics(app);
      if (user) { A.setUserId(instance, user.uid); A.setUserProperties(instance, { account_type: "registered" }); }
      return (name: string, props: Props) => A.logEvent(instance, name, Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined)));
    } catch { return null; }
  })();
}

export function track(name: GameEvent, props: Props = {}) {
  if (!accountsConfigured) return;
  void ga().then(log => log?.(name, props));
  if (SERVER_EVENTS.has(name)) void siteApi("/api/event", { name, props }, true);
}
