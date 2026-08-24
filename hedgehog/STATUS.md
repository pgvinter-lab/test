# Hedgehog Program Status

## Current phase

Program bootstrap, architecture validation, distributed MoE simulation, and security boundary formalization before hardware arrival.

## Verified facts

- The governing 60-day engineering doctrine has been authored (`HEDGEHOG_ENGINEERING_DOCTRINE.md`).
- On 2026-08-24, Google Antigravity executed scheduled engineering cycles (`HH-AGY-20260824T090725Z`, `HH-AGY-20260824T091315Z`, and `HH-AGY-20260824T093112Z`) directly, advancing architecture, security, and distributed MoE simulation baselines.
- ADR-0001 has been authored, validated, and accepted in `architecture/ADR-0001-virtualized-diskless-100gb-fabric-cluster.md`.
- Subsystem source maps and decision matrices have been established for Virtualization (`architecture/source_maps/virtualization_stack_matrix.md`), Network Transport (`architecture/source_maps/transport_stack_matrix.md`), and Distributed MoE / Expert Parallelism (`architecture/source_maps/expert_parallel_matrix.md`).
- A canonical Hardware & Subsystem Assumption Register has been cataloged in `architecture/assumption_register.md`, strictly classifying `VERIFIED`, `SIMULATED`, and `UNVERIFIED` parameters with assigned verification gates.
- Threat Model v0.1 has been authored, validated, and accepted in `security/threat_model/THREAT_MODEL_V0_1.md`, modeling 7 trust boundaries (TB-1 to TB-7), 7 asset classes, 5 threat actors, 18 STRIDE threats (THR-01 to THR-18), 18 security controls (CTL-SEC-01 to CTL-SEC-18), and 4 owner-accepted residual risks (RR-01 to RR-04).
- A Security Control & Test Mapping Matrix has been authored in `security/threat_model/control_test_matrix.md`, linking controls to automated unit tests and hardware verification gates.
- Static MoE Expert-Ownership, Replication, and Activation Routing Simulation is implemented in `moe/` (`topology.py`, `model_config.py`, `expert_placement.py`, `router.py`, `reference.py`, `distributed_layer.py`).
- Golden single-process numerical reference matches distributed execution with bit-exact parity (max diff = 0.0 <= 1e-6) across SwiGLU and GeLU architectures.
- Automated validation is implemented in `scripts/validate_architecture.py`, `scripts/validate_threat_model.py`, and `scripts/validate_moe_simulation.py`.
- Benchmark harness for MoE activation scaling and latency modeling is implemented in `scripts/run_moe_benchmarks.py`.
- The full Hedgehog unit test suite (`tests/`) passes 62 tests with zero errors in ~22s.
- `scripts/verify_evidence.py` validates 6 machine-readable evidence manifests supporting 4 checked queue items in `QUEUE.md` (`evidence-contract-v1.json`, `hh-p0-adr-0001.json`, `hh-p0-threat-model-v0-1.json`, `hh-p1-static-expert-simulation.json`).
- The 36-node dependency-ordered issue graph remains `local-draft`; GitHub issue import has not been performed to avoid unauthorized external mutations.
- The local Wolverine bridge remains available for handoffs.

## Current blockers

- Physical P100 accelerators, PCIe topologies, and 100GbE / EDR fabric hardware are not yet provisioned; hardware-dependent parameters remain explicitly `UNVERIFIED` until hardware arrival gates fire.
- CI exists as code (`.github/workflows/hedgehog-evidence.yml`) but has not produced a passing or deliberately failing Actions run on the current branch head.
- The dependency graph remains a local draft. Creating or updating GitHub issues remains an external mutation requiring human authorization.

## Artifact boundary

Do not publish actual secrets, credentials, customer data, private legal records, model weights, or live production payloads containing private data. Hedgehog's design is not sensitive by default, and the public repository is not a blocker. Untracked configuration or profile directories are excluded from safe handoffs unless reviewed.

## Next task

Build the topology fixture parser for NUMA, PCIe, GPUs, NICs, and memory channels (`hh-p1-topology-fixture-parser`), followed by the activation-routing transport benchmark (`hh-p1-activation-transport-benchmark`).
