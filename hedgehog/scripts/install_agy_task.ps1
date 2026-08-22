[CmdletBinding()]
param(
    [string]$Repo = "C:\SK-O\Hedgehog",
    [datetime]$FirstRun = (Get-Date).AddMinutes(2)
)

$ErrorActionPreference = "Stop"
$TaskName = "Hedgehog AGY Continuous"
$Runner = Join-Path $Repo "hedgehog\scripts\run_agy_loop.ps1"
if (-not (Test-Path $Runner)) { throw "Runner not found: $Runner" }

$PowerShell = (Get-Command powershell.exe).Source
$Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $Runner + '"'
$Action = New-ScheduledTaskAction -Execute $PowerShell -Argument $Arguments -WorkingDirectory $Repo

$Hourly = New-ScheduledTaskTrigger -Once -At $FirstRun `
    -RepetitionInterval (New-TimeSpan -Hours 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$AtLogon = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -WakeToRun `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 55) `
    -MultipleInstances IgnoreNew

$User = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $Action `
    -Trigger @($Hourly, $AtLogon) -Settings $Settings `
    -Principal $Principal -Force | Out-Null

$Task = Get-ScheduledTask -TaskName $TaskName
$Info = Get-ScheduledTaskInfo -TaskName $TaskName

[pscustomobject]@{
    TaskName = $Task.TaskName
    State = $Task.State
    User = $User
    FirstRun = $FirstRun
    NextRunTime = $Info.NextRunTime
    LastRunTime = $Info.LastRunTime
    LastTaskResult = $Info.LastTaskResult
}