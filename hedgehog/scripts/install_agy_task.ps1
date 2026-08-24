[CmdletBinding()]
param(
    [string]$Repo = "C:\SK-O\Hedgehog",
    [datetime]$FirstRun = (Get-Date).AddMinutes(2),
    [switch]$EnableAfterSmokeTest
)

$ErrorActionPreference = "Stop"
$TaskName = "Hedgehog AGY Continuous"
$Runner = Join-Path $Repo "hedgehog\scripts\run_agy_loop.ps1"
if (-not (Test-Path -LiteralPath $Runner -PathType Leaf)) {
    throw "Runner not found: $Runner"
}

$PowerShell = (Get-Command powershell.exe).Source
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing) {
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
}

function Invoke-RunnerPreflight {
    param([Parameter(Mandatory=$true)][string]$Mode)

    $Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
        $Runner + '" ' + $Mode
    $Process = Start-Process -FilePath $PowerShell `
        -ArgumentList $Arguments `
        -WorkingDirectory $Repo `
        -NoNewWindow -Wait -PassThru
    if ($Process.ExitCode -ne 0) {
        throw "Hedgehog runner preflight $Mode failed with exit $($Process.ExitCode)"
    }
}

Invoke-RunnerPreflight -Mode "-ValidateOnly"
if ($EnableAfterSmokeTest) {
    Invoke-RunnerPreflight -Mode "-SmokeTest"
}

$Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $Runner + '"'
$Action = New-ScheduledTaskAction -Execute $PowerShell -Argument $Arguments -WorkingDirectory $Repo

$Hourly = New-ScheduledTaskTrigger -Once -At $FirstRun `
    -RepetitionInterval (New-TimeSpan -Hours 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$AtLogon = New-ScheduledTaskTrigger -AtLogOn `
    -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -WakeToRun `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 55) `
    -MultipleInstances IgnoreNew

$User = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$Principal = New-ScheduledTaskPrincipal `
    -UserId $User -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $Action `
    -Trigger @($Hourly, $AtLogon) -Settings $Settings `
    -Principal $Principal -Force | Out-Null

if ($EnableAfterSmokeTest) {
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
} else {
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
}

$Task = Get-ScheduledTask -TaskName $TaskName
$Info = Get-ScheduledTaskInfo -TaskName $TaskName

[pscustomobject]@{
    TaskName = $Task.TaskName
    State = $Task.State
    User = $User
    Engine = "agy.exe"
    SmokeTestRequiredForEnable = $true
    EnabledAfterSmokeTest = [bool]$EnableAfterSmokeTest
    FirstRun = $FirstRun
    NextRunTime = $Info.NextRunTime
    LastRunTime = $Info.LastRunTime
    LastTaskResult = $Info.LastTaskResult
}
