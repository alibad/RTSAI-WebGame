# Local faction roster audit

This checks our current OpenRA Classic and RA2 modifications, including the
world-war-iii custom factions. It does not claim retail RA2 compatibility.

The independent native oracle creates disposable real OpenRA matches, spawns
the country's starting base, and builds its available infrastructure to closure.
It queries actual `ProductionQueue.BuildableItems` and `TechTree.HasPrerequisites`
without an AllTech cheat. Full tech, own-country infrastructure is the scope;
captured foreign technology and map-specific campaign overrides are excluded.

1. Preserve pre-audit `content/unit-bindings.json`, `unit-modifications.json`, and
   `unit-details.json` as `original-bindings.json`, `original-modifications.json`,
   and `original-details.json` in a local artifact directory.
2. From RTSAI-Web run:

   ```powershell
   node --import tsx scripts/audit-faction-rosters.ts <artifacts>/studio-current.json
   ```

3. Use a frozen native host built from committed canonical main. Run once for
   the pre-fix host and again for the corrected host, separately for each mode:

   ```powershell
   $env:OPENRA_UTILITY_EXPERIENCE_PROFILE='world-war-iii'
   $env:DOTNET_GCHeapHardLimit='0x80000000'
   dotnet <native-host>/websim.dll rosteraudit --root <frozen-vfs> --out <artifacts>/engine-classic-fixed.json
   dotnet <native-host>/websim.dll rosteraudit --root <frozen-ra2-vfs> --out <artifacts>/engine-ra2-fixed.json
   dotnet <native-host>/websim.dll rosteraudit --desktop <frozen-desktop> --support <support> --mod rtsai-classic-core --out <artifacts>/native-classic.json
   dotnet <native-host>/websim.dll rosteraudit --desktop <frozen-desktop> --support <support> --mod rtsai-ra2 --out <artifacts>/native-ra2.json
   ```

   `roster-audit.csproj` is an optional small wrapper for exporting with an
   existing native host: build with `-p:AuditRuntime=<native-host-directory>`.

4. Build and verify the local four-target content preview with
   `RTSAI-Mod/tools/build-unit-preview.py`. Its browser acceptance now checks
   every faction's actual WASM roster against Studio, every existing binding's
   localized name and stats, and the existing production/rule-edit regressions.

5. Generate the assertions and interactive report:

   ```powershell
   python tools/roster-audit/report.py <artifacts> --mod ../RTSAI-Mod --receipt <verified-preview>/receipt.json
   ```

   The report refuses mismatched names, rosters, duplicate labels, changed saved
   edits, or missing bindings. Construction yards obtained from starting MCV
   transformations are reported separately as placement-only forms. Source
   actors excluded from ordinary selection are retained for campaign/custom use.

The October 18 audit preserved all 392 bindings and saved edits. All 12 Classic
and 16 RA2 rosters matched the live native tech tree. The fix replaced the web
drawer's incomplete prerequisite heuristic with a graph over the **current
Ruleset**, including conditional prerequisite providers, country gates, tech
providers and transformations. It deliberately does not read baseline registry
membership, so a saved Studio prerequisite override can change the roster.

## Web vs desktop: what each build ships (23 October 2026)

`rosteraudit` exports carry each actor's resolved numbers (health, armour, speed, sight, every weapon's range, reload,
burst, damage, damage versus armour and targets) and, per faction, the weapons and name an owner gets at rest
(`factionArmaments`, `factionNames`). `--rules-only` skips the live-world pass for a web bundle. Read each side with its
own engine: a websim built against the web pin for the bundle, and one built against the desktop engine for a desktop
build (desktop manifests use `FinalRules`, which the web engine does not read).

```powershell
websim rosteraudit --root <unpacked web bundle> --rules-only --out web-ra2.json
websim rosteraudit --desktop <desktop build> --support <dir> --mod rtsai --out desktop-rts.json
python tools/roster-audit/compare.py web-ra2.json desktop-rts.json --out differences.json
```

The web Red Alert 2 mode (`rtsai`, 16 factions) compares with the desktop RTS game (`rtsai`, 16 factions); the desktop
RA2 game (`rtsai-ra2`) offers only the nine original countries and matched the RTS game for them on 23 Oct. Classic is
`rtsai-classic-core` on both. First comparison: `hq/games/artifacts/desktop-compare-20261023/differences.html`.
