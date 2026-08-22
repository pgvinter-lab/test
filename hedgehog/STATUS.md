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
- On 2026-08-22, commits through `0cfd6bcfd359194825a415d490d1ffc7790183b8` added the evidence contract/verifier, local scheduled runner, and runner-isolation fixes. These commits supersede the earlier same-day monitor snapshot that reported no engineering artifacts.
- `QUEUE.md` has one checked item: the evidence directory conventions and machine-readable result schema, supported by `evidence/bootstrap/evidence-contract-v1.json`.
- `evidence/`, `scripts/verify_evidence.py`, and the evidence-verifier unit tests exist. Current GitHub Actions state is unverified in this scheduled sandbox because GitHub CLI is unauthenticated and bounded public read attempts failed.
- Task `HH-AGY-20260822T194555Z` produced a local-draft, 36-node dependency-ordered issue graph covering all doctrine workstreams and milestone ranges. PowerShell structural checks passed, but the evidence status is partial because GitHub import was not authorized and the Python validator test could not run.
- Task `HH-AGY-20260822T203110Z` removed the local validation blocker: Python 3.12.10 is available, `scripts/validate_issue_graph.py` now validates schema version, required node fields, non-empty acceptance, unique IDs, declared gates, dependency order, and cycles using standard-library `graphlib`.
- The validator passes the real 36-node graph and eight subprocess CLI tests. The Hedgehog full suite passes 12 tests, and `evidence/planning/hh-agy-20260822t203110z-issue-graph-validator.json` records passing local evidence.
- The 2026-08-22 monitor snapshot reported issue #4 as the only open Hedgehog bootstrap issue. Current remote issue state could not be refreshed in this scheduled sandbox and must not be inferred from that historical snapshot.
- The daily monitor/handoff loop continues through 2026-08-22.

## Current blockers

- Current remote GitHub issue and CI state cannot be verified without an authenticated read path or working public network retrieval.
- The dependency graph remains a local draft. Creating or updating GitHub issues is an external mutation requiring explicit owner approval.
- Physical P100 and fast-network hardware are not yet available for measured hardware baselines; architecture, simulation, source analysis, infrastructure-as-code, and synthetic testing remain unblocked.

## Artifact boundary

Do not publish actual secrets, credentials, customer data, private legal records, model weights, or live production payloads containing private data. Hedgehog's design is not sensitive by default, and the public repository is not a blocker.

## Next task

Begin ADR-0001 using the validated local graph's component-map dependencies while the GitHub import awaits explicit owner approval. After approval, import the reviewed DAG and record the issue URL/hash receipt without changing dependency semantics.
