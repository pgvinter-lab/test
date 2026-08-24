#!/usr/bin/env python3
"""Unit tests for Hedgehog Threat Model v0.1 and security controls."""

from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
HEDGEHOG_DIR = REPO_ROOT / "hedgehog"
SCRIPTS_DIR = HEDGEHOG_DIR / "scripts"
SEC_DIR = HEDGEHOG_DIR / "security" / "threat_model"
TM_PATH = SEC_DIR / "THREAT_MODEL_V0_1.md"
CTM_PATH = SEC_DIR / "control_test_matrix.md"
VALIDATE_SCRIPT = SCRIPTS_DIR / "validate_threat_model.py"


class TestThreatModelValidation(unittest.TestCase):
    def setUp(self):
        self.assertTrue(TM_PATH.is_file(), f"Missing {TM_PATH}")
        self.assertTrue(CTM_PATH.is_file(), f"Missing {CTM_PATH}")
        self.tm_content = TM_PATH.read_text(encoding="utf-8")
        self.ctm_content = CTM_PATH.read_text(encoding="utf-8")

    def test_threat_model_document_structure(self):
        required_headers = [
            "## Metadata & Control Record",
            "## 1. Executive Summary & System Scope",
            "## 2. Architecture & Data Flow Diagram",
            "## 3. Trust Boundaries",
            "## 4. Asset Inventory & Sensitivity Classification",
            "## 5. Threat Actors & Capabilities",
            "## 6. STRIDE Threat Analysis Across Trust Boundaries",
            "## 7. Security Controls & Mitigations Matrix",
            "## 8. SK Companies Private Tenant Workload Security Policies",
            "## 9. Failure, Recovery & Containment Protocols",
            "## 10. Residual Risks & Explicit Owner Acceptance Decisions",
            "## 11. Review & Verification Standards",
        ]
        for header in required_headers:
            self.assertIn(header, self.tm_content, f"Missing required header: {header}")

    def test_trust_boundaries_completeness(self):
        for i in range(1, 8):
            tb_id = f"TB-{i}"
            self.assertIn(f"**{tb_id}**", self.tm_content, f"Missing trust boundary {tb_id}")

    def test_stride_threat_coverage(self):
        for i in range(1, 19):
            thr_id = f"THR-{i:02d}"
            self.assertIn(f"**{thr_id}**", self.tm_content, f"Missing threat ID {thr_id}")

    def test_control_test_matrix_alignment(self):
        for i in range(1, 19):
            ctl_id = f"CTL-SEC-{i:02d}"
            self.assertIn(f"`{ctl_id}`", self.tm_content, f"Missing control {ctl_id} in threat model")
            self.assertIn(f"`{ctl_id}`", self.ctm_content, f"Missing control {ctl_id} in control test matrix")

    def test_private_workload_tier_coverage(self):
        self.assertIn("TIER A: STRONG COMMERCIAL CANDIDATES", self.tm_content)
        self.assertIn("TIER B: EXPLICIT CONTROLS REQUIRED", self.tm_content)
        self.assertIn("TIER C: ABSOLUTELY PROHIBITED", self.tm_content)
        self.assertIn("Family Media Digest", self.tm_content)
        self.assertIn("Private Legal Workbench", self.tm_content)
        self.assertIn("Internal Investigations", self.tm_content)

    def test_family_media_digest_boundary_rules(self):
        self.assertIn("FULL", self.tm_content)
        self.assertIn("PARTIAL", self.tm_content)
        self.assertIn("METADATA_ONLY", self.tm_content)
        self.assertIn("<5 minutes", self.tm_content)
        self.assertIn("zero raw data sent to commercial APIs", self.tm_content)

    def test_validation_script_cli_pass(self):
        cmd = [sys.executable, str(VALIDATE_SCRIPT)]
        res = subprocess.run(cmd, capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, f"Validator failed: {res.stderr}\n{res.stdout}")
        self.assertIn("Hedgehog threat model validation PASS", res.stdout)
class TestSecurityControlInvariants(unittest.TestCase):
    """Test architectural invariants corresponding to security controls."""

    def setUp(self):
        self.tm_content = TM_PATH.read_text(encoding="utf-8")

    def test_ipmi_mgmt_isolation(self):
        self.assertIn("CTL-SEC-01", self.tm_content)
        self.assertIn("Cipher 0 disabled", self.tm_content)

    def test_signed_boot_verification(self):
        self.assertIn("CTL-SEC-02", self.tm_content)
        self.assertIn("UEFI Secure Boot", self.tm_content)

    def test_vault_secrets_isolation(self):
        self.assertIn("CTL-SEC-03", self.tm_content)
        self.assertIn("HashiCorp Vault", self.tm_content)

    def test_stateless_tmpfs_invariants(self):
        self.assertIn("CTL-SEC-04", self.tm_content)
        self.assertIn("tmpfs", self.tm_content)

    def test_memory_zeroing_lifecycle(self):
        self.assertIn("CTL-SEC-05", self.tm_content)
        self.assertIn("init_on_free=1", self.tm_content)

    def test_watchdog_reset_protocol(self):
        self.assertIn("CTL-SEC-07", self.tm_content)
        self.assertIn("echo 1 > reset", self.tm_content)

    def test_ingress_token_auth_rate_limit(self):
        self.assertIn("CTL-SEC-10", self.tm_content)
        self.assertIn("Paseto/JWT", self.tm_content)

    def test_single_tenant_scheduling_invariants(self):
        self.assertIn("CTL-SEC-11", self.tm_content)
        self.assertIn("single-tenant VMs", self.tm_content)

    def test_ephemeral_frame_deletion_ttl(self):
        self.assertIn("CTL-SEC-13", self.tm_content)
        self.assertIn("<300 seconds", self.tm_content)

    def test_voice_consent_watermark_policy(self):
        self.assertIn("CTL-SEC-14", self.tm_content)
        self.assertIn("cryptographic watermarks", self.tm_content)

    def test_zero_knowledge_workspace_rules(self):
        self.assertIn("CTL-SEC-15", self.tm_content)
        self.assertIn("zero-knowledge", self.tm_content.lower())

    def test_append_only_audit_chaining(self):
        self.assertIn("CTL-SEC-16", self.tm_content)
        self.assertIn("hash chaining", self.tm_content)

    def test_hardware_fencing_stonith_protocol(self):
        self.assertIn("CTL-SEC-17", self.tm_content)
        self.assertIn("STONITH", self.tm_content)

    def test_guest_vm_egress_airgap_rules(self):
        self.assertIn("CTL-SEC-18", self.tm_content)
        self.assertIn("airgap", self.tm_content.lower())


if __name__ == "__main__":
    unittest.main()
