# Faction showdown — 21–22 October 2026

Every faction against every faction, AI against AI, in the live web game (rtsai.net/play), to see who wins and to find
bugs. 470 games in all, plus a per-faction coverage check and an effects audit of every unit and weapon.

## Open the reports

- [`after-fix/report.html`](after-fix/report.html): the round that counts. 230 games on the fixed AI (120 at no starting
  units and $10,000, plus 110 follow-ups for the lopsided pairings), coverage check, bugs, why sides win, best-battles
  reel.
- [`before-fix/report.html`](before-fix/report.html): the first 120 games (no starting units and heavy units at
  $5,000/$10,000/$20,000), before the AI built the original countries' own units, with 30 match films.

The pages are self-contained except for video. To play the videos, download the release assets of
`eval-faction-showdown-20261022` (GitHub, this repository) into the folders named below:

| Asset | Put it in |
| --- | --- |
| `after-fix-best-battles.mp4` (and `-phone.mp4`) | `after-fix/reel/faction-showdown-best-battles.mp4` |
| `before-fix-best-battles.mp4` (and `-phone.mp4`) | `before-fix/reel/faction-showdown-best-battles.mp4` |
| `before-fix-films.tar` | extract into `before-fix/videos/` (`tar -xf before-fix-films.tar -C before-fix/videos`) |
| `replays.tar.gz` | every scored game's replay (`{scenario, log, tick}`); `tools/film.mjs` films any of them |

## Results (after the fix)

| | Score |
| --- | --- |
| Hezbollah, Iran | 86% |
| Saudi Arabia | 84% |
| Türkiye, China | 82% |
| Yemen | 78% |
| Russia | 72% |
| Libya, Iraq | 68% |
| Israel | 56% |
| Cuba | 54% |
| France, Korea, America, England, Germany | 22%, 15%, 14%, 12%, 8% |

The original Allies won 6, lost 95 and drew 4 against the modern nations, and 2–46–12 against the original Soviets
(every such pairing played three times). They destroy 0.46–0.65 credits of enemy value per credit lost; every other
faction 1.24–1.82. Their economies are as good as anyone's; their retail Red Alert 2 statistics lose to the tuned
modern rosters. Rebalancing is a product decision and was not made here.

## Bugs found ([`bugs.json`](bugs.json))

| | | Status |
| --- | --- | --- |
| B1 | A sound that fails to download ended the match | live 21 Oct |
| B3 | $2,500 starting cash could never build an economy | live 22 Oct |
| B4 | The AI never built the original countries' signature units | live 22 Oct |
| B5 | Yuri's mind control and carrier/destroyer aircraft did nothing for the original countries | live 22 Oct |
| B7 | Some units vanished when they died (modern infantry vs Tesla/radiation/psychic, original IFV, Dolphin, Squid, burning dog) | live 22 Oct |
| B2 | Missing CDN files answered 200 with a placeholder; open tabs broke after a release | live 22 Oct |
| B6 | The main menu polled a missing file every 5 seconds | live 22 Oct |

## Keeping it from regressing

`node tools/gameplay-check.mjs --pack <data>/public/web-bundle.pack` (repository `tools/`, about 5 minutes) runs
`websim effectsaudit` (every roster unit of every faction killed by each damage set; every weapon's impact on each
kind of target and as a miss) and `websim effectstest`. Before the fix: 329 of 3,912 deaths drew nothing. After: 0.
[`data/effects-audit-live-20261022.json.gz`](data/) and `data/effects-audit-fixed-20261022.json.gz` are the two runs.

## What is here

- `data/`: every game's result with its census and timeline (`*.results.jsonl.gz`), the job lists, the build each
  round ran on, the coverage check per faction, both effects audits, the rosters.
- `tools/`: the harness as it ran (paths point at `hq/games/artifacts/faction-showdown-20261021`, where the working
  copy, page twins and replays live): `match.mjs` (one AI-vs-AI game), `tournament.mjs` (rounds with job claims),
  `film.mjs`/`films.mjs` (replay films with a broadcast overlay), `reel.mjs` (best-battles reel), `report.mjs`,
  `coverage.mjs` (buildable / fires per faction), `effects-probe.mjs` (deaths and impacts in a real browser game),
  `notice-check.mjs` (the reload notice), `bundle_rules.py` (test a rules change through a patched bundle).
