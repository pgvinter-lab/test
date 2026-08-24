#!/usr/bin/env python3
"""Unit tests for Hedgehog Architecture Decision Records, Source Maps, and Validator."""

from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

HEDGEHOG_DIR = Path(__file__).resolve().parents[1]
ARCH_DIR = HEDGEHOG_DIR / "architecture"
ADR_0001 = ARCH_DIR / "ADR-0001-virtualized-diskless-100gb-fabric-cluster.md"
VIRT_MATRIX = ARCH_DIR / "source_maps" / "virtualization_stack_matrix.md"
TRANS_MATRIX = ARCH_DIR / "source_maps" / "transport_stack_matrix.md"
ASSUMP_REG = ARCH_DIR / "assumption_register.md"
VALIDATE_SCRIPT = HEDGEHOG_DIR / "scripts" / "validate_architecture.py"

sys.path.insert(0, str(HEDGEHOG_DIR))
from scripts.validate_architecture import (
    validate_adr_0001,
    validate_virtualization_matrix,
    validate_transport_matrix,
    validate_assumption_register,
    simulate_moe_transport_feasibility,
)


class ArchitectureValidationTests(unittest.TestCase):
    def test_adr_0001_file_exists_and_passes(self):
        self.assertTrue(ADR_0001.is_file(), "ADR-0001 markdown file must exist")
        errors = validate_adr_0001(ADR_0001)
        self.assertEqual(errors, [], f"ADR-0001 validation failed: {errors}")

    def test_adr_0001_explicit_failure_domains(self):
        content = ADR_0001.read_text(encoding="utf-8")
        expected_domains = [
            "Compute Node Domain",
            "GPU / VFIO Domain",
            "Inference Fabric Domain",
            "Storage / Control Domain",
            "Tenant Isolation Domain",
        ]
        for domain in expected_domains:
            self.assertIn(domain, content)

    def test_virtualization_matrix_passes(self):
        self.assertTrue(VIRT_MATRIX.is_file(), "Virtualization matrix file must exist")
        errors = validate_virtualization_matrix(VIRT_MATRIX)
        self.assertEqual(errors, [], f"Virtualization matrix validation failed: {errors}")

    def test_transport_matrix_passes(self):
        self.assertTrue(TRANS_MATRIX.is_file(), "Transport matrix file must exist")
        errors = validate_transport_matrix(TRANS_MATRIX)
        self.assertEqual(errors, [], f"Transport matrix validation failed: {errors}")

    def test_assumption_register_passes(self):
        self.assertTrue(ASSUMP_REG.is_file(), "Assumption register file must exist")
        errors = validate_assumption_register(ASSUMP_REG)
        self.assertEqual(errors, [], f"Assumption register validation failed: {errors}")

    def test_moe_transport_simulation_feasible(self):
        result = simulate_moe_transport_feasibility()
        self.assertTrue(result["transport_viable"])
        self.assertLess(result["transport_time_micros"], 1000.0)  # Under 1ms
        self.assertGreater(result["speedup_factor"], 100.0)  # >100x faster than streaming weights

    def test_validator_cli_execution(self):
        res = subprocess.run(
            [sys.executable, str(VALIDATE_SCRIPT)],
            capture_output=True,
            text=True,
            cwd=str(HEDGEHOG_DIR),
        )
        self.assertEqual(res.returncode, 0, f"Validator CLI exited with non-zero code: {res.stderr}")
        self.assertIn("Hedgehog architecture validation PASS", res.stdout)


if __name__ == "__main__":
    unittest.main()
