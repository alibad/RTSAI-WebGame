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
  - Defenses are asked only when enemies are in sight or with credits to spare. A tower that shoots ground units is
    chosen when the enemy is at the base; walls are never offered, and anti-air, coast guns and support buildings are
    left alone.
- **Army, every 5 game seconds:** attack, defend the base, gather at the front, scout (one scout every 45 s), sweep
  toward the far side while the enemy base is unknown, or hold. It fights like a player, not a stream:
  - New units gather at a staging point 40 % of the way to the enemy.
  - Attack sends the idle units gathered forward together, at the enemy's construction yard first, then factories and
    the economy, then the nearest building.
  - Only idle units are ever given new orders, so a fight in progress is never interrupted.
  - Before 23 October every unit was re-sent every 5 seconds. Fresh units trickled into the enemy defences one by one;
    one game lost 53,200 worth of units with a 10× larger army and killed 5 buildings.
- **Adopted on 24 October** (`ADOPTED` in `brain.mjs`), after winning their experiments on the same seeds:
  - **counters:** units are picked against what the enemy fielded in the last two minutes: riflemen against infantry,
    anti-tank teams against vehicles, tanks over scout cars and anti-air. Before, the brain bought the dearest unit
    it could afford. Each unit's description also says what it is good against, for decision models.
  - **hunt:** while the enemy base is unknown, sweeps and scouts work through points across the whole map, nearest to
    the enemy's start first, and move on once the army arrives. Before, they always went to the mirror of our base.
- **Reading a game:** `node tools/arena/game-story.mjs <game id>` prints it minute by minute: what was built, what the
  army did, and what each army turn saw.

The chosen options become the adviser's own command types, sent through `client.adviserExecute()` in groups of at most
12 commands. They are synchronized player orders and go into the replay like clicks.

Providers (`tools/arena/providers.mjs`, `askQuestions()`) all answer the same questions and return a probability per
option:

| Provider | Call | Price (input; output free) |
|---|---|---|
| Scripted scorer | Hand-written scores, softmax. It is the bar a model has to beat. | $0 |
| Laya | The BeTenshi console's local decision service (`:8040/decide`; ModernBERT, Apache-2.0, on the CPU), one question per call, a turn's questions in parallel. | $0 |
| Local LLM | OpenAI-compatible gateway (`OPENRA_AI_ROUTER_URL`, default :4000), JSON-schema enum per question | $0 |
| OpenAI Decisions | `POST /v1/decisions`, `gpt-6-luna`, one `choice` question each | $0.10 / M ($0.01 cached) |
| TypeSafe Jev | TypeSafe's `/v1/systemone` (`jev-latest`) with a TypeSafe key, or the same request through OpenRouter (`typesafe/jev-1.13`) with an OpenRouter key; OpenRouter returns the exact cost | $0.042 / M |

## Experiments, films and the notebook

- **Experiments are flags.** `EXPERIMENTS` in `brain.mjs` lists one rule change each. A run picks one or more
  (`"experiment": "counters"` or `"counters+scouting"`, or the Rules menu on the page).
  - A variant plays the same seeds and factions as the brain without it, so results pair up game by game.
  - Its games are tagged `<BRAIN_VERSION> + <experiment>` and get their own ladder row.
  - A run of the current brain on the same seeds repeats earlier games, which also shows how repeatable a result is.
- **Films:** `node tools/arena/film.mjs <game id>` replays a finished game in the live game's own replay viewer and
  records it, with captions of what the brain decided and saw as it happened (its decision log).
  - **"map":** the whole battlefield, sped up. It also notes where the fighting is each second.
  - **"fight":** a closer camera that follows that track.
  - The explored-map option lifts the black shroud for the camera. Fog stays, so the replay plays out the same: the
    tool prints the replay's ending next to the recorded result.
  - Old replays (before 24 October) kept the Arena's settings instead of the game's scenario; the tool rebuilds the
    scenario from them.
  - Films are in `<arena>/films/`. The runner serves them at `/films/<name>`, with ranges so they can be scrubbed.
- **Story films:** `node tools/arena/story.mjs <notebook entry>` turns a notebook entry into one short film:
  - the question;
  - the change;
  - each game film, introduced by its caption;
  - a results card (each version's wins, draws and losses, counted from the games now);
  - the lesson.

  It writes timed captions (`.vtt`) beside it.
- **The notebook:** `tools/arena/notebook.json`, one entry per question asked of the brain. Each entry has the
  question, the change, the brain versions it compares, the finding, the lesson, a tip, and its films. The runner
  serves it with live results (`/notebook`). The Arena page shows it first: the story film, the game films, the
  results table and the lesson.
- **Restarts:** the runner picks its queue back up after a restart. A game that was playing starts again from the
  beginning.

## Experiments of 24 October: one change at a time

Scripted brain, 4 games per opponent on seeds 1000–1003 (China, Iran, Turkey, Saudi), speed 8, `ra2-tournament-2B`.
"Before" is the 23 October brain with towers only ("24 Oct towers"), 22 games including reruns of the same seeds.

| Rules | Normal | Rush | Hard | Brutal | Wins |
|---|---|---|---|---|---|
| Before | 3 W 1 D 2 L | 1 W 3 D 2 L | 6 L | 4 L | 4 of 22 |
| counters | 1 W 2 D 1 L | 3 W 1 L | 1 W 2 D 1 L | 4 L | 5 of 16 |
| scouting | 2 D 2 L | 1 D 3 L | 1 D 3 L | 4 L | 0 of 16 |
| budget | 3 D 1 L | 2 D 2 L | 1 D 3 L | 4 L | 0 of 16 |
| hunt | 2 W 2 L | 1 W 1 D 2 L | 2 W 2 L | 4 L | 5 of 16 |
| **counters + hunt (adopted)** | **4 W** | **3 W 1 L** | **4 W** | **1 W 3 L** | **12 of 16** |
| counters + hunt + turtle | not run | 3 W, 1 still playing | 2 W 2 L | 1 D 3 L | not adopted |

- **counters + hunt** won the first game ever against Brutal (Iran, minute 20). On the Turkey seed against Hard, each
  rule alone lost at minute 7; together they won at minute 17. Surviving the opening (counters) and finishing the
  game (hunt) were two different problems, and each fix alone looked weak.
- **Repeatability:** rerunning the same seeds with the same brain changed several results. Normal went from 2 wins in 2
  to 1 win, 1 draw and 2 losses in the rerun. Read results over at least 4 games per opponent.
- **turtle** (two towers from minute 1.5 beside the factory, army home until worth 4,000 or minute 8) held Brutal
  longer, up to a draw, but cost two Hard games. A slower brain is not a stronger one.

## Early-defence experiments (24 October, morning)

Goal: survive and beat Brutal (the Rush AI with 15,000 extra credits, at the base by minute 2–5). Scripted brain,
speed 8, `ra2-tournament-2B`, mirror factions. Each version is its own row on the ladder (`BRAIN_VERSION`).

| Version | Normal | Rush | Hard | Brutal |
|---|---|---|---|---|
| 23 Oct strike (+ 24 Oct towers: no walls or anti-air), 18 games | 4 W | 1 W 3 D | 1 W 3 L | 6 L, at minute 6–7 |
| 24 Oct defence: two towers before the factory, army home until worth 4,000, economy paused under pressure | 2 W | 1 D 1 L | 1 D 1 L | 6 L, at minute 7–22 |
| 24 Oct adaptive / scouting: fast factory, towers on pressure, tanks first, scouts on a plain move | 2 L | 1 L | 2 L | not run |

The defensive version made Brutal games last longer (about 11 minutes on average against 6.5) but never won, and it
lost Rush and Hard games that the 23 October brain had won. The live brain is the 23 October one with towers only.

What the game logs showed (`game-story.mjs`), to test one change at a time with at least four games per opponent:

- **"Defend" chases far sightings.** It is offered for any enemy in sight and wins ties with Hold, so the home army
  walks to whatever a scout sees, even at the enemy base. It is a bug, but it is also the brain's only push toward an
  unknown enemy base: fixing it alone made the brain passive, and it lost to Normal.
- **Scouts attack-move:** they stop to fight the first enemy they meet. One game sent 29 scouts and never found the
  enemy base. A plain move needs the attack to change with it.
- **Unit choice by price:** the brain prefers the dearest unit it can afford, so it trains anti-tank missile teams
  against early infantry, and Lynx scout cars as if they were tanks. It should pick against what the enemy fields.
- **Credits at minute 2:** a second refinery, a harvester, the factory and a tower started together leave 0 credits,
  and the army stops growing just as a Hard or Brutal rush arrives.
- **Where the army waits:** 40 % of the way out meets the first Brutal wave alone, without towers; at home it lasts
  longer but lets the plain Rush AI grow to three times our army.

## Voice orders bench

How well each brain reads what the player says, on the OpenRA-AI companion's own 281 spoken/typed order cases
(`OpenRA-AI services/companion/evals/nl_orders`), graded by that benchmark's own grader. The cases mix:

- orders, with slang, jargon, misheard words and several steps;
- refusals (support powers, surrender);
- clarifications;
- questions.

- **Adapter:** `tools/arena/order-adapter.mjs` looks like an OpenAI-compatible model to the companion.
  - The companion asks for an order form: intent, action, units, count, item, target and stance.
  - The adapter makes each blank a closed question, with options taken from the vocabulary the companion sends: the
    units and buildings we have, what can be built or trained, what is in production, visible enemies, named
    coordinates.
  - The decision model picks the answers.
  - Free answers to questions, which a decision model cannot write, go to gpt-4.1-mini.
  - The "LLM" baseline sends the whole form to gpt-4.1-mini, as the companion would with an external model.
- **Two views:**
  - **Every order:** the companion's own rule-based interpreter is switched off in the bench's worker process only
    (`bench-model-only/sitecustomize.py`), so every order is read by the brain. This compares brains.
  - **Full pipeline:** the rules read what they can and the brain gets the rest. This is what the product does.
- **Runner:** `node tools/arena/bench.mjs --orders llm|openai|jev|laya|offline [--path model|pipeline]`, or the
  Arena page's Voice orders card. Records go in `<arena>/bench/<id>/` (record.json, graded.json, report.md,
  model-calls.json).

While a paid or local model thinks, the game is paused. Its latency is still measured and shown, but it does not cost
the brain game time, so results compare decisions, not network speed. If a call fails, the scripted scorer answers
that turn. The turn is marked as a fallback and counted on the page.

## Cost guards

- **Keys:** paid providers need a key. The runner looks in four places, in this order, and the page only ever shows
  where a key came from and its last four characters:
  - pasted in the page (stored in the Arena folder);
  - the environment: `OPENAI_API_KEY`, `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`;
  - `OpenRA-AI/.env`, the companion's own git-ignored key file;
  - `AI/betenshi-console/.env`, whose OpenRouter key the console's Decision Lab already uses for Jev.
- **Caps:** each run has a cap ($0.25–$5, default $1), and the day has one (`budget.json` `dailyCapUsd`, default $5).
  A run stops at whichever is reached first.
- **Scope:** nothing here is reachable from the internet. Public players keep the free built-in adviser.

## Ratings

The ladder fits one rating to every finished game (Bradley-Terry on the Elo scale, two virtual draws per player), with
the Normal AI anchored at 1000. Brains, the opponent skills and you share the same scale. "You" can be compared with
a brain through the opponents both of you played.

## Checks

- `node --test tools/arena/brain.test.mjs`
- `node tools/arena/provider-smoke.mjs openai jev laya scripted`: one real turn per provider, with time and cost.
- `node tools/cocommander-talk-test.mjs`: spoken and typed words reach the order path (no engine or model needed).
- One real game (about 3 minutes):

  ```sh
  curl -X POST 127.0.0.1:3463/runs -d '{"brain":"decision","provider":"scripted","opponents":["normal"],"games":1}'
  ```
