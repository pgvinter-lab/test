[CmdletBinding()]
param(
    [string]$Repo = "C:\SK-O\Hedgehog",
    [string]$Runtime = "C:\SK-O\Hedgehog-runtime",
    [switch]$ValidateOnly,
    [switch]$SmokeTest
)

$ErrorActionPreference = "Stop"
$Branch = "hedgehog/agy-continuous"
$TaskName = "Hedgehog AGY Continuous"
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
$AgentOut = Join-Path $Runtime ("logs\" + $Stamp + ".agent.out.json")
$AgentErr = Join-Path $Runtime ("logs\" + $Stamp + ".agent.err.txt")
$PromptFile = Join-Path $Runtime ("prompt-" + $Stamp + ".txt")
$LockPath = Join-Path $Runtime "run.lock"
$ConversationPath = Join-Path $Runtime "agy-conversation-id.txt"
$FailureCountPath = Join-Path $Runtime "agy-consecutive-failures.txt"

function Write-RunLog([string]$Message) {
    $line = "$(Get-Date -Format o) $Message"
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes(
        $line + [Environment]::NewLine
    )
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
    } finally {
        $stream.Dispose()
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

function Resolve-Agy {
    $resolved = (Get-Command agy.exe -ErrorAction SilentlyContinue).Source
    if (-not $resolved) {
        $fallback = Join-Path $env:LOCALAPPDATA "agy\bin\agy.exe"
        if (Test-Path -LiteralPath $fallback -PathType Leaf) {
            $resolved = $fallback
        }
    }
    if (-not $resolved) { throw "agy.exe not found" }
    if ([System.IO.Path]::GetFileName($resolved) -ne "agy.exe") {
        throw "Refusing unexpected scheduled agent executable: $resolved"
    }
    return $resolved
}

function Invoke-AgyJson {
    param(
        [Parameter(Mandatory=$true)][string]$Agy,
        [Parameter(Mandatory=$true)][string[]]$Arguments
    )
    $old = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $stdout = @(& $Agy @Arguments 2> $AgentErr)
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $old
    }

    $text = ($stdout -join [Environment]::NewLine)
    [System.IO.File]::WriteAllText(
        $AgentOut,
        $text,
        (New-Object System.Text.UTF8Encoding($false))
    )
    Write-RunLog "Antigravity exit=$code"

    if ($code -ne 0) {
        $tail = if (Test-Path $AgentErr) {
            (Get-Content -LiteralPath $AgentErr -Tail 12) -join " | "
        } else {
            ""
        }
        throw "Antigravity failed exit=$code output=$tail"
    }
    if (-not $text.Trim()) { throw "Antigravity returned empty stdout" }

    try {
        $envelope = $text | ConvertFrom-Json
    } catch {
        throw "Antigravity stdout was not a JSON envelope: $($_.Exception.Message)"
    }
    if ($envelope.status -ne "SUCCESS") {
        throw "Antigravity status=$($envelope.status) error=$($envelope.error)"
    }

    $tokens = if ($envelope.usage -and $envelope.usage.total_tokens) {
        [int64]$envelope.usage.total_tokens
    } else {
        0
    }
    if ($tokens -le 0) {
        throw "Antigravity reported SUCCESS with zero token usage"
    }
    if (-not ([string]$envelope.response).Trim()) {
        throw "Antigravity reported SUCCESS with an empty response"
    }
    if (-not $envelope.conversation_id) {
        throw "Antigravity SUCCESS envelope omitted conversation_id"
    }

    Write-RunLog "Antigravity conversation=$($envelope.conversation_id) tokens=$tokens"
    return $envelope
}

function Read-FailureCount {
    if (-not (Test-Path -LiteralPath $FailureCountPath -PathType Leaf)) { return 0 }
    $raw = (Get-Content -LiteralPath $FailureCountPath -Raw).Trim()
    $count = 0
    if ([int]::TryParse($raw, [ref]$count)) { return $count }
    return 0
}

function Write-FailureCount([int]$Count) {
    [System.IO.File]::WriteAllText(
        $FailureCountPath,
        [string]$Count,
        (New-Object System.Text.UTF8Encoding($false))
    )
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

    $Agy = Resolve-Agy
    Write-RunLog "BEGIN task=$TaskId branch=$Branch agent=antigravity agy=$Agy"

    if ($ValidateOnly) {
        $help = @(Invoke-NativeCapture "agy help" $Agy @("--help")) -join "`n"
        if ($help -notmatch "(?m)--print") {
            throw "agy.exe help did not expose headless --print mode"
        }
        if ($help -notmatch "(?m)--output-format") {
            throw "agy.exe help did not expose structured output"
        }
        Write-RunLog "VALIDATION SUCCESS agent=antigravity executable=$Agy"
        exit 0
    }

    if ($SmokeTest) {
        $smokeArgs = @(
            "--add-dir", $HedgehogDir,
            "--mode", "plan",
            "--dangerously-skip-permissions",
            "--effort", "low",
            "--output-format", "json",
            "--print-timeout", "2m",
            "-p", "Reply with exactly AGY_OK and do not use tools."
        )
        $smoke = Invoke-AgyJson -Agy $Agy -Arguments $smokeArgs
        if (([string]$smoke.response).Trim() -ne "AGY_OK") {
            throw "Antigravity smoke test returned unexpected response"
        }
        Write-FailureCount 0
        Write-RunLog "SMOKE SUCCESS agent=antigravity"
        exit 0
    }

    $failures = Read-FailureCount
    if ($failures -ge 3) {
        Write-RunLog "BLOCKED consecutive_failures=$failures; repair runner/instructions and pass -SmokeTest before resuming"
        exit 30
    }

    $SandboxPython = (& $PythonBootstrap | Select-Object -Last 1).Trim()
    $PythonExe = Join-Path $SandboxPython "python.exe"
    if (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
        throw "Hedgehog Python runtime missing after bootstrap: $PythonExe"
    }
    $env:PATH = "$SandboxPython;$env:PATH"

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
This is an explicit human-authorized scheduled Hedgehog Antigravity handoff.

You are Antigravity. Execute this engineering cycle yourself. Do not invoke or delegate
implementation to Codex or any other external coding agent. If the instructions or harness
are defective, preserve reproducible failure evidence and stop; the operator uses Codex
out of band to repair the instructions, then returns the work to Antigravity.

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

    $agyArgs = @(
        "--add-dir", $Runtime,
        "--add-dir", $HedgehogDir,
        "--mode", "accept-edits",
        "--dangerously-skip-permissions",
        "--effort", "high",
        "--output-format", "json",
        "--print-timeout", "45m"
    )

    if (Test-Path -LiteralPath $ConversationPath -PathType Leaf) {
        $ConversationId = (Get-Content -LiteralPath $ConversationPath -Raw).Trim()
        if ($ConversationId) {
            $agyArgs += @("--conversation", $ConversationId)
            Write-RunLog "Resuming Antigravity conversation=$ConversationId"
        }
    }

    $agyPrompt = "Read the UTF-8 task file at $PromptFile and execute it completely. Work in $HedgehogDir. Do not commit or push; the scheduler owns verification and publication."
    $agyArgs += @("-p", $agyPrompt)

    Write-RunLog "Invoking Antigravity"
    $Envelope = Invoke-AgyJson -Agy $Agy -Arguments $agyArgs
    [System.IO.File]::WriteAllText(
        $ConversationPath,
        [string]$Envelope.conversation_id,
        (New-Object System.Text.UTF8Encoding($false))
    )

    $Changed = @(Invoke-NativeCapture "git status" "git" @(
        "-C", $Repo, "status", "--porcelain", "--untracked-files=all"
    ))
    if ($Changed.Count -eq 0) { throw "Antigravity produced no repository changes" }

    $ChangedPaths = @($Changed | ForEach-Object { $_.Substring(3).Trim() })
    $OutsideHedgehog = @($ChangedPaths | Where-Object {
        $_ -notlike "hedgehog/*" -and $_ -notlike "hedgehog\*"
    })
    if ($OutsideHedgehog.Count -gt 0) {
        throw "Antigravity changed paths outside hedgehog/: $($OutsideHedgehog -join ', ')"
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
    $Message = "$Summary`n`nAgent: antigravity`nTask: $TaskId"
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
    [System.IO.File]::WriteAllText(
        (Join-Path $Outbox "handoff-manifest.json"),
        ($Manifest | ConvertTo-Json -Depth 6),
        (New-Object System.Text.UTF8Encoding($false))
    )

    Write-FailureCount 0
    Write-RunLog "SUCCESS task=$TaskId commit=$Head ready_files=$($Ready.Count)"
    exit 0
} catch {
    if (-not $ValidateOnly -and -not $SmokeTest) {
        $current = Read-FailureCount
        Write-FailureCount ($current + 1)
    }
    Write-RunLog "FAIL task=$TaskId error=$($_.Exception.Message)"
    exit 1
} finally {
    if ($LockStream) { $LockStream.Dispose() }
}
