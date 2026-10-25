# The quality gate (since 26 October 2026)

One command, run on this machine before any release of rtsai.net/play, that leaves a dated receipt. It does not add
checks of its own: it runs the ones this repository already had, in one fixed order, so "it passed" means the same
thing every time and can be read back later. There is no hosted CI (owner rule: no GitHub Actions, no costs).

```sh
node tools/quality-gate.mjs                      # everything: about 15 minutes
node tools/quality-gate.mjs --only unit          # one step while iterating
node tools/quality-gate.mjs --only browser --page-url http://127.0.0.1:3493/   # the browser step on a page you serve
node tools/quality-gate.mjs --pack <data>/public/web-bundle.pack               # also the gameplay check (new data root)
node tools/quality-gate.mjs --prepare "<what players get>"                     # the real prepare instead of the dry run
```

| Step | What passes | Where it comes from |
|---|---|---|
| source | checkout clean, on main, not behind the freshly fetched origin/main; unpushed commits are noted, not refused | git |
| typecheck | `web/` compiles | `tsc --noEmit` |
| unit | every script in `tools/quality-gate.json` "unit" exits 0 (Node and Python tests that need no browser) | the existing tests |
| release | `tools/release-play.mjs prepare --dry`: the page built from main against the live Cloudflare roots, then `tools/release-smoke.mjs` plays five short matches on it (each starts, ticks and draws, textures are freed after quitting, nothing throws); deploys nothing | the release tool |
| browser | the player's path on that same sign-in-free page, served locally: every script in "browser" exits 0 (menus and modes, the map editor and battle simulator, the campaign screen with its films and a mission launch) | the existing browser tests |
| gameplay | with `--pack`: `tools/gameplay-check.mjs` (deaths and impacts drawn for every unit, web and desktop ship the same units, the catalog copies match). Without it: skipped when the data root is unchanged, failed when the release would ship a new data root | the gameplay check |

The receipt is `D:\rtsai-play-release\gate\<id>\`: `receipt.json`, `GATE.md` (the table above with results), one log per
check, and the browser tests' screenshots. `gate\latest.json` points at the last run. A copy of `GATE.md` lands in
`hq/games/artifacts/quality-gate-<date>/` so the owner can open it from the artifacts folder.

What it does not prove: that the game is fun or that a new player understands it (the owner's ten minutes of play
after each release), that it works on a real phone or in Safari (emulated only), or multiplayer across networks.
`tools/multiplayer-browser-test.mjs`, `random-map-multiplayer-test.mjs` and `saved-maps-browser-test.mjs` need the
Firebase emulators and the website and are run by hand when multiplayer or saved maps change.

## Releasing with it

1. `node tools/quality-gate.mjs` on the latest main. Fix what fails; do not ship around it.
2. `node tools/release-play.mjs prepare --update "..."` (or step 1 with `--prepare "..."`), then, with the owner's
   approval, `node tools/release-play.mjs promote`.
3. Put the gate id in the release record next to the deployment id.

## Keeping it honest

- A test that waits for a button or text that no longer exists is a stale test, not a passing one. When the UI changes,
  the browser tests in "browser" change in the same commit.
- A test whose feature was retired is deleted (the Scenario workshop test went with the Scenario workshop).
- New checks go into `tools/quality-gate.json`, not into a second runner.
- Running the whole gate on every commit is too slow; run `--only typecheck,unit` while working and the whole gate
  before a release or at the end of a day's work.
