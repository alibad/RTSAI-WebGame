# Simulator placement — 8 November 2026

Released on the owner's word ("Yes, release the simulator polish to rtsai.net/play"). This is the owner's 7 Nov feedback on
the Battle simulator from the 14 Oct walkthrough video: "hovering and clicking experiences could be a lot better".

What players get (main `97af600`):
- While placing, the engine draws a see-through copy of what you're placing under the cursor. Buildings show their
  green placement grid, as in a normal game; units show each soldier or vehicle where it will stand.
- Where it can't go (water, cliffs, slopes, other units), the ghost turns red, the cursor shows "blocked", and a click is
  refused with the reason on the map ("Not on water"). Before, a power plant could be placed in a lake.
- A good click lands with a ring and a soft thud; a refused one shakes with a short buzz.
- The cards lift and brighten on hover, press in on click, and the picked card glows until you stop placing.
  Right-click on open ground or Esc stops placing.
- Building and defence cards show the building big, as it looks on the battlefield, instead of its small cameo.
- The editor and missions are unchanged. Classic gets the same placement rule.

Pictures: `D:\Generated\RTSAI\sim-polish-20261107\` (compare-placement.png).

## Identities

- Production `dpl_5z4f7pp9RHpBLUiFXKciHQcuKh3i` (preview `dpl_3W1SBKwKkThpfPzQTR58Hz7KWyJo`, previous production
  `dpl_ES9sjmytGCTrsmaiK5J95hm2rvhX`), release `2026-11-08T04-56-08-775Z`, standard build machine. Vercel this period:
  $6.90 used, all included, $0 due.
- Page main `97af600`, built against the published website `09241fd` (`--published-site`: RTSAI-Web's canonical checkout
  holds the owner's uncommitted Path redesign, which stays untouched).
- New runtime `rt-ae7ffc044131/` (source 97af600, sim hash b9c2eaa5aa3034f4, engine 8dfa3b12ea, mod 20fb84e8d72c).
  Data `data-5eb9c3d0096c/` unchanged.
- CDN rtsai-play-cdn: added the runtime root (198 files); 19,208 files in all, 792 under Cloudflare's 20,000 limit. The next
  new root needs an old one retired first.
- 31 saved-game engine/content pairs retained on immutable deployments.

## Checks

- Quality gate `2026-11-08T04-55-48-187Z` with the real prepare: source, typecheck, 28 unit scripts, five smoke matches on
  the Cloudflare roots, eight player-path browser tests (including the editor and simulator test); gameplay skipped
  because the data root is unchanged.
- Independent live check: rtsai.net/play/BUILD.json serves 97af600 / rt-ae7ffc044131 / data-5eb9c3d0096c, with the
  isolation headers.

## Note: the mod snapshot was rebuilt

A new runtime compiles the mod's code from the same mod source as the live data (here RTSAI-Mod `fcb7346`, mod
identity `20fb84e8d72c`). That snapshot had been made in an F:\work folder on 1 Nov and deleted with it, so the first
prepare refused ("no prepare-inputs output with mod 20fb84e8d72c"). It was rebuilt without a checkout: `git archive` of
fcb7346 through RTSAI-Mod's own `build-inputs.py snapshot --committed` code, with HEAD replaced by that commit. The
identity matched to the byte, and it was passed with `--inputs`. The script is kept at
`D:\Generated\RTSAI\sim-release-20261108\mod-snapshot-at.py`:

```sh
python -B mod-snapshot-at.py <RTSAI-Mod> <commit> <new dir> <expected mod identity>
```

The snapshot itself (416 MB) was deleted after the release; the built runtime stays cached in the release tool's
`runtimes/` folder.
