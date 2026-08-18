# Hedgehog Program Status

## Current phase

Program bootstrap and architecture validation before hardware arrival.

## Verified facts

- The governing 60-day engineering doctrine has been authored.
- The target architecture is virtualized, diskless for compute nodes, and uses one persistent storage/control node.
- The target inference fabric is 100GbE with RoCEv2 or EDR InfiniBand.
- Whole P100 passthrough and NUMA-aware placement are required.
- SK Companies is intended to run production workloads on Hedgehog, with commercial frontier models retained for high-value review, legality sanity checks, and escalation.
- Hedgehog architecture, topology, system design, implementation details, ADRs, threat models, synthetic fixtures, and benchmark evidence may be stored in the public GitHub repository or under `SK-O/Hedgehog/System` in Google Drive.
- As of 2026-08-18, branch `hedgehog/agy-continuous` still has no AGY engineering work after the previously established 2026-08-06 09:09 UTC cutoff. Since the 2026-08-16 pre-monitor head, the branch is ahead by exactly two commits changing only `hedgehog/STATUS.md` and `hedgehog/reports/2026-08-17-daily.md`, so no engineering artifact appeared between the prior monitor and this run.
- No `hedgehog/evidence/` or `hedgehog/outbox/` directory exists. The branch root also has no `.github/` directory, so no GitHub Actions workflow or evidence-gating CI is currently present on this branch.
- Issue #4 remains the only open Hedgehog bootstrap issue.
- The daily monitor/handoff loop has now executed on four consecutive days, 2026-08-15 through 2026-08-18. The earlier cadence interruption is no longer an active blocker.

## Current blockers

- The scheduled Antigravity trigger is not producing the required evidence-producing hourly work cycles and still appears to require activation or repair in the user's Google environment.
- The evidence schema and CI verification gate do not yet exist.
- Physical P100 and fast-network hardware are not yet available for measured hardware baselines; architecture, simulation, source analysis, infrastructure-as-code, and synthetic testing remain unblocked.

## Artifact boundary

Do not publish actual secrets, credentials, customer data, private legal records, model weights, or live production payloads containing private data. Hedgehog's design is not sensitive by default, and the public repository is not a blocker.

## Next task

Restore or activate the persistent AGY loop and prove it with a scheduled evidence-bearing commit. Then convert the doctrine into a dependency-ordered GitHub issue graph and write ADR-0001. In parallel, create the evidence schema and CI gate so future completion claims are machine-verifiable.
