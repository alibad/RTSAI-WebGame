import { useSyncExternalStore } from "react";

/** Short screens: a phone held sideways (hud.css gives the battlefield back there). */
export const SHORT_SCREEN = "(max-height: 500px)";

/** Whether a media query matches, kept up to date (rotation, resizing). */
export function useMedia(query: string) {
  return useSyncExternalStore(
    (changed) => { const m = matchMedia(query); m.addEventListener("change", changed); return () => m.removeEventListener("change", changed); },
    () => matchMedia(query).matches,
    () => false,
  );
}
