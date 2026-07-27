[CmdletBinding()]
param(
    [ValidateSet("Test", "Rollback", "HoldLock")]
    [string]$Action = "Test",

    [string]$Plan,
    [string]$Transaction,
    [string]$TransactionRoot,
    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "windows_only_cutover_harness"
}

$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Get-RequiredString {
    param([object]$Object, [string]$Name)
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $property.Value -isnot [string] -or [string]::IsNullOrWhiteSpace($property.Value)) {
        throw "missing_or_invalid_$Name"
    }
    return $property.Value
}

function Resolve-Absolute {
    param([string]$Value, [string]$Label)
    if (-not [System.IO.Path]::IsPathRooted($Value) -or $Value -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)') {
        throw "${Label}_must_be_absolute"
    }
    return [System.IO.Path]::GetFullPath($Value)
}

function Normalize-Root {
    param([string]$Value, [string]$Label)
    $full = Resolve-Absolute $Value $Label
    if (-not [System.IO.Directory]::Exists($full)) {
        throw "${Label}_missing"
    }
    $item = Get-Item -LiteralPath $full -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "${Label}_reparse_point_forbidden"
    }
    $trimmed = $full.TrimEnd([char[]]@('\', '/'))
    if ($trimmed -match '^[A-Za-z]:$') { $trimmed += '\' }
    return $trimmed
}

function Test-Contained {
    param([string]$Path, [string]$Root)
    if ([string]::Equals($Path, $Root, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    $prefix = if ($Root.EndsWith('\') -or $Root.EndsWith('/')) { $Root } else { "$Root$([System.IO.Path]::DirectorySeparatorChar)" }
    return $Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparsePath {
    param([string]$Path, [string]$Root, [string]$Label)
    if (-not (Test-Contained $Path $Root)) { throw "${Label}_outside_root" }
    $relative = if ([string]::Equals($Path, $Root, [StringComparison]::OrdinalIgnoreCase)) {
        ''
    } else {
        $prefixLength = $Root.Length
        if (-not ($Root.EndsWith('\') -or $Root.EndsWith('/'))) { $prefixLength += 1 }
        $Path.Substring($prefixLength)
    }
    $cursor = $Root
    foreach ($part in ($relative -split '[\\/]' | Where-Object { $_ -and $_ -ne '.' })) {
        $cursor = [System.IO.Path]::Combine($cursor, $part)
        if ([System.IO.File]::Exists($cursor) -or [System.IO.Directory]::Exists($cursor)) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "${Label}_reparse_point_forbidden"
            }
        }
    }
}

function Resolve-ContainedFile {
    param([string]$Value, [string]$Root, [string]$Label)
    $full = Resolve-Absolute $Value $Label
    if (-not (Test-Contained $full $Root)) { throw "${Label}_outside_root" }
    if (-not [System.IO.File]::Exists($full)) { throw "${Label}_missing" }
    Assert-NoReparsePath $full $Root $Label
    return $full
}

function Assert-HexHash {
    param([string]$Value, [string]$Label)
    if ($Value -notmatch '^[0-9a-fA-F]{64}$') { throw "${Label}_invalid_sha256" }
}

function Get-Sha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-BytesSha256 {
    param([byte[]]$Bytes)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        return (($algorithm.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally { $algorithm.Dispose() }
}

function Get-DistTreeSha256 {
    param([string]$CandidateRoot)
    $distRoot = [System.IO.Path]::Combine($CandidateRoot, 'dist')
    if (-not [System.IO.Directory]::Exists($distRoot)) { throw "candidate_dist_missing" }
    $rootItem = Get-Item -LiteralPath $distRoot -Force
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "candidate_dist_reparse_point_forbidden" }
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($distRoot)
    $inventory = [System.Collections.Generic.List[string]]::new()
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "candidate_dist_reparse_point_forbidden:$($item.FullName)"
            }
            if ($item.PSIsContainer) {
                $pending.Push($item.FullName)
                continue
            }
            $prefixLength = $distRoot.Length
            if (-not ($distRoot.EndsWith('\') -or $distRoot.EndsWith('/'))) { $prefixLength += 1 }
            $relative = $item.FullName.Substring($prefixLength).Replace('\', '/')
            $inventory.Add("$relative`0$(Get-Sha256 $item.FullName)")
        }
    }
    if ($inventory.Count -eq 0) { throw "candidate_dist_empty" }
    $lines = $inventory.ToArray()
    [Array]::Sort($lines, [StringComparer]::Ordinal)
    return Get-BytesSha256 ($Utf8NoBom.GetBytes((($lines -join "`n") + "`n")))
}

function Read-Json {
    param([string]$Path)
    try { return [System.IO.File]::ReadAllText($Path, $Utf8NoBom) | ConvertFrom-Json }
    catch { throw "invalid_json:$Path" }
}

function ConvertTo-JsonBytes {
    param([object]$Value)
    $json = ($Value | ConvertTo-Json -Depth 50) + "`n"
    return $Utf8NoBom.GetBytes($json)
}

function Write-NewBytes {
    param([string]$Path, [byte[]]$Bytes)
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
}

function Set-ExistingBytesAtomically {
    param([string]$Path, [byte[]]$Bytes)
    $directory = [System.IO.Path]::GetDirectoryName($Path)
    $nonce = [Guid]::NewGuid().ToString("N")
    $temporary = Join-Path $directory (".{0}.{1}.tmp" -f [System.IO.Path]::GetFileName($Path), $nonce)
    $replacementBackup = Join-Path $directory (".{0}.{1}.replace-backup" -f [System.IO.Path]::GetFileName($Path), $nonce)
    try {
        Write-NewBytes $temporary $Bytes
        [System.IO.File]::Replace($temporary, $Path, $replacementBackup, $true)
    } finally {
        if ([System.IO.File]::Exists($temporary)) { Remove-Item -LiteralPath $temporary -Force }
        if ([System.IO.File]::Exists($replacementBackup)) { Remove-Item -LiteralPath $replacementBackup -Force }
    }
}

function Write-Transaction {
    param([string]$Path, [object]$Value)
    $bytes = ConvertTo-JsonBytes $Value
    if ([System.IO.File]::Exists($Path)) { Set-ExistingBytesAtomically $Path $bytes }
    else { Write-NewBytes $Path $bytes }
}

function Enter-CutoverLock {
    param([string]$TransactionRoot)
    $lockPath = Join-Path $TransactionRoot '.bridge-test-cutover.lock'
    try {
        $stream = [System.IO.File]::Open(
            $lockPath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
    } catch {
        throw "cutover_transaction_lock_held:$lockPath"
    }
    try {
        $stream.SetLength(0)
        $metadata = $Utf8NoBom.GetBytes("pid=$PID`nacquiredAt=$((Get-Date).ToUniversalTime().ToString('o'))`n")
        $stream.Write($metadata, 0, $metadata.Length)
        $stream.Flush($true)
        return [pscustomobject]@{ path = $lockPath; stream = $stream }
    } catch {
        $stream.Dispose()
        throw
    }
}

function Exit-CutoverLock {
    param([object]$Lock)
    if ($null -ne $Lock -and $null -ne $Lock.stream) { $Lock.stream.Dispose() }
}

function Invoke-Process {
    param([string]$FileName, [string[]]$Arguments)
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $FileName
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $quoted = foreach ($argument in $Arguments) {
        if ($null -eq $argument) { throw "null_process_argument" }
        if ($argument.Length -gt 0 -and $argument -notmatch '[\s"]') {
            $argument
            continue
        }
        $builder = [System.Text.StringBuilder]::new()
        [void]$builder.Append('"')
        $slashes = 0
        foreach ($character in $argument.ToCharArray()) {
            if ($character -eq '\') {
                $slashes += 1
            } elseif ($character -eq '"') {
                [void]$builder.Append(('\' * (($slashes * 2) + 1)))
                [void]$builder.Append('"')
                $slashes = 0
            } else {
                if ($slashes -gt 0) { [void]$builder.Append(('\' * $slashes)); $slashes = 0 }
                [void]$builder.Append($character)
            }
        }
        if ($slashes -gt 0) { [void]$builder.Append(('\' * ($slashes * 2))) }
        [void]$builder.Append('"')
        $builder.ToString()
    }
    $start.Arguments = $quoted -join ' '
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw "process_start_failed" }
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            throw "process_failed:$($process.ExitCode):$($stderr.Trim())"
        }
        return $stdout.Trim()
    } finally { $process.Dispose() }
}

function Invoke-CutoverCli {
    param([string]$NodePath, [string]$CliPath, [string[]]$Arguments)
    $stdout = Invoke-Process $NodePath (@($CliPath) + $Arguments)
    try { return $stdout | ConvertFrom-Json }
    catch { throw "cutover_cli_invalid_json" }
}

function Assert-GitCandidate {
    param([string]$Root, [string]$Commit, [string[]]$TrackedFiles)
    if ($Commit -notmatch '^[0-9a-fA-F]{40}$') { throw "candidateCommit_must_be_full_sha1" }
    $git = (Get-Command git.exe -ErrorAction Stop).Source
    $head = (Invoke-Process $git @('-C', $Root, 'rev-parse', 'HEAD')).Trim()
    if (-not [string]::Equals($head, $Commit, [StringComparison]::OrdinalIgnoreCase)) {
        throw "candidate_commit_mismatch"
    }
    $dirty = Invoke-Process $git @('-C', $Root, 'status', '--porcelain=v1', '--untracked-files=all')
    if (-not [string]::IsNullOrEmpty($dirty)) { throw "candidate_worktree_not_clean" }
    foreach ($file in $TrackedFiles) {
        if (-not (Test-Contained $file $Root)) { throw "tracked_candidate_file_outside_root" }
        $prefixLength = $Root.Length
        if (-not ($Root.EndsWith('\') -or $Root.EndsWith('/'))) { $prefixLength += 1 }
        $relative = $file.Substring($prefixLength).Replace('\', '/')
        $tracked = Invoke-Process $git @('-C', $Root, 'ls-files', '--', $relative)
        if ([string]::IsNullOrEmpty($tracked)) {
            $ignored = Invoke-Process $git @('-C', $Root, 'check-ignore', '--', $relative)
            if ([string]::IsNullOrEmpty($ignored)) { throw "candidate_artifact_not_tracked_or_ignored:$relative" }
        } else {
            [void](Invoke-Process $git @('-C', $Root, 'diff', '--quiet', $Commit, '--', $relative))
        }
    }
}

function Assert-ExactCandidateEntry {
    param([object]$Entry, [string]$NodePath, [string]$Entrypoint, [object]$CurrentEntry)
    $allowed = @('type', 'command', 'args', 'env')
    foreach ($property in $Entry.PSObject.Properties) {
        if ($allowed -notcontains $property.Name) { throw "candidate_entry_field_forbidden:$($property.Name)" }
    }
    foreach ($property in $CurrentEntry.PSObject.Properties) {
        if ($allowed -notcontains $property.Name) { throw "current_entry_field_unsupported:$($property.Name)" }
    }
    $candidateNames = @($Entry.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
    $currentNames = @($CurrentEntry.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
    if (($candidateNames -join "`0") -cne ($currentNames -join "`0")) { throw "candidate_entry_fields_not_preserved" }
    if ($null -eq $Entry.PSObject.Properties['type'] -or $Entry.type -cne 'stdio' -or $CurrentEntry.type -cne 'stdio') {
        throw "candidate_type_must_preserve_stdio"
    }
    $command = Get-RequiredString $Entry 'command'
    if (-not [string]::Equals($command, $NodePath, [StringComparison]::Ordinal)) { throw "candidate_command_not_exact_node_path" }
    $argsProperty = $Entry.PSObject.Properties['args']
    if ($null -eq $argsProperty) { throw "candidate_args_required" }
    $args = @($argsProperty.Value)
    if ($args.Count -ne 1 -or @($args | Where-Object { $_ -isnot [string] -or [string]::IsNullOrEmpty($_) }).Count -gt 0) {
        throw "candidate_args_invalid"
    }
    if (-not [string]::Equals($args[0], $Entrypoint, [StringComparison]::Ordinal)) { throw "candidate_entrypoint_not_exact" }
    $candidateEnv = $Entry.PSObject.Properties['env']
    $currentEnv = $CurrentEntry.PSObject.Properties['env']
    if (($null -eq $candidateEnv) -ne ($null -eq $currentEnv)) { throw "candidate_env_not_preserved" }
    if ($null -ne $candidateEnv) {
        foreach ($property in $candidateEnv.Value.PSObject.Properties) {
            if ($property.Name -cnotin @('BRIDGE_AGENT', 'BRIDGE_LANE') -or $property.Value -isnot [string]) {
                throw "candidate_env_name_forbidden:$($property.Name)"
            }
            if ($property.Name -ceq 'BRIDGE_AGENT' -and $property.Value -cnotin @('codex', 'claude', 'unknown')) {
                throw "candidate_bridge_agent_invalid"
            }
            if ($property.Name -ceq 'BRIDGE_LANE' -and $property.Value -cnotin @('codex', 'claude_desktop_code', 'claude_desktop_cowork')) {
                throw "candidate_bridge_lane_invalid"
            }
        }
        $candidateEnvJson = $candidateEnv.Value | ConvertTo-Json -Compress -Depth 10
        $currentEnvJson = $currentEnv.Value | ConvertTo-Json -Compress -Depth 10
        if ($candidateEnvJson -cne $currentEnvJson) { throw "candidate_env_not_preserved" }
    }
}

function Get-CommandIdentity {
    param([object]$Entry)
    $tokens = [System.Collections.Generic.List[string]]::new()
    $tokens.Add([string]$Entry.command)
    foreach ($argument in @($Entry.args)) { $tokens.Add([string]$argument) }
    return ($tokens.ToArray() | ConvertTo-Json -Compress)
}

function Assert-ConfigEntry {
    param([string]$ConfigPath, [string]$ServerName, [object]$ExpectedEntry)
    $config = Read-Json $ConfigPath
    $servers = $config.PSObject.Properties['mcpServers']
    if ($null -eq $servers -or $null -eq $servers.Value) { throw "mcpServers_missing" }
    $entry = $servers.Value.PSObject.Properties[$ServerName]
    if ($null -eq $entry) { throw "mcp_server_missing:$ServerName" }
    $actual = $entry.Value | ConvertTo-Json -Compress -Depth 50
    $expected = $ExpectedEntry | ConvertTo-Json -Compress -Depth 50
    if ($actual -cne $expected) { throw "candidate_entry_verification_failed" }
}

function Restore-IfChanged {
    param([string]$Path, [byte[]]$Bytes, [string]$ExpectedHash)
    if ((Get-Sha256 $Path) -ne $ExpectedHash) { Set-ExistingBytesAtomically $Path $Bytes }
    if ((Get-Sha256 $Path) -ne $ExpectedHash) { throw "restore_verification_failed:$Path" }
}

function Resolve-TestPlan {
    param([string]$PlanPath)
    $resolvedPlan = Resolve-Absolute $PlanPath 'plan'
    if (-not [System.IO.File]::Exists($resolvedPlan)) { throw "plan_missing" }
    $value = Read-Json $resolvedPlan
    if ((Get-RequiredString $value 'schemaVersion') -ne 'bridge2-windows-test-cutover-v1') { throw "invalid_plan_schema" }

    $configRoot = Normalize-Root (Get-RequiredString $value 'configRoot') 'configRoot'
    $stateRoot = Normalize-Root (Get-RequiredString $value 'stateRoot') 'stateRoot'
    $candidateRoot = Normalize-Root (Get-RequiredString $value 'candidateRoot') 'candidateRoot'
    $runtimeRoot = Normalize-Root (Get-RequiredString $value 'runtimeRoot') 'runtimeRoot'
    $transactionRoot = Normalize-Root (Get-RequiredString $value 'transactionRoot') 'transactionRoot'
    if (Test-Contained $transactionRoot $candidateRoot) { throw "transaction_root_inside_candidate_forbidden" }
    $localAppData = Normalize-Root ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'localAppData'
    if (-not (Test-Contained $transactionRoot $localAppData)) { throw "transaction_root_must_be_local_app_data" }

    $configPath = Resolve-ContainedFile (Get-RequiredString $value 'mcpConfigPath') $configRoot 'mcpConfigPath'
    if ([System.IO.Path]::GetFileName($configPath) -cne '.mcp.json') { throw "mcp_config_filename_must_be_dot_mcp_json" }
    $statePath = Resolve-ContainedFile (Get-RequiredString $value 'cutoverStatePath') $stateRoot 'cutoverStatePath'
    if (Test-Contained $configPath $candidateRoot) { throw "mcp_config_inside_candidate_forbidden" }
    if (Test-Contained $statePath $candidateRoot) { throw "cutover_state_inside_candidate_forbidden" }
    $nodePath = Resolve-ContainedFile (Get-RequiredString $value 'nodePath') $runtimeRoot 'nodePath'
    $cliPath = Resolve-ContainedFile (Get-RequiredString $value 'cutoverCliPath') $candidateRoot 'cutoverCliPath'
    $entrypoint = Resolve-ContainedFile (Get-RequiredString $value 'candidateMcpEntrypoint') $candidateRoot 'candidateMcpEntrypoint'
    $expectedCliPath = [System.IO.Path]::Combine($candidateRoot, 'dist', 'v2', 'cli', 'main.js')
    $expectedEntrypoint = [System.IO.Path]::Combine($candidateRoot, 'dist', 'server.js')
    if ($cliPath -cne $expectedCliPath) { throw "cutover_cli_must_be_candidate_dist_v2_cli" }
    if ($entrypoint -cne $expectedEntrypoint) { throw "candidate_mcp_must_be_compatibility_entrypoint" }

    $planHash = Get-Sha256 $resolvedPlan
    $nodeHash = Get-RequiredString $value 'nodeSha256'
    $cliHash = Get-RequiredString $value 'cutoverCliSha256'
    $entryHash = Get-RequiredString $value 'candidateMcpEntrypointSha256'
    $distHash = Get-RequiredString $value 'candidateDistSha256'
    $configHash = Get-RequiredString $value 'expectedConfigSha256'
    $stateHash = Get-RequiredString $value 'expectedStateSha256'
    foreach ($pair in @(@($nodeHash, 'nodeSha256'), @($cliHash, 'cutoverCliSha256'), @($entryHash, 'candidateMcpEntrypointSha256'), @($distHash, 'candidateDistSha256'), @($configHash, 'expectedConfigSha256'), @($stateHash, 'expectedStateSha256'))) {
        Assert-HexHash $pair[0] $pair[1]
    }
    if ((Get-Sha256 $nodePath) -ne $nodeHash.ToLowerInvariant()) { throw "node_runtime_hash_mismatch" }
    if ((Get-Sha256 $cliPath) -ne $cliHash.ToLowerInvariant()) { throw "cutover_cli_hash_mismatch" }
    if ((Get-Sha256 $entrypoint) -ne $entryHash.ToLowerInvariant()) { throw "candidate_entrypoint_hash_mismatch" }
    if ((Get-DistTreeSha256 $candidateRoot) -ne $distHash.ToLowerInvariant()) { throw "candidate_dist_hash_mismatch" }
    if ((Get-Sha256 $configPath) -ne $configHash.ToLowerInvariant()) { throw "mcp_config_changed_since_plan" }
    if ((Get-Sha256 $statePath) -ne $stateHash.ToLowerInvariant()) { throw "cutover_state_changed_since_plan" }

    $serverName = Get-RequiredString $value 'serverName'
    $config = Read-Json $configPath
    $servers = $config.PSObject.Properties['mcpServers']
    if ($null -eq $servers -or $null -eq $servers.Value -or $null -eq $servers.Value.PSObject.Properties[$serverName]) {
        throw "mcp_server_missing:$serverName"
    }
    $currentEntry = $servers.Value.PSObject.Properties[$serverName].Value
    $candidateEntryProperty = $value.PSObject.Properties['candidateEntry']
    if ($null -eq $candidateEntryProperty -or $null -eq $candidateEntryProperty.Value) { throw "candidateEntry_required" }
    Assert-ExactCandidateEntry $candidateEntryProperty.Value $nodePath $entrypoint $currentEntry
    $commit = Get-RequiredString $value 'candidateCommit'
    Assert-GitCandidate $candidateRoot $commit @($cliPath, $entrypoint)

    $candidateBridgeId = Get-RequiredString $value 'candidateBridgeId'
    $approvalRef = Get-RequiredString $value 'approvalRef'
    $rollbackApprovalRef = Get-RequiredString $value 'rollbackApprovalRef'
    if ($approvalRef -notmatch '^approval\.cutover\.' -or $rollbackApprovalRef -notmatch '^approval\.cutover\.') { throw "cutover_approval_ref_invalid" }
    $reason = Get-RequiredString $value 'reason'
    $rollbackReason = Get-RequiredString $value 'rollbackReason'

    $status = Invoke-CutoverCli $nodePath $cliPath @('cutover-status', '--state', $statePath)
    if ($status.phase -ne 'shadow' -and $status.phase -ne 'rollback') { throw "test_cutover_requires_shadow_or_rollback" }
    if ($status.primaryBridgeId -eq $candidateBridgeId) { throw "candidate_already_primary" }
    $candidateEndpoint = @($status.bridges | Where-Object { $_.bridgeId -eq $candidateBridgeId })
    if ($candidateEndpoint.Count -ne 1 -or $candidateEndpoint[0].version -ne '2.0') { throw "candidate_bridge_endpoint_invalid" }
    $expectedCommand = Get-CommandIdentity $candidateEntryProperty.Value
    if ($candidateEndpoint[0].command -cne $expectedCommand) { throw "manifest_candidate_command_mismatch" }
    if ($null -eq $candidateEndpoint[0].statePath) { throw "manifest_candidate_state_path_required" }
    $manifestState = Resolve-ContainedFile ([string]$candidateEndpoint[0].statePath) $stateRoot 'manifestCandidateStatePath'
    if ([System.IO.Path]::GetExtension($manifestState) -cne '.sqlite') { throw "manifest_candidate_state_extension_invalid" }
    if ($null -eq $candidateEndpoint[0].mcpConfigPath) { throw "manifest_mcp_config_path_required" }
    $manifestConfig = Resolve-Absolute ([string]$candidateEndpoint[0].mcpConfigPath) 'manifestMcpConfigPath'
    if (-not [string]::Equals($manifestConfig, $configPath, [StringComparison]::OrdinalIgnoreCase)) { throw "manifest_mcp_config_path_mismatch" }

    return [pscustomobject]@{
        planPath = $resolvedPlan; configRoot = $configRoot; stateRoot = $stateRoot
        candidateRoot = $candidateRoot; runtimeRoot = $runtimeRoot; transactionRoot = $transactionRoot
        configPath = $configPath; statePath = $statePath; nodePath = $nodePath; cliPath = $cliPath
        planHash = $planHash; nodeHash = $nodeHash.ToLowerInvariant(); cliHash = $cliHash.ToLowerInvariant(); entrypoint = $entrypoint; entryHash = $entryHash.ToLowerInvariant(); distHash = $distHash.ToLowerInvariant()
        commit = $commit.ToLowerInvariant(); candidateEntry = $candidateEntryProperty.Value; serverName = $serverName
        candidateBridgeId = $candidateBridgeId; priorPrimaryBridgeId = [string]$status.primaryBridgeId
        priorPhase = [string]$status.phase; configHash = $configHash.ToLowerInvariant(); stateHash = $stateHash.ToLowerInvariant()
        approvalRef = $approvalRef; reason = $reason; rollbackApprovalRef = $rollbackApprovalRef; rollbackReason = $rollbackReason
        expectedCommand = $expectedCommand
    }
}

function Invoke-TestCutover {
    param([object]$Resolved, [bool]$DoApply)
    if (-not $DoApply) {
        return [pscustomobject]@{
            ok = $true; action = 'test'; applied = $false; dryRun = $true
            fromBridgeId = $Resolved.priorPrimaryBridgeId; toBridgeId = $Resolved.candidateBridgeId
            phase = $Resolved.priorPhase; configPath = $Resolved.configPath; statePath = $Resolved.statePath
            candidateCommit = $Resolved.commit; candidateCommand = $Resolved.expectedCommand
        }
    }

    if ((Get-Sha256 $Resolved.planPath) -ne $Resolved.planHash) { throw "plan_changed_before_apply" }
    if ((Get-Sha256 $Resolved.nodePath) -ne $Resolved.nodeHash) { throw "node_runtime_changed_before_apply" }
    Assert-GitCandidate $Resolved.candidateRoot $Resolved.commit @($Resolved.cliPath, $Resolved.entrypoint)
    if ((Get-DistTreeSha256 $Resolved.candidateRoot) -ne $Resolved.distHash) { throw "candidate_dist_changed_before_apply" }

    $transactionDirectory = Join-Path $Resolved.transactionRoot ((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N'))
    [System.IO.Directory]::CreateDirectory($transactionDirectory) | Out-Null
    $configBackup = Join-Path $transactionDirectory 'mcp-config.backup.json'
    $stateBackup = Join-Path $transactionDirectory 'cutover-state.backup.json'
    $stagedConfig = Join-Path $transactionDirectory 'mcp-config.test.json'
    $stagedState = Join-Path $transactionDirectory 'cutover-state.test.json'
    $switchInput = Join-Path $transactionDirectory 'switch-test.json'
    $transactionPath = Join-Path $transactionDirectory 'transaction.json'
    $originalConfigBytes = [System.IO.File]::ReadAllBytes($Resolved.configPath)
    $originalStateBytes = [System.IO.File]::ReadAllBytes($Resolved.statePath)
    Write-NewBytes $configBackup $originalConfigBytes
    Write-NewBytes $stateBackup $originalStateBytes
    if ((Get-Sha256 $configBackup) -ne $Resolved.configHash -or (Get-Sha256 $stateBackup) -ne $Resolved.stateHash) {
        throw "backup_verification_failed"
    }

    $config = Read-Json $Resolved.configPath
    $config.mcpServers.PSObject.Properties[$Resolved.serverName].Value = $Resolved.candidateEntry
    $stagedConfigBytes = ConvertTo-JsonBytes $config
    Write-NewBytes $stagedConfig $stagedConfigBytes
    Assert-ConfigEntry $stagedConfig $Resolved.serverName $Resolved.candidateEntry
    Write-NewBytes $stagedState $originalStateBytes
    $switch = [pscustomobject]@{
        statePath = $stagedState; toBridgeId = $Resolved.candidateBridgeId; phase = 'test'
        approvalRef = $Resolved.approvalRef; reason = $Resolved.reason
    }
    Write-NewBytes $switchInput (ConvertTo-JsonBytes $switch)
    if ((Get-Sha256 $Resolved.nodePath) -ne $Resolved.nodeHash) { throw "node_runtime_changed_during_prepare" }
    $testState = Invoke-CutoverCli $Resolved.nodePath $Resolved.cliPath @('cutover-switch', '--config', $switchInput)
    if ($testState.phase -ne 'test' -or $testState.primaryBridgeId -ne $Resolved.candidateBridgeId) { throw "staged_test_phase_invalid" }
    $testConfigHash = Get-Sha256 $stagedConfig
    $testStateHash = Get-Sha256 $stagedState
    $record = [ordered]@{
        schemaVersion = 'bridge2-windows-cutover-transaction-v1'; status = 'prepared'
        createdAt = (Get-Date).ToUniversalTime().ToString('o'); planPath = $Resolved.planPath; planSha256 = $Resolved.planHash
        configRoot = $Resolved.configRoot; stateRoot = $Resolved.stateRoot; candidateRoot = $Resolved.candidateRoot
        runtimeRoot = $Resolved.runtimeRoot; transactionRoot = $Resolved.transactionRoot
        configPath = $Resolved.configPath; statePath = $Resolved.statePath; configBackup = $configBackup; stateBackup = $stateBackup
        originalConfigSha256 = $Resolved.configHash; originalStateSha256 = $Resolved.stateHash
        testConfigSha256 = $testConfigHash; testStateSha256 = $testStateHash
        nodePath = $Resolved.nodePath; nodeSha256 = $Resolved.nodeHash; cliPath = $Resolved.cliPath; cliSha256 = $Resolved.cliHash; candidateDistSha256 = $Resolved.distHash
        candidateCommit = $Resolved.commit; candidateBridgeId = $Resolved.candidateBridgeId
        priorPrimaryBridgeId = $Resolved.priorPrimaryBridgeId; priorPhase = $Resolved.priorPhase; serverName = $Resolved.serverName
        rollbackApprovalRef = $Resolved.rollbackApprovalRef; rollbackReason = $Resolved.rollbackReason
        committedAt = $null; failure = $null; restoreErrors = @(); failedAt = $null
        rolledBackAt = $null; rollbackStateSha256 = $null; rollbackMode = $null; candidateIntegrityFailure = $null
    }
    Write-Transaction $transactionPath $record

    try {
        if ((Get-Sha256 $Resolved.configPath) -ne $Resolved.configHash -or (Get-Sha256 $Resolved.statePath) -ne $Resolved.stateHash) {
            throw "source_changed_during_prepare"
        }
        if ((Get-Sha256 $Resolved.planPath) -ne $Resolved.planHash) { throw "plan_changed_during_prepare" }
        if ((Get-Sha256 $Resolved.nodePath) -ne $Resolved.nodeHash) { throw "node_runtime_changed_during_prepare" }
        Assert-GitCandidate $Resolved.candidateRoot $Resolved.commit @($Resolved.cliPath, $Resolved.entrypoint)
        if ((Get-DistTreeSha256 $Resolved.candidateRoot) -ne $Resolved.distHash) { throw "candidate_dist_changed_during_prepare" }
        Set-ExistingBytesAtomically $Resolved.configPath $stagedConfigBytes
        Set-ExistingBytesAtomically $Resolved.statePath ([System.IO.File]::ReadAllBytes($stagedState))
        Assert-ConfigEntry $Resolved.configPath $Resolved.serverName $Resolved.candidateEntry
        if ((Get-Sha256 $Resolved.nodePath) -ne $Resolved.nodeHash) { throw "node_runtime_changed_before_live_verify" }
        $live = Invoke-CutoverCli $Resolved.nodePath $Resolved.cliPath @('cutover-status', '--state', $Resolved.statePath)
        if ($live.phase -ne 'test' -or $live.primaryBridgeId -ne $Resolved.candidateBridgeId) { throw "live_test_phase_verification_failed" }
        if ((Get-Sha256 $Resolved.configPath) -ne $testConfigHash -or (Get-Sha256 $Resolved.statePath) -ne $testStateHash) {
            throw "live_test_hash_verification_failed"
        }
        $record.status = 'committed'
        $record.committedAt = (Get-Date).ToUniversalTime().ToString('o')
        Write-Transaction $transactionPath $record
        return [pscustomobject]@{
            ok = $true; action = 'test'; applied = $true; dryRun = $false; phase = 'test'
            primaryBridgeId = $Resolved.candidateBridgeId; transactionPath = $transactionPath
            configBackup = $configBackup; stateBackup = $stateBackup; candidateCommit = $Resolved.commit
        }
    } catch {
        $failure = $_.Exception.Message
        $restoreErrors = [System.Collections.Generic.List[string]]::new()
        try { Restore-IfChanged $Resolved.configPath $originalConfigBytes $Resolved.configHash } catch { $restoreErrors.Add($_.Exception.Message) }
        try { Restore-IfChanged $Resolved.statePath $originalStateBytes $Resolved.stateHash } catch { $restoreErrors.Add($_.Exception.Message) }
        $record.status = if ($restoreErrors.Count -eq 0) { 'failed_restored' } else { 'failed_restore_incomplete' }
        $record.failure = $failure
        $record.restoreErrors = @($restoreErrors)
        $record.failedAt = (Get-Date).ToUniversalTime().ToString('o')
        try { Write-Transaction $transactionPath $record } catch { $restoreErrors.Add("transaction_record_update_failed") }
        if ($restoreErrors.Count -gt 0) { throw "test_cutover_failed:$failure;restore_failed:$($restoreErrors -join '|');transaction:$transactionPath" }
        throw "test_cutover_failed_restored:$failure;transaction:$transactionPath"
    }
}

function Get-RollbackCandidateIntegrity {
    param(
        [string]$CandidateRootPath,
        [string]$RuntimeRootPath,
        [string]$NodePathValue,
        [string]$CliPathValue,
        [object]$Record
    )
    try {
        $candidateRoot = Normalize-Root $CandidateRootPath 'candidateRoot'
        $runtimeRoot = Normalize-Root $RuntimeRootPath 'runtimeRoot'
        $nodePath = Resolve-ContainedFile $NodePathValue $runtimeRoot 'nodePath'
        $cliPath = Resolve-ContainedFile $CliPathValue $candidateRoot 'cutoverCliPath'
        $expectedCliPath = [System.IO.Path]::Combine($candidateRoot, 'dist', 'v2', 'cli', 'main.js')
        if ($cliPath -cne $expectedCliPath) { throw "rollback_cli_path_invalid" }
        $entrypoint = Resolve-ContainedFile ([System.IO.Path]::Combine($candidateRoot, 'dist', 'server.js')) $candidateRoot 'candidateMcpEntrypoint'
        if ((Get-Sha256 $nodePath) -ne $Record.nodeSha256) { throw "rollback_node_runtime_hash_mismatch" }
        if ((Get-Sha256 $cliPath) -ne $Record.cliSha256) { throw "rollback_cli_hash_mismatch" }
        if ((Get-DistTreeSha256 $candidateRoot) -ne $Record.candidateDistSha256) { throw "rollback_candidate_dist_hash_mismatch" }
        Assert-GitCandidate $candidateRoot (Get-RequiredString $Record 'candidateCommit') @($cliPath, $entrypoint)
        return [pscustomobject]@{ ok=$true; reason=$null; candidateRoot=$candidateRoot; nodePath=$nodePath; cliPath=$cliPath }
    } catch {
        return [pscustomobject]@{ ok=$false; reason=$_.Exception.Message; candidateRoot=$CandidateRootPath; nodePath=$NodePathValue; cliPath=$CliPathValue }
    }
}

function Resolve-TransactionRecord {
    param([string]$TransactionPath)
    $path = Resolve-Absolute $TransactionPath 'transaction'
    if (-not [System.IO.File]::Exists($path)) { throw "transaction_missing" }
    $record = Read-Json $path
    if ((Get-RequiredString $record 'schemaVersion') -ne 'bridge2-windows-cutover-transaction-v1') { throw "invalid_transaction_schema" }
    if ((Get-RequiredString $record 'status') -ne 'committed') { throw "transaction_not_committed" }
    $configRoot = Normalize-Root (Get-RequiredString $record 'configRoot') 'configRoot'
    $stateRoot = Normalize-Root (Get-RequiredString $record 'stateRoot') 'stateRoot'
    $transactionRoot = Normalize-Root (Get-RequiredString $record 'transactionRoot') 'transactionRoot'
    $candidateRootPath = Resolve-Absolute (Get-RequiredString $record 'candidateRoot') 'candidateRoot'
    $runtimeRootPath = Resolve-Absolute (Get-RequiredString $record 'runtimeRoot') 'runtimeRoot'
    $nodePathValue = Resolve-Absolute (Get-RequiredString $record 'nodePath') 'nodePath'
    $cliPathValue = Resolve-Absolute (Get-RequiredString $record 'cliPath') 'cutoverCliPath'
    if (-not (Test-Contained $nodePathValue $runtimeRootPath)) { throw "nodePath_outside_runtime_root" }
    if (-not (Test-Contained $cliPathValue $candidateRootPath)) { throw "cutoverCliPath_outside_candidate_root" }
    if (-not (Test-Contained $path $transactionRoot)) { throw "transaction_outside_transaction_root" }
    Assert-NoReparsePath $path $transactionRoot 'transaction'
    $configPath = Resolve-ContainedFile (Get-RequiredString $record 'configPath') $configRoot 'mcpConfigPath'
    $statePath = Resolve-ContainedFile (Get-RequiredString $record 'statePath') $stateRoot 'cutoverStatePath'
    $configBackup = Resolve-ContainedFile (Get-RequiredString $record 'configBackup') $transactionRoot 'configBackup'
    $stateBackup = Resolve-ContainedFile (Get-RequiredString $record 'stateBackup') $transactionRoot 'stateBackup'
    foreach ($name in @('planSha256','originalConfigSha256','originalStateSha256','testConfigSha256','testStateSha256','nodeSha256','cliSha256','candidateDistSha256')) {
        Assert-HexHash (Get-RequiredString $record $name) $name
    }
    if ((Get-RequiredString $record 'candidateCommit') -notmatch '^[0-9a-fA-F]{40}$') { throw "candidateCommit_must_be_full_sha1" }
    if ((Get-Sha256 $configBackup) -ne $record.originalConfigSha256 -or (Get-Sha256 $stateBackup) -ne $record.originalStateSha256) {
        throw "transaction_backup_hash_mismatch"
    }
    $backupState = Read-Json $stateBackup
    if ($backupState.schemaVersion -cne 'bridge2-cutover-v1' -or $backupState.phase -cne (Get-RequiredString $record 'priorPhase') -or $backupState.primaryBridgeId -cne (Get-RequiredString $record 'priorPrimaryBridgeId')) {
        throw "transaction_state_backup_posture_mismatch"
    }
    $backupConfig = Read-Json $configBackup
    $serverName = Get-RequiredString $record 'serverName'
    if ($null -eq $backupConfig.PSObject.Properties['mcpServers'] -or $null -eq $backupConfig.mcpServers.PSObject.Properties[$serverName]) {
        throw "transaction_config_backup_server_missing"
    }
    if ((Get-Sha256 $configPath) -ne $record.testConfigSha256 -or (Get-Sha256 $statePath) -ne $record.testStateSha256) {
        throw "live_state_drift_since_test_cutover"
    }
    $liveState = Read-Json $statePath
    if ($liveState.schemaVersion -cne 'bridge2-cutover-v1' -or $liveState.phase -cne 'test' -or $liveState.primaryBridgeId -cne $record.candidateBridgeId) {
        throw "live_state_not_test_primary"
    }
    $integrity = Get-RollbackCandidateIntegrity $candidateRootPath $runtimeRootPath $nodePathValue $cliPathValue $record
    return [pscustomobject]@{
        path=$path; value=$record; configPath=$configPath; statePath=$statePath
        configBackup=$configBackup; stateBackup=$stateBackup; candidateRoot=$candidateRootPath
        runtimeRoot=$runtimeRootPath; nodePath=$nodePathValue; cliPath=$cliPathValue
        transactionRoot=$transactionRoot; candidateIntegrity=$integrity
    }
}

function Invoke-Rollback {
    param([object]$Resolved, [bool]$DoApply)
    $record = $Resolved.value
    if (-not $DoApply) {
        return [pscustomobject]@{
            ok = $true; action = 'rollback'; applied = $false; dryRun = $true; phase = 'test'
            fromBridgeId = $record.candidateBridgeId; toBridgeId = $record.priorPrimaryBridgeId
            rollbackMode = if ($Resolved.candidateIntegrity.ok) { 'hash_chained' } else { 'emergency_exact_state' }
            candidateIntegrityFailure = $Resolved.candidateIntegrity.reason
            transactionPath = $Resolved.path
        }
    }

    $currentConfigBytes = [System.IO.File]::ReadAllBytes($Resolved.configPath)
    $currentStateBytes = [System.IO.File]::ReadAllBytes($Resolved.statePath)
    $originalConfigBytes = [System.IO.File]::ReadAllBytes($Resolved.configBackup)
    $originalStateBytes = [System.IO.File]::ReadAllBytes($Resolved.stateBackup)
    $integrity = Get-RollbackCandidateIntegrity $Resolved.candidateRoot $Resolved.runtimeRoot $Resolved.nodePath $Resolved.cliPath $record
    $mode = if ($integrity.ok) { 'hash_chained' } else { 'emergency_exact_state' }
    $integrityFailure = $integrity.reason
    $targetStateBytes = $originalStateBytes
    $targetStateHash = $record.originalStateSha256
    $targetPhase = $record.priorPhase

    if ($integrity.ok) {
        try {
            $directory = [System.IO.Path]::GetDirectoryName($Resolved.path)
            $nonce = [Guid]::NewGuid().ToString('N')
            $stagedState = Join-Path $directory "cutover-state.rollback.$nonce.json"
            $rollbackInput = Join-Path $directory "switch-rollback.$nonce.json"
            Write-NewBytes $stagedState $currentStateBytes
            $switch = [pscustomobject]@{
                statePath = $stagedState; toBridgeId = $record.priorPrimaryBridgeId; phase = 'rollback'
                approvalRef = $record.rollbackApprovalRef; reason = $record.rollbackReason
            }
            Write-NewBytes $rollbackInput (ConvertTo-JsonBytes $switch)
            $freshIntegrity = Get-RollbackCandidateIntegrity $Resolved.candidateRoot $Resolved.runtimeRoot $Resolved.nodePath $Resolved.cliPath $record
            if (-not $freshIntegrity.ok) { throw $freshIntegrity.reason }
            $rollbackState = Invoke-CutoverCli $freshIntegrity.nodePath $freshIntegrity.cliPath @('cutover-switch', '--config', $rollbackInput)
            if ($rollbackState.phase -ne 'rollback' -or $rollbackState.primaryBridgeId -ne $record.priorPrimaryBridgeId) {
                throw "staged_rollback_phase_invalid"
            }
            $targetStateBytes = [System.IO.File]::ReadAllBytes($stagedState)
            $targetStateHash = Get-BytesSha256 $targetStateBytes
            $targetPhase = 'rollback'
        } catch {
            $mode = 'emergency_exact_state'
            $integrityFailure = "candidate_rollback_unavailable:$($_.Exception.Message)"
            $targetStateBytes = $originalStateBytes
            $targetStateHash = $record.originalStateSha256
            $targetPhase = $record.priorPhase
        }
    }

    try {
        if ((Get-Sha256 $Resolved.configPath) -ne $record.testConfigSha256 -or (Get-Sha256 $Resolved.statePath) -ne $record.testStateSha256) {
            throw "live_state_changed_during_rollback_prepare"
        }
        Set-ExistingBytesAtomically $Resolved.configPath $originalConfigBytes
        Set-ExistingBytesAtomically $Resolved.statePath $targetStateBytes
        if ((Get-Sha256 $Resolved.configPath) -ne $record.originalConfigSha256) { throw "rollback_config_verification_failed" }
        if ((Get-Sha256 $Resolved.statePath) -ne $targetStateHash) { throw "rollback_state_verification_failed" }
        $live = Read-Json $Resolved.statePath
        if ($live.phase -cne $targetPhase -or $live.primaryBridgeId -cne $record.priorPrimaryBridgeId) { throw "rollback_phase_verification_failed" }
    } catch {
        $failure = $_.Exception.Message
        $restoreErrors = [System.Collections.Generic.List[string]]::new()
        try { Restore-IfChanged $Resolved.configPath $currentConfigBytes $record.testConfigSha256 } catch { $restoreErrors.Add($_.Exception.Message) }
        try { Restore-IfChanged $Resolved.statePath $currentStateBytes $record.testStateSha256 } catch { $restoreErrors.Add($_.Exception.Message) }
        if ($restoreErrors.Count -gt 0) { throw "rollback_failed:$failure;restore_failed:$($restoreErrors -join '|');transaction:$($Resolved.path)" }
        throw "rollback_failed_restored:$failure;transaction:$($Resolved.path)"
    }

    $record.status = if ($mode -eq 'hash_chained') { 'rolled_back' } else { 'rolled_back_emergency_exact_state' }
    $record.rolledBackAt = (Get-Date).ToUniversalTime().ToString('o')
    $record.rollbackStateSha256 = Get-Sha256 $Resolved.statePath
    $record.rollbackMode = $mode
    $record.candidateIntegrityFailure = $integrityFailure
    try { Write-Transaction $Resolved.path $record }
    catch {
        throw "rollback_applied_record_update_failed:$($_.Exception.Message);mode:$mode;phase:$targetPhase;transaction:$($Resolved.path)"
    }
    return [pscustomobject]@{
        ok = $true; action = 'rollback'; applied = $true; dryRun = $false; phase = $targetPhase
        primaryBridgeId = $record.priorPrimaryBridgeId; rollbackMode = $mode
        candidateIntegrityFailure = $integrityFailure; transactionPath = $Resolved.path
    }
}

if ($Action -eq 'HoldLock') {
    if (
        [string]::IsNullOrWhiteSpace($TransactionRoot) -or
        -not [string]::IsNullOrWhiteSpace($Plan) -or
        -not [string]::IsNullOrWhiteSpace($Transaction) -or
        $Apply.IsPresent
    ) { throw "hold_lock_action_requires_transaction_root_only" }
    $lockRoot = Normalize-Root $TransactionRoot 'transactionRoot'
    $localAppData = Normalize-Root ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'localAppData'
    if (-not (Test-Contained $lockRoot $localAppData)) { throw "transaction_root_must_be_local_app_data" }
    Assert-NoReparsePath $lockRoot $localAppData 'transactionRoot'
    $lock = Enter-CutoverLock $lockRoot
    try {
        [Console]::Out.WriteLine("BRIDGE_TEST_CUTOVER_LOCK_READY")
        [Console]::Out.Flush()
        [void][Console]::In.ReadLine()
    } finally { Exit-CutoverLock $lock }
    exit 0
}

if ($Action -eq 'Test') {
    if ([string]::IsNullOrWhiteSpace($Plan) -or -not [string]::IsNullOrWhiteSpace($Transaction) -or -not [string]::IsNullOrWhiteSpace($TransactionRoot)) { throw "test_action_requires_plan_only" }
    $resolved = Resolve-TestPlan $Plan
    if ($Apply.IsPresent) {
        $lock = Enter-CutoverLock $resolved.transactionRoot
        try { $result = Invoke-TestCutover $resolved $true }
        finally { Exit-CutoverLock $lock }
    } else {
        $result = Invoke-TestCutover $resolved $false
    }
} else {
    if ([string]::IsNullOrWhiteSpace($Transaction) -or -not [string]::IsNullOrWhiteSpace($Plan) -or -not [string]::IsNullOrWhiteSpace($TransactionRoot)) { throw "rollback_action_requires_transaction_only" }
    $resolved = Resolve-TransactionRecord $Transaction
    if ($Apply.IsPresent) {
        $lock = Enter-CutoverLock $resolved.transactionRoot
        try { $result = Invoke-Rollback $resolved $true }
        finally { Exit-CutoverLock $lock }
    } else {
        $result = Invoke-Rollback $resolved $false
    }
}

$result | ConvertTo-Json -Depth 20
