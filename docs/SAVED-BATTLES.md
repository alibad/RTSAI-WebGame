# Saved battles across releases

A battle resumes with its original engine, rules, content and custom-map bytes. Never
change a save's identity to the current build or skip native replay hash validation:
doing so can silently change the battle or lose its progress.

`save-versions.json` is the site's trusted archive catalog. Its identities hash the
decoded runtime identity file and content bundle. Each entry pins an immutable
Cloudflare deployment and a compatible UI/worker under the game's own
`saved-clients/<commit>/` path. Keeping the client on the same origin preserves access
to the player's browser saves and map library. An imported save cannot choose an
executable URL; only the published catalog can do that.

`tools/release-play.mjs` verifies new archive hashes, carries forward every previous
catalog entry, freezes the client and preserves previous page files during release.
Never delete a Cloudflare deployment or frozen client referenced by this catalog.
Retiring a root from the moving CDN alias is safe only when its immutable deployment
remains available. The initial historical seeds are recorded in `release-play.json`.

Custom maps are embedded in new match exports. Legacy saves can recover their exact
map by ID from the browser's map library; adding this metadata never changes their
recorded orders, target tick, frame hashes, selection, groups or camera. A genuinely
missing legacy map must be recovered from its original files, not regenerated as an
approximation. Quitting an archived battle returns to the current game for new matches.

Reviewed legacy recovery exports may be shipped under `web/public/saved-maps/`, keyed
by the exact map ID and original simulator/content hashes. Recovery never relaxes the
native replay checks. The original Hormuz export reproduces all 13,010 recorded
simulation frames; its later cosmetic sand stroke could not be recovered. That limit
is recorded in the asset provenance and the save's `mapRecovery` notice. Keep the
original save payload and backup unchanged; add only the recovered map metadata.

Restored battles start paused at the saved tick, so graphics loading cannot consume
battle time before the player has control. `saveClientRefresh` is a one-time explicit
UI repair for the first archived client: its worker protocol and native identities
stay unchanged, and the previous files remain available as a recovery backup.

Retired soundtrack entries are a presentation policy in `sim/soundtrack.ts`, applied
by compatible browser workers even when an old save retains its original audio pack.
Final Push is excluded from the library, transport controls and automatic playback.
PCM is held until the native call returns and its track identity is known, so no
opening fragment escapes. This does not alter map files, simulation rules, orders,
frame hashes or saved ticks. Refresh the compatible client catalog explicitly when
shipping this policy; preserve the old clients and immutable packs for recovery.

Saves are retained until the player explicitly deletes them. Storage pressure may
omit the new thumbnail, but must never evict an earlier battle or discard map bytes.
If the remaining save will not fit, report the failure and leave earlier saves intact.

Run `node tools/save-compatibility-test.mjs` and `npm --prefix web run typecheck`.
For end-to-end release QA, save a custom-map battle, update to a different runtime and
content pair, resume through the library, verify the original tick and world, and
check that leaving returns to the current client. Test the real legacy save too;
the native restore must validate every recorded frame hash before resuming it.
