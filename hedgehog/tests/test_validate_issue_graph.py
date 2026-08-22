from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

VALIDATOR = (
    Path(__file__).resolve().parents[1] / "scripts" / "validate_issue_graph.py"
)


class IssueGraphValidatorTests(unittest.TestCase):
    @staticmethod
    def node(node_id: str, dependencies: list[str] | None = None) -> dict:
        return {
            "id": node_id,
            "title": f"Task {node_id}",
            "description": f"Complete {node_id} with reproducible evidence.",
            "priority": "P0",
            "workstream": "program-bootstrap",
            "milestone": "days-1-10",
            "status": "planned",
            "labels": ["hedgehog", "planning"],
            "dependencies": dependencies or [],
            "gates": [],
            "acceptance": [f"{node_id} evidence passes verification."],
            "evidence_types": ["validated-artifact"],
            "source_refs": ["QUEUE.md#p0--program-bootstrap"],
        }

    @staticmethod
    def graph(nodes: list[dict]) -> dict:
        return {
            "schema_version": "1.0",
            "graph_id": "test-graph",
            "title": "Test issue graph",
            "gate_definitions": {
                "owner-approval": "External mutation requires owner approval."
            },
            "nodes": nodes,
        }

    def run_validator(self, payload: dict) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as td:
            graph = Path(td) / "graph.json"
            graph.write_text(json.dumps(payload), encoding="utf-8")
            return subprocess.run(
                [sys.executable, str(VALIDATOR), str(graph)],
                capture_output=True,
                check=False,
                text=True,
            )

    def test_accepts_valid_graph_in_dependency_order(self):
        result = self.run_validator(
            self.graph(
                [self.node("inventory"), self.node("architecture", ["inventory"])]
            )
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.strip(),
            "Hedgehog issue graph PASS: 2 nodes in dependency order.",
        )

    def test_rejects_dependency_that_appears_later(self):
        result = self.run_validator(
            self.graph(
                [self.node("architecture", ["inventory"]), self.node("inventory")]
            )
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn(
            "node architecture has unknown or out-of-order dependency inventory",
            result.stderr,
        )

    def test_rejects_undefined_gate(self):
        node = self.node("import-issues")
        node["gates"] = ["production-write"]

        result = self.run_validator(self.graph([node]))

        self.assertEqual(result.returncode, 1)
        self.assertIn(
            "node import-issues has undefined gate production-write",
            result.stderr,
        )

    def test_rejects_duplicate_node_id(self):
        result = self.run_validator(
            self.graph([self.node("inventory"), self.node("inventory")])
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn("duplicate node id inventory", result.stderr)

    def test_rejects_dependency_cycle(self):
        result = self.run_validator(
            self.graph(
                [self.node("inventory", ["architecture"]),
                 self.node("architecture", ["inventory"])]
            )
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn("dependency cycle", result.stderr)

    def test_rejects_missing_required_node_fields(self):
        required_fields = (
            "id",
            "title",
            "description",
            "priority",
            "workstream",
            "milestone",
            "status",
            "labels",
            "dependencies",
            "gates",
            "acceptance",
            "evidence_types",
            "source_refs",
        )

        for field in required_fields:
            with self.subTest(field=field):
                node = self.node("inventory")
                del node[field]

                result = self.run_validator(self.graph([node]))

                self.assertEqual(result.returncode, 1)
                self.assertIn(
                    f"node 1 missing required field {field}", result.stderr
                )

    def test_rejects_empty_acceptance_criteria(self):
        node = self.node("inventory")
        node["acceptance"] = []

        result = self.run_validator(self.graph([node]))

        self.assertEqual(result.returncode, 1)
        self.assertIn(
            "node inventory acceptance must be a non-empty string array",
            result.stderr,
        )

    def test_rejects_unsupported_schema_version(self):
        graph = self.graph([self.node("inventory")])
        graph["schema_version"] = "2.0"

        result = self.run_validator(graph)

        self.assertEqual(result.returncode, 1)
        self.assertIn("unsupported schema_version 2.0", result.stderr)


if __name__ == "__main__":
    unittest.main()
