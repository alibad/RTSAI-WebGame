# Public profile data (the standalone game, project content only): packs data\public\web-bundle.pack (+ audio) from
# the standalone mod checkout, then prebakes the sprite sheets of its maps into data\public\sprites, so a first visit
# restores packed sheets instead of decoding every sprite file.
#   tools\public.ps1 [-Mod ..\RTSAI-Mod-wt-web-public] [-Maps all|twin-fords,harbor-line] [-NoBuild]
# Runtimes: dotnet publish sim\OpenRA.WebSim.Browser -c Release -p:WebProfile=public [-p:Aot=true] -o data\public\wasm-<interp|aot>
param(
	[string]$Mod = "..\RTSAI-Mod-wt-web-public",
	[string]$Engine = "..\OpenRA-wt-web",
	[string]$Maps = "all",
	[switch]$NoBuild
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$scratch = if ($env:RTSAI_WEB_SCRATCH) { $env:RTSAI_WEB_SCRATCH } else { Join-Path $env:LOCALAPPDATA "RTSAI-WebGame\scratch" }
New-Item -ItemType Directory -Force $scratch, data\public | Out-Null
$ws = "bin\OpenRA.WebSim.Native-public\Release\net10.0\websim.exe"

if (-not $NoBuild) {
	dotnet build sim\OpenRA.WebSim.Native\OpenRA.WebSim.Native.csproj -c Release -nologo -v q -p:WebProfile=public | Select-String -Pattern " error |rror\(s\)"
}
& $ws pack --engine $Engine --mod $Mod --out data\public\web-bundle.pack
if ($LASTEXITCODE -ne 0) { throw "pack failed" }

$root = Join-Path $scratch "vfs-public-bake"
if (Test-Path $root) { Remove-Item -Recurse -Force $root }
& $ws unpack --pack data\public\web-bundle.pack --root $root | Out-Null
$env:OPENRA_AI_HOST = "0"
& $ws bake --root $root --maps $Maps --out data\public\sprites
if ($LASTEXITCODE -ne 0) { throw "bake failed" }
Remove-Item -Recurse -Force $root
