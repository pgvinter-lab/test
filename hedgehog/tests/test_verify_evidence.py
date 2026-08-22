from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "verify_evidence.py"
SPEC = importlib.util.spec_from_file_location("verify_evidence", MODULE_PATH)
ve = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(ve)


class EvidenceVerifierTests(unittest.TestCase):
    def test_lf_normalized_hash_is_cross_platform_stable(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            crlf = root / "crlf.txt"
            lf = root / "lf.txt"
            crlf.write_bytes(b"a\r\nb\r\n")
            lf.write_bytes(b"a\nb\n")
            self.assertEqual(
                ve.sha256_for(crlf, "lf-normalized"),
                ve.sha256_for(lf, "lf-normalized"),
            )
            self.assertNotEqual(
                ve.sha256_for(crlf, "raw"), ve.sha256_for(lf, "raw")
            )

    def test_passing_manifest_rejects_failed_check(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            manifest = root / "manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "schema_version": "1.0",
                        "evidence_id": "test-evidence",
                        "task_id": "test-task",
                        "title": "test title",
                        "status": "pass",
                        "generated_at": "2026-08-22T18:00:00Z",
                        "producer": "unit-test",
                        "commands": ["test"],
                        "checks": [{"name": "forced failure", "outcome": "fail"}],
                        "artifacts": [],
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ve.EvidenceError, "failed check"):
                ve.validate_manifest(manifest)

    def test_queue_checked_item_requires_evidence_annotation(self):
        with tempfile.TemporaryDirectory() as td:
            queue = Path(td) / "QUEUE.md"
            queue.write_text("- [x] unsupported completion\n", encoding="utf-8")
            with patch.object(ve, "QUEUE", queue):
                errors = ve.verify_queue({})
            self.assertEqual(len(errors), 1)
            self.assertIn("exactly one evidence annotation", errors[0])

    def test_queue_accepts_passing_manifest(self):
        with tempfile.TemporaryDirectory() as td:
            queue = Path(td) / "QUEUE.md"
            queue.write_text(
                "- [x] supported <!-- evidence: hedgehog/evidence/pass.json -->\n",
                encoding="utf-8",
            )
            manifest_path = (ve.REPO / "hedgehog/evidence/pass.json").resolve()
            with patch.object(ve, "QUEUE", queue):
                errors = ve.verify_queue({manifest_path: {"status": "pass"}})
            self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()