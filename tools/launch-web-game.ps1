param([switch]$NoOpen, [switch]$BrowserTab, [switch]$Public)
$ErrorActionPreference = 'Stop'
$repository = Split-Path $PSScriptRoot -Parent
try {
    if ($Public) {
        $game = [pscustomobject]@{ url = 'https://rtsai.net/play/'; target = 'production' }
    } else {
        $result = & node (Join-Path $PSScriptRoot 'local-game.mjs') start 2>&1
        if ($LASTEXITCODE -ne 0) { throw ($result -join "`n") }
        $game = ($result -join "`n") | ConvertFrom-Json
    }
    if (!$NoOpen) {
        $browser = @(
            "$env:ProgramFiles/Google/Chrome/Application/chrome.exe",
            "${env:ProgramFiles(x86)}/Microsoft/Edge/Application/msedge.exe"
        ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        if ($browser -and !$BrowserTab) { Start-Process -FilePath $browser -ArgumentList "--app=$($game.url)" }
        else { Start-Process $game.url }
    }
    Write-Output ($game | ConvertTo-Json -Compress)
} catch {
    if (!$NoOpen) {
        Add-Type -AssemblyName PresentationFramework
        $failure = if ($Public) { 'The public web game could not be opened.' } else { 'The web game could not be verified. No other build was opened.' }
        [System.Windows.MessageBox]::Show("$failure`n`n$_", 'RTS AI Web Game') | Out-Null
    }
    Write-Error $_
    exit 1
}
