# Verified standalone main inputs; portable implementation also works on macOS/Linux.
param([string]$Inputs = ".inputs", [string]$Out = "build/public-inputs", [string]$Maps = "all", [ValidateSet('isometric','classic')][string]$GameMode = 'isometric', [string]$EaArt, [switch]$ProjectArtOnly, [switch]$CheckOnly)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$argsForPython = @("$repo/tools/public.py", "--inputs", $Inputs, "--out", $Out, "--maps", $Maps, '--game-mode', $GameMode)
if ($EaArt) { $argsForPython += @('--ea-art', $EaArt) }
if ($ProjectArtOnly) { $argsForPython += '--project-art-only' }
if ($CheckOnly) { $argsForPython += "--check-only" }
& python @argsForPython
if ($LASTEXITCODE -ne 0) { throw "public input/build adapter failed" }
