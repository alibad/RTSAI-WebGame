# Google Analytics on by default again — 1 November 2026 (fifth release)

Released on the owner's word ("let's release", 2 November). The owner removed the website's Allow banner ("bugging
people is worse than actually tracking"; RTSAI-Web 09241fd), so the fourth release, which waited for an Allow that can
no longer be given, counted almost nobody in the game.

What players get:
- Nothing they can see: no new screen, button or banner, and the game plays the same.
- Google Analytics in the game runs unless the player turned it off on their rtsai.net account page (localStorage
  `rtsai.consent.v1` says "denied"). No choice means on. Consent mode is unchanged: analytics storage only, with ads
  storage, user data and personalization denied. Turning it off in another tab stops collection (e741fdc,
  web/src/net/track.ts).
- The first-party counting for signed-in players (`/api/event`) is unchanged.

## Identities

- Production `dpl_ES9sjmytGCTrsmaiK5J95hm2rvhX` (preview `dpl_6w48VRsDVRKwLmveQkwJUX6s9i4H`, on
  `dpl_57muTnoBKtSrh8mUiYtNtDntQ9uq`), release `2026-11-01T13-30-06-611Z`, standard build machine, amount due $0.
- Page main `e741fdc`, built against the published website `09241fd`.
- Runtime `rt-142f8f7ca20c/` and data `data-5eb9c3d0096c/`, both unchanged. Cloudflare unchanged.

## Checks

- Quality gate `2026-11-01T13-18-24-524Z`: 28 unit scripts, five smoke matches, eight browser paths; gameplay skipped
  (data root unchanged).
- tools/telemetry-unit-test.mjs runs track.ts itself: "denied" never loads GA while /api/event still counts; no choice
  sets the consent mode, loads and logs; a "denied" from another tab stops collection.
- Release smoke: all five matches start and tick. The preview matched the build byte for byte.
- Live: rtsai.net/play BUILD.json names e741fdc (site 09241fd), and the page serves `index-BE0dQCH3.js`, which carries
  the `rtsai.consent.v1` check.
- Not checked in a browser: GA events from a signed-in player in the game. The game only sends events after sign-in.
