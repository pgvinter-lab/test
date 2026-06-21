# Launch both orchestrator watchers as DETACHED background processes that survive
# this PowerShell session (Start-Process spawns independent processes). Writes their
# PIDs to .shared\events\watchers.pid and prints a startup banner. Stop them with
# stop_watchers.ps1.
#
# Honors $env:SHARED_DIR (default <repo>\.shared) and passes the watcher env through.
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo      = Split-Path -Parent $ScriptDir
$SharedDir = if ($env:SHARED_DIR) { $env:SHARED_DIR } else { Join-Path $Repo '.shared' }
$Events    = Join-Path $SharedDir 'events'
New-Item -ItemType Directory -Force -Path $Events | Out-Null

# Resolve a python interpreter.
$pyPre = @()
$pyCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $pyCmd) {
    $pyCmd = Get-Command py -ErrorAction SilentlyContinue
    if ($pyCmd) { $pyPre = @('-3') }
}
if (-not $pyCmd) { Write-Error 'No python interpreter (python/py) found on PATH'; exit 1 }
$py = $pyCmd.Source

# Ensure the watchers inherit the same shared dir.
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

Set-Content -Path (Join-Path $Events 'watchers.pid') `
    -Value @("$($cowork.Id)", "$($codex.Id)") -Encoding ascii

Write-Host "============================================================"
Write-Host "  Orchestrator watchers started (detached)"
Write-Host "------------------------------------------------------------"
Write-Host "  watch_cowork.py   pid $($cowork.Id)   git-fetch poll"
Write-Host "  watch_codex.py    pid $($codex.Id)   mtime poll"
Write-Host "  shared dir     -> $SharedDir"
Write-Host "  event stream   -> $(Join-Path $Events 'orchestrator_inbox.jsonl')"
Write-Host "  logs           -> $(Join-Path $Events 'watch_cowork.log')"
Write-Host "                    $(Join-Path $Events 'watch_codex.log')"
Write-Host "  pid file       -> $(Join-Path $Events 'watchers.pid')"
Write-Host "  stop with      -> powershell -File $(Join-Path $ScriptDir 'stop_watchers.ps1')"
Write-Host "============================================================"
