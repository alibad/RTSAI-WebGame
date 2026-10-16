# Campaign victory acceptance — 16 October 2026

**Result: 13/13 victories**, with every required objective complete, a rendered debrief,
saved completion, and zero page errors. Twelve missions use the shipped Auto adviser;
Sweet Water uses the careful player described below. These are full native missions,
not the short objective fixtures used for release plumbing checks.

Acceptance scope: all 13 original browser campaign scenarios on Normal, seed 2026, fog enabled,
10,000 starting cash, at 8× game speed. The test player issues ordinary validated native orders;
it never grants resources, spawns or removes actors, changes objectives, or forces an outcome.
Each accepted run must reach native `Won`, render **Operation complete**, save its completion in
`rtsai.missions.completed`, complete every required objective, and have no page errors.

The full evidence is retained locally in `artifacts/campaign-victory-20261016/`. The `final/`
directory contains one result receipt, final native observation, and screenshot per mission.
`final/report.html` provides the visual index and `final/summary.json` the machine-readable index.
Earlier failed and interrupted runs remain in their own directories for comparison.

| Mission | Game minutes | Required objectives |
| --- | ---: | ---: |
| Jizan Corridor | 3.88 | 3/3 |
| Hodeidah Lifeline | 3.27 | 4/4 |
| Haitan Network | 2.00 | 3/3 |
| Bab al-Mandab Passage | 1.81 | 4/4 |
| Relay Under Siege | 6.63 | 3/3 |
| Straits Shield | 13.11 | 4/4 |
| Lights in the Water | 9.66 | 6/6 |
| Hold the Ferry Line | 12.02 | 4/4 |
| Sweet Water | 7.53 | 4/4 |
| Glass Island | 2.76 | 4/4 |
| Black Platform | 4.76 | 5/5 |
| Ghosts on the Glass | 9.75 | 4/4 |
| Every Light On | 10.36 | 2/2 |

The individual receipts and visual report are authoritative for per-objective details,
including optional bonuses. Additional regression runs win Jizan in 2.57 and Ghosts in
9.87 game minutes after the landing changes.

## Corrections

- Let synchronized orders settle before making the next purchase, preventing duplicate queues.
- Prioritize base survival before gated assaults; keep a home reserve and escort engineers.
- Use available anti-armor teams and technicals for factions without tanks.
- Build an affordable missile fleet and reserve its budget, rather than buying mainland tanks
  while ships wait for money.
- Give ships approach orders for shoreline targets even when the ground grid marks their cell
  passable. The engine's naval locomotor determines the legal approach.
- Demote lost mobile contacts until other known targets have been visited, and search water
  for lost ships.
- Load actual infantry and engineers onto amphibious carriers, clear the hostile surface group,
  cross, unload, and advance the landed force on its own connected island.
- Release disembarked troops from carrier reservations immediately so they can clear the beach;
  keep mainland regrouping and home-guard rules from recalling the landing force. Recognize
  the faction's abbreviated AT Specialist label when buying reinforcements.
- Stop Relay's free scripted waves after its authored four-minute defense phase. Surviving
  enemies and the command-post counterattack remain. This controller change is mirrored in
  `RTSAI-Mod/OpenRA.Mods.RTSAI/Traits/RTSAICampaign.cs`.

Sweet Water uses the careful `WaterPlayer` strategy from `tools/campaign-player.mjs`, ported
from the existing native campaign probe. It regroups at roadblocks, maintains home defense,
and captures the plant and vault behind an escort. This proves completion with normal player
commands; it does not claim the shipped Auto adviser reliably completes that chapter.

## Supporting verification

- 26 mission-adviser regression tests pass; TypeScript passes.
- The base adviser passes 351 Python parity cases across the shared, standalone and Classic
  catalogs (`PYTHON` points to the installed interpreter on this Windows machine).
- Relay also wins seeds 2027 and 2028 (5.88 and 7.90 game minutes), in addition to seed 2026.
- Native desktop build and rules/settings/standalone checks pass. The rules check reports two
  warnings; full output is preserved in `desktop-parity-test-final.log`.
- Local runtime smoke passes RA2, Classic, and repeated starts with no page errors.
- Local runtime: `rt-1d810a853608/`; engine `8dfa3b12ea`; retained campaign data
  `data-790a042d842e/`. The official release tool produced the runtime; its dry preparation
  stopped before the page step because the website checkout had unpublished work.

This is local validation, not a production deployment. Easy and Hard, all optional bonuses,
and a subjective human difficulty review are outside this acceptance pass.

## Reproduce

Use a local static build with the campaign runtime and data configured as above, then:

```powershell
node tools/campaign-playthrough.mjs --url http://127.0.0.1:3485/?mode=missions --out artifacts/campaign-victory-20261016/repeat --scripted-water --limit 35 --speed 8 --jobs 2
node tools/campaign-playthrough-report.mjs artifacts/campaign-victory-20261016/repeat
node tools/mission-adviser-test.mjs
```

For diagnostic observations at each game minute, run `tools/chapters-playtest.mjs` directly
with `--diagnostic-samples`. `--seed` selects the first seed; `--runs` increments it thereafter.
