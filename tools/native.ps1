# Native (CoreCLR) runner for RTSAI-WebGame: rebuild, repack the bundle, rebuild the native VFS root, run a scenario.
#   tools\native.ps1 -Scenario scenarios\battle-50.json -Ticks 300 [-NoBuild] [-NoPack] [-Extra '--snapshot']
# The native VFS root lives in $env:RTSAI_WEB_SCRATCH (default: %LOCALAPPDATA%\RTSAI-WebGame\scratch) and holds private EA content:
# it is a plain directory (no links), safe to delete.
param(
	[string]$Scenario = "scenarios\battle-50.json",
	[int]$Ticks = 300,
	[switch]$NoBuild,
	[switch]$NoPack,
	[string]$Mod = "..\RTSAI-Mod",
	[string]$Engine = "..\OpenRA-wt-web",
	[string]$Private = "$env:LOCALAPPDATA\RTSAI-WebGame\private\ra2-all.pack",
	[string[]]$Extra = @()
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$scratch = if ($env:RTSAI_WEB_SCRATCH) { $env:RTSAI_WEB_SCRATCH } else { Join-Path $env:LOCALAPPDATA "RTSAI-WebGame\scratch" }
New-Item -ItemType Directory -Force $scratch | Out-Null
$ws = "bin\OpenRA.WebSim.Native\Release\net10.0\websim.exe"

if (-not $NoBuild) {
	dotnet build sim\OpenRA.WebSim.Native\OpenRA.WebSim.Native.csproj -c Release -nologo -v q | Select-String -Pattern " error |rror\(s\)"
}
if (-not $NoPack) {
	& $ws pack --engine $Engine --mod $Mod --out data\web-bundle.pack
	$root = Join-Path $scratch "vfs-native"
	if (Test-Path $root) { Remove-Item -Recurse -Force $root }
	& $ws unpack --pack data\web-bundle.pack --private $Private --root $root | Out-Null
}
$root = Join-Path $scratch "vfs-native"
& $ws run --root $root --scenario $Scenario --ticks $Ticks @Extra
