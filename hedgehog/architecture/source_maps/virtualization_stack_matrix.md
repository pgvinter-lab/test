# Virtualization & Hypervisor Stack Decision Matrix

**Workstream**: `reproducible-infrastructure`  
**Issue Reference**: `hh-p1-map-virtualization` / `hh-p0-adr-0001`  
**Status**: Completed Evaluation  
**Date**: 2026-08-24  

---

## Executive Summary

This matrix evaluates candidate virtualization and hypervisor orchestration stacks for Project Hedgehog stateless compute nodes. The objective is identifying the smallest, most reliable, and lowest-latency software layer capable of:
1. Booting diskless enterprise servers via iPXE into an immutable RAM-backed hypervisor.
2. Passing complete NVIDIA Tesla P100 GPUs and 100Gb Mellanox ConnectX-4 NICs directly to guest inference workloads via VFIO with near-zero latency and throughput overhead ($\le 2\%$).
3. Strictly enforcing NUMA node memory locality and 1-to-1 CPU core pinning.
4. Performing rapid fencing, watchdog monitoring, and VM destruction/rebuilding upon hardware or guest failure.

---

## Candidate Stacks Evaluated

1. **Linux KVM + QEMU + libvirt (Recommended Baseline)**
2. **HashiCorp Nomad + QEMU Driver (Evaluated Alternative)**
3. **OpenNebula (Minimal Cloud Manager)**
4. **Kubernetes (K8s) + KubeVirt / GPU Operator (Rejected)**
5. **Proxmox VE / Proxmox API (Rejected)**
6. **Pure Bare-Metal without Hypervisor (Rejected)**

---

## Comparative Evaluation Matrix

| Criterion | KVM + QEMU + libvirt | Nomad + QEMU | OpenNebula | K8s + KubeVirt | Proxmox VE | Pure Bare-Metal |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Stateless / Diskless Host Boot** | **Native** (SquashFS + tmpfs) | **Native** (Single static binary on host) | **Supported** (requires central DB) | **Complex** (etcd/kubelet state friction) | **Poor** (assumes local debian disk) | **Native** (tmpfs) |
| **VFIO Passthrough Precision** | **Exact** (Direct XML / QEMU flags) | **Good** (via QEMU task driver) | **Good** (PCI device mapping) | **Clunky** (DevicePlugin / CDI friction) | **Good** (GUI/CLI configs) | **N/A** (No VM isolation) |
| **NUMA Pinning & Hugepages** | **Full Fine-Grained Control** (libvirt `<numatune>`, `<cputune>`) | **Partial** (requires wrapper scripts) | **Good** (NUMA aware templates) | **Coarse** (CPU manager static policy) | **Good** (via QEMU options) | **Native** (`numactl`, `cgroups`) |
| **Memory & Control Overhead** | **Very Low** (~30–50MB RAM for `libvirtd`) | **Low** (~40MB RAM client) | **Moderate** (~200MB central daemon) | **Very High** (2GB+ per node for kubelet, CNI, pods) | **Moderate** (~300MB per node) | **Zero** |
| **Zero-Trust Fencing & Isolation** | **Strong** (Hardware VT-x/VT-d, VM destroy in <1s) | **Strong** (cgroups + VM isolation) | **Strong** (Host fencing hooks) | **Moderate** (Kubernetes node eviction >30s) | **Moderate** (Corosync quorum requirements) | **None** (Process kill only, no kernel boundary) |
| **Pascal / P100 Driver Stability** | **Rock Solid** (`vfio-pci` standard driver) | **Rock Solid** (Passes through PCI ID) | **Rock Solid** (Direct PCI pass) | **Brittle** (NVIDIA GPU Operator version lock) | **Good** | **Good** |
| **Operational Complexity** | **Minimal** (Boring, standard Linux tools) | **Low** (Single binary agent) | **Moderate** | **Extreme** (Huge YAML surface, CNI, ingress) | **Moderate** (Web UI centric, clustering overhead) | **Low initial, High drift** |

---

## Detailed Architectural Findings

### 1. Selected Stack: KVM + QEMU + libvirt
- **Rationale**: `libvirt` provides a stable, scriptable C/Python API for generating programmatic domain XMLs with strict NUMA memory backing (`<memoryBacking><hugepages/></memoryBacking>`), explicit vCPU thread pinning (`<cputune><vcpupin/></cputune>`), and direct VFIO hostdev passthrough (`<hostdev mode='subsystem' type='pci' managed='yes'>`).
- **Stateless Integration**: The compute node image boots via iPXE, starts `libvirtd`, registers its local capacity to the Control Node via a lightweight gRPC/HTTPS agent, and receives VM launch XML templates dynamically.

### 2. Evaluated Candidate: Nomad + QEMU Driver
- **Rationale**: HashiCorp Nomad provides an exceptionally clean, single-binary orchestrator. It can directly execute QEMU VMs via its `qemu` task driver.
- **Role in Hedgehog**: Retained as an optional higher-level job placement engine on top of libvirt/QEMU if multi-tenant queue orchestration grows beyond simple control-node dispatch scripts.

### 3. Rejected: Kubernetes + KubeVirt
- **Reason for Rejection**: Kubernetes violates the *Be Legit* principle in Hedgehog's environment. KubeVirt layers multiple control loops (CRDs, virt-handler, virt-launcher pods) on top of libvirt, adding 20–40 seconds to VM startup latency and introducing complex CNI flannel/calico routing that degrades RDMA RoCEv2 transport performance.

### 4. Rejected: Pure Bare-Metal
- **Reason for Rejection**: While bare-metal has zero virtualization overhead, it lacks hard memory fencing. If a distributed MoE worker crashes due to a CUDA memory corruption or PCIe bus error, a bare-metal host often requires a full node reboot (2–4 minutes on enterprise server IPMI/POST). With KVM/VFIO, the VM process can be killed and restarted in $<2$ seconds, resetting the P100 PCIe function cleanly without host reboot.

---

## Pinned Versions for Hedgehog Baseline

- **Linux Kernel**: $\ge 6.6$ LTS (Debian 12 / Alpine 3.20 base)
- **QEMU**: $\ge 8.2$
- **libvirt**: $\ge 10.0$
- **vfio-pci**: Built-in kernel module (`CONFIG_VFIO_PCI=y` or `m`)
- **iPXE**: $\ge 1.21.1$ (UEFI x86_64 build)
