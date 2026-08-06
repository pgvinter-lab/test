# Hedgehog Engineering Queue

## P0 — Program bootstrap

- [ ] Convert the 60-day doctrine into a dependency-ordered GitHub issue graph.
- [ ] Produce ADR-0001: virtualized diskless compute nodes, one persistent storage/control node, whole-GPU passthrough, and 100GbE/EDR fabric.
- [ ] Produce Threat Model v0.1 for the cluster and SK Companies tenant workloads.
- [ ] Create evidence directory conventions and machine-readable result schema.
- [ ] Establish CI that rejects unsupported completion claims and missing evidence links.

## P1 — Existing-work inventory

- [ ] Map llama.cpp/GGML CUDA, RPC, MoE, CPU offload, and device-limit capabilities.
- [ ] Map UCX, MPI, RDMA-Core, RoCEv2, and InfiniBand options for P100-era systems.
- [ ] Map KVM/libvirt/OpenNebula or minimal alternative for stateless hypervisors.
- [ ] Identify P100/Pascal limitations in current inference stacks and CUDA versions.
- [ ] Identify existing expert-parallel implementations that can be adapted.

## P1 — Simulation and test harnesses

- [ ] Build static expert-ownership simulation.
- [ ] Build activation-routing transport benchmark.
- [ ] Build topology fixture parser for NUMA, PCIe, GPUs, NICs, and memory channels.
- [ ] Define numerical reference tests for distributed MoE execution.
- [ ] Define failure-injection tests for worker, NIC, VM, and expert loss.

## P2 — Hardware arrival readiness

- [ ] Create one-command hardware inventory collector.
- [ ] Create one-, two-, and four-P100 acceptance test plans.
- [ ] Create CUDA 12/Pascal reproducible environment.
- [ ] Create PXE/iPXE immutable hypervisor prototype.
- [ ] Create VFIO whole-GPU and whole-NIC passthrough automation.
