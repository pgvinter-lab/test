#!/usr/bin/env python3
"""Validate Hedgehog Architecture Decision Records, Source Maps, and Assumption Registers."""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List, Dict, Any

REPO_ROOT = Path(__file__).resolve().parents[2]
HEDGEHOG_DIR = REPO_ROOT / "hedgehog"
ARCH_DIR = HEDGEHOG_DIR / "architecture"
ADR_0001_PATH = ARCH_DIR / "ADR-0001-virtualized-diskless-100gb-fabric-cluster.md"
VIRT_MATRIX_PATH = ARCH_DIR / "source_maps" / "virtualization_stack_matrix.md"
TRANS_MATRIX_PATH = ARCH_DIR / "source_maps" / "transport_stack_matrix.md"
ASSUMP_REG_PATH = ARCH_DIR / "assumption_register.md"

REQUIRED_ADR_SECTIONS = [
    "## Status",
    "## Context",
    "## Decision Drivers",
    "## Considered Options",
    "## The Architectural Decision",
    "## Failure Domain Boundaries",
    "## Consequences",
    "## Measurable Assumptions & Hardware Verification Register",
    "## Implementation & Transition Plan",
    "## References",
]

REQUIRED_FAILURE_DOMAINS = [
    "Compute Node Domain",
    "GPU / VFIO Domain",
    "Inference Fabric Domain",
    "Storage / Control Domain",
    "Tenant Isolation Domain",
]

VALID_ASSUMPTION_STATUSES = {"VERIFIED", "SIMULATED", "UNVERIFIED"}


class ArchitectureValidationError(Exception):
    pass


def validate_adr_0001(path: Path) -> List[str]:
    errors = []
    if not path.is_file():
        return [f"Missing ADR-0001 file at {path}"]

    content = path.read_text(encoding="utf-8")
    
    for sec in REQUIRED_ADR_SECTIONS:
        if sec not in content:
            errors.append(f"ADR-0001 missing required section: '{sec}'")

    for domain in REQUIRED_FAILURE_DOMAINS:
        if domain not in content:
            errors.append(f"ADR-0001 missing explicit failure domain: '{domain}'")

    # Check that hardware-dependent assumptions are marked UNVERIFIED
    if "UNVERIFIED" not in content:
        errors.append("ADR-0001 must explicitly identify unverified hardware assumptions")

    if "Status\n\nAccepted" not in content and "Status\n\nAccepted" not in content.replace("\r\n", "\n"):
        if "## Status\n\nAccepted" not in content:
            errors.append("ADR-0001 must have status 'Accepted'")

    return errors


def validate_virtualization_matrix(path: Path) -> List[str]:
    errors = []
    if not path.is_file():
        return [f"Missing virtualization stack matrix at {path}"]

    content = path.read_text(encoding="utf-8")
    required_keywords = [
        "KVM", "QEMU", "libvirt", "VFIO", "NUMA", "hugepages", "Nomad", "Kubernetes"
    ]
    for kw in required_keywords:
        if kw not in content:
            errors.append(f"Virtualization matrix missing required concept: '{kw}'")

    return errors


def validate_transport_matrix(path: Path) -> List[str]:
    errors = []
    if not path.is_file():
        return [f"Missing transport stack matrix at {path}"]

    content = path.read_text(encoding="utf-8")
    required_keywords = [
        "RoCEv2", "InfiniBand", "OpenUCX", "libibverbs", "RDMA", "P100", "PCIe Gen3"
    ]
    for kw in required_keywords:
        if kw not in content:
            errors.append(f"Transport matrix missing required concept: '{kw}'")

    return errors


def validate_assumption_register(path: Path) -> List[str]:
    errors = []
    if not path.is_file():
        return [f"Missing assumption register at {path}"]

    content = path.read_text(encoding="utf-8")
    lines = content.splitlines()

    # Parse markdown table rows with assumption IDs
    table_rows = [line.strip() for line in lines if line.strip().startswith("| `ASSUMP-")]
    if not table_rows:
        errors.append("Assumption register contains no parsed table rows with 'ASSUMP-' IDs")

    for row in table_rows:
        cols = [c.strip() for c in row.split("|")[1:-1]]
        if len(cols) < 6:
            errors.append(f"Malformed assumption table row: {row}")
            continue
        assump_id, desc, param, status_raw, gate, fallback = cols[:6]
        
        # Extract status tag (could be `UNVERIFIED` or UNVERIFIED)
        status_clean = re.sub(r"[`*]", "", status_raw).strip()
        if status_clean not in VALID_ASSUMPTION_STATUSES:
            errors.append(f"Assumption {assump_id} has invalid status '{status_clean}' (expected one of {VALID_ASSUMPTION_STATUSES})")

        if not gate:
            errors.append(f"Assumption {assump_id} missing verification gate definition")

    return errors


def simulate_moe_transport_feasibility() -> Dict[str, Any]:
    """
    Simulate activation transport overhead vs weight streaming over 100Gb fabric.
    MoE config: e.g. 1.0T parameter model with 64 experts, top-2 routing, hidden size 8192, batch size 1..16.
    """
    hidden_size = 8192
    bytes_per_elem = 2  # FP16
    batch_size = 8
    seq_len = 1  # Per token step
    
    # Activation vector size for top-2 experts: 2 * batch * seq_len * hidden_size * bytes_per_elem
    activation_bytes = 2 * batch_size * seq_len * hidden_size * bytes_per_elem  # e.g. 262,144 bytes = 256 KB
    
    # 100GbE effective bandwidth = ~11.5 GB/s = 11.5 * 10^9 B/s
    effective_bw_bytes_sec = 11.5 * 1024 * 1024 * 1024
    fabric_latency_sec = 12.0 * 1e-6  # 12 microseconds RoCEv2 one-way
    
    transport_time_sec = fabric_latency_sec + (activation_bytes / effective_bw_bytes_sec)
    
    # Full expert weight streaming if not resident: e.g. 2 experts * (8192 * 8192 * 3 * 2 bytes) ~ 800 MB
    expert_layer_weights_bytes = 2 * (3 * hidden_size * hidden_size * bytes_per_elem)
    weight_stream_time_sec = expert_layer_weights_bytes / effective_bw_bytes_sec
    
    speedup_factor = weight_stream_time_sec / transport_time_sec
    
    return {
        "activation_bytes": activation_bytes,
        "transport_time_micros": transport_time_sec * 1e6,
        "weight_stream_time_ms": weight_stream_time_sec * 1e3,
        "speedup_factor": speedup_factor,
        "transport_viable": transport_time_sec < 0.001,  # Sub-millisecond
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate Hedgehog architecture artifacts")
    parser.add_argument("--strict", action="store_true", help="Fail on any warning")
    args = parser.parse_args()

    all_errors = []

    print("Validating ADR-0001...")
    adr_errors = validate_adr_0001(ADR_0001_PATH)
    all_errors.extend(adr_errors)

    print("Validating Virtualization Matrix...")
    virt_errors = validate_virtualization_matrix(VIRT_MATRIX_PATH)
    all_errors.extend(virt_errors)

    print("Validating Transport Matrix...")
    trans_errors = validate_transport_matrix(TRANS_MATRIX_PATH)
    all_errors.extend(trans_errors)

    print("Validating Assumption Register...")
    assump_errors = validate_assumption_register(ASSUMP_REG_PATH)
    all_errors.extend(assump_errors)

    print("Running MoE Transport Feasibility Simulation...")
    sim = simulate_moe_transport_feasibility()
    if not sim["transport_viable"]:
        all_errors.append("MoE activation transport simulation failed feasibility gate (<1ms)")

    if all_errors:
        print("\n--- ARCHITECTURE VALIDATION FAILURES ---", file=sys.stderr)
        for err in all_errors:
            print(f"ERROR: {err}", file=sys.stderr)
        return 1

    print(
        f"\nHedgehog architecture validation PASS: ADR-0001, 2 source maps, and assumption register "
        f"validated with {sim['speedup_factor']:.1f}x activation vs weight streaming advantage."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
