# Multiplayer

One **Multiplayer** button, peer-to-peer play, for signed-in players.

## For players

1. Host: **Multiplayer → Create match**, then **Copy invite** and send the link in any chat app.
2. Friends open the link. The game loads and drops them straight into the lobby. They can also paste the link or type
   the 6-character code under **Have an invite?**.
3. The host picks the map (or **New random map**) and AI opponents. Everyone picks a faction and team. Guests press
   **Ready**.
4. The host presses **Start match**.

A match holds up to the map's slot count (4 on Four Fronts, 2 elsewhere), humans first, then AI. Lobby chat,
in-match chat (Enter) and an optional camera and microphone are included.

## How it works

```
 browser A (host) ── offer/answer only ──▶ Firestore p2pMatches (rtsai-net) ◀── browser B, C …
        ▲                                                                       │
        └──────────── direct WebRTC data channel: lobby, orders, chat, media ◀──┘
```

- **Accounts.** Multiplayer (like the whole public game) needs a signed-in rtsai.net account. The game is served at
  rtsai.net/play, the same origin as the website, so the website's Firebase sign-in is visible to the game
  (`web/src/net/account.ts`).
- **Matchmaker** (`web/src/net/matchmaker.ts`, Firestore). It introduces browsers and nothing else.
  - The host creates `p2pMatches/{code}` naming itself.
  - A guest adds `joins/{id}` holding its WebRTC offer. Only the host can list and read the offers, and only the host
    can answer them.
  - Both sides are pushed updates (no polling). The host deletes each offer once that guest is seated or turned
    away, and the match when it starts or closes.
  - The rules live in RTSAI-Web `firestore.rules` and are tested by RTSAI-Web `tools/firestore-rules-test.mjs`.
- **Star topology.** Each guest connects to the host. The host runs the lobby and relays every player's order and
  hash events to the others, so every world receives identical frames.
- **Lockstep** (`PeerLockstep` in `web/src/peer.ts`). A frame is released when all N players' orders for it have
  arrived and the previous frame's SyncHash reports all agree. Malformed, conflicting or mismatching input stops the
  match for everyone, with the frame number. Bots run on the host (client 1), as in OpenRA.
- **Random maps.** The lobby carries the request that made a random map (seed, player count, landscape;
  `Lobby.generated`), not the map. Each guest's browser makes the map from it with the engine's map generator, which
  is deterministic: the same request gives the same map and the same uid (the preview's colours are drawn from the
  seed, since the uid hashes the preview). A guest can press Ready only once its copy exists, and a copy that comes out
  different is reported instead of joining. Proof: `tools/random-map-multiplayer-test.mjs` (two browsers, the
  emulators, a synchronized match on the map).
- **Compatibility.** The game build fingerprint (`runtime-identity.json` + content pack) must match. The guest
  checks the match's version before joining, and the host checks again over the direct channel.
- **Disconnects.** A guest leaving the lobby frees the seat. During a match, anyone leaving or going silent for
  15 seconds stops the match for everyone with the reason on screen. There is no reconnection.
- **Networks.** Public STUN servers (Google, Cloudflare) find routes. There is no TURN relay. Some strict networks
  cannot connect directly, and the game then suggests trying another network.

## Checks

```powershell
node tools/peer-unit-test.mjs
# Browser test: Firebase emulators (RTSAI-Web: firebase emulators:start --only auth,firestore --project demo-rtsai),
# the website on the emulators, and a game build with VITE_FIREBASE_EMULATORS=1 VITE_REQUIRE_SIGNIN=1 on one origin.
$env:RTSAI_TEST_URL = 'http://127.0.0.1:3520/'
node tools/multiplayer-browser-test.mjs
```

The browser test runs three independent Chromium contexts with host ICE routes only:
- the sign-in gate (nothing boots before sign-in) and an invite waiting behind it;
- invite-link auto-join, code join, bad codes, a build-mismatch rejection, and a full match that says so;
- a four-slot map with AI, where any settings change clears readiness;
- lobby chat relayed through the host, and a camera to the host;
- a mobile-width lobby;
- a synchronized three-player match with AI: all deploy orders applied in every world, matching hashes, in-match
  chat, and every player's match counted by the website;
- in-match feedback reaching the website;
- a leave that stops everyone, a fresh second match, and a host quit that stops the guest.

Screenshots and a receipt go to `artifacts/multiplayer/`.

## In-game chat

Press **Enter** on the battlefield to open chat, type, and press **Enter** to send. Focus returns to the game.
**Escape** closes the composer and keeps your draft. The upper-left corner shows up to four recent messages for
15 seconds. Messages go to everyone in the match.
