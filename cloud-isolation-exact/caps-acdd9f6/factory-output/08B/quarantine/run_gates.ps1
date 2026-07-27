$ErrorActionPreference = "Stop"

# Create factory output dirs
New-Item -ItemType Directory -Force -Path "factory-output/08B/quarantine"

# Quarantine files
If (Test-Path "stdio-probe-telemetry-21492.json") { Move-Item -Path "stdio-probe-telemetry-21492.json" -Destination "factory-output/08B/quarantine/" }
If (Test-Path "stdio-probe-telemetry-28556.json") { Move-Item -Path "stdio-probe-telemetry-28556.json" -Destination "factory-output/08B/quarantine/" }
$manifest = @{
  quarantined_files = @("stdio-probe-telemetry-21492.json", "stdio-probe-telemetry-28556.json")
  reason = "Quarantined during CAPS 08B Remediation Round 6 as instructed."
}
$manifest | ConvertTo-Json | Set-Content -Path "factory-output/08B/quarantine/manifest.json"

# Gates
Write-Host "Running build"
npm run build
if ($LASTEXITCODE -ne 0) { throw "build failed" }

Write-Host "Running tests"
node --test test/caps/cli.test.mjs
if ($LASTEXITCODE -ne 0) { throw "test failed" }

Write-Host "Running isolated status"
$temp1 = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP "caps-08b-temp1")
$env:BRIDGE_CAPS_STATE_DIR = $temp1.FullName
node dist/cli.js caps status | Out-File -FilePath "factory-output/08B/status-evidence.json" -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw "status failed" }

Write-Host "Running isolated search"
$temp2 = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP "caps-08b-temp2")
$env:BRIDGE_CAPS_STATE_DIR = $temp2.FullName
$seedScript = @"
const { CapsStore } = require('./dist/caps/store.js');
const store = new CapsStore({ databasePath: '$($temp2.FullName.Replace('\','\\'))\\\\caps.sqlite', stateDirectory: '$($temp2.FullName.Replace('\','\\'))' });
store.db.exec(`
    INSERT INTO available_for_install (id, kind, name, slug, surface_owner, transport, pricing, official, source_lane, producer_surface, capture_class, observed_at, last_verified, stale_at, provenance_json)
    VALUES
    ('free-1', 'server', 'Free 1', 'free-1', 'n/a', 'stdio', 'free', 0, 'mcpservers-search', 'external-index', 'reported', '2026', '2026', '2026', '{}'),
    ('paid-1', 'server', 'Paid 1', 'paid-1', 'n/a', 'stdio', 'paid', 0, 'mcpservers-search', 'external-index', 'reported', '2026', '2026', '2026', '{}'),
    ('free-2', 'server', 'Free 2', 'free-2', 'n/a', 'stdio', 'free', 0, 'mcpservers-search', 'external-index', 'reported', '2026', '2026', '2026', '{}'),
    ('unknown-1', 'server', 'Unknown 1', 'unknown-1', 'n/a', 'stdio', 'unknown', 0, 'mcpservers-search', 'external-index', 'reported', '2026', '2026', '2026', '{}');

    INSERT INTO caps_search_fts (rowid, id, name, slug, description, curated_notes, table_name) VALUES
    (1, 'free-1', 'Free 1 matchtoken', 'free-1', '', '', 'available_for_install'),
    (2, 'paid-1', 'Paid 1 matchtoken', 'paid-1', '', '', 'available_for_install'),
    (3, 'free-2', 'Free 2 matchtoken', 'free-2', '', '', 'available_for_install'),
    (4, 'unknown-1', 'Unknown 1 matchtoken', 'unknown-1', '', '', 'available_for_install');
`);
store.close();
"@
Set-Content -Path "seed.js" -Value $seedScript
node seed.js
node dist/cli.js caps search matchtoken | Out-File -FilePath "factory-output/08B/search-evidence.json" -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw "search failed" }

# Restore env
Remove-Item Env:\BRIDGE_CAPS_STATE_DIR

Write-Host "Running contract test"
npm run contract-test
if ($LASTEXITCODE -ne 0) { throw "contract-test failed" }

Write-Host "Running git diff check"
git diff --check -- src/caps/cli.ts src/cli.ts package.json test/caps/cli.test.mjs
if ($LASTEXITCODE -ne 0) { throw "git diff check failed" }
