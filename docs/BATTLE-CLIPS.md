# Battle clips for the Review inbox

Short films (20 to 40 seconds) of real fights, for the owner to judge by eye in the Review inbox
(`RTSAI-Web/docs/review-inbox.md`). Started on 20 November 2026 as the "battle simulation" front.

Each clip is one row of a coverage grid, [`evals/battle-review/grid.json`](../evals/battle-review/grid.json): two
countries, their units, one way of fighting. The grid is curated, not generated: every clip has a reason to exist
(its `why`). On 22 October 2026 the owner stopped a 240-film run in favour of coverage plus targeted games; keep it
that way.

## How a clip is made

`tools/battle-clips.mjs` opens the Battle simulator's own link (`?mode=sandbox&s=...`, `web/src/sandbox.ts`) for the
row, lets the simulator run it, and films the battlefield.

- **Side A is the player's.** Its units carry the simulator's opening orders, and a row's `script` gives further
  orders the way a player does (select, then a right-click on the target).
- **Side B is the engine's AI** at the row's skill (Normal by default), also starting from its units' opening orders.
- Nothing is approximated: it is the game's page, runtime and data. The simulator's panels are hidden in the film,
  not removed.
- The camera shows both armies while they stand and approach, then closes in on the units being hit and whoever
  stands near them, so the fight fills the picture. `"camera": "all"` keeps everyone in frame for the whole clip
  (long-range fights, where the launch and the landing are far apart).
- The clip opens on both armies standing (the run is held on its first tick for a second), then plays in real time
  until the row's seconds are up or one side is gone.

It writes, into the `--out` folder: each clip's `.mp4` (1920x1080, 30 fps) and poster, `flags/`, `icons/` (each unit's
build icon exactly as the game draws it), `clips.json` (what `node tools/review.mjs add <folder>` in RTSAI-Web takes,
with a link that opens the same fight in the game) and `report.json` (per clip: who fired, who died, the timeline).

## Which build

Film the build players have: the page the last release smoke-tested, which is the live page without the sign-in gate,
reading the live runtime and data from the game's CDN.

```sh
node tools/release-play.mjs status      # what is live, and whether main still matches it
node tools/static-serve.mjs --dir D:/Builds/RTSAI/play-release/releases/<live release>/smoke-page --port 3475
node tools/battle-clips.mjs --grid evals/battle-review/grid.json --out <folder> \
  --flags D:/Builds/RTSAI/play-release/releases/<live release>/smoke-page/flags
```

Put the build in the grid's `build` (page commit, runtime root, data root): it travels with every clip. To film a fix
that is not released yet, serve a page built from it instead (`tools/build-public.mjs`, or a `release-play.mjs
prepare --dry` build) and say so in `build.label`.

`--only id,id` films some rows again; `clips.json` and `report.json` keep the others. One clip takes about three
minutes. Work in `F:\work\<topic>-<date>\`, not in the repository.

## The grid's columns

**Countries:** the sixteen in the game's rosters.

**Unit classes:** infantry, vehicles, aircraft, ships, defences, special (abilities and special weapons).

**Attack modes.** "Attack modes" is the owner's phrase. Checked against the orders the game really has (the command
bar: attack-move, guard, scatter, deploy, stop; four stances; a right-click attack; support powers) and what the
simulator can open a fight with (`engage` = attack-move to the enemy, `hold` = the Defend stance, `move`, `deploy`):

| Mode in the grid | What happens in the game |
|---|---|
| `attack-move` | Both sides get the attack-move order toward each other. |
| `direct` | The player selects everyone and right-clicks one enemy: a direct attack order. |
| `defence` (hold ground) | The player's side stands in the Defend stance, or is a line of defences; the AI attacks it. |
| `deployed` | The player's units deploy first (G.I.s behind sandbags), then hold. |
| `siege` | Long-range units attack-move and stop at their own range to shell defences. |
| `air-strike` | Aircraft attack-move onto ground units. |
| `anti-air` | Aircraft fly into air defences: the clip is about what shoots up. |
| `naval` | Ships and submarines, on a map with water. |
| `special` | A special ability decides the fight (mind control). |

Not filmed yet, each needing more than opening orders: garrisoned buildings (an enter order, on a map with
buildings), superweapons (they need minutes to charge), guard and escort orders, force-fire on ground, ships shelling
the shore, transports and landings, engineers and spies, repair.

## A row

```json
{ "id": "battles-cuba-france-siege", "title": "V3 launchers shell a gun line",
  "why": "Do the rockets launch, arc and land with a blast, and do the Grand Cannon and Prism Tower answer?",
  "classes": ["vehicle", "defence"], "mode": { "id": "siege", "label": "Long-range siege" }, "gap": 26, "seconds": 34,
  "a": { "faction": "cuba", "units": [{ "id": "v3", "count": 4 }, { "id": "htnk", "count": 2 }] },
  "b": { "faction": "france", "units": [{ "id": "gapill", "count": 2 }, { "id": "gtgcan", "count": 1 }, { "id": "gapowr", "count": 2 }] } }
```

- Units are the game's actor ids; each side's first group stands in front. `count`, and per group `order` (`engage`
  by default, `hold`, `move`), `deploy`, `rows`, `level`.
- `gap`: cells between the two front lines (12 by default; more for long-range fights). `map` (`web-arena` by
  default), `centre` (the cell between the armies), `seconds`, `skill`, `camera`, `zoomMin`, `zoomMax`, `fightMin`
  (the least zoom once the fighting starts).
- Defences that need power get a power plant in their own side's last group.
- Ships need water: `node tools/battle-clips.mjs --probe <map> --unit <ship>` draws where a unit can be placed.
- `script`: the player's orders during the fight, e.g. `[{ "at": 0.4, "do": "attack", "target": "apoc" }]`.

## Watching your own clips first

Before anything goes to the owner, watch every clip. `report.json` and the `suspects` in `clips.json` come from the
simulator's own counts (a unit type that recorded no shot, a fight where nobody died, a unit the map refused, a page
error): they are leads, not verdicts. Look at the frames, drop broken recordings, and rewrite the suspects into what
you actually see. Some units never "fire" by design (suicide drones, a demolition truck).

```sh
ffmpeg -i <clip>.mp4 -vf "fps=1/2.5,scale=960:-1,tile=4x3" -frames:v 1 <clip>-sheet.jpg     # twelve frames on one sheet
```

Clips are silent for now: the recorder films the page's frames only. Sound needs its own capture.
