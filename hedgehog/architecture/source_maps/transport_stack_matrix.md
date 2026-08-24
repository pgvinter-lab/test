# Network Transport & Interconnect Stack Decision Matrix

**Workstream**: `network-transport`  
**Issue Reference**: `hh-p1-map-transport` / `hh-p0-adr-0001`  
**Status**: Completed Evaluation  
**Date**: 2026-08-24  

---

## Executive Summary

This matrix evaluates network transport protocols, RDMA communication libraries, and distributed runtime frameworks for Project Hedgehog's 100Gb fabric. 

In a distributed Mixture-of-Experts (MoE) inference pipeline (scaling to 1.0T–1.3T parameters), compute hosts hold resident expert weights in local DDR3/DDR4 RAM and active layers in P100 VRAM. The steady-state network workload consists of:
1. **Activation Routing & Token Dispatch**: Transferring activation tensors ($1\text{KB} - 64\text{KB}$ per token vector) between router nodes and assigned expert worker nodes with minimal latency ($< 15\,\mu\text{s}$) and maximum message rate.
2. **All-to-All / Scatter-Gather Collective Communications**: Aggregating expert outputs back to the token sequence before the next MoE layer.
3. **Initial Model Shard Staging**: Streaming multi-gigabyte expert weight shards from persistent storage to node RAM during cold starts.

---

## Comparative Transport Protocols & Hardware Fabrics

| Protocol / Fabric | Physical Layer | Hardware Bypass | Latency (4KB Payload) | Bandwidth Utilization | Hardware Requirements & Caveats |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **RoCEv2 (RDMA over Converged Ethernet)** | 100GbE (QSFP28) | **Yes** (Kernel bypass via RNIC) | **$8 - 15\,\mu\text{s}$** | **$92 - 96\%$** ($11.5 - 12.0\,\text{GB/s}$) | Requires Priority Flow Control (PFC) and ECN configured on 100Gb switches to prevent packet drop. |
| **EDR InfiniBand** | 100G EDR (QSFP28) | **Yes** (Native IB verbs bypass) | **$1.5 - 3.5\,\mu\text{s}$** | **$95 - 98\%$** ($12.0 - 12.2\,\text{GB/s}$) | Requires InfiniBand Subnet Manager (OpenSM) and native IB switches. |
| **Standard TCP/IP (Kernel Socket)** | 100GbE / 10GbE | **No** (Kernel buffer copies & context switches) | **$60 - 180\,\mu\text{s}$** | **$60 - 75\%$** (High CPU load for socket processing) | Runs on any Ethernet switch. Fallback transport only. |
| **Kernel-Bypass TCP (DPDK / Solarflare)** | 100GbE | **Yes** (User-space polling) | **$25 - 40\,\mu\text{s}$** | **$80 - 88\%$** | High CPU core consumption for busy-polling. More complex than RDMA. |

---

## Comparative Communication Libraries & APIs

| Library / Framework | Abstraction Level | Point-to-Point RDMA | Collectives (All-to-All) | P100 / CUDA Support | Verdict & Role in Hedgehog |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **OpenUCX (`libucx`)** | Middleware / Transport Engine | **Native UCP API** (Zero-copy, Active Messages) | **Excellent** (Built-in collective protocols) | **Full CUDA Support** (Host-pinned & device memory) | **Selected Primary Transport Stack** |
| **RDMA-Core (`libibverbs` / `librdmacm`)** | Low-Level Driver API | **Raw Queue Pairs** (RC, UC, UD) | **Manual Implementation Required** | **Supported** (via `cudaHostRegister`) | **Underlying Driver Layer for UCX** |
| **OpenMPI / MPICH** | HPC High-Level API | **Standard MPI_Send/Recv** | **Standard MPI_Alltoallv** | **Supported** (CUDA-aware MPI) | **Retained for Synthetic HPC Benchmarks** |
| **NCCL (NVIDIA Collective Comm)** | GPU-Direct Collective Engine | **Optimized for NVLink/Modern GPUs** | **High Performance** | **Limited on sm_60 without NVLink** | **Secondary (Fallback for multi-GPU single-node)** |
| **gRPC / HTTP/2** | Application RPC | **TCP Socket Stream** | **Manual Serialization** | **Host Memory Only** | **Control Plane Telemetry Only** |

---

## Pascal (Tesla P100) & PCIe Gen3 Architectural Considerations

### 1. GPUDirect RDMA on Tesla P100 (sm_60)
- **PCIe Topology Requirements**: Direct peer-to-peer RDMA between Mellanox ConnectX-4 and NVIDIA P100 requires both devices to reside on the same PCIe switch / PCIe root complex.
- **BAR1 Sizing**: P100 GPUs provide large BAR1 memory windows (allowing the RNIC to read/write directly to GPU HBM2 over PCIe).
- **Unverified Hardware Assumption**: On older PCIe Gen3 host chipsets (e.g., Intel Xeon E5 v4 / Broadwell-EP), crossing the QPI/UPI socket bus for GPUDirect RDMA incurs high latency penalties. The architecture strictly enforces NUMA-local device pairing.
- **Staging in Host RAM**: Since MoE expert weights reside primarily in host system DDR4 RAM and activations are transferred between hosts, the primary RDMA path is **Host RAM $\leftrightarrow$ Host RAM** (via RoCEv2/IB verbs), followed by local **Host RAM $\leftrightarrow$ P100 HBM** over PCIe Gen3 x16 ($12.0\,\text{GB/s}$).

### 2. Transport Architecture Recommendations for Hedgehog

1. **Primary Data Transport Engine**:
   - Build on **OpenUCX (UCP)** for all token activation scatter/gather operations.
   - Use UCX Active Messages (`ucp_am_send_nbx`) for asynchronous, event-driven activation dispatch to MoE worker threads.
2. **Network Fabric Configuration**:
   - For 100GbE switches: Enable DSCP-based Priority Flow Control (PFC, IEEE 802.1Qbb) on Priority 3 and Explicit Congestion Notification (ECN, RFC 3168) for lossless RoCEv2 operation.
   - For InfiniBand switches: Run `opensm` on the Control Node.
3. **Control Plane Protocol**:
   - Keep control plane communications (heartbeats, registration, fencing commands) strictly isolated on the 1GbE/10GbE management network using mutual TLS over standard HTTPS/gRPC.

---

## Pinned Versions for Hedgehog Baseline

- **RDMA-Core**: $\ge \text{v48.0}$ (`libibverbs1`, `ibverbs-providers`)
- **OpenUCX**: $\ge \text{v1.16.0}$
- **Mellanox OFED / Driver**: Upstream Linux kernel `mlx5_core` + `mlx5_ib`
- **CUDA Toolkit**: 12.x (Targeting Compute Capability `sm_60`)
