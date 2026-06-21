# Stop the watchers launched by start_watchers.ps1, by PID. Idempotent: missing
# processes or a missing pid file are not errors.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo      = Split-Path -Parent $ScriptDir
$SharedDir = if ($env:SHARED_DIR) { $env:SHARED_DIR } else { Join-Path $Repo '.shared' }
$Events    = Join-Path $SharedDir 'events'
$PidFile   = Join-Path $Events 'watchers.pid'

if (-not (Test-Path $PidFile)) {
    Write-Host "No pid file at $PidFile - nothing to stop."
    exit 0
}

Get-Content $PidFile | ForEach-Object {
    $id = $_.Trim()
    if ($id) {
        try {
            Stop-Process -Id ([int]$id) -Force -ErrorAction Stop
            Write-Host "Stopped $id"
        } catch {
            Write-Host "Process $id not running"
        }
    }
}

Remove-Item $PidFile -Force
Write-Host "Removed $PidFile"
