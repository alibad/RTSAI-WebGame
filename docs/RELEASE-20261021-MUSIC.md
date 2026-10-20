# Final Push removed from live and saved battles — 21 October 2026

The source soundtrack had already replaced Final Push, but the live data pack and
immutable saved-battle packs still contained it. Removing a source manifest entry
did not update those already published playlists.

The browser worker now applies a presentation-only retirement policy to every
soundtrack, including archived versions. Final Push is absent from the library,
direct selection and next/previous traversal. Native automatic selection is moved
to an available track before any of its PCM reaches Web Audio. PCM waits until the
native call returns and identifies its song; stop, paused seek and volume events
keep their ordering. Original simulation inputs and save identities are unchanged.

The published catalog refreshes the compatible client for all ten archived
identities. Original packs and previous frozen clients remain available for
recovery. Reopen through the current game/save library to use the repaired client;
an already open old page keeps its previously loaded code until navigation.

## Verified release

- Page `b2642c4`, committed/pushed on canonical main.
- Runtime `rt-738104198cd2/`, data `data-6d6e5f05c328/`, both unchanged.
- Compatible saved client `saved-clients/b2642c4e4dfe/`.
- Release `2026-10-20T21-13-42-865Z` (21 October in Riyadh).
- Preview `dpl_GUVDrMQUvb62xef7Y2mqF1m86dNT`; production
  `dpl_E1zk1xQ6vqXu1FLT46a1icuurucN`.
- Official `tools/release-play.mjs prepare` and `promote`; preview bytes and
  isolation headers checked, live BUILD verified. No CDN pack was rewritten.

## Validation

- `tools/soundtrack-test.mjs`: legacy catalogs, direct selection, next/previous
  wrap, automatic rotation with zero retired PCM, paused seek event ordering,
  stop/reset and an empty remaining library.
- TypeScript, Web Audio capability checks and save compatibility checks pass.
- All five packaged-game smoke matches pass, including Classic, without memory
  growth across repeated identical matches.
- Actual WASM browser test plays all ten remaining tracks, verifies transport,
  pause/seek/resume and rejects direct Final Push selection.
- Original Hormuz restored paused at tick 13,010 (8:40), with its complete log,
  selection and groups deep-equal to the original recovered save. The original
  runtime/content identity is retained and its playlist also has ten tracks.

Local evidence: `artifacts/music-retirement-20261021/` in the games workspace.
Source bundle and receipts: `E:/rtsai-backups/music-retirement-20261021/`.
