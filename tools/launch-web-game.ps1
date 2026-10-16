param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$repository = Split-Path $PSScriptRoot -Parent
try {
    $result = & node (Join-Path $PSScriptRoot 'local-game.mjs') start 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($result -join "`n") }
    $game = ($result -join "`n") | ConvertFrom-Json
    if (!$NoOpen) { Start-Process $game.url }
    Write-Output ($game | ConvertTo-Json -Compress)
} catch {
    if (!$NoOpen) {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show("The web game could not be verified. No other build was opened.`n`n$_", 'RTS AI Web Game') | Out-Null
    }
    Write-Error $_
    exit 1
}
