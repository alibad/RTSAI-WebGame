# Working in RTSAI-WebGame

Several sessions change this game at the same time. On 14 October 2026 that cost us twice: a page built from a
branch would have dropped work other sessions had already shipped, and a runtime built from a stale worktree went
live without a fix that was already on main. These rules prevent that.

## Where things live (owner, 1 Nov 2026)

| Repository | Holds | GitHub |
|---|---|---|
| `OpenRA` | The engine: our fork of OpenRA/OpenRA (`fork/main`) | public |
| `RTSAI-Mod` | The desktop game, plus the faction catalog master (`catalog/`), the AI companion (`companion/`), the older missions (`missions/`) and the roadmap (`docs/roadmap.md`) | public |
| `RTSAI-WebGame` | The web game at rtsai.net/play, plus its release tool | public |
| `RTSAI-Web` | rtsai.net, plus the Faction Studio (the one review desk) and the Sound Desk | private |
| `RTSAI-Art` | The forge: the look (`bible/`), art sources, the sound tools (`tools/sound`) and the trailers (`film/`) | private |

- **Archived on GitHub (read-only), so don't work in them:**
  - `OpenRA-AI`, now `RTSAI-Mod/companion`, `missions` and `docs/roadmap.md`
  - `RTSAI-Film`, now `RTSAI-Art/film`
  - `OpenRA-RL`
- **Drafts made with AI** (art, sound, film) stay outside git in `D:\Generated\RTSAI\<faction>\<kind>` until the Faction Studio approves them. Approved files go into git.
- **One look:** names come from the catalog (`RTSAI-Mod/catalog/factions.json`), and colours and style come from the bible (`RTSAI-Art/bible`). Read them; never hand-write a faction's name or palette. `RTSAI-Art/film` still has its own palette, which is still to be fixed.

## Branches: commit on main, always from the latest main

- `main` is the only long-lived branch and `origin/main` is the truth. Commit on main.
- Before you start, before every commit, and before any build you test or ship, run `git fetch` and bring your
  checkout up to the latest `origin/main`: `git pull --ff-only`, or `git pull --rebase` if you have local commits. Never
  build or test on a checkout that is behind main.
- If another session uses main, coordinate or wait. Worktrees require an explicit owner request; see the policy below.
- Finished work must not sit on a branch or as unpushed commits on a local main. Other sessions can't see it there,
  and the next release from main would drop it. Pushing main here deploys nothing, because Vercel Git deployments are
  off.
- Never force-push, hard-reset or rebase commits that are already on `origin/main` or that belong to another session.
  If main has moved under you, rebase your own commits onto it. If there is a conflict that needs a product decision,
  stop and ask.

## Releasing rtsai.net/play: only with tools/release-play.mjs

Deploying needs the owner's approval. When you have it, use the release command; never assemble pages, runtimes or
the Cloudflare folder by hand. Before `prepare`, run the quality gate on the latest main and keep its receipt id for
the release record: `node tools/quality-gate.mjs` (docs/QUALITY-GATE.md). It runs typecheck, the unit tests, the dry
run with its smoke test and the player-path browser tests, and leaves a dated receipt in `D:/Builds/RTSAI/play-release/gate`.

```sh
node tools/release-play.mjs status          # what is live, what main would change, who holds the release lock
node tools/release-play.mjs prepare --update "<what players get>"   # build + checks + Vercel preview; production untouched
node tools/release-play.mjs promote         # production, after re-checking nothing else went out meanwhile
node tools/release-play.mjs prepare --dry --update "..."            # build and smoke-test only, deploys nothing
```

What the command guarantees:
- It builds from `origin/main` only, and it refuses when the live page is not on main.
- It rebuilds the runtime exactly when `sim/`, the engine pin or the data's mod changed, and records the runtime's
  source in BUILD.json.
- It keeps page settings, such as the campaign files' location, in `tools/release-play.json`.
- It smoke-tests the page in a browser (`tools/release-smoke.mjs`).
- It never lets Cloudflare drop a live file.
- It checks the preview byte for byte.

See docs/DEPLOY-PUBLIC.md ("Releasing").

Shipping something that is not on main yet means landing it on main first. That includes a campaign chapter, new
data, or a branch's runtime.

## Worktrees require an explicit owner request (15 October 2026)

- Use the existing canonical checkout. Do not create a Git worktree or a parallel clone unless the owner explicitly asks for it in the current task. This supersedes older instructions permitting worktrees for concurrency, isolation, convenience, or risk.
- Another session using the checkout is not permission to create a worktree. Coordinate non-overlapping changes, wait, or report the specific blocker; preserve all in-progress work.
- In the OpenRA/RTS AI repositories, work and commit on canonical `main`. Fetch the correct owner remote and safely incorporate its main before starting, committing, or validating a build. Never reset, force-push, or rewrite another session's commits.
- If the owner explicitly authorizes a worktree, keep it temporary, start from current main, and integrate validated work back into canonical main. Do not leave the only copy of finished work on a branch or worktree.
- Before retiring an existing branch or worktree, verify that its unique commits, uncommitted files, and user artifacts are preserved and integrated where appropriate. Never delete unique work to make a checkout look clean.
- Keep this policy change and local consolidation local. A request to consolidate on main does not by itself authorize a push, deployment, release, or deletion of branches/worktrees.
