# Working in RTSAI-WebGame

Several sessions change this game at the same time. On 14 October 2026 that cost us twice: a page built from a
branch would have dropped work other sessions had already shipped, and a runtime built from a stale worktree went
live without a fix that was already on main. These rules prevent that.

## Branches: commit on main, always from the latest main

- `main` is the only long-lived branch and `origin/main` is the truth. Commit on main.
- Before you start, before every commit, and before any build you test or ship, run `git fetch` and bring your
  checkout up to the latest `origin/main`: `git pull --ff-only`, or `git pull --rebase` if you have local commits. Never
  build or test on a checkout that is behind main.
- If another session already uses the main checkout, work in a worktree started from the latest main
  (`git worktree add -b <topic> <dir> origin/main`). Keep rebasing it onto `origin/main` and land it on main
  (`git push origin HEAD:main`) as soon as it works, the same day. Don't stack branches on branches.
- Finished work must not sit on a branch or as unpushed commits on a local main. Other sessions can't see it there,
  and the next release from main would drop it. Pushing main here deploys nothing, because Vercel Git deployments are
  off.
- Never force-push, hard-reset or rebase commits that are already on `origin/main` or that belong to another session.
  If main has moved under you, rebase your own commits onto it. If there is a conflict that needs a product decision,
  stop and ask.

## Releasing rtsai.net/play: only with tools/release-play.mjs

Deploying needs the owner's approval. When you have it, use the release command; never assemble pages, runtimes or
the Cloudflare folder by hand.

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
