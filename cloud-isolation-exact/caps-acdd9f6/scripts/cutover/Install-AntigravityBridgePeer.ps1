[CmdletBinding()]
param(
  [string]$ReleaseRoot,
  [switch]$Apply,
  [string]$RollbackBackup
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Resolve-ExistingPath([string]$Value, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw "$Label is required." }
  $resolved = (Resolve-Path -LiteralPath $Value -ErrorAction Stop).Path
  if (-not (Test-Path -LiteralPath $resolved)) { throw "$Label does not exist: $resolved" }
  return $resolved
}

function Assert-Within([string]$Candidate, [string]$Root, [string]$Label) {
  $candidatePath = [IO.Path]::GetFullPath($Candidate).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if (-not $candidatePath.StartsWith("$rootPath$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label is outside its allowed root: $candidatePath"
  }
}

function Write-JsonAtomic([string]$Path, [object]$Value) {
  $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    $json = ($Value | ConvertTo-Json -Depth 100) + [Environment]::NewLine
    [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  }
}

function Copy-Backup([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source)) { return $false }
  if ((Get-Item -LiteralPath $Source).PSIsContainer) {
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse
  } else {
    Copy-Item -LiteralPath $Source -Destination $Destination
  }
  return $true
}

function Restore-Backup([string]$BackupRoot) {
  $resolvedBackup = Resolve-ExistingPath $BackupRoot "Rollback backup"
  $manifestPath = Join-Path $resolvedBackup "manifest.json"
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  foreach ($entry in $manifest.targets) {
    $target = [string]$entry.target
    $allowedRoot = [string]$entry.allowedRoot
    Assert-Within $target $allowedRoot "Rollback target"
    if (Test-Path -LiteralPath $target) {
      $item = Get-Item -LiteralPath $target
      if ($item.PSIsContainer) { Remove-Item -LiteralPath $target -Recurse -Force }
      else { Remove-Item -LiteralPath $target -Force }
    }
    if ([bool]$entry.existed) {
      $source = Join-Path $resolvedBackup ([string]$entry.backupName)
      if ((Get-Item -LiteralPath $source).PSIsContainer) {
        Copy-Item -LiteralPath $source -Destination $target -Recurse
      } else {
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $target
      }
    }
  }
  [ordered]@{ ok = $true; rolledBackFrom = $resolvedBackup } | ConvertTo-Json -Depth 5
}

if (-not [string]::IsNullOrWhiteSpace($RollbackBackup)) {
  if ($Apply) { throw "Use either -Apply or -RollbackBackup, not both." }
  Restore-Backup $RollbackBackup
  exit 0
}

$release = Resolve-ExistingPath $ReleaseRoot "ReleaseRoot"
$server = Join-Path $release "dist\server.js"
$mailboxCli = Join-Path $release "dist\v2\mailbox\cli.js"
foreach ($required in @($server, $mailboxCli, (Join-Path $release "package.json"))) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Candidate release is incomplete: $required" }
}

$userProfileRoot = [Environment]::GetFolderPath("UserProfile")
$localAppDataRoot = [Environment]::GetFolderPath("LocalApplicationData")
$geminiRoot = Join-Path $userProfileRoot ".gemini"
$geminiConfigRoot = Join-Path $geminiRoot "config"
$bridgeRoot = Join-Path $localAppDataRoot "Bridge2"
$mailboxRoot = Join-Path $bridgeRoot "mailbox"
$mcpConfigPath = Join-Path $geminiConfigRoot "mcp_config.json"
$permissionConfigPath = Join-Path $geminiConfigRoot "config.json"
$importManifestPath = Join-Path $geminiConfigRoot "import_manifest.json"
$mailboxConfigPath = Join-Path $mailboxRoot "config.json"
$pluginSource = Join-Path $mailboxRoot "antigravity-plugin"
$installedPlugin = Join-Path $geminiConfigRoot "plugins\bridge-mailbox"
$chromeIntegration = Join-Path $mailboxRoot "chrome-extension"

foreach ($candidate in @($mcpConfigPath, $permissionConfigPath, $importManifestPath, $installedPlugin)) {
  Assert-Within $candidate $geminiRoot "Antigravity configuration target"
}
foreach ($candidate in @($mailboxConfigPath, $pluginSource, $chromeIntegration)) {
  Assert-Within $candidate $bridgeRoot "Bridge state target"
}
foreach ($required in @($mcpConfigPath, $permissionConfigPath, $mailboxConfigPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required live configuration is missing: $required" }
}

$plan = [ordered]@{
  ok = $true
  mode = $(if ($Apply) { "apply" } else { "dry-run" })
  releaseRoot = $release
  bridgeServer = $server
  mcpConfig = $mcpConfigPath
  permissionConfig = $permissionConfigPath
  pluginSource = $pluginSource
  installedPlugin = $installedPlugin
  permissions = @(
    "mcp(bridge/bridge_a2a_send)",
    "mcp(bridge/bridge_a2a_get)",
    "mcp(bridge/bridge_task_dispatch)"
  )
}
if (-not $Apply) {
  $plan | ConvertTo-Json -Depth 8
  exit 0
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupRoot = Join-Path $bridgeRoot "cutovers\antigravity-peer-$timestamp"
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
$targets = @(
  [ordered]@{ target = $mcpConfigPath; allowedRoot = $geminiRoot; backupName = "mcp_config.json" },
  [ordered]@{ target = $permissionConfigPath; allowedRoot = $geminiRoot; backupName = "config.json" },
  [ordered]@{ target = $importManifestPath; allowedRoot = $geminiRoot; backupName = "import_manifest.json" },
  [ordered]@{ target = $pluginSource; allowedRoot = $bridgeRoot; backupName = "plugin-source" },
  [ordered]@{ target = $installedPlugin; allowedRoot = $geminiRoot; backupName = "plugin-installed" },
  [ordered]@{ target = $chromeIntegration; allowedRoot = $bridgeRoot; backupName = "chrome-extension" }
)
foreach ($entry in $targets) {
  $entry["existed"] = Copy-Backup ([string]$entry.target) (Join-Path $backupRoot ([string]$entry.backupName))
}
Write-JsonAtomic (Join-Path $backupRoot "manifest.json") ([ordered]@{
  schemaVersion = "bridge-antigravity-peer-cutover-v1"
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  releaseRoot = $release
  targets = $targets
})

try {
  $mcp = Get-Content -Raw -LiteralPath $mcpConfigPath | ConvertFrom-Json
  if ($null -eq $mcp.mcpServers.bridge) { throw "The Antigravity bridge MCP entry is missing." }
  $nodeCommand = [string]$mcp.mcpServers.bridge.command
  if (-not (Test-Path -LiteralPath $nodeCommand -PathType Leaf)) { throw "Configured Node executable is unavailable: $nodeCommand" }
  $mcp.mcpServers.bridge.command = $nodeCommand
  $mcp.mcpServers.bridge.args = @($server)
  $mcp.mcpServers.bridge.env = [ordered]@{
    BRIDGE_AGENT = "antigravity"
    BRIDGE_LANE = "google_antigravity"
  }
  Write-JsonAtomic $mcpConfigPath $mcp

  $permissions = Get-Content -Raw -LiteralPath $permissionConfigPath | ConvertFrom-Json
  $allow = @($permissions.userSettings.globalPermissionGrants.allow)
  foreach ($grant in $plan.permissions) {
    if ($allow -notcontains $grant) { $allow += $grant }
  }
  $permissions.userSettings.globalPermissionGrants.allow = @($allow | Sort-Object -Unique)
  Write-JsonAtomic $permissionConfigPath $permissions

  & $nodeCommand $mailboxCli install-integrations --config $mailboxConfigPath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Bridge integration generation failed with exit code $LASTEXITCODE." }

  $agy = (Get-Command agy -ErrorAction Stop).Source
  $validation = & $agy plugin validate $pluginSource 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "Antigravity rejected the Bridge plugin: $validation" }
  if ($validation -notmatch "skills\s*:\s*1 processed" -or $validation -notmatch "mcpServers\s*:\s*1 processed") {
    throw "Antigravity did not load both Bridge skill and MCP components: $validation"
  }
  $beforeList = (& $agy plugin list 2>&1 | Out-String) | ConvertFrom-Json
  if (@($beforeList.imports).Where({ $_.name -eq "bridge-mailbox" }).Count -gt 0) {
    & $agy plugin uninstall bridge-mailbox | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Antigravity could not remove the stale Bridge plugin registration." }
  }
  $installation = & $agy plugin install $pluginSource 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0 -or $installation -notmatch "skills\s*:\s*1 processed" -or $installation -notmatch "mcpServers\s*:\s*1 processed") {
    throw "Antigravity did not install both Bridge skill and MCP components: $installation"
  }
  $pluginList = & $agy plugin list 2>&1 | Out-String
  $installed = @((ConvertFrom-Json $pluginList).imports).Where({ $_.name -eq "bridge-mailbox" }) | Select-Object -First 1
  if ($LASTEXITCODE -ne 0 -or $null -eq $installed -or @($installed.components) -notcontains "skills" -or @($installed.components) -notcontains "mcpServers") {
    throw "Antigravity no longer reports bridge-mailbox as installed: $pluginList"
  }

  $result = [ordered]@{
    ok = $true
    mode = "applied"
    releaseRoot = $release
    backupRoot = $backupRoot
    rollbackCommand = "& `"$PSCommandPath`" -RollbackBackup `"$backupRoot`""
    pluginValidated = $true
    mcpIdentity = [ordered]@{ agent = "antigravity"; lane = "google_antigravity" }
    permissionsAdded = $plan.permissions
  }
  $result | ConvertTo-Json -Depth 8
} catch {
  try { Restore-Backup $backupRoot | Out-Null } catch { }
  throw
}
