# Google Analytics waits for the player's Allow — 1 November 2026 (fourth release)

Released on the owner's word ("Fucking release it"), after "Yes, fix /play": rtsai.net went live the same day with an
analytics choice (Allow / No thanks, RTSAI-Web lib/consent.ts), and the game ignored it.

What players get:
- Nothing they can see: no new screen, button or banner, and the game plays the same.
- Google Analytics in the game loads only when the choice stored on rtsai.net (localStorage `rtsai.consent.v1`) says
  "granted". It uses the website's consent mode: analytics storage only, with ads storage, user data and
  personalization denied. A "No thanks" in another tab stops collection. No choice yet means no Google Analytics
  (291fe5b, web/src/net/track.ts).
- The first-party counting for signed-in players (`/api/event`: counters, daily rollups, event emails) is unchanged,
  as /privacy says.

## Identities

- Production `dpl_57muTnoBKtSrh8mUiYtNtDntQ9uq` (preview `dpl_HQB2kThdsehXaHVZP7DtBUFdhFL5`, on
  `dpl_285RSQTHBsJHynXDNoGaGsSYY44n`), release `2026-11-01T12-00-52-928Z`, standard build machine, amount due $0
  (October's report: $33.88 used, all included).
- Page main `291fe5b`, built against the published website `0d840bf` (no unpublished website work left).
- Runtime `rt-142f8f7ca20c/` and data `data-5eb9c3d0096c/`, both unchanged. Cloudflare unchanged.

## Checks

- Quality gate `2026-11-01T11-01-43-086Z`: source, typecheck, 28 unit scripts, five smoke matches, eight browser paths
  (Chromium, Firefox, WebKit, touch, failed joins); gameplay skipped (data root unchanged).
- tools/telemetry-unit-test.mjs runs track.ts itself: no choice and "No thanks" never load GA, while /api/event still
  counts. Allow sets the consent mode and then logs. A "No thanks" from another tab stops collection.
- Release smoke on the Cloudflare roots: all five matches start, tick and free their textures. The preview matched
  the build byte for byte.
- Live: rtsai.net/play BUILD.json names 291fe5b, and the page serves `index-DCWXxA9v.js` (the bundle carrying the
  consent check). The sign-in screen is unchanged and no request fails.
- Not checked in a browser: GA loading after Allow for a signed-in player. The preview sits behind Vercel's sign-in,
  and the game only sends events after the player signs in.
