# Launch both orchestrator watchers as DETACHED background processes that survive
# this PowerShell session. Writes namespace-tagged PIDs ("ps:<id>") to
# .shared\events\watchers.pid and prints a startup banner. Stop with stop_watchers.ps1.
#
# Hardening (Forge review): F14 namespace-tagged pids, F15 already-running guard so a
# double-start can't spawn a duplicate pair or orphan the pid file.
#
# Honors $env:SHARED_DIR (default <repo>\.shared).
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo      = Split-Path -Parent $ScriptDir
$SharedDir = if ($env:SHARED_DIR) { $env:SHARED_DIR } else { Join-Path $Repo '.shared' }
$Events    = Join-Path $SharedDir 'events'
$PidFile   = Join-Path $Events 'watchers.pid'
New-Item -ItemType Directory -Force -Path $Events | Out-Null

# F15: refuse to start if a PowerShell-launched watcher is already alive (identity-checked).
if (Test-Path $PidFile) {
    foreach ($raw in Get-Content $PidFile) {
        $line = $raw.Trim(); if (-not $line) { continue }
        if ($line -like 'ps:*') {
            $id = $line.Substring(3)
            $p = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue
            if ($p -and ($p.Path -like '*python*' -or $p.ProcessName -like 'py*')) {
                Write-Error "watchers already running (ps:$id); stop first: stop_watchers.ps1"
                exit 3
            }
        }
    }
}

# Resolve a python interpreter.
$pyPre = @()
$pyCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $pyCmd) {
    $pyCmd = Get-Command py -ErrorAction SilentlyContinue
    if ($pyCmd) { $pyPre = @('-3') }
}
if (-not $pyCmd) { Write-Error 'No python interpreter (python/py) found on PATH'; exit 1 }
$py = $pyCmd.Source

$env:SHARED_DIR = $SharedDir

$cowork = Start-Process -FilePath $py `
    -ArgumentList ($pyPre + @((Join-Path $ScriptDir 'watch_cowork.py'))) `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $Events 'watch_cowork.out') `
    -RedirectStandardError  (Join-Path $Events 'watch_cowork.err')

$codex = Start-Process -FilePath $py `
    -ArgumentList ($pyPre + @((Join-Path $ScriptDir 'watch_codex.py'))) `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $Events 'watch_codex.out') `
    -RedirectStandardError  (Join-Path $Events 'watch_codex.err')

# F14: tag each line with the runtime so stop_watchers.{sh,ps1} can refuse a
# wrong-namespace pid (Windows pids and MSYS pids are different number spaces).
Set-Content -Path $PidFile -Value @("ps:$($cowork.Id)", "ps:$($codex.Id)") -Encoding ascii

Write-Host "============================================================"
Write-Host "  Orchestrator watchers started (detached)"
Write-Host "------------------------------------------------------------"
Write-Host "  watch_cowork.py   pid ps:$($cowork.Id)   git-fetch poll"
Write-Host "  watch_codex.py    pid ps:$($codex.Id)   mtime poll"
Write-Host "  shared dir     -> $SharedDir"
Write-Host "  event stream   -> $(Join-Path $Events 'orchestrator_inbox.jsonl')"
Write-Host "  logs (cycles)  -> $(Join-Path $Events 'watch_cowork.log') $(Join-Path $Events 'watch_codex.log')"
Write-Host "  crashes/stderr -> $(Join-Path $Events 'watch_cowork.err') $(Join-Path $Events 'watch_codex.err')"
Write-Host "  pid file       -> $PidFile"
Write-Host "  stop with      -> powershell -File $(Join-Path $ScriptDir 'stop_watchers.ps1')"
Write-Host "============================================================"
