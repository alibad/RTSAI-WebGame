# Units no longer vanish when they die; missing files answer 404 — 22 October 2026

Production: https://rtsai.net/play/

The owner noticed units that "just disappear" when killed, and rockets that seemed to land with no impact. A new
engine-level audit (`websim effectsaudit`) killed every roster unit of every faction with each of the 12 damage sets
weapons deal and fired every weapon at every kind of target, counting only what the snapshot sends the browser. On
the live data 329 of 3,912 deaths drew nothing; every impact drew. This release fixes every one of them, plus faction
showdown bugs B2 and B6.

## What players get

- **Every unit leaves something on screen when it dies.**
  - Modern infantry (all seven modern nations) killed by a Tesla trooper, coil or tank, a Desolator or Yuri used to
    vanish: their art has no melt, psychic or zap frames, and their rules had removed that death animation. They now
    play their ordinary falls (RTSAI-Mod `f530495`).
  - The original countries' IFV kept no death explosion: the overlay switched off the ordinary one although only the
    demolition variant has an original twin. It explodes again.
  - The Dolphin's death pointed at blank shadow frames; it now rolls over (its last 12 drawn frames).
  - The Giant Squid had no death at all; it plays its retail one.
  - A burning dog falls too. (`tools/ea_gameplay.py` in RTSAI-WebGame `9711ab8`, checked by `test-ea-art.py`.)
- **Impacts:** every weapon with an explosion drew it in all 1,567 cases (vehicles, infantry, buildings, aircraft,
  ships, and misses on ground and water). In two live-like AI games the effect sheets loaded within seconds and no
  effect draw was skipped, so "a rocket lands with no impact" was not reproduced as such. A unit vanishing as the
  rocket lands looks exactly like it, and that is fixed.
- **After a release, an open tab no longer reads a placeholder for its files** (bug B2). Missing CDN files answer 404:
  the release tool writes `404.html`, and every page fetch handles a non-OK status. An open page compares BUILD.json
  with its own roots on focus and every 10 minutes, and shows "New version ready. Reload" without forcing it.
- **The main menu stops asking rtsai.net for a local-only file every 5 seconds** (bug B6, `ContentStatus.tsx`).

## Gameplay check (new)

`node tools/gameplay-check.mjs --pack <data>/public/web-bundle.pack` builds the native runner from the pinned engine
and origin/main's mod, unpacks the bundle and runs `websim effectsaudit` and `websim effectstest`; it exits non-zero
on any failure. `docs/DEPLOY-PUBLIC.md` makes it the check before any new data root.

- Live data before this release (`data-b1abd205626b`): effectsaudit FAIL, 329 failures; effectstest pass.
- This release's bundle: effectsaudit PASS (3,912 deaths, 1,567 impacts, 0 failures); effectstest pass.

## How it was built

Mod main had changed by `f530495` alone since the live data's input (`b286b94`). So the release packages exactly that
onto the published profile instead of a full rebuild:
- `tools/prepare-rules-release.py` swapped the 8 changed rule files and the regenerated original-country content in.
- Only the lines matching the death fixes changed in the content: `ea-art.yaml` and `ea-sequences.yaml`.
- The other 5,575 files are byte-identical.
- The content was regenerated from the frozen release input plus `b286b94` and `f530495`, with the generator fixes.
- Sprites were re-baked, because the Dolphin and Squid death frames are new art. That re-packs the sheets under new names.
- Classic is unchanged.

```sh
python tools/prepare-content.py --mod <frozen input + b286b94 + f530495> ... --ea-art D:/rtsai-full-20261021/ea-art --out <rel>/content
python tools/prepare-rules-release.py --base <data-b1abd205626b public> --mod <RTSAI-Mod> --from b286b94 --to f530495 \
  --files <8 rule files> --out <rel>/final/public --content <rel>/content --content-files ea-art.yaml ea-sequences.yaml \
  --content-lines '<only the death-fix lines>' --content-source 9711ab8
websim unpack --pack <rel>/final/public/web-bundle.pack --root <rel>/vfs-iso --audio
websim bake --root <rel>/vfs-iso --maps all --out <rel>/final/public/sprites
node tools/gameplay-check.mjs --pack <rel>/final/public/web-bundle.pack        # PASS
node tools/build-public.mjs --data-only --data <rel>/final/public --classic-data D:/rtsai-full-20261021/final/public-classic --out <rel>/static
node tools/release-play.mjs prepare --data <rel>/static --update "..."; node tools/release-play.mjs promote
```

## Verification

- `test-ea-art.py --content <regenerated>`: 38 tests pass; the new deaths test fails on the previously published content.
- `websim effectstest` and `npx tsc --noEmit` pass.
- Reload notice in a release-style build: absent while BUILD.json names this page's roots, shown once it names newer
  ones. No `api/content-status` request in 12 seconds on the menu.
- Release smoke: public skirmish 205/200/201 ticks, original-art battle 201, Classic skirmish 202; textures released
  after quitting.
- The live `web-bundle.pack` is byte-identical to the audited bundle.
- Missing CDN paths answer 404 (177 bytes).

## Release identity

- Page main `7641d02`, runtime `rt-7824bd8bb601/` unchanged.
- Data `data-bad1fbdfc616/`, public bundle `d8563ec1e28f383f895f` (from `ee15e53f0ebfa495bf50`).
- Cloudflare rtsai-play-cdn:
  - Added `data-bad1fbdfc616/` and `404.html` (41 header rules, 18,018 files).
  - The alias root `data-b80ffa239e04/` moved to the retired folder; its saved battles load from their immutable deployment.
  - `data-5371825e5fda/`, `data-d6eab40ee94c/`, `data-b9e0c656e8e4/` and `data-b1abd205626b/` remain served.
- Vercel: standard build machine, $0 due. Preview `dpl_63SyD98wjrcLQaU8zuDm7rpKeACF`; production
  `dpl_DzSJXrLUwxCjvGEyApyd9fewdHvX`.
- Release `2026-10-22T08-24-01-927Z`, receipt `D:/rtsai-play-release/releases/2026-10-22T08-24-01-927Z/receipt.json`.
- Evidence: `evals/faction-showdown-20261022/` (effects audits, bugs) and
  `hq/games/artifacts/faction-showdown-20261021/release-effects-fix/`.
