# Grid button — 16 November 2026

Released on the owner's word. Comparing the website's old Map Workshop with the game's own Map editor and Battle
simulator, the owner said: "I really like the grid approach and the map. Maybe if we can like enable that mode, that
would be really cool. So like it feels like an actual calculated thing." After the before/after pictures:
"Yes, release it".

What players get:
- A Grid button on the battle's top bar, the battle simulator's setup bar and the map editor's bar. It outlines every
  map cell, so a battle reads as a board you can count and measure. The lines follow the ground: on hills they step up
  onto plateaus, slopes come out as one smooth mesh, cliffs as a clean step. They lie over the ground, under every unit
  and under the shroud. Classic's square maps get square cells. The choice is kept for the next visit (off by default).
- The sign-in screen's fourth tile reads "Map editor", not "Workshop", and its line names the map editor and the
  battle simulator.

How it works and why no runtime change: `docs/EDITOR-SIMULATOR.md` ("Grid"). The page reads each cell's height from the
terrain the engine already sends (`web/src/render/grid.ts`).

Pictures: `D:\Generated\RTSAI\workshop-compare-20261116\grid-and-links.png` (grid off and on, Valley of Gems; a
simulator battle; a Classic map), from a local build against the live runtime and data.

Sources: this repository 2d67233 (sign-in screen) and a6e9eea (Grid button).

## Identities

- Production `dpl_9e31xwVncGR8UYd1vr5TJrLaZqW9` (preview `dpl_8vxbhWdQszHsXbjPeinekGDwGWGd`, previous production
  `dpl_7nLcwV1dt4YZ2EW3x5dmmWdwhfm1`), release `2026-11-16T12-56-09-372Z`, standard build machine. Vercel this period:
  $0 due; Build Minutes, Build CPU Minutes and Deployment Storage $0. A page-only release: 12 new files.
- Page main `a6e9eea`, built against the published website `3150776` (`--published-site`: RTSAI-Web's canonical
  checkout held another session's uncommitted Concept Forge work, left untouched). The website files the page compiles
  (`@site`) are those of the live page; `ViewerStage.tsx` changed on the website's main since and is not in this release.
- Runtime `rt-93fcc127b22e/` and data `data-ada60803287d/` unchanged; Cloudflare unchanged.
- Quality gate `2026-11-16T12-44-05-960Z` passed (source, typecheck, 28 unit, dry run with 5 smoke matches, 8 browser
  tests; gameplay skipped, data unchanged). It built against the website's main `ae39eed`; the release's own smoke test
  ran on the published-website page: isometric skirmish x3, original-art battle and Classic skirmish all started,
  ticked and drew, textures freed after quitting.
- Checked after promote on https://rtsai.net/play/ (signed in): the Grid button is on the simulator's bar, the grid draws
  over the arena under the placed tanks, no WebGL errors; the owner's grid setting was left off as it was.

## Still pointing at the old /workshop

The website's admin tab, sitemap and noindex were fixed and are live (RTSAI-Web `ae39eed`). Two remain, both real moves:
the Campaign studio's "Open mission" (needs the simulator to run campaign missions and report pass/fail; no "repair"
objective yet) and AI testing's "Use saved Workshop scene" (its lab runs on the old page's battle maths).
