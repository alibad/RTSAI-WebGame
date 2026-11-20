// Which sounds a match asks for as it starts, and in what order.
//
// The game's sounds are single files fetched in the background (lazyfs.ts), and a sound that is not here yet is
// skipped, never waited for (Sound.AudioReady). Until 20 November 2026 only the announcer and the interface sounds
// were asked for ahead, so every unit voice line, gunshot and explosion was silent the first time it was needed: a
// freshly selected unit said nothing, and each of its other lines stayed mute until it had been asked for once.
//
// Asked for now, in the order a player meets them:
//   1. the local player's announcer and the interface sounds (as before);
//   2. the battlefield: weapon and explosion sounds, which every player hears whoever fires;
//   3. the local player's own unit voices (a unit speaks only to its owner).
// Never: music (the soundtrack streams and waits for itself), other players' announcers, and the voice lines of
// modern countries the local player does not play.

/** The modern countries (sides.ts MODERN_NATIONS) and how their voice files start in modern-factions/audio. */
const MODERN_VOICE_PREFIX: Record<string, string[]> = {
  china: ["rcn"], iran: ["iran", "shadow"], turkey: ["tr"], saudi: ["rsa"], israel: ["il"], yemen: ["rye"], lebanon: ["hz"],
};

/** A modern country's voice line: <prefix>[-<class>]-<event>-<language>.wav. Returns the prefix, or null for any other sound. */
function modernVoicePrefix(path: string): string | null {
  const m = /\/modern-factions\/audio\/([a-z0-9]+)(?:-[a-z0-9]+)?-(?:select|move|attack|action|build)-[a-z]{2}\.wav$/.exec(path);
  return m ? m[1] : null;
}

/**
 * The background sound files (lazy mount paths) to fetch for a match, most urgent first.
 * `local` is the local player's country; `countries` are all the countries in the match.
 */
export function matchSounds(paths: readonly string[], local: string, countries: readonly string[] = [local]): string[] {
  const own = MODERN_VOICE_PREFIX[local];
  // The original countries' voices and weapon sounds share one folder (builds with the original art and sound); it
  // is only needed when one of them plays, and then as part of the battlefield: their guns are heard by everyone.
  const originals = countries.some((c) => !(c in MODERN_VOICE_PREFIX));
  const originalSounds = paths.some((p) => p.includes("/web/ea/"));
  const rank = (p: string): number => {
    if (p.includes("/music/")) return -1;
    if (p.includes("/eva/")) return p.includes(`/eva/${local}/`) ? 0 : -1;
    if (p.includes("/audio/ui/")) return 0;
    const prefix = modernVoicePrefix(p);
    // A country the table does not know yet keeps the old behaviour for its voices (fetched when first needed).
    if (prefix !== null) return own?.includes(prefix) ? 2 : -1;
    if (p.includes("/web/ea/")) return originals ? 1 : -1;
    // The shared kit voices (engineer, dog, miner...): a modern country's, and an original country's only in a
    // build that does not carry the originals' own.
    if (p.includes("/audio/voices/")) return own || !originalSounds ? 2 : -1;
    return 1;
  };
  return paths.map((p) => [rank(p), p] as const).filter(([r]) => r >= 0).sort((a, b) => a[0] - b[0]).map(([, p]) => p);
}
