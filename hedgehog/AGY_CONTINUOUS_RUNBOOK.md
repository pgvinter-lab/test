# Hedgehog AGY Continuous Engineering Loop

## Purpose

Run the 60-day Hedgehog engineering program as a persistent, evidence-driven Google Antigravity loop. Antigravity is the scheduled heavy-work engine. Codex is reserved for out-of-band diagnosis and repair of prompts, instructions, harnesses, and orchestration defects that prevent Antigravity from doing that work.

## Source of truth

- GitHub repository: `pgvinter-lab/test`
- Working branch: `hedgehog/agy-continuous`
- Doctrine: `hedgehog/HEDGEHOG_ENGINEERING_DOCTRINE.md`
- Queue: `hedgehog/QUEUE.md`
- Status: `hedgehog/STATUS.md`
- Evidence: `hedgehog/evidence/`
- Outreach drafts: `hedgehog/outreach/drafts/`
- Scheduled runner: `hedgehog/scripts/run_agy_loop.ps1`

The existing repository is public, and that is not a blocker. Hedgehog architecture, topology, system design, implementation details, ADRs, threat models, synthetic fixtures, benchmark methods and results, and reproducibility evidence may be committed there. The same material may also be archived under `SK-O/Hedgehog/System` in Google Drive. Never commit actual secrets, credentials, customer data, private legal records, model weights, or live production payloads containing private data. Move real customer or private production data to appropriately restricted storage before it enters the project.

## Execution-engine contract

The scheduled runner must resolve and execute `agy.exe` directly. There is no automatic fallback to Codex or another coding agent.

The runner uses Antigravity headless print mode with JSON output so it can verify the terminal status, response, token usage, and `conversation_id`. The first successful engineering cycle records the Antigravity conversation ID under the local runtime directory; subsequent cycles resume that conversation with `--conversation` so context persists across scheduled executions.

The runner rejects:

- a missing or unexpected Antigravity executable;
- a non-zero Antigravity exit code;
- a non-`SUCCESS` terminal envelope;
- empty stdout or a non-JSON result;
- a `SUCCESS` result with zero token usage or an empty response;
- substantive changes outside `hedgehog/`;
- prose-only progress without substantive artifacts;
- a cycle that does not create or update machine-readable evidence.

After three consecutive scheduled failures, later scheduled attempts stop before invoking Antigravity. A successful `-SmokeTest` clears the failure counter after the prompt/harness/authentication defect has been repaired.

## Codex repair loop

Codex does not perform the recurring Hedgehog engineering cycle. Its role is to improve leverage when Antigravity fails:

1. Preserve the Antigravity failure, logs, exit state, and reproducible conditions.
2. Use Codex out of band to diagnose the instruction, prompt, harness, tool, or orchestration defect.
3. Repair that mechanism and add a regression test whenever practical.
4. Run the Antigravity smoke test.
5. Return the substantive task to Antigravity.

A failed Antigravity run is therefore a debugging input for Codex, not permission to replace Antigravity with Codex for the workload.

## Trigger configuration

Use the Windows scheduled task `Hedgehog AGY Continuous` for the local loop.

- Schedule: hourly
- Time zone: `America/New_York`
- Persistent context: reuse the recorded Antigravity `conversation_id`
- Maximum consecutive failures that may invoke Antigravity: 3
- Execution timeout: 55 minutes for the task; 45 minutes for one Antigravity headless turn
- Notifications: daily handoff plus explicit failure/blocker reporting

The runner constructs each task from `hedgehog/AGY_TRIGGER_PROMPT.md` and an explicit task ID.

`install_agy_task.ps1` validates the local CLI before registering the task. It keeps the task disabled by default; `-EnableAfterSmokeTest` performs a real Antigravity smoke test before enabling the hourly schedule.

## One-run operating cycle

Every scheduled engineering execution must:

1. Pull or fast-forward the latest `hedgehog/agy-continuous` branch when the worktree is clean; otherwise enter explicit recovery mode.
2. Read the doctrine, queue, status, open issues, latest commits, CI results, and prior evidence.
3. Select the highest-priority unblocked task that can be advanced in the current environment.
4. Prefer extending prior work over starting a new branch of investigation.
5. Research primary documentation and source code before proposing custom implementation.
6. Implement, test, benchmark, or produce a minimal reproducible experiment.
7. Store raw evidence, commands, logs, benchmark data, and exact versions.
8. Update `STATUS.md` with what changed, evidence, blockers, and next task.
9. Update `QUEUE.md` only when evidence changes priority or dependency order.
10. Return control without committing or pushing.
11. Let the runner execute the evidence verifier and full Hedgehog unit suite.
12. Let the runner commit and push verified `hedgehog/` changes and populate the Wolverine handoff outbox.
13. Stop cleanly before timeout, leaving the environment resumable.

## Evidence gate

Never mark work complete because code compiled, a process started, a GPU appeared, or a model emitted text. Completion requires task-appropriate evidence such as correctness tests, benchmark measurements, topology data, failure recovery, security checks, or reproduction on a clean environment.

## Hardware-absent mode

Until physical Hedgehog hardware is available, work continuously on:

- Primary-source literature and repository review
- Architecture decision records
- Threat models
- PXE and immutable-host prototypes in nested VMs or containers
- KVM/libvirt and VFIO automation with mocked hardware inventories
- NUMA and PCIe topology parsers using captured or synthetic fixtures
- CUDA 12/Pascal build matrices where cloud hardware permits compilation
- llama.cpp and GGML source analysis
- Distributed MoE routing simulations
- UCX/MPI/RDMA transport harnesses
- Deterministic correctness tests
- Benchmark harnesses
- Failure injection
- Documentation and outreach preparation

Do not invent benchmark results for unavailable hardware. Label simulations and estimates explicitly.

## Outreach policy

The agent may identify experts, read their work, prepare minimal reproducers, and draft technically narrow emails or GitHub discussions. It may not send external communications without explicit human approval. Save drafts under `hedgehog/outreach/drafts/` with the proposed recipient, rationale, cited prior work, exact question, and attached reproducer/evidence.

## Security boundary

All security testing must be limited to owned systems, local simulations, deliberately vulnerable training targets, or systems with explicit written authorization. Do not build anonymous access, raw shell rental, unrestricted outbound scanning, credential collection, malware deployment, or offensive-cyber-as-a-service functionality.

## Daily handoff

At least once per day, produce `hedgehog/reports/YYYY-MM-DD-daily.md` containing:

- Verified progress
- New evidence
- Current architecture decisions
- Failed approaches and why
- Open blockers
- External outreach drafts created
- Security or legal concerns
- Hardware assumptions still needing measurement
- Next 24-hour plan

## First tasks

1. Convert the doctrine into a dependency-ordered 60-day issue graph.
2. Inventory existing open-source components and identify only the true missing layers.
3. Produce ADR-0001 for the virtualized, diskless, 100Gb fabric architecture.
4. Produce a threat model for SK Companies workloads on Hedgehog.
5. Build the first simulation harness for static MoE expert ownership and activation routing.
6. Define exact acceptance tests for one-, two-, and four-P100 baselines.
