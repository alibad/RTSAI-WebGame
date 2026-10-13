# Lines of Hope

Local campaign presentation for the six existing standalone missions. The Lifeline follows Jizan Corridor, Hodeidah Lifeline and Bab al-Mandab Passage. Broken Signals connects three independent fictional exercises: Straits Shield, Haitan Network and Relay Under Siege. These are anthology arcs with changing playable factions, not one continuous army or persistent strategic simulation.

The campaign has original narrative introductions, command advice, optional narrated videos, written transcripts, English captions, victory/failure debriefs and next-chapter navigation. A player can launch directly, watch first and deploy automatically, or skip the introduction. All missions remain accessible. Progress is stored on the current browser/device; failure does not mark a mission complete. The original mission briefings remain available in an expandable section.

## Preserved source and reuse

The authoritative new story is `RTSAI-Mod/resources/campaign-story.json`. `tools/build-campaign-story.py` generates `web/src/campaign-story.ts` and six MP4/VTT pairs in `web/public/campaign-video`. The videos use the canonical mod's existing project map previews, original text and local cached Kokoro-82M `am_michael` narration at speed 0.98, normalized to -16 LUFS/-1.5 dBTP. Source audio takes, stills and intermediate clips remain in `artifacts/campaign-story`. No older game movie clips or dialogue were copied. These are narrated operations-map introductions, not character-animated movies or gameplay recordings.

The legacy mission adaptation labels in `content/missions.json` are retained. Existing standalone scenarios are reused as playable battles; this change does not rewrite their objectives, balance or native scripting. The new narrative source is preserved in the canonical mod, but the desktop game does not yet display these new videos.

## Build and test

Run `python tools/build-campaign-story.py --text-only` to synchronize text. For videos, run the same script without that flag using the local Kokoro environment (`C:/Users/Admin/Code/AI/chatterbox/.venv/Scripts/python.exe`). Cached model files must already exist; the script requests offline operation and never substitutes a Windows system voice.

Run `npm --prefix web run build`. Vite copies the videos and captions from `web/public`, including into the static public build; no API or paid generation service is required during play. MP4s need `video/mp4` and byte-range support; captions need `text/vtt`. The local game server now supports both.

Run `node tools/campaign-story-test.mjs` against the local game server (default port 3489, override `CAMPAIGN_TEST_URL`). Evidence goes to `artifacts/campaign-story/acceptance.json`. It checks all six videos, playback/seeking/captions, missing-video fallback, an actual native mission launch, and campaign progress/navigation. Outcome UI checks inject paused Won/Lost states and must not be represented as completed mission playthroughs.

## Further campaign work

`RTSAI-Mod/docs/story-bible.md` defines the story that joins the two arcs and the five Act III chapters to come: the recurring cast, the fictional antagonist, the content rules, and the clue lines for the built debriefs. New chapters, films and radio lines follow it.

The preserved map library has 453 indexed entries; most are marked review-required. An indexed map is not a playable campaign mission. Additional ports must review each source's provenance, replace dependencies on owned-game content, translate actors/terrain, implement and validate timed events and all objectives in the browser's deterministic host, and test every success/failure path. Keep unresolved originals archived and indexed. Start with a compact scout-and-rescue mission, then a timed defense, then an infiltration/extraction operation; author new dialogue rather than copying historical campaign scripts or cinematics. Do not advertise these proposed chapters as built.

This delivery stays local. Publishing the website or rebuilding the Windows release is separate work.
