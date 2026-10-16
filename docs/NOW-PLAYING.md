# In-match music indicator

The match toolbar has a compact music-note button. Its themed popover shows the engine's current track title, actual elapsed audio time, total duration and a progress bar. Music-only mute leaves effects and voices enabled. The status distinguishes muted music, a paused match, suspended browser audio, loading and no current track. Escape and outside click dismiss the panel; focus returns to the trigger.

`Ui.State` exposes only the current music entry. Its duration is measured after playback begins, when that file is already fetched; the rest of the playlist is not downloaded for metadata. `AudioEngine.musicPlayback()` reads the browser output clock and freezes with the suspended audio context. Older runtimes without track metadata show an honest empty state rather than an invented title.

Local verification, 16 October 2026:

- TypeScript/Vite production build passed.
- The browser runtime compiled against a verified, Git-free dependency copy exported from canonical OpenRA main `8dfa3b12ea9039b1f23dcaf6d7e9e0d3405bdd28`, with the existing `r3-20261015` mod input snapshot. No engine source or public runtime was changed.
- `tools/now-playing-browser-test.mjs` passed against an actual interpreter skirmish. The engine selected **Desert Convoy** (`rtsai-desert-convoy.ogg`, 154 seconds). The test verified advancing audio time, duration, music-only mute, paused clock, Escape/focus return and expanded popover bounds at desktop and landscape-phone sizes, including RTL.
- Expanded screenshots were inspected in `artifacts/now-playing/{desktop,phone,phone-rtl}.png`.

For a local server carrying a rebuilt runtime, set `RTSAI_TEST_URL` to its complete profile/runtime URL and run `node tools/now-playing-browser-test.mjs`. The local verification used `http://127.0.0.1:3540/?profile=public&runtime=interp-nowplaying`.

This change requires both the new page and runtime for track metadata. It remains local; any future public release must use `tools/release-play.mjs` with explicit deployment authorization.
