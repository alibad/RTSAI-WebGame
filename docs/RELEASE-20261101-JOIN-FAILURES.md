# Failed multiplayer joins reported, and the GPL source link — 1 November 2026 (third release)

Released on the owner's word ("Release it"), after the owner picked "Log failed joins" from the first-ten-minutes
findings (multiplayer across networks: no relay today, and a failed join was invisible).

What players get:
- A failed join is reported. When a guest's join fails on the network, the owner's event log gets one `game_error`
  (`where: network`).
  - The message names the step: no connection route found, the host never answered, or the direct line never opened.
  - The props say what the player saw, the connection type, the kinds of route each side offered, and whether each
    side's NAT keeps one public port or gives each STUN server a new one. No address is sent.
  - A guest who gives up, an expired invite and a different version are not reported. A late timeout after the guest
    left no longer shows an error (e0e5a38; docs/MULTIPLAYER.md "Failed joins are reported").
- The menu's "Source code" link opens the exact commit the page was built from, on the now-public repository, with
  the GPL-3.0 LICENSE and NOTICE (c45767c, d01e98b, from the GPL session).
- The game itself, its runtime and its data are unchanged.

## Identities

- Production `dpl_285RSQTHBsJHynXDNoGaGsSYY44n` (preview `dpl_FSRvh8gQ9U4Np8QHXaax4UgJEoN3`, on `dpl_AhwCrPok6iSfpXepdxNrvuwY4uUs`),
  release `2026-11-01T10-30-38-616Z`, standard build machine, amount due $0 (October's report: $33.88 used, all included).
- Page main `e0e5a38`, built against the published website `d43e3b9` (`--published-site`). The canonical RTSAI-Web
  checkout holds another session's unpublished work, which was left untouched.
- Runtime `rt-142f8f7ca20c/` and data `data-5eb9c3d0096c/`, both unchanged. Cloudflare unchanged.

## Checks

- Quality gate `2026-11-01T10-30-18-586Z` with the real prepare. Every step passed:
  - source and typecheck;
  - 28 unit scripts;
  - five smoke matches;
  - eight browser paths, including the new `join-failure-browser-test.mjs`: real WebRTC in Chromium, five cases;
  - gameplay skipped, because the data root is unchanged.
- Preview checked by the release tool: BUILD.json, index.html, isolation headers and scripts are byte-identical to the build.
- Independent live check:
  - rtsai.net/play/BUILD.json names release `2026-11-01T10-30-38-616Z`, commit e0e5a38, site d43e3b9;
  - the live `index-CgzUc9so.js` carries the failure report and the source link;
  - github.com/alibad/RTSAI-WebGame/tree/e0e5a38 answers 200.

## Reading the reports

Count the reports against `multiplayer_joined` for a failure rate. The interesting reports are the ones that say "new
port per server" on either side: those are the joins a relay (TURN) would rescue. The options and costs are in
hq/games/artifacts/first-ten-minutes-20261101/ (Cloudflare Realtime TURN, 1,000 GB a month free; Metered, 20 GB free;
or our own coturn).
