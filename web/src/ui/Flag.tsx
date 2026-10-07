// National flags (web/public/flags: the website's flag set, see flags/SOURCES.md) and the catalog's player-facing
// faction identity (data/factions.json, synced from the website by tools/sync-catalog.mjs).

import catalog from "../data/factions.json";
import { cn } from "../lib/utils";

const FLAGS = new Set(["america", "china", "cuba", "england", "france", "germany", "hezbollah", "iran", "iraq", "israel", "korea", "libya", "russia", "saudi", "turkey", "ukraine", "yemen"]);

export function Flag({ id, className }: { id: string; className?: string }) {
  if (!FLAGS.has(id))
    return <span className={cn("grid place-items-center bg-[#1b211a] text-[10px] font-black text-[var(--hud-gold-dim)]", className)}>?</span>;
  return <img src={`flags/${id}.svg`} alt="" className={cn("object-cover", className)} draggable={false} />;
}

export interface FactionIdentity { name: string; title: string; tagline: string; accent: string; strengths: string }

/** Title and tagline of a modern faction ("Red Sea Command", "Hold the corridor. Protect the lifeline."), if any. */
export function factionIdentity(id: string): FactionIdentity | undefined {
  return (catalog.factions as Record<string, FactionIdentity>)[id];
}
