[CmdletBinding()]
param(
    [string]$Destination = "C:\ProgramData\HedgehogPython312"
)

$ErrorActionPreference = "Stop"

function Test-HedgehogPython([string]$Root) {
    $Python = Join-Path $Root "python.exe"
    if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) { return $false }
    $old = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $version = @(& $Python --version 2>&1)
        $versionCode = $LASTEXITCODE
        $probe = @(& $Python -c "import hashlib,json,pathlib,subprocess,tempfile,unittest; print('HEDGEHOG_STDLIB_OK')" 2>&1)
        $probeCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $old
    }
    return (
        $versionCode -eq 0 -and
        (($version -join " ") -match '^Python 3\.12\.') -and
        $probeCode -eq 0 -and
        (($probe -join " ") -match 'HEDGEHOG_STDLIB_OK')
    )
}

if (Test-HedgehogPython $Destination) {
    Write-Output $Destination
    exit 0
}

$SourcePython = (Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $SourcePython) { throw "No host python.exe found to bootstrap Hedgehog runner runtime" }

$SourceRoot = Split-Path -Parent $SourcePython
$old = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    $SourceVersion = @(& $SourcePython --version 2>&1)
    $SourceCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $old
}
if ($SourceCode -ne 0 -or (($SourceVersion -join " ") -notmatch '^Python 3\.12\.')) {
    throw "Host Python must be 3.12.x; found: $($SourceVersion -join ' ')"
}

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
foreach ($Name in @(
    "python.exe",
    "python3.dll",
    "python312.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "LICENSE.txt"
)) {
    $Source = Join-Path $SourceRoot $Name
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "Required Python runtime file missing: $Source"
    }
    Copy-Item -LiteralPath $Source -Destination (Join-Path $Destination $Name) -Force
}

$DllSource = Join-Path $SourceRoot "DLLs"
$LibSource = Join-Path $SourceRoot "Lib"
if (-not (Test-Path -LiteralPath $DllSource -PathType Container)) { throw "Missing Python DLLs directory: $DllSource" }
if (-not (Test-Path -LiteralPath $LibSource -PathType Container)) { throw "Missing Python Lib directory: $LibSource" }

& robocopy.exe $DllSource (Join-Path $Destination "DLLs") /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy DLLs failed with exit $LASTEXITCODE" }

$SitePackages = Join-Path $LibSource "site-packages"
& robocopy.exe $LibSource (Join-Path $Destination "Lib") /E /XD $SitePackages /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy Lib failed with exit $LASTEXITCODE" }

# The scheduled runtime is intentionally standard-library only. Do not copy
# Scripts, site-packages, credentials, user configuration, or project data.
if (-not (Test-HedgehogPython $Destination)) {
    throw "Bootstrapped Hedgehog Python runtime failed validation at $Destination"
}

Write-Output $Destination