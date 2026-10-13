# Portable main-only public inputs

The standalone public profile now derives from canonical RTSAI-Mod **main current
source**, including reviewed uncommitted additions. It never follows the former
standalone/worktree branch. Explicit public checks reject owned-content mounts,
MIX/BAG/IDX/retail-video payloads and missing standalone base-kit. This is an input
gate; full native provenance/content audits remain release gates.

```sh
python3 tools/prepare-inputs.py --out ../.session-artifacts/S02/inputs
python3 tools/public.py --inputs ../.session-artifacts/S02/inputs --out ../.session-artifacts/S02/public-build --check-only
python3 tools/public.py --inputs ../.session-artifacts/S02/inputs --out ../.session-artifacts/S02/public-build
```

Original Westwood art for the isometric public game is a separate, explicit input that never enters a Git
repository: `tools/prepare-ea-art.py plan|extract|manifest` lists the art files the generator draws (.shp, .vxl,
.hva, .pal only), copies or extracts them from the player's own RA2 files into a directory outside every
repository and records `EA-INPUTS.json` (name, sha256, source); `public.py --ea-art <dir>` verifies it and passes
it to `prepare-content.py --ea-art` and `websim pack --ea`. See DEPLOY-PUBLIC.md.

Existing destinations are refused. `prepare-inputs.py` exports the unchanged
mod.config engine pin from OpenRA's object database, snapshots main Mod source,
mission sources and historical Classic map terrain vocabulary. Historical
OpenRA main is **only map-conversion input**, never the shipping engine.
`build-inputs.json` links immutable per-file manifests (`INPUTS.json`). Local
credentials/config, caches and owned-game archive payloads are excluded. Preserve
provenance files and audit them before release; absence of retail extensions alone
is not evidence that an unknown art file is project-authored.

`public.py` verifies all hashes, copies the engine to its own output/work folder,
stamps VERSION/mod versions ONLY in that private build copy (build-transforms.json),
then builds the existing native pack/bake tool. Generated content, mission
scenarios, bin/obj, VFS and baked data all stay under the chosen session output.
Public builds never use or mount a private owned-game pack. The PowerShell
entry point delegates to this same portable adapter. `pin-standalone.ps1` is now
only a main-source freeze wrapper; no git checkout or automatic rollback exists.

For later browser publishing use the SAME private engine copy, immutable Mod
snapshot and isolated build root. For example (absolute paths, trailing `/`):

```sh
dotnet publish sim/OpenRA.WebSim.Browser/OpenRA.WebSim.Browser.csproj -c Release \
  -p:WebProfile=public -p:EngineRoot=/session/public-build/work/engine/ \
  -p:ModRoot=/session/inputs/mod/ -p:WebBuildRoot=/session/browser-interp/ \
  -o /session/public-build/data/public/wasm-interp
```

AOT additionally requires .NET `wasm-tools` and `-p:Aot=true`; use a distinct
engine copy/output per simultaneous runtime build. Lean AOT remains unresolved;
do not enable it. Browser ProjectReferences still follow engine build conventions
and therefore write to this private engine's bin/obj; never pass the immutable
input tree as EngineRoot. Default EngineRoot `.build-deps/engine/` is deliberately
a local disposable copy; defaults do not fall back to a sibling checkout.

On Apple Silicon without Rosetta, Grpc.Tools 2.69.0's bundled x64 compiler cannot
execute. Select installed native tools with `PROTOBUF_PROTOC` and
`GRPC_PROTOC_PLUGIN` for both native and browser builds. These are the package's
supported overrides; record the compiler version and executable hashes alongside
the build receipt. Do not silently reuse generated bindings from another build.

The frontend requires its generated faction catalog before typecheck/build. A
private workspace can derive it directly from a frozen native catalog:

```sh
node tools/sync-catalog.mjs --catalog /session/catalog-source/catalog/factions.json \
  --out /session/work/webgame/web/src/data/factions.json
cd /session/work/webgame/web
VITE_DEFAULT_PROFILE=public npm run build -- --outDir /session/frontend-dist
```

`--catalog` consumes the native generated catalog; `--from` retains the existing
website snapshot input. Both preserve source names and record a catalog checksum.
Install dependencies and generate outputs only in private build copies, never in
the immutable source snapshot. Browser checks share `tools/browser-launch.mjs`,
which selects local Chrome on macOS or `RTSAI_CHROME_EXECUTABLE` explicitly.

`prepare-content.py` accepts `--mod`, `--missions`, `--classic-source`, `--out`
and `--scenarios-out`. `sync-portraits.mjs` accepts environment inputs
RTSAI_ART_ROOT/RTSAI_MOD_ROOT and output paths RTSAI_PORTRAITS_OUT/
RTSAI_PORTRAITS_MANIFEST; cross-repository imports remain exclusive integration
work. `build-public.mjs --data /session/data/public --inputs /session/inputs/build-inputs.json --out /session/static`
reads explicit data, records frozen source identities in BUILD.json, and never
publishes. Source verification and actual runtime acceptance are separate checks.

Before acceptance, parity is a **mandatory separate gate**. The old pin wrapper's
automatic fidelity/rollback loop was removed because it switched worktree refs;
preparing inputs alone never establishes parity. The adapted fidelity runner uses
.NET websim.dll on every host and requires nonzero equal hash counts.

Existing consumers can use isolated outputs directly without overwriting data/:

```sh
RTSAI_WEB_DATA=/session/public-build/data RTSAI_WEB_BUILD=/session/public-build \
  RTSAI_WEB_SCRATCH=/session/fidelity node tools/fidelity.mjs \
  --profile public --runtime interp --scenario scenarios/skirmish-public.json --ticks 1500 --replay
RTSAI_WEB_DATA=/session/public-build/data RTSAI_WEB_BUILD=/session/public-build \
  RTSAI_WEB_DIST=/session/web-dist RTSAI_WEB_SCRATCH=/session/server-cache \
  RTSAI_WEBGAME_PORT=3493 node server/serve.mjs
```

Both Node WASM runner and local server resolve RTSAI_WEB_DATA as a parent directory
containing public/. Server bin lookup uses RTSAI_WEB_BUILD, page output uses
RTSAI_WEB_DIST and compression cache uses RTSAI_WEB_BR_CACHE or its own scratch.
Fidelity logs stay in RTSAI_WEB_SCRATCH. Session-specific ports must be checked for
availability. Map Workshop/companion services have their own local prerequisites;
input path adapters do not establish acceptance of those services.
