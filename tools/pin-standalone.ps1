# Compatibility entry point: freeze current main source, never checkout/move any branch or worktree.
# Use tools/public.py to build and tools/fidelity.mjs for the separate parity gate.
param([string]$Out = ".inputs", [string]$Mod = "../RTSAI-Mod", [string]$EngineRepo = "../OpenRA")
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
& python "$repo/tools/prepare-inputs.py" --out $Out --mod $Mod --engine-repo $EngineRepo
if ($LASTEXITCODE -ne 0) { throw "standalone main snapshot preparation failed" }
