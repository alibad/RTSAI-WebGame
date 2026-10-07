# Follows the standalone game: moves the public profile's mod checkout (..\RTSAI-Mod-wt-web-public, a detached
# worktree owned by this repo) to the tip of rtsai/standalone (or -Ref), rebuilds what changed, re-bakes the sprite
# sheets and runs the SyncHash parity gate. On any failure it returns to the previous pin and rebuilds that, so the
# public build always runs a commit that passed. The result is appended to data\public\pins.jsonl.
#   tools\pin-standalone.ps1 [-Ref rtsai/standalone] [-Force] [-SkipAot]
# Safe to run unattended (e.g. from a scheduled task or after each standalone commit): it never touches the
# standalone agent's own worktree, never commits, and never pushes.
param(
	[string]$Ref = "rtsai/standalone",
	[string]$Worktree = "..\RTSAI-Mod-wt-web-public",
	[switch]$Force,
	[switch]$SkipAot
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$env:DOTNET_ROOT = if ($env:DOTNET_ROOT) { $env:DOTNET_ROOT } else { Join-Path $env:USERPROFILE ".dotnet" }
$dotnet = Join-Path $env:DOTNET_ROOT "dotnet.exe"
if (-not (Test-Path $dotnet)) { $dotnet = "dotnet" }
$log = "data\public\pins.jsonl"
New-Item -ItemType Directory -Force data\public | Out-Null

function RunGit([string[]]$a) { $o = & git.exe -C $Worktree @a 2>&1; if ($LASTEXITCODE -ne 0) { throw "git $($a -join ' '): $o" }; return $o }
function Record($obj) { ($obj | ConvertTo-Json -Compress) | Add-Content -Encoding utf8 $log; $obj | ConvertTo-Json }

function Publish([string]$runtime) {
	$pa = @("publish", "sim\OpenRA.WebSim.Browser\OpenRA.WebSim.Browser.csproj", "-c", "Release", "-nologo", "-v", "q", "-p:WebProfile=public", "-o", "data\public\wasm-$runtime")
	if ($runtime -eq "aot") { $pa += "-p:Aot=true" }
	$out = & $dotnet @pa 2>&1 | Select-String -Pattern " error " | Select-Object -First 5
	if ($LASTEXITCODE -ne 0 -or $out) { throw "publish $runtime failed: $out" }
}

function Build([bool]$code) {
	if ($code) {
		Publish "interp"
		if (-not $SkipAot) { Publish "aot" }
	}
	& tools\public.ps1
	if ($LASTEXITCODE -ne 0) { throw "pack/bake failed" }
}

function Gate {
	$rt = if ($SkipAot) { "interp" } else { "aot" }
	$results = @()
	foreach ($run in @(@("scenarios/skirmish-public.json", "1500", "--replay"), @("scenarios/sandbox.json", "1200"))) {
		$line = & node tools/fidelity.mjs --profile public --runtime $rt --scenario $run[0] --ticks $run[1] @($run | Select-Object -Skip 2) 2>&1 | Select-Object -Last 1
		$r = $line | ConvertFrom-Json
		$results += $r
		if (-not $r.identical) { throw "parity: $line" }
	}
	return $results
}

if (RunGit @("status", "--porcelain")) { throw "$Worktree has local changes; refusing to move it" }
$old = (RunGit @("rev-parse", "HEAD")).Trim()
$new = (RunGit @("rev-parse", $Ref)).Trim()
if ($old -eq $new -and -not $Force) { Write-Output "public profile already at $($new.Substring(0, 10)) ($Ref)"; exit 0 }

$changed = RunGit @("diff", "--name-only", $old, $new)
$code = [bool]($changed | Where-Object { $_ -match '^OpenRA\.Mods\.(RA2|RTSAI)/.*\.cs$' })
$subject = (RunGit @("log", "-1", "--format=%s", $new)).Trim()
Write-Output "pinning $($old.Substring(0, 10)) -> $($new.Substring(0, 10)) ($subject); C# changed: $code"

try {
	RunGit @("checkout", "--quiet", "--detach", $new) | Out-Null
	Build $code
	$gate = Gate
	Record ([ordered]@{ at = (Get-Date).ToString("o"); sha = $new; from = $old; subject = $subject; ok = $true; code = $code; parity = $gate })
}
catch {
	$err = "$_"
	Write-Warning "pin $($new.Substring(0, 10)) failed: $err; returning to $($old.Substring(0, 10))"
	RunGit @("checkout", "--quiet", "--detach", $old) | Out-Null
	Build $code
	Record ([ordered]@{ at = (Get-Date).ToString("o"); sha = $new; from = $old; subject = $subject; ok = $false; error = $err; kept = $old })
	exit 1
}
