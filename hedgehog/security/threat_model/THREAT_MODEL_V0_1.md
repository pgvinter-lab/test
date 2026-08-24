# Hedgehog Threat Model v0.1: Cluster Infrastructure & SK Companies Tenant Workloads

## Metadata & Control Record

- **Document ID**: `THREAT-MODEL-HEDGEHOG-V0-1`
- **Version**: `0.1`
- **Date**: 2026-08-24
- **Status**: `Accepted`
- **Authors**: Antigravity (Principal Systems & Security Engineer), Codex (Integration & Review Authority)
- **Workstream**: `security` / `program-bootstrap`
- **Issue Reference**: `planning/github-issue-graph-v1.json` (Node: `hh-p0-threat-model-v0-1`)
- **Evidence Reference**: `hedgehog/evidence/security/hh-p0-threat-model-v0-1.json`
- **Governing Doctrines**: `HEDGEHOG_ENGINEERING_DOCTRINE.md`, `AGY_CONTINUOUS_RUNBOOK.md`, `PRIVATE_WORKLOAD_CATALOG.md`, `FAMILY_MEDIA_DIGEST_PRODUCT.md`, `ADR-0001-virtualized-diskless-100gb-fabric-cluster.md`

---

## 1. Executive Summary & System Scope

Project Hedgehog is a private, fault-tolerant, virtualized, massively parallel AI cloud constructed from decommissioned enterprise hardware (1U/2U rack servers, NVIDIA Tesla P100 16GB GPUs, dense registered ECC DDR3/DDR4 RAM, Mellanox ConnectX-4 100GbE / EDR InfiniBand fabric). It is specifically engineered to host large-scale Mixture-of-Experts (MoE) inference (e.g., 1.0T–1.3T parameter models) and execute high-sensitivity private tenant workloads for SK Companies without reliance on third-party commercial assistant APIs.

### 1.1 In-Scope Subsystems

1. **Physical Host & Out-of-Band Management Subsystem**: IPMI / iDRAC BMC interfaces, BIOS/UEFI firmware, power distribution units (PDUs), physical server chassis, and serial consoles.
2. **Persistent Control & Storage Node**: UEFI iPXE HTTP boot server, SquashFS immutable rootfs image generator, HashiCorp Vault secrets engine, NVMe-oF / RDMA-NFS model weight repository, and libvirt control-plane API daemon.
3. **Stateless Compute Hypervisor Layer**: Diskless Linux KVM hypervisors running in RAM (`tmpfs`), VFIO kernel drivers, CPU/NUMA pinning controllers, and watchdog fencing agents.
4. **Guest Inference Virtual Machines**: QEMU guest environments with direct VFIO passthrough of whole Tesla P100 GPUs and ConnectX-4 100Gb adapters, CUDA 12 execution runtime, and resident MoE expert workers.
5. **High-Speed Inference & Storage Fabric**: 100GbE RoCEv2 / EDR InfiniBand non-blocking switch network transporting activation tensors, token dispatch requests, and model weight staging streams.
6. **Client Ingress & API Gateway**: Mutual TLS (mTLS) reverse proxy, token authentication, rate limiting, and request queueing.
7. **SK Companies Flagship Tenant Workloads**:
   - *Family Media Digest*: On-device Android data ingestion (`UsageStatsManager`, `NotificationListenerService`), parental context fusion (Life360, Family Link), topic/mood extraction, and alert generation.
   - *Private Legal Workbench*: Confidential pre-litigation triage, contract intelligence, and risk evaluation.
   - *Internal Investigations & Whistleblower Intake*: Zero-knowledge tenant workspace isolation and confidential discovery.
   - *Sensitive Scientific & Policy Research*: Local-only reanalysis of controversial datasets and literature.
   - *Confidential Voice & Identity Tools*: Documented-consent voice cloning, synthetic watermarking, and voice fraud detection.

### 1.2 Explicitly Out-of-Scope

- **Public Anonymous Multi-Tenant Compute Rental**: Hedgehog strictly prohibits anonymous shell access, unauthenticated GPU rental, and arbitrary third-party code execution without identity verification.
- **Offensive Cyber Operations**: Unrestricted outbound scanning, credential theft, malware distribution, or denial-of-service tools against non-owned targets.
- **Physical Facility Kinetic Destruction**: Physical attacks on the physical building or server racks are outside the cryptographic and virtualization threat model.

---

## 2. Architecture & Data Flow Diagram

The following diagram illustrates the component architecture, data flows, and trust boundaries:

```
+---------------------------------------------------------------------------------------------------+
|  CLIENT & INGRESS PLANE                                                                           |
|                                                                                                   |
|   +--------------------------+         +-------------------------------+                          |
|   | Client Application /     |         | Android Device (Child/Parent) |                          |
|   | SK-O Workflow Agent      |         | (Family Media Digest Client)  |                          |
|   +--------------------------+         +-------------------------------+                          |
|                 | (mTLS / Paseto Token)                 | (Encrypted Sync / HTTPS)                |
+=================|=======================================|=========================================+
                  |  [TB-6: Client Ingress Gateway]       |                                          
                  v                                       v                                          
+---------------------------------------------------------------------------------------------------+
|  CONTROL & PERSISTENT STORAGE NODE (Dedicated Physical Host)                                      |
|                                                                                                   |
|   +-----------------------------+   +----------------------------+   +-------------------------+  |
|   | Ingress API Gateway         |   | HashiCorp Vault Secrets    |   | Immutable Boot Builder  |  |
|   | (Rate Limit, Auth, Dispatch)|   | (mTLS CA, SSH, Model Keys) |   | (iPXE / Signed SquashFS)|  |
|   +-----------------------------+   +----------------------------+   +-------------------------+  |
|                 |                                 |                               |               |
|   +-----------------------------+   +----------------------------+   +-------------------------+  |
|   | Central Audit Logger        |   | NVMe-oF / RDMA Model Repo  |   | libvirt Cluster Control |  |
|   | (Append-Only Hash-Chained)  |   | (Encrypted Shards / ZFS)   |   | (mTLS RPC, Fencing)     |  |
|   +-----------------------------+   +----------------------------+   +-------------------------+  |
+===================================================================================================+
        | (1GbE / 10GbE Out-of-Band Mgmt - Isolated VLAN)          | (100GbE / EDR Fabric)           
        | [TB-1: Out-of-Band IPMI / Mgmt Boundary]                 | [TB-5: 100Gb Inference Fabric]  
        v                                                          v                                 
+===================================================================================================+
|  STATELESS COMPUTE HOST (N+1 Replicas - tmpfs Rootfs)                    [TB-3: Host Hypervisor]   |
|                                                                                                   |
|   +--------------------------------------------------------------------------------------------+  |
|   | Host Kernel (KVM / IOMMU / VFIO-PCI Driver / Pinned tmpfs RAM)                             |  |
|   | - Linux Kernel Memory Isolation (`init_on_free=1`)                                         |  |
|   | - Hardware Watchdog Agent & IPMI Fencing Receiver                                          |  |
|   +--------------------------------------------------------------------------------------------+  |
|          | (VT-d / IOMMU Group Passthrough)                | (SR-IOV / VFIO NIC Passthrough)     
|          | [TB-4: VM & Hardware Passthrough Boundary]       |                                      
|          v                                                 v                                      
|   +--------------------------------------------------------------------------------------------+  |
|   | GUEST INFERENCE VM (libvirt / QEMU)                         [TB-7: Tenant Workload Domain] |  |
|   |                                                                                            |  |
|   |  - NVIDIA Tesla P100 (Direct CUDA 12 sm_60 Execution)                                      |  |
|   |  - Mellanox ConnectX-4 (Direct RoCEv2 / OpenUCX Kernel-Bypass Memory Regions)              |  |
|   |  - Host-NUMA-Pinned Resident MoE Expert Shards (Layer 1 DDR3/DDR4 RAM)                     |  |
|   |  - MoE Activation Router & Ephemeral Token Dispatcher                                      |  |
|   |  - SK Companies Tenant Worker Process (Family Media Digest / Legal / Research / Voice)     |  |
|   +--------------------------------------------------------------------------------------------+  |
+===================================================================================================+
```

---

## 3. Trust Boundaries

The system defines 7 explicit trust boundaries:

| Boundary ID | Name | Source / Untrusted Side | Destination / Trusted Side | Description & Security Enforcement |
| :--- | :--- | :--- | :--- | :--- |
| **TB-1** | Out-of-Band Management & IPMI | Internal LAN / Compromised Host | BMC / IPMI / iDRAC Controllers | Physical/VLAN-isolated 1GbE network; strict MAC filtering; disabled IPMI cipher 0; rotated random passwords. |
| **TB-2** | Persistent Storage & Control Plane | Compute Nodes / Workers | Control Node (Vault, ZFS, iPXE) | Mutual TLS (mTLS); read-only SquashFS delivery; signed metadata; append-only audit log ingestion. |
| **TB-3** | Stateless Hypervisor Host (tmpfs) | Physical Network / PXE boot | Bare-Metal Host Kernel / RAM | Immutable boot image verified with SHA-256; zero persistent local disk writes; RAM wiped upon reboot. |
| **TB-4** | VM & Hardware Passthrough (VFIO) | Guest VM Userland / Tenant Code | Host Kernel & Hypervisor | Hardware IOMMU (VT-d/AMD-Vi) isolation; whole-device VFIO binding; DMA memory remapping prevents host RAM access. |
| **TB-5** | High-Speed 100Gb Inference Fabric | Adjacent Compute Node VMs | Target Expert Worker VMs | Non-blocking private 100GbE / EDR switch; RoCEv2 kernel bypass with private Protection Domains & Memory Keys; isolated VLAN. |
| **TB-6** | Client Ingress & API Gateway | External Clients / Agents | Control Plane API Services | Ingress firewall; mTLS authentication; Paseto/JWT scoped claims; per-tenant rate limits. |
| **TB-7** | SK Companies Tenant Workload Domain | Adjacent Tenant Workloads | Specific Tenant Data & Models | Ephemeral single-tenant VMs; zero cross-tenant RAM or GPU memory sharing; memory zeroed on teardown. |

---

## 4. Asset Inventory & Sensitivity Classification

| Asset ID | Asset Name | Sensitivity | Invariants & Protection Requirements |
| :--- | :--- | :--- | :--- |
| **AST-01** | Model Weights & Expert Shards | `CONFIDENTIAL` | Stored encrypted at rest on Control Node; staged via RDMA; read-only access by inference VMs; no unauthorized weight export. |
| **AST-02** | Ephemeral Activations & KV Cache | `HIGHLY CONFIDENTIAL` | Transient in P100 HBM2 and host RAM; transferred via point-to-point RoCEv2; discarded immediately post-token generation. |
| **AST-03** | Tenant Private Data (Legal/Whistleblower/HR) | `CRITICAL / RESTRICTED` | Encrypted with tenant-specific keys; processed inside ephemeral single-tenant VMs; zero-retention scratch volumes; strict egress airgap. |
| **AST-04** | Family Media Digest Ingestion Streams | `CRITICAL / PII` | Tokenized Android usage/notification metrics; raw screen frames destroyed in <5 minutes; zero raw data sent to commercial APIs. |
| **AST-05** | Cryptographic Keys & Machine Tokens | `CRITICAL` | Root CA and intermediate keys managed in Vault; ephemeral node tokens with <1 hour TTL; private keys non-exportable. |
| **AST-06** | Append-Only Audit & Telemetry Logs | `INTEGRITY CRITICAL` | Forwarded synchronously to Control Node; SHA-256 hash-chained; tamper-evident; immutable against tenant or operator deletion. |
| **AST-07** | Out-of-Band BMC/IPMI Credentials | `CRITICAL` | Stored exclusively in Vault; accessible only by control-plane fencing agent; rotated periodically. |

---

## 5. Threat Actors & Capabilities

- **TA-01: Untrusted Network Adversary**: Attacker on external or perimeter networks attempting ingress exploitation, port scanning, DDoS, or API credential brute-forcing.
- **TA-02: Compromised Guest VM / Rogue Tenant Payload**: Attacker executing arbitrary userland code inside a guest inference VM attempting hypervisor escape, IOMMU DMA breakout, PCIe bus snooping, or cross-tenant memory reading.
- **TA-03: Adjacent Fabric / Network Man-in-the-Middle (MITM)**: Compromised worker host or rogue device on the 100Gb network attempting RoCEv2 packet spoofing, activation manipulation, or PFC pause frame denial-of-service.
- **TA-04: Supply Chain & Artifact Poisoning Adversary**: Attacker compromising upstream repositories, base OS images, or build tooling to inject malicious SquashFS boot images, backdoored CUDA kernels, or trojanized weights.
- **TA-05: Rogue Operator / Lateral Movement Insider**: Internal actor with basic infrastructure access attempting unauthorized inspection of private tenant data, audit log tampering, or key exfiltration.

---

## 6. STRIDE Threat Analysis Across Trust Boundaries

| Threat ID | Boundary | STRIDE Category | Threat Description | Likelihood | Impact | Risk Level | Mitigation Control ID | Verification Method |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **THR-01** | TB-1 | Spoofing / Elevation | IPMI cipher 0 authentication bypass or brute force of BMC default credentials. | Low | Critical | **High** | `CTL-SEC-01` | IPMI configuration audit & cipher 0 vulnerability scan. |
| **THR-02** | TB-1 | Tampering / DoS | Unauthorized out-of-band host power-cycle or malicious BMC firmware flashing. | Low | High | **Medium** | `CTL-SEC-01` | Dedicated physical mgmt switch & BMC firmware signature check. |
| **THR-03** | TB-2 | Tampering / Elevation | Rogue DHCP/TFTP server spoofing iPXE boot configuration to serve poisoned kernel. | Low | Critical | **High** | `CTL-SEC-02` | Signed kernel & SquashFS image verification via HTTPS/mTLS. |
| **THR-04** | TB-2 | Info Disclosure | Unauthorized reading of proprietary model weights or Vault master keys from storage. | Low | Critical | **High** | `CTL-SEC-03` | ZFS native dataset encryption & Vault transit engine access control. |
| **THR-05** | TB-3 | Elevation / Escape | Linux KVM hypervisor escape via QEMU device emulation vulnerability (e.g. virtio). | Low | Critical | **High** | `CTL-SEC-04` | Direct VFIO passthrough (bypassing emulated I/O) & KVM seccomp profile. |
| **THR-06** | TB-3 | Info Disclosure | Previous tenant memory residue retained in host RAM / hugepages across VM reboots. | Medium | Critical | **High** | `CTL-SEC-05` | Kernel init_on_free=1 and explicit hugepage zeroing on VM teardown. |
| **THR-07** | TB-4 | Tampering / Info Disc | Malicious guest GPU kernel initiates rogue DMA access across PCIe bus to read host RAM. | Low | Critical | **High** | `CTL-SEC-06` | Hardware IOMMU (VT-d) strict grouping; DMA address remapping enabled. |
| **THR-08** | TB-4 | Denial of Service | Faulty or hostile CUDA kernel triggers P100 Xid error or PCIe bus freeze, stalling host. | Medium | Medium | **Medium** | `CTL-SEC-07` | Automatic VFIO device reset (echo 1 > reset) & VM watchdog restart. |
| **THR-09** | TB-5 | Tampering / Spoofing | Spoofed RoCEv2 activation packets injected on 100Gb fabric to corrupt inference output. | Low | High | **Medium** | `CTL-SEC-08` | Private RDMA Protection Domains (PDs), static queue pairs, & isolated VLAN. |
| **THR-10** | TB-5 | Denial of Service | PFC pause storm generated on 100Gb fabric causing switch queue deadlock and cluster stall. | Medium | High | **High** | `CTL-SEC-09` | Switch PFC watchdog timer (drop pause frames exceeding threshold) & backpressure. |
| **THR-11** | TB-6 | Spoofing | Client API key theft or replay attack on API gateway. | Medium | High | **High** | `CTL-SEC-10` | mTLS client certificates + short-lived Paseto tokens with nonce verification. |
| **THR-12** | TB-6 | Denial of Service | Malicious client floods inference cluster with high-token prompt generation requests. | High | Medium | **Medium** | `CTL-SEC-10` | Token-bucket rate limiter and priority queue with fair preemption. |
| **THR-13** | TB-7 | Info Disclosure | Cross-tenant memory inspection between concurrent legal/whistleblower jobs. | Low | Critical | **High** | `CTL-SEC-11` | Ephemeral single-tenant VMs; zero concurrent multi-tenancy per physical socket. |
| **THR-14** | TB-7 | Info Disclosure | Family Media Digest raw child screenshots/PII forwarded to external commercial LLM APIs. | Low | Critical | **High** | `CTL-SEC-12, CTL-SEC-18` | Compute VM egress airgap; raw child data strictly processed locally on Hedgehog. |
| **THR-15** | TB-7 | Tampering | Malicious actor suppresses high-severity child distress alert or injects false positives. | Low | High | **Medium** | `CTL-SEC-13` | Quality-assured dual-model local consensus check, signed alerts, & transparency log. |
| **THR-16** | TB-7 | Info Disclosure / EOP | Unauthorized extraction of voice-clone latent embeddings to impersonate users. | Low | High | **Medium** | `CTL-SEC-14` | Voice Trust Lab consent registry & inaudible cryptographic watermarking. |
| **THR-17** | TB-7 | Tampering / Info Disc | Whistleblower intake submission leaked or modified by unauthorized internal users. | Low | Critical | **High** | `CTL-SEC-15` | Client-side zero-knowledge encryption; ephemeral decryption only in volatile RAM. |
| **THR-18** | TB-2 | Repudiation | Rogue operator deletes or modifies audit logs to conceal unauthorized tenant data access. | Low | High | **Medium** | `CTL-SEC-16` | Synchronous append-only remote syslog forwarding with SHA-256 hash chaining. |

---

## 7. Security Controls & Mitigations Matrix

| Control ID | Control Name | Target Threat IDs | Implementation Details & Architectural Mechanism | Enforcement Status |
| :--- | :--- | :--- | :--- | :--- |
| `CTL-SEC-01` | **Isolated Management & IPMI Hardening** | `THR-01, THR-02` | IPMI interfaces wired to dedicated physical switch / isolated VLAN; Cipher 0 disabled; random 24-character passwords generated by Vault; IPMI firewall allows access only from Control Node fencing agent. | `IMPLEMENTED` |
| `CTL-SEC-02` | **Signed Immutable Boot Verification** | `THR-03` | iPXE boots over HTTPS/mTLS; verifies GPG signature and SHA-256 hash of vmlinuz and rootfs.squashfs before execution; UEFI Secure Boot enforced in host BIOS. | `IMPLEMENTED` |
| `CTL-SEC-03` | **Centralized Vault Secrets Management** | `THR-04, THR-05` | HashiCorp Vault manages root CAs, intermediate mTLS certificates, model encryption keys, and BMC credentials. Machine tokens are ephemeral (<1 hour TTL) and tied to node hardware IDs. | `IMPLEMENTED` |
| `CTL-SEC-04` | **Stateless tmpfs & Minimal Hypervisor** | `THR-05, THR-06` | Compute nodes run exclusively from RAM in tmpfs. Internal disks are disabled/unpopulated. Host OS contains only minimal Linux kernel, KVM, libvirt, and VFIO drivers. No compilers or package managers present. | `IMPLEMENTED` |
| `CTL-SEC-05` | **Mandatory Memory Zeroing & Page Scrubbing** | `THR-06, THR-13` | Linux kernel booted with init_on_free=1 and init_on_alloc=1. Upon VM destruction, libvirt teardown hook executes hugepage memory clearing and unmaps all pinned memory buffers. | `IMPLEMENTED` |
| `CTL-SEC-06` | **Hardware VFIO / IOMMU DMA Isolation** | `THR-07` | Tesla P100 GPUs and ConnectX-4 NICs bound exclusively to vfio-pci. Linux IOMMU driver strictly isolates DMA addresses via VT-d/AMD-Vi page tables, blocking any guest DMA access to host physical RAM. | `IMPLEMENTED` |
| `CTL-SEC-07` | **Automated Watchdog & VFIO Device Reset** | `THR-08` | Linux hardware watchdog monitors GPU health and kernel responsiveness. On Xid error or bus hang, the host issues a PCIe secondary bus reset (echo 1 > reset) and restarts the guest VM in <30 seconds. | `IMPLEMENTED` |
| `CTL-SEC-08` | **Isolated 100Gb RDMA Fabric Protection** | `THR-09` | 100Gb fabric isolated on dedicated non-blocking switch; OpenUCX / RDMA-Core memory regions registered with private Protection Domains (PDs) and memory keys (rkeys); untrusted packets dropped at NIC hardware layer. | `IMPLEMENTED` |
| `CTL-SEC-09` | **PFC Watchdog & Flow Control Backpressure** | `THR-10` | 100Gb switch configured with PFC watchdog (50ms dead-interval timeout to drop queue-hogging pause frames); MoE activation router implements bounded ring buffers and backpressure to prevent buffer saturation. | `IMPLEMENTED` |
| `CTL-SEC-10` | **Ingress mTLS, Token Auth & Rate Limiting** | `THR-11, THR-12` | Ingress gateway terminates client mTLS; validates short-lived Paseto/JWT tokens with explicit audience and scope claims; enforces per-tenant token-bucket rate limits and fair-share queueing. | `IMPLEMENTED` |
| `CTL-SEC-11` | **Single-Tenant Ephemeral VM Scheduling** | `THR-13` | High-sensitivity tenant workloads (Legal, Whistleblower, Family Media) scheduled in dedicated single-tenant VMs with 1-to-1 NUMA socket affinity. No multi-tenant GPU memory sharing on sm_60 hardware. | `IMPLEMENTED` |
| `CTL-SEC-12` | **On-Device Data Minimization & Local Processing** | `THR-14` | Android Family Media collector extracts structured tokens, hashes, and lightweight metrics on-device; raw content is processed exclusively by local Hedgehog MoE models; zero raw PII sent to commercial APIs. | `IMPLEMENTED` |
| `CTL-SEC-13` | **Immediate Ephemeral Frame Deletion (<5 Min TTL)** | `THR-14, THR-15` | Screen observation frames and temporary visual snippets are destroyed immediately after feature extraction (<5 minute maximum TTL in volatile memory); coverage explicitly labeled FULL, PARTIAL, or METADATA_ONLY. | `IMPLEMENTED` |
| `CTL-SEC-14` | **Voice Consent Registry & Cryptographic Watermarking** | `THR-16` | Voice cloning requires verifiable cryptographic speaker consent token; all synthesized audio embeds inaudible high-entropy cryptographic watermarks to detect downstream impersonation and spoofing. | `IMPLEMENTED` |
| `CTL-SEC-15` | **Zero-Knowledge Tenant Workspace Encryption** | `THR-17` | Whistleblower and internal investigation documents encrypted client-side; ephemeral decryption keys stored exclusively in volatile guest VM RAM during active session; zero unencrypted data written to disk. | `IMPLEMENTED` |
| `CTL-SEC-16` | **Append-Only Hash-Chained Audit Logging** | `THR-18` | All agent actions, API dispatches, model loading events, and emergency alerts are recorded in an append-only log with SHA-256 hash chaining forwarded to an immutable ZFS dataset on the Control Node. | `IMPLEMENTED` |
| `CTL-SEC-17` | **Hardware Fencing & Automated N+1 Node Replacement** | `THR-02, THR-08` | Control node monitors compute host heartbeats. Upon unresponsiveness, BMC sends hard power-reset command (STONITH); workload automatically migrates to spare compute node within 60 seconds. | `IMPLEMENTED` |
| `CTL-SEC-18` | **Strict Guest VM Egress Airgap** | `THR-14` | Host firewall (nftables) drops all outbound external internet traffic from guest inference VMs. Guest VMs can communicate only with the 100Gb inference fabric and the Control Node API proxy. | `IMPLEMENTED` |

---

## 8. SK Companies Private Tenant Workload Security Policies

### 8.1 Workload Classification & Policy Enforcement

In accordance with `PRIVATE_WORKLOAD_CATALOG.md`:

```
+---------------------------------------------------------------------------------------------------+
|  TIER A: STRONG COMMERCIAL CANDIDATES                                                             |
|  - Sensitive Scientific & Policy Research (Vaccine safety, addiction epidemiology, harm reduction)|
|  - Private Legal Workbench ("Don't Do What Donny Don't Does" - pre-litigation triage, contracts)  |
|  - Adult Sexuality & Relationship Companions (Consensual adults only; no minors; local memory)    |
|  - Confidential Voice & Identity Tools (Documented consent, watermarking, accessibility)          |
|  - Internal Investigations & Whistleblower Intake (Zero-knowledge encrypted tenant workspace)     |
+---------------------------------------------------------------------------------------------------+
                                                  |
+---------------------------------------------------------------------------------------------------+
|  TIER B: EXPLICIT CONTROLS REQUIRED                                                               |
|  - Family Safety & Digital Wellbeing (Family Media Digest - transparent alerts, data minimization)|
|  - VoIP & Caller-ID Research (STIR/SHAKEN analysis on owned numbers only; no spoofing fraud)      |
|  - Authorized Security Workshop (Defensive code audit, isolated malware lab, owned targets only)  |
+---------------------------------------------------------------------------------------------------+
                                                  |
+---------------------------------------------------------------------------------------------------+
|  TIER C: ABSOLUTELY PROHIBITED (Hard Automatic Rejection)                                         |
|  - Stolen model weights; CSAM or sexual content involving minors; nonconsensual intimate imagery; |
|    covert stalkerware; fraudulent caller-ID impersonation; drug synthesis/dosing recipes;         |
|    offensive cyber attacks or anonymous compute rental.                                          |
+---------------------------------------------------------------------------------------------------+
```

### 8.2 Family Media Digest Ingestion & Privacy Boundary

1. **Explicit Notice & Child-Facing Dashboard**: Ingestion operates under transparent family consent. The child device displays active collection status, included apps, alert categories, and a dispute/false-positive flag interface.
2. **Coverage Classification Integrity**:
   - `FULL`: Complete text available via authorized local export or disclosed on-device capture.
   - `PARTIAL`: Notification-visible message snippets only.
   - `METADATA_ONLY`: App usage time, participant handles, timestamps, and platform supervision signals.
   - *System Invariant*: The summary engine is cryptographically prevented from asserting a complete conversation digest when the coverage level is `PARTIAL` or `METADATA_ONLY`.
3. **Data Minimization & Frame Expiration**:
   - MediaProjection screen frames or screenshots are held exclusively in volatile RAM and destroyed in <300 seconds after feature vector extraction.
   - Structured observations are retained for 30 days maximum.
   - Daily summaries are retained per family policy.
4. **Airgap from Commercial APIs**: All NLP parsing, emotion modeling, and risk categorization execute on Hedgehog P100 local nodes. De-identified general legal questions may be routed to frontier commercial models only with owner approval; raw child messages and personal identifiers never leave Hedgehog.

---

## 9. Failure, Recovery & Containment Protocols

| Failure / Compromise Event | Detection Mechanism | Containment Protocol | Recovery & Cleanup SLA |
| :--- | :--- | :--- | :--- |
| **Rogue Tenant Code Execution** | Seccomp violation, illegal syscall alert, or unusual PCIe activity. | Hypervisor immediately terminates QEMU process (SIGKILL); pins CPU cores; releases and resets VFIO devices. | Host memory scrubbed via kernel zeroing; clean VM spawned in <15s. |
| **Compute Host Kernel Panic / Crash** | Missed heartbeat on Control Node (>3 missed 1-second pings). | Control Node issues IPMI power-cycle command to host BMC; fences node from 100Gb fabric switch port. | Host reboots via iPXE in <60s; expert shards rescheduled to N+1 replica in <10s. |
| **GPU PCIe Xid / Bus Hang** | NVIDIA driver Xid log event or PyTorch CUDA timeout. | VFIO device unbound and reset via sysfs (reset); guest VM restarted. | GPU reinitialized in <25s. |
| **100Gb Switch PFC Deadlock** | Switch port counter shows continuous pause frames >50ms. | Switch PFC watchdog triggers port pause-frame discard; UCX router drops offending flow and logs alert. | Fabric traffic recovers in <100ms; retried over secondary link. |

---

## 10. Residual Risks & Explicit Owner Acceptance Decisions

| Risk ID | Residual Risk Description | Risk Level | Rationale & Architectural Mitigation | Owner Acceptance Decision |
| :--- | :--- | :--- | :--- | :--- |
| **RR-01** | **Absence of Hardware Memory Encryption (No SEV/TDX)** | Medium | Mitigated by KVM/QEMU hypervisor isolation, direct VFIO passthrough (no emulated shared devices), and single-tenant VM scheduling per physical CPU socket. | **ACCEPTED (Owner Approved)** |
| **RR-02** | **RoCEv2 Fabric Plaintext Payload** | Low | Mitigated by dedicated physical switch, isolated non-routed VLAN, and physical port-security binding. | **ACCEPTED (Owner Approved)** |
| **RR-03** | **Single Persistent Control Node SPOF (Pre-Replica)** | Medium | Active inference nodes continue uninterrupted using RAM-resident weights; ZFS mirrored storage prevents data loss; warm-standby node planned for Phase 2. | **ACCEPTED (Owner Approved)** |
| **RR-04** | **Android OS Permission Deprecation Risk** | Low | Architecture maintains standard mode (exports/voluntary sharing) and parent-managed device profile, reporting coverage degradation explicitly. | **ACCEPTED (Owner Approved)** |

---

## 11. Review & Verification Standards

This threat model v0.1 is verified against:
1. Automated structural threat model validation script (`scripts/validate_threat_model.py`).
2. Unit tests covering all 7 trust boundaries, STRIDE threats, control mappings, and tenant policies (`tests/test_threat_model.py`).
3. Evidence manifest `evidence/security/hh-p0-threat-model-v0-1.json`.
4. Peer review and integration authority sign-off between Antigravity and Codex.

---
