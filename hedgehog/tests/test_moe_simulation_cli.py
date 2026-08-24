#!/usr/bin/env python3
"""CLI Execution tests for Hedgehog MoE Validation and Benchmark Scripts."""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

HEDGEHOG_DIR = Path(__file__).resolve().parents[1]
VALIDATE_SCRIPT = HEDGEHOG_DIR / "scripts" / "validate_moe_simulation.py"
BENCHMARK_SCRIPT = HEDGEHOG_DIR / "scripts" / "run_moe_benchmarks.py"


class MoESimulationCliTests(unittest.TestCase):
    def test_validate_script_cli_pass(self):
        res = subprocess.run(
            [sys.executable, str(VALIDATE_SCRIPT), "--json"],
            capture_output=True,
            text=True,
            cwd=str(HEDGEHOG_DIR),
        )
        self.assertEqual(res.returncode, 0, f"validate_moe_simulation.py failed: {res.stderr}")
        data = json.loads(res.stdout)
        self.assertEqual(data["status"], "pass")
        self.assertEqual(len(data["checks"]), 6)
        for check in data["checks"]:
            self.assertEqual(check["outcome"], "pass")

    def test_benchmark_script_cli_pass(self):
        res = subprocess.run(
            [sys.executable, str(BENCHMARK_SCRIPT), "--json"],
            capture_output=True,
            text=True,
            cwd=str(HEDGEHOG_DIR),
        )
        self.assertEqual(res.returncode, 0, f"run_moe_benchmarks.py failed: {res.stderr}")
        data = json.loads(res.stdout)
        self.assertEqual(data["status"], "pass")
        self.assertGreater(len(data["benchmarks"]), 0)
        for b in data["benchmarks"]:
            self.assertIn("simulated_network_latency_us", b)
            self.assertIn("routing_time_us", b)


if __name__ == "__main__":
    unittest.main()
