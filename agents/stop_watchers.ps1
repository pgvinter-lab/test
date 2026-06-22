# Stop PowerShell-launched watchers (ps:<id> lines) from watchers.pid. Idempotent.
# F14: refuses bash-launched (sh:) pids - different PID namespace; stop those with
# stop_watchers.sh. Any skipped sh: entries are kept so they are not orphaned.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo      = Split-Path -Parent $ScriptDir
$SharedDir = if ($env:SHARED_DIR) { $env:SHARED_DIR } else { Join-Path $Repo '.shared' }
$Events    = Join-Path $SharedDir 'events'
$PidFile   = Join-Path $Events 'watchers.pid'

if (-not (Test-Path $PidFile)) {
    Write-Host "No pid file at $PidFile - nothing to stop."
    exit 0
}

$mine = @(); $skipped = @()
foreach ($raw in Get-Content $PidFile) {
    $line = $raw.Trim(); if (-not $line) { continue }
    if ($line -like 'ps:*')     { $mine    += $line.Substring(3) }
    elseif ($line -like 'sh:*') { $skipped += $line }
    else                        { $mine    += $line }   # legacy bare pid
}

foreach ($id in $mine) {
    try {
        Stop-Process -Id ([int]$id) -Force -ErrorAction Stop
        Write-Host "Stopped $id"
    } catch {
        Write-Host "Process $id not running"
    }
}

if ($skipped.Count -gt 0) {
    Set-Content -Path $PidFile -Value $skipped -Encoding ascii
    Write-Host "Kept $($skipped.Count) bash-launched pid(s) in $PidFile; stop those with stop_watchers.sh."
} else {
    Remove-Item $PidFile -Force
    Write-Host "Removed $PidFile"
}
