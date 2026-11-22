# Full release of main — 21 November 2026

Released on the owner's word, in session `release-check` of the RTS AI production push: "Yes, prepare it" (21 Nov,
evening), then "Yes, promote" (22 Nov, 08:40 Doha). Every session's work on main since the 16 Nov page went out with it:
95 commits in this repository and 20 in RTSAI-Mod since the live data's mod.

What players get:
- The nine original countries look, sound and fight more like RA2: their units and buildings die with RA2's own sounds
  (a building cries once), and their other trait sounds are RA2's; damaged ships, tanks and aircraft smoke; the Prism
  fires its glowing house-colour laser; the Flak Track's gun sits on its deck; impacts are chosen by damage and blasts
  are translucent; torpedo bubbles, flak shells and missile trails draw in RA2's palette.
- **Gameplay changes:** Patriot and Aegis missiles lock on and fly at RA2's missile speed (measured on the 16 Nov build,
  F-15s go down 3.6 s and Apaches 7 s sooner); missiles of old and new countries reach their full range; modern blasts
  are sized by damage; the original Sniper hits at once (web only: the desktop game still fires a bullet); bots build
  Terror Drones, Demolition Trucks and Terrorists and open with a second refinery.
- Selection boxes fit each unit, with RA2's corners and a pip health bar.
- "Your first battle" on the main menu; a stronger adviser (base, money, waves, scouting, the enemy base remembered).
- Multiplayer keeps the game's speed at any ping, says why it waits, and words leaving and failed joins clearly. When
  two players' networks cannot reach each other, the page now asks the relay function (live on rtsai-net since 20 Nov,
  on the owner's yes) for Cloudflare relay credentials (`d258ebd`); not yet tried on production after the promote.
- The Battle simulator: see inside a fight, a replay timeline that stops with the battle, Play from here, per-unit
  what-ifs, random maps and saved setups, the map editor's own ground.
- Menus, campaign briefings and result screens fit laptop windows; the campaign radio does not replay after a resume.

## Identities

- Production `dpl_GpUfkiY1CKbfz3MPeeKbFXsyDQqd` (preview `dpl_HEFf8X8wGDwE8bJa1kdjhu33JAav`, previous production
  `dpl_9e31xwVncGR8UYd1vr5TJrLaZqW9`), release `2026-11-21T17-40-00-273Z`, standard build machine. Vercel: $0 due;
  Build Minutes, Build CPU Minutes and Deployment Storage $0.
- Page main `4744e75`, built against the published website `3150776` (`--published-site`: RTSAI-Web's canonical
  checkout holds three unpushed commits of other sessions, left untouched).
- New runtime `rt-e8efeba0c384/` (source 4744e75, engine 8dfa3b12ea, mod 85e68ba043b3), new data `data-412d5591f280/`
  from RTSAI-Mod main `cdd72fb`. Public bundle `e1dd386decd67693f6b8` (3,135 core, 584 art, 1,953 audio files; pack
  sha256 3a1b5c35…); Classic bundle `66af58fcf826d815bb83` (the published one, core pack sha256 71dcd134…).
- CDN rtsai-play-cdn (deployment b278dc92): the root `data-2276dd88d67f/` retired first (`ecc9949`; its permanent
  deployment https://e510972d.rtsai-play-cdn.pages.dev/ serves all 2,592 entries and both bundles, and its two
  saved-battle versions are pinned there); added the runtime and data roots: 19,856 files, 50 header rules.
- 37 saved-game engine/content pairs retained on immutable deployments.
- Quality gate `2026-11-21T17-12-44-690Z` passed all six steps.

## Checks

- Gameplay check: 3,912 deaths and 1,565 weapon impacts drawn, 0 failures; the weapon fidelity audit 18 accepted
  findings, 0 new; both games agree (72 accepted differences, 0 new; Classic 0); the faction catalog matches.
- Quality gate: source, typecheck, 31 unit scripts, five smoke matches (four isometric, one Classic), eight browser
  paths, gameplay.
- Release smoke on the Cloudflare roots: all five matches start, tick and free their textures.
- Independent live check: rtsai.net/play BUILD.json names page 4744e75, rt-e8efeba0c384 and data-412d5591f280 with the
  isolation headers; the live public pack is the built one (and has its gameplay receipt); the live Classic pack is
  byte-identical to the 15 Nov one; the old faction name is in neither pack; the page opens to the sign-in screen with
  no console error; the retired root answers 404 on the shared alias and 200 on its own deployment.

## Two things found on the way

- The first data build stopped on "packed object ... is corrupt" in RTSAI-Mod while archiving the inputs. Read again,
  the object was sound, and `git fsck --full` found nothing: a one-off read error (this PC has faulty RAM). The rebuild
  went through, and every later identity check (Classic's bundle, the pack the gate checked, the pack Cloudflare serves)
  agrees.
- The gameplay check failed once on a stale accepted entry: `0677772` made the web Sniper's `ea-retail-awp` an
  InstantHit, and `tools/roster-audit/accepted-differences.json` still recorded it as a Bullet. Only that field changed
  (`4744e75`); the owner accepted it with the promote.

## Not in this release

- The Lebanon chapter's Relay film and radio voices: the page asks for `campaign-v2/lebanon-relay/`, and the CDN has
  them only under the old name. The fix (7 byte-identical files and one index line, prepared by the campaign session in
  `D:\Generated\RTSAI\campaign-20261120\fix-relay-files`) can only go up with a Cloudflare upload, which happens at
  `prepare` and reaches players at once, so it waits on the owner.
- The desktop game: Windows is still 0.4.0-alpha.4 (14 Nov).

## How it was built

Work folder `F:\work\release-check-20261120\rel` (deleted afterwards). The build script, step log, logs, the retired
root's proof, the gate's GATE.md and the smoke pictures are kept in
`D:\Generated\RTSAI\release-check-20261120\release-20261121`. Order, as on 15 Nov: retired-root proof; push;
`prepare-inputs.py --committed`; `prepare-ea-art.py` plan, extract through a shim of real copies (no junctions),
manifest, verify (599 art entries, 604 sound clips); `public.py --ea-art`; the live public core from the CDN folder;
`prepare-gameplay-release.py` (84 reviewed overlays unchanged); unpack and bake; Classic reassembled from the live gate's
kept data root and proven to be the published bundle; `build-public.mjs --data-only`; `gameplay-check.mjs`; the quality
gate with `--pack --data --inputs --published-site`; `release-play.mjs prepare --published-site --data --inputs`;
`promote`.
