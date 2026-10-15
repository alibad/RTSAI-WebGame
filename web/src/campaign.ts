// The campaign's story data (campaign-story.ts, generated from RTSAI-Mod/resources/campaign-story.json by
// tools/build-campaign-story.py): its shape, and the lookups the campaign screen (ui/Missions.tsx) and the in-match radio
// (radio.ts) share. Portraits, films and radio voices live on the CDN under VITE_CAMPAIGN_BASE and load only when shown.

import story from "./campaign-story";

/** When a radio call plays: at the start, after so many seconds of game time, when objective N completes, when the
 * mission's event with that id fires (ui.mission.events: an alarm, reinforcements, the lights coming on), or at the end. */
export type RadioWhen = "start" | "victory" | "defeat" | { time: number } | { objective: number } | { event: string };
export interface RadioCall { when: RadioWhen; speaker: string; line: string; /** <mission>/radio-1.mp3 under the CDN base. */ audio?: string }
export interface CastMember { name: string; role?: string; /** cast/<id>.webp under the CDN base. */ portrait?: string }
export interface Chapter {
  title: string; location: string; intro: string; tactics: string; victory: string; defeat: string;
  /** "coming": shown locked, never launchable. Missing means playable (stories written before the field). */
  status?: "playable" | "coming";
  /** The cast id whose portrait the chapter's card and briefing show. */
  speaker?: string;
}
export interface Arc { id: string; title: string; premise: string; missions: string[]; /** "Act I" etc. */ act?: string }
/** A film around the acts, not a mission: the prologue before Act I, the epilogue after the last act. Shown once its
 * film is published (in the briefings index under its id). */
export interface Prologue { id: string; title: string; eyebrow?: string; intro: string }
export type Epilogue = Prologue;
/** The next part of the story, teased after the epilogue: a locked card, never launchable from this campaign. */
export interface Sequel { id: string; title: string; eyebrow?: string; premise: string; status?: "coming" }
export interface CampaignStory {
  title: string; provenance?: string; prologue?: Prologue; epilogue?: Epilogue; sequel?: Sequel; arcs: Arc[];
  chapters: Record<string, Chapter>; cast?: Record<string, CastMember>; radio?: Record<string, RadioCall[]>;
}

/** The CDN folder holding campaign/index.json, films, portraits and radio voices; unset in local builds. */
export const CAMPAIGN_BASE = (import.meta.env.VITE_CAMPAIGN_BASE as string | undefined)?.replace(/\/?$/, "/") ?? null;

export const campaign: CampaignStory = story;

/** A file under the campaign CDN folder, or null without one. */
export const campaignAsset = (path: string) => (CAMPAIGN_BASE ? CAMPAIGN_BASE + path.replace(/^\//, "") : null);

export const castMember = (id: string | undefined): CastMember | undefined => (id ? campaign.cast?.[id] : undefined);
export const castPortrait = (id: string) => campaignAsset(castMember(id)?.portrait ?? `cast/${id}.webp`);

const TITLES = new Set(["colonel", "captain", "commander", "dr", "dr.", "the", "major", "general", "lieutenant", "sergeant", "chief"]);
/** Initials for a portrait that has not been made yet ("Colonel Badr Al-Shammari": BA). */
export function castInitials(id: string) {
  const words = (castMember(id)?.name ?? id.replace(/-/g, " ")).split(/\s+/).filter((w) => w && !TITLES.has(w.toLowerCase()));
  const pick = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return pick.map((w) => w[0]).join("").toUpperCase() || "?";
}

/** Every chapter id in story order (act by act). */
export const storyOrder = () => campaign.arcs.flatMap((a) => a.missions);

/** A chapter the player can start: written as playable and present in this game's mission catalog. */
export const launchable = (id: string, missionIds: readonly string[]) => campaign.chapters[id]?.status !== "coming" && missionIds.includes(id);

/** The next chapter in story order that can be started, across acts (undefined after the last one). */
export function nextChapter(id: string, missionIds: readonly string[]) {
  const order = storyOrder();
  return order.slice(order.indexOf(id) + 1).find((next) => launchable(next, missionIds));
}

/** Act I, II, III... for an arc without its own "act" label. */
export const actLabel = (arc: Arc, index: number) => arc.act ?? `Act ${["I", "II", "III", "IV", "V", "VI"][index] ?? index + 1}`;

/** A mission's radio calls (campaign missions only). */
export const radioCalls = (mission: string): RadioCall[] => campaign.radio?.[mission] ?? [];
