import { useEffect, useState } from "react";
import { CAMPAIGN_BASE as BASE } from "./campaign";

// Mission briefings made through Montage (tools/briefings: Qwen-Image stills animated by a local video model, narrated
// and scored), published to the CDN under campaign/<mission>/ with an index at campaign/index.json. Nothing loads until
// the campaign screen asks: the index when it opens, a film only when it is played. The prologue's film is listed
// under the mission id "prologue".

export interface Briefing { mission: string; title: string; eyebrow?: string; seconds: number; video: string; captions: string; poster: string }

let pending: Promise<Record<string, Briefing>> | null = null;

function load(): Promise<Record<string, Briefing>> {
  if (!BASE) return Promise.resolve({});
  pending ??= fetch(`${BASE}index.json`, { mode: "cors" })
    .then((r) => (r.ok ? r.json() : { briefings: [] }))
    .then((index: { briefings?: Omit<Briefing, "video" | "captions" | "poster">[] }) => Object.fromEntries((index.briefings ?? []).map((b) => [b.mission, {
      ...b,
      video: `${BASE}${b.mission}/briefing.mp4`,
      captions: `${BASE}${b.mission}/briefing.vtt`,
      poster: `${BASE}${b.mission}/poster.webp`,
    }])))
    .catch(() => { pending = null; return {}; });
  return pending;
}

/** The published briefings by mission id (empty until the index arrives, or when there is none). */
export function useBriefings() {
  const [briefings, setBriefings] = useState<Record<string, Briefing>>({});
  useEffect(() => { let alive = true; void load().then((b) => { if (alive) setBriefings(b); }); return () => { alive = false; }; }, []);
  return briefings;
}

/** m:ss for a film's length. */
/**
 * A film as one downloaded file, while it is open. The CDN (Cloudflare Pages) answers no byte-range requests, and a
 * browser cannot seek in a video served that way, so the film is fetched whole (7–11 MB) and played from memory, then
 * released when it closes. If the download fails, the plain URL is used (it still plays, without seeking).
 */
export function useWholeFile(url: string | null) {
  // The memory URL with the film it holds: when the film changes, the old URL is never handed out again (a new player
  // given it in the render before the effect below ran would load a URL that is about to be revoked).
  const [held, setHeld] = useState<{ url: string; src: string } | null>(null);
  useEffect(() => {
    setHeld(null);
    if (!url) return;
    let alive = true;
    let objectUrl: string | null = null;
    // Played from memory, never by range (the CDN answers none, and Safari plays only what it can range): one retry
    // before falling back to the plain URL (which plays without seeking where the browser can, and fails in Safari).
    const whole = () => fetch(url, { mode: "cors" }).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))));
    whole().catch(() => new Promise<Blob>((ok, fail) => setTimeout(() => whole().then(ok, fail), 1500)))
      .then((blob) => { if (!alive) return; objectUrl = URL.createObjectURL(blob); setHeld({ url, src: objectUrl }); })
      .catch(() => { if (alive) setHeld({ url, src: url }); });
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url]);
  return held && held.url === url ? held.src : null;
}

export const filmLength = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
