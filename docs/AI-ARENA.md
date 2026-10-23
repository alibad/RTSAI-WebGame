# AI Arena

The Arena answers one question with real games: can a brain play the live game well enough to beat the built-in
AIs, and you? It runs only on the owner's machine. Nothing is deployed, and paid models use the owner's own key under
a spending cap.

- **Page:** the local admin's Workshop → **AI Arena** (RTSAI-Web `/workshop/arena`, admin builds only).
- **Runner:** `node tools/arena/server.mjs`, loopback only. It listens on 127.0.0.1:3463 and serves the live game's
  twin page on 127.0.0.1:3464. The local app (RTSAI-Web `scripts/local-app.ps1`) starts it.
- **Data:** `%LOCALAPPDATA%\RTSAI-WebGame\arena`:
  - `games.jsonl`: one finished game per line;
  - `decisions/<game>.json`: every turn's questions, options, probabilities and orders;
  - `replays/<game>.json`: the game's recorded orders;
  - `runs.json`, `budget.json`;
  - `keys.json`, holding keys pasted in the page.

## What is tested

The live game, exactly. The runner serves the sign-in-free twin page that `tools/release-play.mjs` built for the release
that is live now (`<work>/releases/<id>/smoke-page`, stage `live` in its receipt). That page loads the same runtime and
data from Cloudflare as rtsai.net/play. Every game records which page, runtime and data it ran on.

## Seats

Our seat (Multi0) is played by one of these:

| Brain | What plays |
|---|---|
| Normal AI | The engine's own bot (`normal`): the baseline. |
| Built-in adviser | The public game's co-commander (`web/src/adviser.ts`) on Auto. |
| Decision brain | Closed questions answered by a provider (below). |
| You | You, in a game window the runner opens; your result is recorded. |

The other seat is the engine's bot at the Battle simulator's skills (`web/src/sandbox.ts` `AI_SKILLS`):

| Skill | Bot |
|---|---|
| Easy | Normal AI with a 50 % handicap |
| Normal | Normal AI |
| Rush | Rush AI |
| Hard | Rush AI with 5,000 extra credits |
| Brutal | Rush AI with 15,000 extra credits |

The simulator's Brutal also makes placed units veterans. A skirmish has no placed units, so that part does not apply.

Defaults:
- both sides play the same faction, rotating through the seven modern factions;
- map `ra2-tournament-2B`;
- no crates;
- speed 6;
- a game is a draw after 40 game minutes. Bot-vs-bot showdown games averaged 26.

## The decision brain

`tools/arena/brain.mjs` turns each fog-respecting co-commander observation (`client.adviserObserve()`, the one the
adviser reads) into a few closed questions:

- **Automatic, never asked:** deploy the construction vehicle; place finished buildings.
- **Production, asked every 2 game seconds at most:** one question per idle line: building, defense, infantry,
  vehicle, aircraft, ship.
  - The options are the items buildable now, each described by role, cost and how many we have, plus Wait.
  - Defenses are asked only under pressure or with credits to spare.
- **Army, every 5 game seconds:** attack the nearest known enemy building, defend the base, scout (one scout every 45
  s), sweep toward the far side while the enemy base is unknown, gather, or hold.

The chosen options become the adviser's own command types, sent through `client.adviserExecute()` in groups of at most
12 commands. They are synchronized player orders and go into the replay like clicks.

Providers (`tools/arena/providers.mjs`) all answer the same questions and return a probability per option:

| Provider | Call | Price (input; output free) |
|---|---|---|
| Scripted scorer | Hand-written scores, softmax. Free. It is the bar a model has to beat. | $0 |
| Local model | OpenAI-compatible gateway (`OPENRA_AI_ROUTER_URL`, default :4000), JSON-schema enum per question | $0 |
| OpenAI Decisions | `POST /v1/decisions`, `gpt-6-luna`, one `choice` question each | $0.10 / M ($0.01 cached) |
| TypeSafe Jev | `POST https://api.typesafe.ai/v1/systemone`, `jev-latest`, `choice` questions | $0.042 / M |

While a paid or local model thinks, the game is paused. Its latency is still measured and shown, but it does not cost
the brain game time, so results compare decisions, not network speed. If a call fails, the scripted scorer answers
that turn. The turn is marked as a fallback and counted on the page.

## Cost guards

- **Keys:** paid providers need a key. It is pasted in the page and stored in the Arena folder, or read from
  `OPENAI_API_KEY` / `TYPESAFE_API_KEY`. The page only ever shows the last four characters.
- **Caps:** each run has a cap ($0.25–$5, default $1), and the day has one (`budget.json` `dailyCapUsd`, default $5).
  A run stops at whichever is reached first.
- **Scope:** nothing here is reachable from the internet. Public players keep the free built-in adviser.

## Ratings

The ladder fits one rating to every finished game (Bradley-Terry on the Elo scale, two virtual draws per player), with
the Normal AI anchored at 1000. Brains, the opponent skills and you share the same scale. "You" can be compared with
a brain through the opponents both of you played.

## Checks

- `node --test tools/arena/brain.test.mjs`
- One real game (about 3 minutes):

  ```sh
  curl -X POST 127.0.0.1:3463/runs -d '{"brain":"decision","provider":"scripted","opponents":["normal"],"games":1}'
  ```
