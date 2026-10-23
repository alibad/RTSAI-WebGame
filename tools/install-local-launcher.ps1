param([string]$BackupDirectory)
$ErrorActionPreference = 'Stop'
$repository = Split-Path $PSScriptRoot -Parent
$launcher = Join-Path $PSScriptRoot 'launch-web-game.ps1'
& node (Join-Path $PSScriptRoot 'local-game.mjs') verify
if ($LASTEXITCODE -ne 0) { throw 'Register and verify the accepted web game before installing its shortcut.' }
$shell = New-Object -ComObject WScript.Shell
$destinations = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'RTS AI Web Game.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'RTS AI/RTS AI Web Game.lnk')
)
foreach ($destination in $destinations) {
    if (Test-Path -LiteralPath $destination) {
        if (!$BackupDirectory) { throw 'Supply -BackupDirectory to preserve an existing launcher before replacement.' }
        New-Item -ItemType Directory -Force -Path $BackupDirectory | Out-Null
        Copy-Item -LiteralPath $destination -Destination (Join-Path $BackupDirectory (([guid]::NewGuid().ToString()) + '.lnk'))
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
    $shortcut = $shell.CreateShortcut($destination)
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
    $shortcut.WorkingDirectory = $repository
    $shortcut.Description = 'Open the checksum-verified local web game; refuse missing or mismatched builds.'
    $shortcut.IconLocation = (Join-Path $repository 'web/public/favicon.ico') + ',0'
    $shortcut.Save()
    Write-Output "Installed $destination"
}
