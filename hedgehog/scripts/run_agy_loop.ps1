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
$PythonBootstrap = Join-Path $HedgehogDir "scripts\bootstrap_runner_python.ps1"
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
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($line + [Environment]::NewLine)
    $written = $false
    for ($attempt = 1; $attempt -le 20 -and -not $written; $attempt++) {
        try {
            $stream = [System.IO.File]::Open(
                $Log,
                [System.IO.FileMode]::OpenOrCreate,
                [System.IO.FileAccess]::Write,
                [System.IO.FileShare]::ReadWrite
            )
            try {
                [void]$stream.Seek(0, [System.IO.SeekOrigin]::End)
                $stream.Write($bytes, 0, $bytes.Length)
                $stream.Flush()
                $written = $true
            } finally {
                $stream.Dispose()
            }
        } catch [System.IO.IOException] {
            if ($attempt -eq 20) { throw }
            Start-Sleep -Milliseconds 100
        }
    }
    Write-Output $line
}

function Invoke-NativeCapture {
    param(
        [Parameter(Mandatory=$true)][string]$Label,
        [Parameter(Mandatory=$true)][string]$File,
        [Parameter(Mandatory=$true)][string[]]$Arguments
    )
    $old = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $lines = @(& $File @Arguments 2>&1)
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $old
    }
    if ($code -ne 0) {
        $tail = ($lines | Select-Object -Last 8) -join " | "
        throw "$Label failed exit=$code output=$tail"
    }
    return $lines
}

function Invoke-NativeLogged {
    param(
        [Parameter(Mandatory=$true)][string]$Label,
        [Parameter(Mandatory=$true)][string]$File,
        [Parameter(Mandatory=$true)][string[]]$Arguments
    )
    $lines = @(Invoke-NativeCapture -Label $Label -File $File -Arguments $Arguments)
    foreach ($line in $lines) { Write-RunLog "$Label`: $line" }
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
    if (-not (Test-Path $PythonBootstrap)) { throw "Missing Python bootstrap: $PythonBootstrap" }

    $SandboxPython = (& $PythonBootstrap | Select-Object -Last 1).Trim()
    $PythonExe = Join-Path $SandboxPython "python.exe"
    if (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
        throw "Hedgehog Python runtime missing after bootstrap: $PythonExe"
    }
    $env:PATH = "$SandboxPython;$env:PATH"

    $Codex = (Get-Command codex.cmd -ErrorAction SilentlyContinue).Source
    if (-not $Codex) {
        $fallback = Join-Path $env:APPDATA "npm\codex.cmd"
        if (Test-Path $fallback) { $Codex = $fallback }
    }
    if (-not $Codex) { throw "codex.cmd not found" }

    Write-RunLog "BEGIN task=$TaskId branch=$Branch codex=$Codex"
    Invoke-NativeLogged "git fetch" "git" @("-C", $Repo, "fetch", "origin", $Branch)

    $dirtyBefore = @(Invoke-NativeCapture "git status" "git" @(
        "-C", $Repo, "status", "--porcelain", "--untracked-files=all"
    ))
    if ($dirtyBefore.Count -eq 0) {
        Invoke-NativeLogged "git ff" "git" @(
            "-C", $Repo, "merge", "--ff-only", "origin/$Branch"
        )
    } else {
        Write-RunLog "RECOVERY mode: worktree already has $($dirtyBefore.Count) changed paths"
    }

    $BaseHead = (Invoke-NativeCapture "git rev-parse" "git" @(
        "-C", $Repo, "rev-parse", "HEAD"
    ) | Select-Object -Last 1).Trim()
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
        '" exec --ignore-user-config -c windows.sandbox=elevated -c model_reasoning_effort=high --sandbox workspace-write --ignore-rules --ephemeral -C "' +
        $HedgehogDir + '" -'
    Write-RunLog "Invoking Codex"
    $Process = Start-Process -FilePath "cmd.exe" `
        -ArgumentList @("/d", "/s", "/c", $CmdLine) `
        -WorkingDirectory $HedgehogDir `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $AgentOut `
        -RedirectStandardError $AgentErr
    Write-RunLog "Codex exit=$($Process.ExitCode)"

    $OutBytes = if (Test-Path $AgentOut) { (Get-Item -LiteralPath $AgentOut).Length } else { 0 }
    $ErrBytes = if (Test-Path $AgentErr) { (Get-Item -LiteralPath $AgentErr).Length } else { 0 }
    Write-RunLog "Codex trace files stdout=$AgentOut ($OutBytes bytes) stderr=$AgentErr ($ErrBytes bytes)"
    if ($Process.ExitCode -ne 0) { throw "Codex failed with exit $($Process.ExitCode); inspect $AgentErr" }

    $Changed = @(Invoke-NativeCapture "git status" "git" @(
        "-C", $Repo, "status", "--porcelain", "--untracked-files=all"
    ))
    if ($Changed.Count -eq 0) { throw "Codex produced no repository changes" }

    $ChangedPaths = @($Changed | ForEach-Object { $_.Substring(3).Trim() })
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

    Invoke-NativeLogged "verify" $PythonExe @($Verifier)
    Invoke-NativeLogged "tests" $PythonExe @(
        "-m", "unittest", "discover", "-s", (Join-Path $HedgehogDir "tests"),
        "-p", "test_*.py"
    )

    Invoke-NativeLogged "git add" "git" @("-C", $Repo, "add", "--", "hedgehog")
    $Summary = "Hedgehog scheduled engineering cycle $TaskId"
    $Message = "$Summary`n`nAgent: codex`nTask: $TaskId"
    Invoke-NativeLogged "commit" "git" @("-C", $Repo, "commit", "-m", $Message)
    Invoke-NativeLogged "rebase" "git" @("-C", $Repo, "pull", "--rebase", "origin", $Branch)
    Invoke-NativeLogged "push" "git" @("-C", $Repo, "push", "origin", "HEAD:$Branch")

    $Head = (Invoke-NativeCapture "git rev-parse" "git" @(
        "-C", $Repo, "rev-parse", "HEAD"
    ) | Select-Object -Last 1).Trim()
    $Published = @(Invoke-NativeCapture "git diff-tree" "git" @(
        "-C", $Repo, "diff-tree", "--no-commit-id", "--name-only", "-r", $Head,
        "--", "hedgehog"
    ))
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