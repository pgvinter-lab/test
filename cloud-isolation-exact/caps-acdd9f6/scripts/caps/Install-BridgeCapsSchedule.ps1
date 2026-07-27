<#
.SYNOPSIS
reasoned | script-rendered-from-reasoned-data | script-generated
#>

[CmdletBinding()]
param (
    [switch]$Apply,
    [switch]$Remove,
    [string]$RestoreManifest,
    [string]$SchedulerCmd = "schtasks.exe"
)

$ErrorActionPreference = 'Stop'

$mode = "Audit"
if ($Apply) { $mode = "Apply" }
if ($Remove) { $mode = "Remove" }

if ($Apply -and $Remove) { throw "Cannot specify both Apply and Remove switches" }
if ($RestoreManifest -and -not $Apply) { throw "RestoreManifest must be used with -Apply" }

$taskName = "\Bridge Caps Daily Refresh"
$codexTask = "\CodexConnector-CatalogSync"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)

$capsState = $env:BRIDGE_CAPS_STATE_DIR
if (-not $capsState) {
    $capsState = Join-Path $env:LOCALAPPDATA "Bridge2\caps"
}
$backupsDir = Join-Path $capsState "scheduler\backups"

function Export-TaskXML {
    param($tn, $outPath)
    $xml = & $SchedulerCmd /query /tn $tn /xml 2>$null
    if ($LASTEXITCODE -eq 0 -and $xml) {
        $xml | Out-File $outPath -Encoding Unicode
        if (-not (Test-Path $outPath)) { return $false }
        $hash = (Get-FileHash $outPath -Algorithm SHA256).Hash
        $manifestPath = "$outPath.manifest"
        $hash | Out-File $manifestPath -Encoding utf8
        if (-not (Test-Path $manifestPath)) { return $false }
        $verifyHash = (Get-FileHash $outPath -Algorithm SHA256).Hash
        if ($hash -ne $verifyHash) { return $false }
        $manifestContent = (Get-Content $manifestPath).Trim()
        if ($manifestContent -ne $verifyHash) { return $false }
        return $true
    }
    return $false
}

Write-Host "Mode: $mode"

if ($mode -ne "Audit" -and -not (Test-Path $backupsDir)) {
    New-Item -ItemType Directory -Path $backupsDir -Force | Out-Null
}

if ($mode -eq "Audit") {
    $output = & $SchedulerCmd /query /tn $codexTask /v /fo list 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Audit: $codexTask exists and is audited. It remains read-only."
        Write-Host $output
    } else {
        Write-Host "Audit: $codexTask not found."
    }
    Write-Host "Dry-run (Audit) complete. No changes made."
    exit 0
}

if ($mode -eq "Apply") {
    $invokeScript = Join-Path $scriptDir "Invoke-BridgeCapsRefresh.ps1"
    if (-not (Test-Path $invokeScript)) { throw "Missing $invokeScript" }

    $existingXmlPath = Join-Path $backupsDir "backup-$(Get-Date -Format 'yyyyMMddHHmmss').xml"
    $taskExists = & $SchedulerCmd /query /tn $taskName 2>$null
    if ($LASTEXITCODE -eq 0) {
        if (-not (Export-TaskXML -tn $taskName -outPath $existingXmlPath)) {
            throw "Failed to backup and verify manifest before apply."
        }
        Write-Host "Backed up existing task to $existingXmlPath"
    }

    if ($RestoreManifest) {
        if (-not (Test-Path $RestoreManifest)) { throw "Manifest file not found at $RestoreManifest" }
        $restoreXmlPath = $RestoreManifest -replace '\.manifest$', ''
        if (-not (Test-Path $restoreXmlPath)) { throw "Backup XML file not found at $restoreXmlPath" }

        $expectedHash = (Get-Content $RestoreManifest).Trim()
        $actualHash = (Get-FileHash $restoreXmlPath -Algorithm SHA256).Hash

        if ($expectedHash -ne $actualHash) { throw "Backup XML hash mismatch for restore" }
        $xmlToApply = $restoreXmlPath
    } else {
        $powershellExe = (Get-Command powershell -ErrorAction Ignore).Source
        $xmlTemplate = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Bridge Caps Daily Refresh</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2020-01-01T06:30:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>true</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$powershellExe</Command>
      <Arguments>-NoProfile -ExecutionPolicy Bypass -File "$invokeScript"</Arguments>
      <WorkingDirectory>$repoRoot</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
        $xmlToApply = Join-Path $capsState "scheduler\apply-$(Get-Date -Format 'yyyyMMddHHmmss').xml"
        $xmlTemplate | Out-File $xmlToApply -Encoding Unicode
    }

    $args = @( "/create", "/tn", $taskName, "/xml", $xmlToApply, "/f" )

    & $SchedulerCmd $args
    if ($LASTEXITCODE -ne 0) { throw "Failed to apply schedule." }
    Write-Host "Task applied."
}

if ($mode -eq "Remove") {
    $existingXmlPath = Join-Path $backupsDir "backup-$(Get-Date -Format 'yyyyMMddHHmmss').xml"
    $taskExists = & $SchedulerCmd /query /tn $taskName 2>$null
    if ($LASTEXITCODE -eq 0) {
        $backupOk = Export-TaskXML -tn $taskName -outPath $existingXmlPath
        if (-not $backupOk) { throw "Failed to backup and verify manifest before removal." }
        & $SchedulerCmd /delete /tn $taskName /f
        if ($LASTEXITCODE -ne 0) { throw "Failed to remove task." }
        Write-Host "Task removed. Backup at $existingXmlPath"
    } else {
        Write-Host "Task not found. Nothing to remove."
    }
}
