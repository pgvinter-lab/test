# Hedgehog Architecture Repository

This directory contains the formal Architecture Decision Records (ADRs), subsystem decision matrices, source maps, and hardware assumption registers for Project Hedgehog.

---

## Directory Index

### Architecture Decision Records (ADRs)

| ADR | Title | Status | Date | Primary Workstreams |
| :--- | :--- | :--- | :--- | :--- |
| [**ADR-0001**](ADR-0001-virtualized-diskless-100gb-fabric-cluster.md) | Virtualized Diskless Compute Nodes, Persistent Control/Storage, Whole-GPU Passthrough, and 100GbE/EDR Fabric | `Accepted` | 2026-08-24 | `program-bootstrap`, `reproducible-infrastructure`, `network-transport` |

### Subsystem Source Maps & Decision Matrices

- [**Virtualization & Hypervisor Stack Decision Matrix**](source_maps/virtualization_stack_matrix.md): Evaluation of Linux KVM/QEMU/libvirt vs Nomad vs Kubernetes/KubeVirt vs Bare-Metal.
- [**Network Transport & Interconnect Stack Decision Matrix**](source_maps/transport_stack_matrix.md): Evaluation of OpenUCX, RDMA-Core (`libibverbs`), RoCEv2, EDR InfiniBand, TCP, and P100 GPUDirect over PCIe Gen3.

### Subsystem Registers & Models

- [**Hardware & Subsystem Assumption Register**](assumption_register.md): Strict categorization of verified, simulated, and unverified physical hardware assumptions with associated verification gates.

---

## Governance & Verification

All architectural artifacts in this repository must satisfy the verification criteria defined in `scripts/validate_architecture.py` and pass the unit suite in `tests/test_architecture.py`.

To validate all architectural artifacts locally:
```powershell
python scripts/validate_architecture.py
python -m unittest tests/test_architecture.py
```
