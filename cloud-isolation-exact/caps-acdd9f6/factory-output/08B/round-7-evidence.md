# CAPS 08B Round 7 Remediation Evidence

## Objective
Remediate the status reporting and refresh receipt validation logic from Round 6.

## Corrections Made
1. **Truthful `needsState` Parsing:** Extracted status directly from `NEEDS.json` in `stateDirectory` independent of `caps.sqlite` existence. Status returns `installed`, `not_installed`, or `error` accurately without modifying the DB.
2. **Strict Refresh Receipt Validation:** Restricted file sizes to `<250KB`, enforced the `bridge-caps-refresh-report-v1` schema constraint, and ensured `start_at` and `end_at` precisely match standard `toISOString()` checks. Handled missing `end_at` scenarios safely while ignoring invalid properties.
3. **Census Matrix Fidelity:** Handled sequential census evaluation using isolated states. Proven correctness for:
   - missing => due true/null
   - stale canonical => due true/exact stale lastCensus
   - fresh canonical age >=0 and <24h => due false/exact fresh lastCensus
   - malformed-only => due true with no fabricated valid freshness
   - future-only => due true and a truthful bounded representation

## Quarantine Manifest
The following items remain contained and hashes preserved per `manifest.json`:
- `debug.cjs`
- `manifest.json`
- `refresh.lock`
- `run_gates.ps1`
- `stdio-probe-telemetry-*.json`
- `unauthorized-fetch-policy-debug.patch`

## Test Proofs
- `caps cli boundary tests` (19/19 passing)
- `contract-test` (100% schemas passing, no FTS5 breakage)
- `git diff --check` (exit 0)

All constraints are satisfied. Zero unmodified blob breakage.
