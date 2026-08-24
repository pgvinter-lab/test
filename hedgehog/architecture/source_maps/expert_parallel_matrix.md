# Distributed MoE & Expert-Parallel Architecture Decision Matrix

## 1. Context & Mission

Project Hedgehog targets running frontier-class Mixture-of-Experts (MoE) models (up to 1.0T–1.3T total parameters) across a private cluster of decommissioned enterprise servers. The physical substrate features:
- **Accelerators**: 4x NVIDIA Tesla P100 (16GB HBM2, PCIe Gen3 x16, Compute Capability 6.0 / Pascal) per compute host.
- **Host Memory**: Large quantities of inexpensive DDR3/DDR4 system RAM (256GB–512GB+ per node).
- **Interconnect**: 100GbE (RoCEv2) or EDR InfiniBand fabric connecting diskless compute hosts to a persistent storage/control node.
- **Fundamental Invariant**: Move **activations** across the high-speed network fabric during token routing, rather than repeatedly streaming massive **model weights** over PCIe or the network during inference.

This matrix evaluates existing open-source expert-parallel, MoE routing, and distributed inference engines to establish which components can be reused directly and which custom layers Hedgehog must construct.

---

## 2. Comparative Evaluation of Candidate Implementations

| System / Engine | Primary Maintainer | Parallelism Model | Interconnect Assumption | Memory Model | Pascal (P100) Compatibility | Failure Tolerance | License |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **DeepSpeed-MoE** | Microsoft | Expert Parallel (EP) + Tensor/Data Parallel | NVLink / high-bandwidth IB; NCCL All-to-All | GPU VRAM resident; ZeRO-Offload to NVMe/RAM | Partial (sm_60 supported in legacy kernels; newer CUTLASS kernels drop sm_60) | Process crash / abort on rank failure | Apache 2.0 |
| **Megatron-LM MoE** | NVIDIA | Expert + Tensor + Pipeline Parallelism | NVLink / NVSwitch + InfiniBand | VRAM only; expects homogeneous GPU clusters | Low (optimized for Hopper/Blackwell with FP8/FP4, sm_90+) | NCCL abort on rank loss | Apache 2.0 |
| **vLLM Distributed MoE** | vLLM Project | Ray-orchestrated EP / TP / PP | Ray IPC / NCCL / Gloo | GPU VRAM + PagedAttention | High (vLLM has Triton & CUDA fallback, but relies on PyTorch NCCL) | Ray actor restart (high recovery latency) | Apache 2.0 |
| **llama.cpp (RPC Backend)** | ggerganov / GGML | Tensor Sharding / Split-by-Layer / RPC | TCP / Socket RPC | Host RAM + GPU offload (split tensors) | Full (GGML supports CUDA sm_60, CPU, cuBLAS) | Connection timeout / error propagation | MIT |
| **FastMoE / ScatterMoE** | Tsinghua / Stanford | Custom PyTorch MoE kernels / Scatter-Gather | Single-node multi-GPU or NCCL EP | VRAM resident | Moderate (FastMoE has sm_60 CUDA kernels; ScatterMoE requires Triton 2.1+) | None (library-level) | Apache 2.0 |
| **Switch Transformers / ST-MoE** | Google | GShard / Mesh-TensorFlow / Jax EP | TPU Pod / high-speed fabric | TPU HBM / Host RAM | N/A (Jax/TPU focused; algorithms portable) | Checkpoint restart | Apache 2.0 |

---

## 3. Detailed Dimension Analysis

### 3.1 Network Traffic: Activation Routing vs. Weight Streaming
- **Naive Weight Streaming**: If a 1.0T model has 64 experts of 16B parameters each (fp16 = 32GB per expert, or 4-bit = 8GB per expert), streaming an expert from host RAM or central storage over 100GbE (12.5 GB/s line rate) incurs **~640 ms latency per expert invocation**.
- **Static Sharding with Activation Routing**: A token activation vector for hidden dimension =4096$ in fp16 is only **8 KB**. Dispatching =2$ token activations to remote expert owners and returning the resulting activations over 100Gb fabric incurs **< 15 microseconds transport latency**.
- **Conclusion**: Hedgehog must enforce **Static Expert Ownership** where experts remain permanently resident in local RAM or VRAM on designated compute nodes. Only token activations and gating scores cross the fabric.

### 3.2 Memory Hierarchy Exploitation (VRAM vs. System RAM)
- In a 4-node Hedgehog cluster with 16x P100 GPUs:
  - Total GPU VRAM =  	imes 16	ext{ GB} = 256	ext{ GB}$.
  - Total Cluster Host RAM =  	imes 512	ext{ GB} = 2048	ext{ GB}$ (2 TB).
- High-frequency shared layers (embeddings, self-attention, router gate networks) and hot experts reside in **GPU VRAM** (fast compute).
- Lower-frequency or sparse expert shards reside in **Host System RAM** (pinned DDR4, mapped via PCIe Gen3 BAR / unified memory or staged via pinned host buffers).

### 3.3 Hardware Compatibility: NVIDIA Pascal (Compute Capability 6.0 / sm_60)
- The Tesla P100 lacks Tensor Cores (introduced in Volta sm_70) and lacks hardware FP8/INT4 matrix units (Ada/Hopper).
- FP16 performance on P100 is supported natively via packed FP16 (__half2 arithmetic, executing at 2x FP32 rate: 18.7 TFLOPS FP16 vs 9.3 TFLOPS FP32).
- GGML / llama.cpp provides proven, highly optimized CUDA kernels for Pascal (sm_60) for quantized matrix multiplication (Q4_K, Q5_K, Q8_0, FP16).
- Heavy modern frameworks (e.g. FlashAttention-2/3, modern CUTLASS 3.x) do not support sm_60. Hedgehog must reuse GGML/llama.cpp-compatible Pascal kernels for local expert computation.

### 3.4 Fault Tolerance & Expert Replication (N+1 Ready)
- Existing frameworks (DeepSpeed, Megatron, vLLM) use collective communications (
cclAllToAll, MPI_Alltoall) that abort the entire distributed job if any single GPU or node drops a heartbeat.
- **Hedgehog Invariant (Principle 2: Always Have Another One Ready)**:
  - Every expert shard has a **Primary Owner** (Node $) and at least one **Secondary Replica** (Node $) in standby RAM.
  - The token dispatch router detects worker unresponsiveness via lightweight heartbeats and automatically fails over tokens destined for Node $ to Node $.
  - Single-node failure degrades throughput slightly but does not halt the cluster or abort active inference requests.

---

## 4. Reusable Components vs. Custom Hedgehog Integration Layer

### 4.1 Reusable Upstream Components
1. **llama.cpp / GGML Core**: Quantization kernels (Q4_K_M, Q5_K_M, Q8_0, FP16), CUDA sm_60 execution backend, memory-mapped model loader.
2. **OpenUCX / RDMA-Core**: High-performance, zero-copy point-to-point token activation transport over RoCEv2 and InfiniBand with libfabric / TCP fallback.
3. **Switch Transformer / GShard Routing Mathematics**: Top-K softmax gating, auxiliary load-balancing loss formulations, capacity factor dispatch algorithms.

### 4.2 Custom Hedgehog Integration Layer (hedgehog/moe)
Hedgehog builds the missing integration layers:
1. **Topology-Aware Expert Placement Engine (hedgehog.moe.expert_placement)**:
   - Maps $ experts across $ physical nodes, NUMA sockets, and GPU seats.
   - Enforces VRAM bounds, NUMA memory channel affinity, and replica placement across distinct failure domains.
2. **Deterministic Activation Dispatch Router (hedgehog.moe.router)**:
   - Computes Top-K gating logits, softmax routing probabilities, and expert assignments.
   - Enforces capacity factor limits, token dropping / retry buffering, and backpressure under burst traffic.
   - Tracks expert load balance (imbalance ratio, coefficient of variation).
   - Manages automatic worker loss failover to secondary replicas.
3. **Golden Numerical Reference & Verification Suite (hedgehog.moe.reference)**:
   - Single-process golden reference executing exact MoE layer mathematics.
   - Strict numerical equivalence verification ($|Y_{distributed} - Y_{reference}| < 10^{-6}$).
   - Injected mutation test harness validating failure detection under weight, routing, or aggregation corruption.

---

## 5. Licensing & Upstream Governance

- **GGML / llama.cpp**: MIT License (Permissive, fully compatible with private/commercial deployment, no copyleft contamination).
- **OpenUCX**: BSD 3-Clause (Permissive).
- **PyTorch / vLLM / DeepSpeed**: Apache 2.0 (Permissive with patent grant).
- **Upstream Strategy**: Keep custom Hedgehog patches cleanly isolated into the hedgehog/moe runtime module; contribute standalone kernel improvements or bugfixes back to upstream GGML/llama.cpp where broadly applicable.
