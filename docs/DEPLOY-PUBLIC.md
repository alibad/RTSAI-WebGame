# Publishing the web game at rtsai.net/play: what it would take

**Status:** deployed on 9 October 2026 at https://rtsai.net/play/ following the owner's explicit deployment request ([release record](RELEASE-20261009.md)); updated on 13 October with the original Westwood art ([release record](RELEASE-20261013.md)). Future pushing or deploying needs the owner's approval. The workspace rules also
apply:
- standard build machine;
- no manual `vercel deploy` unless asked;
- `vercel usage --scope alibads-projects` before a manual production deploy;
- pushes never deploy: the Vercel project `rtsai-play` is linked to this repository, but the repository holds no
  built site (the game is built locally from the pinned inputs), so the root `vercel.json` turns Git deployments off.
  A Git deployment on 13 October served the raw repository and had to be rolled back.

## What gets published

`node tools/build-public.mjs` writes `build/public-web/`. This is the standalone game: project art and audio, no
server APIs (accounts, events and matchmaking: below). Since 13 October the isometric mode also draws the nine
original countries with the original Westwood art, under EA's free, non-commercial C&C modding guidelines: see
[Original Westwood art](#original-westwood-art-isometric-mode). No EA audio, music or video is ever included. Its exact
standalone and engine inputs are recorded in the verified `build-inputs.json`; use `tools/pin-standalone.ps1` to
prepare those inputs.

The static builder validates the actual ORAPACK1 `ora/BUNDLE_ID` against each supplied `sprites/index.json` before deleting output or running Vite. Missing, malformed, duplicate or mismatched IDs stop the build; rebuild the prebakes from the exact current pack. The builder never relabels a cache automatically. Run `node --test tools/public-sprite-inputs.test.mjs` to check this guard and output preservation.

| Path | Contents | Raw | Stored and sent | Downloaded |
|---|---|---|---|---|
| `/` (index.html, assets/, flags/) | page (React UI, renderer, worker) | 0.8 MB | 0.2 MB (host compression) | always |
| `rt-<hash>/public/aot/_framework/` | .NET runtime + engine + mod, lean AOT | 48 MB | 11.0 MB (brotli 11) | always |
| `data-<hash>/public/web-bundle.pack` | rules, maps, terrain, small files | 9.2 MB | 4.7 MB (brotli 11) | always |
| `data-<hash>/public/sprites/` | prebaked sprite sheets, one set per faction + shared + effects | 467 MB | 16.7 MB (brotli 11) | shared 2.7 + own faction 1.6 before the game; the other factions and effects (2 MB) right after; factions not in the match only if they appear |
| `data-<hash>/public/audio/` | sounds and music, one file each | 84 MB | 70 MB (WAVs brotli) | as played; the announcer and the music fetched in the background |
| `data-<hash>/public/web-art.pack` + .json | large sprite files, read by byte range only if sheets were not prebaked | 108 MB | as stored | normally never |

`web-art.pack` can be left out (e.g. over a host's file-size limit): every map's sprites are prebaked, and since
8 October the cursor art is in the core bundle (it used to be read from the art pack at the start of every game: on a
host without the file that read failed and crashed the runtime, "memory access out of bounds"). A sprite the sheets lack
would still be read from the art pack; without it that read is now an I/O error the engine reports, not a crash.

The build also writes `vercel.json` and `_headers` (Netlify / Cloudflare Pages), plus `BUILD.json` (sizes,
standalone SHA, bundle id). To check the output exactly as a CDN would serve it:
`node tools/static-serve.mjs [--throttle 9000,170] [--h2]`.

## Accounts, events and matchmaking

The public game starts only for signed-in players (`VITE_REQUIRE_SIGNIN=1`, set by `build-public.mjs`). Sign-in,
`/api/event` and `/api/feedback` belong to the website (RTSAI-Web), which shares the rtsai.net origin with /play.

In-game feedback (`web/src/ui/Feedback.tsx`) is the website's flow: the battlefield frame grabbed when Feedback opens
(`Game.captureFrame`), the annotator, dictation, a voice note and files. The player's browser writes the files straight
into Firestore (`feedbackReports/<id>`, readable only by the team in the website's `/feedback/<id>` viewer), so deploy
RTSAI-Web's `firestore.rules` (and a website with the viewer) before a game build with this flow.
`tools/feedback-browser-test.mjs` checks it in a running match against the Auth and Firestore emulators, with the
website's `/api/feedback` mocked. The shared files in `web/src/ui/feedback/` (`media.ts`, `report-files.ts`,
`ScreenshotAnnotator.tsx`, `FeedbackMedia.tsx`, `feedback-kit.css`, `useFeedbackDictation.tsx`) are copies of
RTSAI-Web `app/components/feedback/` (and `useFeedbackDictation.tsx`); change both together.

1. **Firebase web config.** Copy rtsai.net's public `NEXT_PUBLIC_FIREBASE_*` values into
   `web/.env.production.local` (gitignored) as `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`,
   `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` and `VITE_FIREBASE_MEASUREMENT_ID`. `build-public.mjs` refuses
   to build without them, because the game would otherwise start for anyone.
2. **Firestore rules** for matchmaking and usage counters are deployed from RTSAI-Web
   (`firebase deploy --only firestore:rules --project rtsai-net`). Deploy them before a game build that uses them.
3. **Cleanup** is done by the clients: the host deletes each join offer once that guest is seated or turned away,
   and the match when it starts or closes. (Firestore TTL policies would need the paid Blaze plan; rtsai-net stays on
   the free Spark plan.)

## Original Westwood art (isometric mode)

**What.** America, Germany, England, France, Korea, Cuba, Libya, Iraq and Russia draw the original Red Alert 2 art for
everything they field: infantry, vehicles, ships, aircraft, defences, the shared base buildings, MCVs, harvesters,
walls, husks and death animations, with the original cameos. 84 actor types, 78 sprite images and 32 voxel models,
333 files (18.0 MB raw). Exceptions:
- the Soviet power plant, barracks, service depot, battle lab and nuclear reactor (`napowr`, `nahand`, `nadept`,
  `natech`, `nanrct`) keep the project art: their standalone footprints differ from RA2's;
- the ore purifier plug (`gapurifier`, a standalone-only actor) and support-power cameos stay project art;
- harvesters show no unload animation (the original unload body is a dock client and could affect the simulation);
- buildings keep the overlays the standalone kit has; the overlays the kit removed are restored only where the
  trait can name the original image (air-force command, Soviet construction yard, war factories).
The seven modern factions, the Classic/top-down mode and every sound are unchanged. Mission enemies whose faction is
Russia (Orion Group in Straits Shield, Obsidian Directorate in Haitan Network) also show the original art: the art
follows the faction.

**Legal conditions** (EA's C&C Franchise Modding Guidelines: free, non-commercial):
- the page shows "EA has not endorsed and does not support this product." on the main menu, the skirmish screen and
  the campaign screen (`web/src/legal.ts`), and the static root carries `NOTICE`;
- only art files (`.shp .vxl .hva .pal`); no `theme.mix`, EVA, voices or any other EA audio, music or video;
- the extracted files live outside every Git repository; `EA-INPUTS.json` records each file's name, sha256 and
  source, and the bundle carries `mods/rtsai/web/ea/ea-content.json`.

**Build.**
```sh
python tools/prepare-ea-art.py plan --inputs <inputs> --out <plan.json>
python tools/prepare-ea-art.py extract --plan <plan.json> --out <dir outside every repository>
python tools/prepare-ea-art.py manifest --plan <plan.json> --dir <that dir> --inputs <inputs>
python tools/public.py --inputs <inputs> --out <new isometric build> --ea-art <that dir>
python tools/public.py --inputs <inputs> --out <new classic build> --game-mode classic
```
`extract` copies a file from the RTSAI-Web Studio cache (`.cache/ra2-originals`, extracted through `rtsai-classic`)
when present, else runs the mod engine's `OpenRA.Utility rtsai-classic --extract` against the player's own
`ra2.mix`/`language.mix` through a shim engine directory, and refuses files identical to the standalone stand-ins.
Then publish the runtimes and run `build-public.mjs` as usual.

**How.** `tools/ea_originals.py` (called by `prepare-content.py --ea-art`) reads two views of the frozen mod: the
classic add-on's rules and sequences (the reference) and the current public isometric game. For every actor an
original country fields it clones the reference image as `ea-<image>` with its temperate files rewritten to
`ra2|web/ea/<file>`, aliases the sequence names only the stand-in offered (a transparent project pixel, or the
closest original pose), and writes render-only rules (`content/ea-art.yaml`, loaded after every other rules file):
`RenderSprites.FactionImages` for the nine countries, `WithFactionPalettes` (OpenRA.WebSim: a render modifier that
swaps the actor's palettes for the original ones when its FactionInit is one of them, and for a spy only while it
shows an original disguise), original voxel bodies behind a faction condition with the stand-in sprite bodies
disabled for those countries, original-palette death animations, `IconPalette: eacameo`, five original palettes and
a `SpriteGroupFactions` hint for the browser's sprite groups. It fails if an alias or palette does not resolve, if a
trait would draw project art with a swapped palette, or if another owner's cameo depends on the icon palette.
`websim pack --ea` bundles exactly the hashed `EA-INPUTS.json` files (large sprites in `web-art.pack`) and appends
the three overlays at the very end of Rules, Sequences and ModelSequences.

**Checks.** `tools/test-ea-art.py`, `tools/test-bundle-paths.py`, `node --test tools/ea-gate.test.mjs`;
`websim contenttest --faction <each of 16> --baseline <dump>`: original palettes iff original images, no missing
original file, modern factions identical to a dump of the same build without original art; `build-public.mjs`
refuses MIX/BAG/IDX/VQA/BIK payloads, audio under `web/ea`, unlisted original files and original art in the Classic
profile (`tools/ea-gate.mjs`); `tools/ea-art-browser-test.mjs` (notice, screenshots, no original audio requests,
sheet groups). Parity on 13 October: 14 runs (isometric and Classic, AOT and interpreter, 1500 ticks each,
including `skirmish-originals` and `battle-originals`) identical.

**Sizes** (13 October build, brotli 11, compared with the same build without original art):

| | Without | With original art |
|---|---|---|
| `web-bundle.pack` (always downloaded) | 5.3 MB | 6.3 MB (voxels and small sprites) |
| isometric sprite sheets, all | 16.3 MB | 22.2 MB |
| sheets before the world starts, Saudi Arabia vs Iran | 5.4 MB | 5.9 MB |
| sheets before the world starts, America vs Russia | 4.8 MB | 5.6 MB (the other side's 5.1 MB right after) |
| `web-art.pack` (range reads, normally never) | 108 MB | 123 MB |

First visit on emulated 4G (9 Mbps, 170 ms, HTTP/1.1, standard AOT runtime, one run each): Saudi Arabia vs Iran
world started at 28.7 s → 32.1 s (31.9 → 33.9 MB transferred); America vs Russia 28.9 s → 35.9 s (32.3 → 39.4 MB;
the harness starts the match from a setup screen prepared for its default nations, so America's sheets download
after Start). Return visits: 6.5–6.8 s → 7.2–7.3 s.

## Frontend-only updates

When only the page changes (runtime and data roots unchanged), a deployment can reuse every file of the current
production deployment by SHA and upload just `index.html`, `BUILD.json` and the new `assets/*` (about 2 MB):
list the files with `vercel api /v6/deployments/<id>/files`, create a preview with `/v13/deployments`, check it,
then `vercel promote`. Build the page with the current `rtRoot`/`dataRoot` from the live `BUILD.json`.

**Never request a new asset URL through rtsai.net before the deployment is live.** `/assets/*` carries
`immutable, max-age=1 year` even on a 404, so rtsai.net's CDN and the browser keep a 404 for a file that does not
exist yet, and the game shows a blank page. On 13 October this happened; `vercel cache purge --type cdn` in the
RTSAI-Web checkout (project rtsai-web) cleared it.

## Engine and data on Cloudflare

Since 13 October the page at rtsai.net/play (Vercel) loads the runtime and data roots from the Cloudflare Pages project
`rtsai-play-cdn` (https://rtsai-play-cdn.pages.dev). Cloudflare has an edge in Doha; Vercel answers players in Qatar
from Mumbai. Measured from Qatar: about 4 ms per file against about 215 ms, and 18 ms against about 410 ms for a new
connection. To publish new roots:
1. Copy `rt-<hash>/` and `data-<hash>/` from the build into a folder with a `_headers` file. That file holds the build's
   `/rt-*` and `/data-*` rules (Cache-Control, `Content-Encoding: br`, Content-Type) plus `Access-Control-Allow-Origin: *`
   and `Cross-Origin-Resource-Policy: cross-origin` for every path. Cloudflare serves the pre-compressed files as they
   are; this was verified.
2. Run `npx wrangler pages deploy <folder> --project-name rtsai-play-cdn --branch main`. Each deployment replaces the
   whole site, so keep older roots in the folder while old pages may still use them. Limits: 20,000 files, 25 MiB per
   file.
3. Build the page with `VITE_RT_BASE=https://rtsai-play-cdn.pages.dev/rt-<hash>/` and
   `VITE_DATA_BASE=https://rtsai-play-cdn.pages.dev/data-<hash>/`, then deploy it to Vercel as before.
   `BUILD.json` records `assetHost`.

## Hard requirements on the host

1. **Cross-origin isolation** for the snapshot ring (SharedArrayBuffer):
   - `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on the document and
     on everything under the game's path.
   - Every subresource is same-origin today, so nothing else is needed.
   - Keep these headers off the rest of rtsai.net: they would block third-party embeds there.
2. **Precompressed files.** Runtime, bundle, sprite sheets and WAVs are stored brotli-compressed and must be served
   with `Content-Encoding: br` (the header rules say so), not compressed again. Verify this on a preview: if a host
   ignores the rule, the browser receives brotli bytes it does not decode and the game fails to load.
3. **Byte ranges** (`Range` → `206`) for `web-art.pack` only (rarely used).
4. **Caching.** Runtime and data live under content-hashed roots (`rt-<hash>/`, `data-<hash>/`), and Vite hashes
   `assets/`, so all of them are `immutable`; only `index.html` revalidates. A returning player downloads
   `index.html` and nothing else until a new build.
5. **No SPA fallback** is needed: there is a single `index.html`, and the page uses relative URLs, so any base path
   such as `/play/` works.

## Options for rtsai.net/play

| Option | How | Pros | Watch out for |
|---|---|---|---|
| **A. Separate static project + rewrite** (recommended) | New Vercel project (framework: none, output `build/public-web`); RTSAI-Web adds a rewrite `/play/:path*` → that project | game deploys independently of the site; headers live in the game project; no 200+ MB in the site repo | the rewrite must pass COOP/COEP and `Content-Encoding` through; check on a preview before going live |
| B. Subdomain play.rtsai.net | same project on a subdomain; rtsai.net/play redirects | simplest isolation, no proxying | a second origin (fine: it shares nothing with the site) |
| C. Inside RTSAI-Web `public/play/` | copy the build into the site | one project | 200+ MB of binaries in the site repo and in every site deploy; headers must be scoped to /play |
| D. Heavy files on object storage | runtime/data on Vercel Blob or R2, page on Vercel | cheap egress (R2) | cross-origin under COEP: needs `Cross-Origin-Resource-Policy: cross-origin` + CORS; the page already takes its runtime and data roots from the build (`VITE_RT_BASE`, `VITE_DATA_BASE`), so they can point at another origin |

Before any of these, verify on a preview deployment:
- COOP/COEP headers present (`self.crossOriginIsolated === true` in the page);
- precompressed files arrive with `Content-Encoding: br` and are not compressed twice;
- the file-size and deployment-size limits for the 108 MB art pack, which I could not confirm from the docs search.
  It can be left out of a deployment entirely while every map's sheets are prebaked.

## First-visit numbers

Setup:
- Static build served by `tools/static-serve.mjs`, lean AOT runtime, Twin Fords, Saudi Arabia against Iran.
- Network emulated at the server: one shared downlink and its latency (WebPageTest profiles).
- Desktop Chromium on an RTX 5090 with a fresh disk profile.
- HTTP/1.1, and HTTP/2 over HTTPS (`--h2`, like a CDN).

| Network | Visit | Setup screen | Map + art ready | World started | Downloaded by world start |
|---|---|---|---|---|---|
| 4G (9 Mbps, 170 ms), HTTP/2 | first | 18.1 s | 21.6 s | **23.0 s** | about 20 MB |
| 4G, HTTP/1.1 | first | 19.8 s | 23.3 s | 24.7 s | about 20 MB |
| 4G, HTTP/1.1 | return | 5.7 s | 7.1 s | **8.5 s** | index.html (plus downloads the first visit left unfinished) |
| Cable (5 Mbps, 28 ms), HTTP/1.1 | first | 31.2 s | 35.5 s | 36.9 s | about 20 MB |
| Cable, HTTP/1.1 | return | 2.9 s | 4.1 s | 5.2 s | as above |

Before: 80.4 s and 66.7 MB on a 4G first visit, 18.9 s on a return visit.

Breakdown of a first visit (26.7 MB in the first three seconds of play):
- before the world starts:
  - runtime 10.6 MB;
  - bundle 4.7 MB;
  - shared sheets 2.7 MB and the player's faction 1.6 MB;
  - page 0.2 MB;
- right after, in the background: the opponent's sheets and the effects (about 3.6 MB), the opening music track and
  the announcer (about 2.9 MB).

In game: 240–300 MB heap, 144 fps. Start → playing: 1.0–1.4 s. Music never blocks start: it begins once its file is
in, and a sound that has not arrived is skipped.

What made the difference:
1. **Prebaked sheets per faction**, packed by the engine in groups (`SpriteCache.PackGroup`, `PackGroups.cs`). The
   game waits for the shared and own-faction sheets only.
2. **Planar sheets plus brotli 11.** Indexed sheets hold four 8-bit sprite planes in RGBA; stored plane by plane,
   cropped to the rows in use, they shrink about 3× more.
3. **Lean AOT.** Third-party assemblies are fully trimmed, IL is stripped after AOT, and libraries off the per-tick
   path are interpreted. Download 17 → 11 MB, same tick speed (mean 0.78 vs 0.82 ms over 1500 ticks), parity
   identical.
4. **Non-blocking audio** (`Sound.AudioReady` in the engine): no synchronous network read for music or sounds.
5. **Content-hashed immutable roots**, single-file audio, and parallel downloads (bundle alongside the runtime,
   shared sheets during engine boot).

## Browser matrix

| Browser | Status |
|---|---|
| Chromium desktop (Playwright) | full playtest, co-commander, parity verify: pass |
| Phones and tablets (Chromium emulation of Pixel 7 landscape, real touch events) | touch controls pass `tools/touch-test.mjs`: tap to select, tap to order, long-press to order onto own units (e.g. deploy), one-finger selection box, pinch zoom, two-finger tap to clear, cameo tap to build, long-press to hold. Compact sidebar below 600 px tall or 900 px wide; a "turn sideways" screen in portrait. Not measured with a phone's CPU. |
| WebKit and Firefox (Playwright) | not run: Playwright's WebKit and Firefox builds (about 60–90 MB each, from the Playwright CDN) are not installed, and installing them needs the owner's OK. The code paths they exercise all exist in current Safari (16.4+) and Firefox; the matrix is needed to confirm. |

The code paths those browsers would exercise:
- SharedArrayBuffer with COOP/COEP;
- WebAssembly SIMD;
- synchronous XHR in workers;
- CompressionStream and DecompressionStream;
- WebGL2.

## Not in the public build yet

- **Original art for the Classic/top-down mode** (it keeps the stand-ins by decision).
- **Conversational co-commander** (model chat and voice). It needs either the player's local companion or hosted mode
  (see `docs/CO-COMMANDER.md`, waiting for the owner's environment variables); the strategy adviser ships
  ([PUBLIC-CO-COMMANDER.md](PUBLIC-CO-COMMANDER.md)).
- **Analytics and error reporting.**
- **A credits/licenses page** for the project's audio.
