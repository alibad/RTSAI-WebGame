import { useEffect, useState } from "react";

// Mission briefings made through Montage (tools/briefings: Qwen-Image stills animated by a local video model, narrated
// and scored), published to the CDN under campaign/<mission>/ with an index at campaign/index.json. Nothing loads until
// the campaign screen asks: the index when it opens, a film only when it is played.

export interface Briefing { mission: string; title: string; eyebrow?: string; seconds: number; video: string; captions: string; poster: string }

/** The CDN folder holding campaign/index.json; unset in local builds, which keep the bundled introductions. */
const BASE = (import.meta.env.VITE_CAMPAIGN_BASE as string | undefined)?.replace(/\/?$/, "/") ?? null;

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
export const filmLength = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
