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
- On 2026-08-22, commits through `5e7dd988eacffd469501c5f2e473531b7d89e59c` added the evidence contract/verifier, local scheduled runner, runner-isolation fixes, a 36-node dependency-ordered issue graph, a graph validator, and passing local evidence.
- `QUEUE.md` has one checked item: the evidence directory conventions and machine-readable result schema, supported by `evidence/bootstrap/evidence-contract-v1.json`.
- The validator passes the real 36-node graph and eight subprocess CLI tests. The Hedgehog full suite passes 12 tests, and `evidence/planning/hh-agy-20260822t203110z-issue-graph-validator.json` records passing local evidence.
- The graph remains `local-draft`; GitHub issue import has not been performed.
- As of 2026-08-24, issue #4 remains the only open Hedgehog issue.
- `.github/workflows/hedgehog-evidence.yml` exists, but the current engineering head has no combined status checks and no commit-associated workflow runs; CI execution is still unproven.
- The local Wolverine bridge is available. Its `READY_FOR_DRIVE` manifest for `HH-AGY-20260822T203110Z` lists seven staged files, and fresh SHA-256 recomputation matched all seven exactly. Those staged artifacts are already represented in the 2026-08-23 Drive snapshot.
- The committed `scripts/run_agy_loop.ps1` does not invoke Antigravity. It resolves `codex.cmd` and runs `codex exec` as the scheduled worker.
- Local logs show five Codex invocations on 2026-08-22. Three completed runs reported 16,139, 189,771, and 159,501 tokens, establishing a confirmed minimum of 365,411 Codex tokens; two interrupted runs add an unknown amount.
- The scheduled `Hedgehog AGY Continuous` task is currently disabled, so that erroneous scheduled Codex consumption is not continuing.

## Current blockers

- The primary orchestration blocker is that the supposed AGY runner executes Codex rather than `agy.exe`. There is no verified Antigravity-driven engineering cycle yet.
- CI exists as code but has not produced a passing or deliberately failing Actions run on the current branch head.
- The dependency graph remains a local draft. Creating or updating GitHub issues remains an external mutation and has not been performed.
- Physical P100 and fast-network hardware are not yet available for measured hardware baselines; architecture, simulation, source analysis, infrastructure-as-code, and synthetic testing remain unblocked.

## Artifact boundary

Do not publish actual secrets, credentials, customer data, private legal records, model weights, or live production payloads containing private data. Hedgehog's design is not sensitive by default, and the public repository is not a blocker. The untracked repository-root `agy-profile/` contains Antigravity/Gemini CLI profile/configuration material and is excluded from the safe handoff unless separately reviewed.

## Next task

Use Codex to diagnose and repair the AGY instructions/harness until the scheduled runner actually invokes `agy.exe` and one real Antigravity cycle produces reproducible evidence. Then return substantive engineering work to Antigravity and proceed to ADR-0001; Codex remains the instruction/orchestration debugger and hard-case reviewer rather than the repeated heavy-work engine.
