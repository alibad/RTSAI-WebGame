# Web RTS: direct play

The public build is static. It contains the game, sprites, original audio and the AOT simulation. Two friends connect with **Direct multiplayer**, exchange the offer and answer codes through their existing messenger, select their factions and start. Chat and optional camera/microphone use the same WebRTC connection. Media permissions are requested only when a player starts their camera.

No owned Red Alert installation or room service is needed. The default public STUN endpoint helps discover routes; it does not run the match. There is no TURN relay. Same-machine/LAN acceptance passed; connections across restrictive networks remain an acceptance item. Public hosting must use HTTPS for camera access and retain the provided isolation and Brotli headers.

Build and preview locally from RTSAI-WebGame:

```powershell
node tools/build-public.mjs --out D:/rtsai-release/dual-20261009/web-public --quality 4
node tools/serve-static.mjs --root D:/rtsai-release/dual-20261009/web-public --port 3507
```

Open `http://127.0.0.1:3507/`. The static edition offers direct two-player matches. The separate development room transport retains four-player/AI/spectator features and needs its local room service. A model co-commander needs the local companion; ordinary bots and the AI workshop do not need a model. Classic presentation is still a browser migration item.

Verified locally on 9 October 2026: independent Chromium contexts, manually exchanged descriptions, bidirectional synthetic video/audio tracks, peer chat, 200 matching engine frames, both human MCV deploy orders, visible stop on disconnect and zero room API requests. Protocol checks cover missing orders/hash barriers, mismatches, malformed packets and conflicting duplicates. This is development acceptance, not a cross-network or mobile certification.

Checks:

```powershell
node tools/peer-unit-test.mjs
$env:RTSAI_TEST_URL='http://127.0.0.1:3507/'
node tools/direct-browser-test.mjs
```
