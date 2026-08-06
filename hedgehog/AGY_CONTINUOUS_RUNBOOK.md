# Hedgehog AGY Continuous Engineering Loop

## Purpose

Run the 60-day Hedgehog engineering program as a persistent, evidence-driven Antigravity agent loop. The agent must reuse one sandbox/environment so research notes, source trees, test fixtures, build artifacts, and status survive between scheduled executions.

## Source of truth

- GitHub repository: `pgvinter-lab/test`
- Working branch: `hedgehog/agy-continuous`
- Doctrine: `hedgehog/HEDGEHOG_ENGINEERING_DOCTRINE.md`
- Queue: `hedgehog/QUEUE.md`
- Status: `hedgehog/STATUS.md`
- Evidence: `hedgehog/evidence/`
- Outreach drafts: `hedgehog/outreach/drafts/`

The existing repository is public. Never commit secrets, credentials, customer data, private legal material, exploit code intended for unauthorized use, or sensitive infrastructure details. Move to a private repository before real customer or production data enters the project.

## Trigger configuration

Create one scheduled Gemini/Antigravity trigger bound to one persistent environment ID.

- Schedule: hourly
- Time zone: `America/New_York`
- Environment: reuse the same environment ID on every run
- Maximum consecutive failures: 3
- Execution timeout: use the maximum available practical timeout
- Notifications: emit completion and failure events when supported

The trigger should execute the prompt in `hedgehog/AGY_TRIGGER_PROMPT.md`.

## One-run operating cycle

Every scheduled execution must:

1. Pull the latest `hedgehog/agy-continuous` branch.
2. Read the doctrine, queue, status, open issues, latest commits, CI results, and prior evidence.
3. Select the highest-priority unblocked task that can be advanced in the current environment.
4. Prefer extending prior work over starting a new branch of investigation.
5. Research primary documentation and source code before proposing custom implementation.
6. Implement, test, benchmark, or produce a minimal reproducible experiment.
7. Store raw evidence, commands, logs, benchmark data, and exact versions.
8. Update `STATUS.md` with what changed, evidence, blockers, and next task.
9. Update `QUEUE.md` only when evidence changes priority or dependency order.
10. Commit and push all verified work to the working branch.
11. Open or update a narrowly scoped GitHub issue when external input is required.
12. Stop cleanly before timeout, leaving the sandbox and repository resumable.

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
