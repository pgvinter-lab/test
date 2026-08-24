# Hedgehog Security Control & Test Mapping Matrix v0.1

## Metadata

- **Document ID**: `CTRL-TEST-MATRIX-V0-1`
- **Threat Model Ref**: `security/threat_model/THREAT_MODEL_V0_1.md`
- **Date**: 2026-08-24
- **Status**: `Active`

---

## 1. Traceability Matrix

| Control ID | Control Name | Target Threats | Verification Type | Test Identifier / Target | Pass / Acceptance Criteria | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `CTL-SEC-01` | Isolated Management & IPMI Hardening | `THR-01, THR-02` | Automated Test / Gate | `tests/test_threat_model.py::test_ipmi_mgmt_isolation` | Passes VLAN & cipher 0 scan | `IMPLEMENTED` |
| `CTL-SEC-02` | Signed Immutable Boot Verification | `THR-03` | Automated Test / Gate | `tests/test_threat_model.py::test_signed_boot_verification` | Passes boot signature check | `IMPLEMENTED` |
| `CTL-SEC-03` | Centralized Vault Secrets Management | `THR-04, THR-05` | Automated Test / Gate | `tests/test_threat_model.py::test_vault_secrets_isolation` | Tokens ephemeral & scoped | `IMPLEMENTED` |
| `CTL-SEC-04` | Stateless tmpfs & Minimal Hypervisor | `THR-05, THR-06` | Automated Test / Gate | `tests/test_threat_model.py::test_stateless_tmpfs_invariants` | Zero persistent local disks | `IMPLEMENTED` |
| `CTL-SEC-05` | Mandatory Memory Zeroing & Page Scrubbing | `THR-06, THR-13` | Automated Test / Gate | `tests/test_threat_model.py::test_memory_zeroing_lifecycle` | Hugepages scrubbed post-VM | `IMPLEMENTED` |
| `CTL-SEC-06` | Hardware VFIO / IOMMU DMA Isolation | `THR-07` | Automated Test / Gate | `tests/test_architecture.py::test_vfio_isolation_model` | IOMMU groups isolated | `IMPLEMENTED` |
| `CTL-SEC-07` | Automated Watchdog & VFIO Device Reset | `THR-08` | Automated Test / Gate | `tests/test_threat_model.py::test_watchdog_reset_protocol` | Device reset in <30s | `IMPLEMENTED` |
| `CTL-SEC-08` | Isolated 100Gb RDMA Fabric Protection | `THR-09` | Automated Test / Gate | `tests/test_architecture.py::test_transport_matrix_structure` | Private RDMA Protection Domains | `IMPLEMENTED` |
| `CTL-SEC-09` | PFC Watchdog & Flow Control Backpressure | `THR-10` | Automated Test / Gate | `tests/test_architecture.py::test_moe_transport_feasibility_logic` | Queue bound & watchdog active | `IMPLEMENTED` |
| `CTL-SEC-10` | Ingress mTLS, Token Auth & Rate Limiting | `THR-11, THR-12` | Automated Test / Gate | `tests/test_threat_model.py::test_ingress_token_auth_rate_limit` | Validates mTLS & rate limiting | `IMPLEMENTED` |
| `CTL-SEC-11` | Single-Tenant Ephemeral VM Scheduling | `THR-13` | Automated Test / Gate | `tests/test_threat_model.py::test_single_tenant_scheduling_invariants` | 1:1 socket & ephemeral VM | `IMPLEMENTED` |
| `CTL-SEC-12` | On-Device Data Minimization & Local Processing | `THR-14` | Automated Test / Gate | `tests/test_threat_model.py::test_family_media_digest_boundary_rules` | Local-only MoE & tokenization | `IMPLEMENTED` |
| `CTL-SEC-13` | Immediate Ephemeral Frame Deletion (<5 Min TTL) | `THR-14, THR-15` | Automated Test / Gate | `tests/test_threat_model.py::test_ephemeral_frame_deletion_ttl` | TTL <300s & explicit coverage | `IMPLEMENTED` |
| `CTL-SEC-14` | Voice Consent Registry & Cryptographic Watermarking | `THR-16` | Automated Test / Gate | `tests/test_threat_model.py::test_voice_consent_watermark_policy` | Consent token & watermark required | `IMPLEMENTED` |
| `CTL-SEC-15` | Zero-Knowledge Tenant Workspace Encryption | `THR-17` | Automated Test / Gate | `tests/test_threat_model.py::test_zero_knowledge_workspace_rules` | Client encrypted & volatile RAM | `IMPLEMENTED` |
| `CTL-SEC-16` | Append-Only Hash-Chained Audit Logging | `THR-18` | Automated Test / Gate | `tests/test_threat_model.py::test_append_only_audit_chaining` | SHA-256 hash chain valid | `IMPLEMENTED` |
| `CTL-SEC-17` | Hardware Fencing & Automated N+1 Node Replacement | `THR-02, THR-08` | Automated Test / Gate | `tests/test_threat_model.py::test_hardware_fencing_stonith_protocol` | Failover within 60s | `IMPLEMENTED` |
| `CTL-SEC-18` | Strict Guest VM Egress Airgap | `THR-14` | Automated Test / Gate | `tests/test_threat_model.py::test_guest_vm_egress_airgap_rules` | Outbound internet dropped | `IMPLEMENTED` |

---

## 2. Verification Gate Alignment

- `gate-hardware-p100`: Validates physical VFIO GPU isolation and hardware watchdog resets on physical Tesla P100.
- `gate-hardware-fabric`: Validates 100GbE / RoCEv2 PFC watchdog and memory key protection on ConnectX-4 switches.
- `gate-hardware-boot`: Validates iPXE signed UEFI boot and immutable tmpfs initialization on bare-metal hosts.
- `test-account-required`: Validates on-device Android data minimization and notification ingestion using authorized synthetic test accounts only.
- `authorized-target-only`: Validates security fault containment tests on owned and simulated test fixtures.

---
