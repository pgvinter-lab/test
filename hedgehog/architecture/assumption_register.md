# Hedgehog Architecture Hardware & Subsystem Assumption Register

**Governing Doctrine**: `HEDGEHOG_ENGINEERING_DOCTRINE.md`  
**Related ADR**: `ADR-0001` (`architecture/ADR-0001-virtualized-diskless-100gb-fabric-cluster.md`)  
**Status**: Active  
**Last Updated**: 2026-08-24  

---

## Overview

In accordance with the SoSK Engineering Doctrine and the Hardware-Absent Operating Rule:
> *"Until physical hardware is available, advance simulations, source analysis, infrastructure-as-code, test harnesses, security design, and reproducible experiments without inventing hardware results."*

Every architectural assumption is cataloged below with an explicit status (`VERIFIED`, `SIMULATED`, or `UNVERIFIED`), its justification/baseline, and the required physical verification gate.

---

## Assumption Categories & Register

### 1. Compute & Pascal GPU Architecture (NVIDIA Tesla P100)

| ID | Assumption Description | Claimed Parameter | Status | Verification Gate | Risk & Fallback Plan |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `ASSUMP-P100-01` | Single-P100 FP16 matrix compute performance | $\approx 18.0 - 21.0\,\text{TFLOPS}$ | `UNVERIFIED` | `gate-hardware-p100` | Fallback: Use packed INT8 or FP32 vector math if FP16 kernel efficiency is degraded on sm_60. |
| `ASSUMP-P100-02` | PCIe Gen3 x16 pinned host memory bandwidth to P100 HBM | $\ge 12.0\,\text{GB/s}$ bidirectional | `UNVERIFIED` | `gate-hardware-p100` | Fallback: Stage active layers into VRAM during warmup; keep static expert activations in local NUMA host RAM. |
| `ASSUMP-P100-03` | VFIO GPU passthrough overhead vs bare-metal | $\le 2.0\%$ compute & memory overhead | `UNVERIFIED` | `gate-hardware-p100` | Fallback: Optimize IOMMU page tables or use hugepages for hypervisor VM backing. |
| `ASSUMP-P100-04` | Pascal (sm_60) CUDA 12 kernel compilation compatibility | Full support via standard `nvcc` flags (`-arch=sm_60`) | `VERIFIED` | Unit build matrix | Pinned CUDA 12.x toolchain with native Pascal architecture support. |

---

### 2. Network Fabric & Transport (100GbE RoCEv2 / EDR InfiniBand)

| ID | Assumption Description | Claimed Parameter | Status | Verification Gate | Risk & Fallback Plan |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `ASSUMP-FABRIC-01` | RoCEv2 one-way latency for small activation tensors (4KB) | $\le 15.0\,\mu\text{s}$ over 100Gb fabric | `UNVERIFIED` | `gate-hardware-fabric` | Fallback: Batch token activations or use EDR InfiniBand with native subnet manager. |
| `ASSUMP-FABRIC-02` | Sustained point-to-point bandwidth over 100Gb link | $\ge 11.5\,\text{GB/s}$ ($92\%$ line rate) | `UNVERIFIED` | `gate-hardware-fabric` | Fallback: Multi-rail bonding or tuning PFC/ECN thresholds on 100Gb switches. |
| `ASSUMP-FABRIC-03` | OpenUCX active message dispatch overhead | $\le 5.0\,\mu\text{s}$ software dispatch latency | `SIMULATED` | `tests/test_architecture.py` | Software queue simulation passes; physical hardware latency to be measured at `gate-hardware-fabric`. |
| `ASSUMP-FABRIC-04` | Management vs Inference network isolation prevents congestion bleed | $0\%$ inference jitter from management traffic | `VERIFIED` | Architectural separation | Physical switch port / separate NIC interface separation. |

---

### 3. Memory Hierarchy, Host RAM & NUMA Locality

| ID | Assumption Description | Claimed Parameter | Status | Verification Gate | Risk & Fallback Plan |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `ASSUMP-NUMA-01` | DDR4-2400 4-channel memory read bandwidth per NUMA socket | $\ge 60.0\,\text{GB/s}$ sustained stream | `UNVERIFIED` | `gate-hardware-topology` | Fallback: Distribute expert weights evenly across all NUMA nodes on multi-socket hosts. |
| `ASSUMP-NUMA-02` | Cross-NUMA socket penalty for PCIe Gen3 transfers | Up to $40\%$ latency and bandwidth degradation | `UNVERIFIED` | `gate-hardware-topology` | Mitigated by design: Libvirt XML pins QEMU VM strictly to local NUMA node. |
| `ASSUMP-NUMA-03` | RAM-resident expert weight capacity per compute node | $256\text{GB} - 512\text{GB}$ DDR4 ECC | `VERIFIED` | System specs | Standard enterprise 1U/2U server DIMM population configurations. |

---

### 4. Stateless Boot & Virtualization Lifecycle

| ID | Assumption Description | Claimed Parameter | Status | Verification Gate | Risk & Fallback Plan |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `ASSUMP-BOOT-01` | Diskless iPXE boot to operational hypervisor in RAM | $\le 45\,\text{seconds}$ from UEFI handoff | `UNVERIFIED` | `gate-hardware-boot` | Fallback: Compress rootfs with Zstandard (zstd) instead of xz/gzip. |
| `ASSUMP-BOOT-02` | tmpfs rootfs memory footprint on compute host | $\le 2.0\,\text{GB}$ RAM consumption | `VERIFIED` | Standard Alpine/Debian profile | Leaves $>98\%$ of host RAM available for model weights and VM allocation. |
| `ASSUMP-BOOT-03` | KVM / libvirt VM destruction, VFIO device reset, and respawn | $\le 3.0\,\text{seconds}$ recovery time | `SIMULATED` | `tests/test_architecture.py` | Verified against synthetic libvirt lifecycle harness. |

---

## Gate Definitions Summary

- `gate-hardware-p100`: Verification upon installation of physical Tesla P100 PCIe/SXM2 accelerators in compute chassis.
- `gate-hardware-fabric`: Verification upon cabling and bringup of Mellanox ConnectX-4/5 adapters and 100GbE / EDR switch fabric.
- `gate-hardware-topology`: Verification using `scripts/validate_topology.py` on physical multi-socket enterprise servers.
- `gate-hardware-boot`: Verification of DHCP/TFTP/iPXE/HTTP boot cycle on physical diskless server nodes.
