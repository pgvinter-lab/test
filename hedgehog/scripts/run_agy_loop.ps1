[CmdletBinding()]
param(
    [string]$Repo = "C:\SK-O\Hedgehog",
    [string]$Runtime = "C:\SK-O\Hedgehog-runtime"
)

$ErrorActionPreference = "Stop"
$Branch = "hedgehog/agy-continuous"
$HedgehogDir = Join-Path $Repo "hedgehog"
$PromptSource = Join-Path $HedgehogDir "AGY_TRIGGER_PROMPT.md"
$Verifier = Join-Path $HedgehogDir "scripts\verify_evidence.py"
$Outbox = Join-Path $Repo "WOLVERINE_OUTBOX"
$ReadyRoot = Join-Path $Outbox "READY_FOR_DRIVE"
$TaskId = "HH-AGY-" + (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")

New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Runtime "logs") | Out-Null
New-Item -ItemType Directory -Force -Path $Outbox | Out-Null
New-Item -ItemType Directory -Force -Path $ReadyRoot | Out-Null

$Stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$Log = Join-Path $Runtime ("logs\" + $Stamp + ".log")
$AgentOut = Join-Path $Runtime ("logs\" + $Stamp + ".agent.out.txt")
$AgentErr = Join-Path $Runtime ("logs\" + $Stamp + ".agent.err.txt")
$PromptFile = Join-Path $Runtime ("prompt-" + $Stamp + ".txt")
$LockPath = Join-Path $Runtime "run.lock"

function Write-RunLog([string]$Message) {
    $line = "$(Get-Date -Format o) $Message"
    Add-Content -LiteralPath $Log -Value $line -Encoding UTF8
    Write-Output $line
}

$LockStream = $null
try {
    $LockStream = [System.IO.File]::Open(
        $LockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
} catch {
    Write-Output "Hedgehog AGY loop skipped: another run owns $LockPath"
    exit 20
}

try {
    if (-not (Test-Path $PromptSource)) { throw "Missing prompt: $PromptSource" }
    if (-not (Test-Path $Verifier)) { throw "Missing verifier: $Verifier" }

    $Codex = (Get-Command codex.cmd -ErrorAction SilentlyContinue).Source
    if (-not $Codex) {
        $fallback = Join-Path $env:APPDATA "npm\codex.cmd"
        if (Test-Path $fallback) { $Codex = $fallback }
    }
    if (-not $Codex) { throw "codex.cmd not found" }

    Write-RunLog "BEGIN task=$TaskId branch=$Branch codex=$Codex"
    & git -C $Repo fetch origin $Branch 2>&1 |
        ForEach-Object { Write-RunLog "git fetch: $_" }
    if ($LASTEXITCODE -ne 0) { throw "git fetch failed: $LASTEXITCODE" }

    $dirtyBefore = @(& git -C $Repo status --porcelain --untracked-files=all)
    if ($LASTEXITCODE -ne 0) { throw "git status failed" }

    if ($dirtyBefore.Count -eq 0) {
        & git -C $Repo merge --ff-only "origin/$Branch" 2>&1 |
            ForEach-Object { Write-RunLog "git ff: $_" }
        if ($LASTEXITCODE -ne 0) { throw "fast-forward failed: $LASTEXITCODE" }
    } else {
        Write-RunLog "RECOVERY mode: worktree already has $($dirtyBefore.Count) changed paths"
    }

    $BaseHead = (& git -C $Repo rev-parse HEAD).Trim()
    $SourcePrompt = Get-Content -LiteralPath $PromptSource -Raw
    $Invocation = @"
Task ID: $TaskId
This is an explicit human-authorized scheduled Hedgehog handoff.

Work only inside the current hedgehog/ directory. Read AGENTS.md here before acting.
Do not edit repository-root .shared state. Do not run finalize_task.py. Do not commit or push;
the scheduler verifies and publishes after you exit.

A successful run MUST change at least one substantive engineering artifact outside STATUS.md,
QUEUE.md, and reports/, and MUST create or update at least one JSON evidence manifest under
evidence/. Run `python scripts/verify_evidence.py` and the Hedgehog unit tests before exit.
If a task cannot be completed, preserve useful reproducible failure evidence rather than making
a prose-only status update.

$SourcePrompt
"@
    [System.IO.File]::WriteAllText(
        $PromptFile,
        $Invocation,
        (New-Object System.Text.UTF8Encoding($false))
    )

    $CmdLine = 'type "' + $PromptFile + '" | "' + $Codex +
        '" exec --ignore-user-config --sandbox workspace-write --ephemeral -C "' +
        $HedgehogDir + '" -'
    Write-RunLog "Invoking Codex"
    $Process = Start-Process -FilePath "cmd.exe" `
        -ArgumentList @("/d", "/s", "/c", $CmdLine) `
        -WorkingDirectory $HedgehogDir `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $AgentOut `
        -RedirectStandardError $AgentErr
    Write-RunLog "Codex exit=$($Process.ExitCode)"

    if (Test-Path $AgentOut) {
        Get-Content $AgentOut | ForEach-Object { Write-RunLog "codex: $_" }
    }
    if (Test-Path $AgentErr) {
        Get-Content $AgentErr | ForEach-Object { Write-RunLog "codex.err: $_" }
    }
    if ($Process.ExitCode -ne 0) { throw "Codex failed with exit $($Process.ExitCode)" }

    $Changed = @(& git -C $Repo status --porcelain --untracked-files=all)
    if ($Changed.Count -eq 0) { throw "Codex produced no repository changes" }

    $ChangedPaths = @(& git -C $Repo status --porcelain --untracked-files=all |
        ForEach-Object { $_.Substring(3).Trim() })
    $OutsideHedgehog = @($ChangedPaths | Where-Object {
        $_ -notlike "hedgehog/*" -and $_ -notlike "hedgehog\*"
    })
    if ($OutsideHedgehog.Count -gt 0) {
        throw "Codex changed paths outside hedgehog/: $($OutsideHedgehog -join ', ')"
    }

    $Substantive = @($ChangedPaths | Where-Object {
        $_ -notmatch '^hedgehog[\\/](STATUS\.md|QUEUE\.md|reports[\\/])'
    })
    if ($Substantive.Count -eq 0) {
        throw "Run changed only status/queue/report files; prose-only progress is rejected"
    }
    $EvidenceChanged = @($ChangedPaths | Where-Object {
        $_ -match '^hedgehog[\\/]evidence[\\/].+\.json$' -and
        $_ -notmatch 'schema\.json$'
    })
    if ($EvidenceChanged.Count -eq 0) {
        throw "Run did not create or update a JSON evidence manifest"
    }

    & python $Verifier 2>&1 | ForEach-Object { Write-RunLog "verify: $_" }
    if ($LASTEXITCODE -ne 0) { throw "evidence verifier failed" }
    & python -m unittest discover -s (Join-Path $HedgehogDir "tests") -p "test_*.py" 2>&1 |
        ForEach-Object { Write-RunLog "tests: $_" }
    if ($LASTEXITCODE -ne 0) { throw "Hedgehog unit tests failed" }

    & git -C $Repo add -- hedgehog
    $Summary = "Hedgehog scheduled engineering cycle $TaskId"
    $Message = "$Summary`n`nAgent: codex`nTask: $TaskId"
    & git -C $Repo commit -m $Message 2>&1 |
        ForEach-Object { Write-RunLog "commit: $_" }
    if ($LASTEXITCODE -ne 0) { throw "git commit failed" }

    & git -C $Repo pull --rebase origin $Branch 2>&1 |
        ForEach-Object { Write-RunLog "rebase: $_" }
    if ($LASTEXITCODE -ne 0) { throw "git pull --rebase failed" }

    & git -C $Repo push origin "HEAD:$Branch" 2>&1 |
        ForEach-Object { Write-RunLog "push: $_" }
    if ($LASTEXITCODE -ne 0) { throw "git push failed" }

    $Head = (& git -C $Repo rev-parse HEAD).Trim()
    $Published = @(& git -C $Repo diff-tree --no-commit-id --name-only -r $Head -- hedgehog)
    $Ready = @()
    foreach ($Rel in $Published) {
        $Source = Join-Path $Repo $Rel
        if (-not (Test-Path $Source -PathType Leaf)) { continue }
        if ($Rel -match '(?i)(secret|credential|private[_-]?legal|customer[_-]?data|model[_-]?weights)') {
            continue
        }
        $Dest = Join-Path $ReadyRoot $Rel
        New-Item -ItemType Directory -Force -Path (Split-Path $Dest -Parent) | Out-Null
        Copy-Item -LiteralPath $Source -Destination $Dest -Force
        $Ready += [ordered]@{
            path = $Rel
            sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Source).Hash.ToLowerInvariant()
        }
    }

    $Manifest = [ordered]@{
        schema_version = "1.0"
        generated_at = (Get-Date).ToUniversalTime().ToString("o")
        task_id = $TaskId
        branch = $Branch
        commit = $Head
        base_commit = $BaseHead
        status = "READY_FOR_DRIVE"
        ready_root = "READY_FOR_DRIVE"
        files = $Ready
    }
    $ManifestJson = $Manifest | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText(
        (Join-Path $Outbox "handoff-manifest.json"),
        $ManifestJson,
        (New-Object System.Text.UTF8Encoding($false))
    )

    Write-RunLog "SUCCESS task=$TaskId commit=$Head ready_files=$($Ready.Count)"
    exit 0
} catch {
    Write-RunLog "FAIL task=$TaskId error=$($_.Exception.Message)"
    exit 1
} finally {
    if ($LockStream) { $LockStream.Dispose() }
}