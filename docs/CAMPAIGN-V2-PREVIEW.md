# Lines of Hope v2: overnight preview (14 October 2026)

**Preview:** https://campaign-v2.rtsai-play-cdn.pages.dev/ (Cloudflare Pages branch `campaign-v2` of `rtsai-play-cdn`). Production `/play` is unchanged.

## What is in it
- **The story, v2** (`RTSAI-Mod/docs/story-bible.md`, data in `RTSAI-Mod/resources/campaign-story.json`): an alternate-history sequel to the original Red Alert. Prologue 1953 (Einstein, the Chronosphere, Arkady Orlov, Tanya), Act I The Lifeline, Act II Broken Signals, Act III The Missing Man.
- **Campaign screen:** the prologue film card, three acts, commander portraits, locked "In production" cards for Glass Island, Black Platform and Every Light On.
- **Two new playable chapters:** Lights in the Water (Yemen: find three stranded crews, the tide gate, the convoy to the clinic, Tanya found on the far reef) and Hold the Ferry Line (Türkiye: three checkpoints, four ferries past Orion destroyers, twelve minutes). Native mission tests pass for every success and failure path; browser launch tests pass on the preview.
- **Radio calls:** 50 voiced lines (local Kokoro voices through a field-radio filter) with portraits and captions, fired by mission start, game time, objectives, victory and defeat.
- **Briefing films cut around the real mission:** in-engine footage (`tools/briefings/game-footage.mjs`: HUD-free map glide, every objective on the real map, live battle) intercut with Forge cinematic clips, edited by `tools/briefings/cut-film.py` (objective cards, narration, ducked score, captions, title). Montage only supplies parts (clips, narration takes, score).

## Where things are
- RTSAI-WebGame branch `campaign/preview` (worktree `D:/rtsai-campaign/preview`) merges `campaign/radio`, `campaign/chapters`, `campaign/footage` and `campaign/films`. RTSAI-Mod branch `campaign/act3` (worktree `D:/rtsai-campaign/RTSAI-Mod`). Nothing is pushed.
- CDN (`rtsai-play-cdn` main): data root `data-036902deb973/` (the two new missions; `web-art.pack` omitted like the live root), `campaign-v2/` (films, posters, captions, `cast/`, radio audio, `index.json`). Runtime unchanged: `rt-08958508163b/`.
- Preview page build: `D:/rtsai-campaign/preview-site` (BUILD.json records the commit).

## Promoting to /play (needs the owner's go)
Page-only release against the live runtime with the new data root: build the page from the preview branch with `VITE_DATA_BASE=https://rtsai-play-cdn.pages.dev/<new data root>/` and `VITE_CAMPAIGN_BASE=https://rtsai-play-cdn.pages.dev/campaign-v2/`, then the usual `page-build` / `vercel-page-deploy` / `vercel promote` flow (see `rtsai-map-generator` notes and `docs/DEPLOY-PUBLIC.md`), after `vercel usage --scope alibads-projects`. Merge the branches into main first so other sessions' pages keep this work.

## Known gaps
- Glass Island, Black Platform and Every Light On need Phase 2 mission features (detection zones, fixed squads with squad-loss failure, event-gated objectives, a Tanya hero unit).
- Balance of the new chapters comes from scripted probes; a human playtest is the real check.
- The radio voices are Kokoro (clear but plain); Chatterbox takes would match the film narrator.
- Civilians are still placeholder art in the standalone game; the survivors use engineers.
