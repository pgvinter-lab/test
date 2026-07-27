<#
.SYNOPSIS
reasoned | script-rendered-from-reasoned-data | script-generated
#>

$ErrorActionPreference = 'Stop'

$startTime = Get-Date

$nodeExe = (Get-Command node -ErrorAction Ignore).Source
if (-not $nodeExe) { throw "Node.exe not found on PATH" }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
$entrypoint = Join-Path $repoRoot "dist\cli.js"

if (-not (Test-Path $entrypoint)) {
    throw "Built entrypoint dist\cli.js not found at $entrypoint"
}

$capsState = $env:BRIDGE_CAPS_STATE_DIR
if (-not $capsState) {
    $capsState = Join-Path $env:LOCALAPPDATA "Bridge2\caps"
}
$logDir = Join-Path $capsState "scheduler\logs"
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $logDir "refresh-$timestamp.json"

$envVarsToKeep = @("SystemRoot", "SystemDrive", "Path", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "BRIDGE_CAPS_STATE_DIR")
foreach ($key in [System.Environment]::GetEnvironmentVariables().Keys) {
    if ($key -notin $envVarsToKeep) {
        Remove-Item -Path "Env:\$key" -ErrorAction Ignore
    }
}

$processArgs = @("`"$entrypoint`"", "caps", "refresh", "--lane", "all")
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $nodeExe
$startInfo.Arguments = $processArgs -join ' '
$startInfo.WorkingDirectory = $repoRoot
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.CreateNoWindow = $true

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $startInfo

$output = [System.Text.StringBuilder]::new()
$errorOutput = [System.Text.StringBuilder]::new()

try {
    $process.Start() | Out-Null
    $outTask = $process.StandardOutput.ReadToEndAsync()
    $errTask = $process.StandardError.ReadToEndAsync()

    $process.WaitForExit()
    $childExitCode = $process.ExitCode

    $outStr = $outTask.Result
    $errStr = $errTask.Result

    if ($outStr -and $outStr.Length -gt 1000000) { $outStr = $outStr.Substring(0, 1000000) }
    if ($errStr -and $errStr.Length -gt 50000) { $errStr = $errStr.Substring(0, 50000) }

    $output.Append($outStr) | Out-Null
    $errorOutput.Append($errStr) | Out-Null
} finally {
    if ($process) {
        $process.Dispose()
    }
}

$endTime = Get-Date

$stderrLines = $errorOutput.ToString().Split([Environment]::NewLine, [StringSplitOptions]::RemoveEmptyEntries)
$boundedStderr = if ($stderrLines.Count -gt 50) { $stderrLines[0..49] -join "`n" } else { $stderrLines -join "`n" }
$fullOutput = $output.ToString()

$wrapperExitCode = 1
$resultClass = "error"
$parsedReport = $null

try {
    if ($fullOutput) {
        $parsedReport = $fullOutput | ConvertFrom-Json -ErrorAction Stop
    }
} catch {
    $parsedReport = $null
}

$lifecycleStatus = ""
if ($parsedReport -and $parsedReport.schema -eq "bridge-caps-refresh-report-v1" -and $parsedReport.lifecycle_status -is [string]) {
    $lifecycleStatus = $parsedReport.lifecycle_status
}

if ($childExitCode -eq 0 -and $lifecycleStatus -eq "terminal-success") {
    $wrapperExitCode = 0
    $resultClass = "success"
}

$refreshReportId = ""
if (
    $parsedReport -and
    $parsedReport.refresh_run_id -is [string] -and
    $parsedReport.refresh_run_id.Length -gt 0 -and
    $parsedReport.refresh_run_id.Length -le 256 -and
    $parsedReport.refresh_run_id -match '^[a-zA-Z0-9_-]+$'
) {
    $refreshReportId = $parsedReport.refresh_run_id
}

if ($childExitCode -eq 0 -and $lifecycleStatus -eq "already_running") {
    $wrapperExitCode = 0
    $resultClass = "already_running"
}

$receipt = [PSCustomObject]@{
    StartTime = $startTime.ToString('o')
    EndTime = $endTime.ToString('o')
    ResultClass = $resultClass
    ChildExit = $childExitCode
    WrapperExit = $wrapperExitCode
    LifecycleStatus = $lifecycleStatus
    RefreshReportId = $refreshReportId
    NodeExe = $nodeExe
    Entrypoint = $entrypoint
    RepoRoot = $repoRoot
    BoundedStderr = $boundedStderr
    LogPath = $logFile
    Provenance = "script-generated"
}

$tempLogFile = "$logFile.tmp"
$jsonStr = $receipt | ConvertTo-Json -Depth 3
[System.IO.File]::WriteAllText($tempLogFile, $jsonStr)
Rename-Item -Path $tempLogFile -NewName (Split-Path $logFile -Leaf) -Force
exit $wrapperExitCode
