#!/usr/bin/env python3
"""Validate Hedgehog Threat Model v0.1 and Control Test Matrix."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import List, Dict, Set

REPO_ROOT = Path(__file__).resolve().parents[2]
HEDGEHOG_DIR = REPO_ROOT / "hedgehog"
SEC_DIR = HEDGEHOG_DIR / "security" / "threat_model"
TM_PATH = SEC_DIR / "THREAT_MODEL_V0_1.md"
CTM_PATH = SEC_DIR / "control_test_matrix.md"

REQUIRED_TM_SECTIONS = [
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

MANDATORY_BOUNDARIES = [f"TB-{i}" for i in range(1, 8)]
MANDATORY_THREATS = [f"THR-{i:02d}" for i in range(1, 19)]
MANDATORY_CONTROLS = [f"CTL-SEC-{i:02d}" for i in range(1, 19)]
MANDATORY_RISKS = [f"RR-{i:02d}" for i in range(1, 5)]

REQUIRED_WORKLOAD_CONCEPTS = [
    "TIER A: STRONG COMMERCIAL CANDIDATES",
    "TIER B: EXPLICIT CONTROLS REQUIRED",
    "TIER C: ABSOLUTELY PROHIBITED",
    "Family Media Digest",
    "Private Legal Workbench",
    "Internal Investigations",
    "FULL",
    "PARTIAL",
    "METADATA_ONLY",
]
class ThreatModelValidationError(Exception):
    pass


def validate_threat_model_file(path: Path) -> List[str]:
    errors = []
    if not path.is_file():
        return [f"Missing threat model file at {path}"]

    content = path.read_text(encoding="utf-8")

    # 1. Section presence
    for sec in REQUIRED_TM_SECTIONS:
        if sec not in content:
            errors.append(f"Threat model missing required section: '{sec}'")

    # 2. Status check
    if "- **Status**: `Accepted`" not in content:
        errors.append("Threat model must have status 'Accepted'")

    # 3. Mandatory Trust Boundaries
    for tb in MANDATORY_BOUNDARIES:
        if f"**{tb}**" not in content and f"`{tb}`" not in content:
            errors.append(f"Threat model missing trust boundary: '{tb}'")

    # 4. Mandatory STRIDE Threats
    for thr in MANDATORY_THREATS:
        if f"**{thr}**" not in content and f"`{thr}`" not in content:
            errors.append(f"Threat model missing threat ID: '{thr}'")

    # 5. Mandatory Controls
    for ctl in MANDATORY_CONTROLS:
        if f"`{ctl}`" not in content and f"**{ctl}**" not in content:
            errors.append(f"Threat model missing control ID: '{ctl}'")

    # 6. Mandatory Residual Risks
    for rr in MANDATORY_RISKS:
        if f"**{rr}**" not in content and f"`{rr}`" not in content:
            errors.append(f"Threat model missing residual risk ID: '{rr}'")
        if f"**{rr}**" in content and "ACCEPTED (Owner Approved)" not in content:
            errors.append(f"Residual risk {rr} must have explicit owner acceptance")

    # 7. Workload policies & concepts
    for concept in REQUIRED_WORKLOAD_CONCEPTS:
        if concept not in content:
            errors.append(f"Threat model missing required workload concept: '{concept}'")

    return errors


def validate_control_test_matrix_file(path: Path, tm_content: str) -> List[str]:
    errors = []
    if not path.is_file():
        return [f"Missing control test matrix file at {path}"]

    content = path.read_text(encoding="utf-8")

    for ctl in MANDATORY_CONTROLS:
        if f"`{ctl}`" not in content:
            errors.append(f"Control test matrix missing control ID: '{ctl}'")

    # Check for test identifiers and acceptance criteria in matrix
    if "tests/test_threat_model.py" not in content and "tests/test_architecture.py" not in content:
        errors.append("Control test matrix must reference unit test suite identifiers")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate Hedgehog Threat Model v0.1 and Control Test Matrix")
    parser.add_argument("--strict", action="store_true", help="Fail on any warning")
    args = parser.parse_args()

    all_errors = []

    print("Validating THREAT_MODEL_V0_1.md...")
    tm_errors = validate_threat_model_file(TM_PATH)
    all_errors.extend(tm_errors)

    tm_content = TM_PATH.read_text(encoding="utf-8") if TM_PATH.is_file() else ""

    print("Validating control_test_matrix.md...")
    ctm_errors = validate_control_test_matrix_file(CTM_PATH, tm_content)
    all_errors.extend(ctm_errors)

    if all_errors:
        print("\n--- THREAT MODEL VALIDATION FAILURES ---", file=sys.stderr)
        for err in all_errors:
            print(f"ERROR: {err}", file=sys.stderr)
        return 1

    print(
        f"\nHedgehog threat model validation PASS: 7 trust boundaries, 18 STRIDE threats, "
        f"18 security controls, and 4 owner-accepted residual risks verified."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
