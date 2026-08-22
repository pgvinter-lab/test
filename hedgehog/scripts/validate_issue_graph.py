#!/usr/bin/env python3
"""Validate a dependency-ordered Hedgehog issue graph."""

from __future__ import annotations

import json
import sys
from graphlib import CycleError, TopologicalSorter
from pathlib import Path

REQUIRED_NODE_FIELDS = (
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


class IssueGraphError(ValueError):
    """Raised when an issue graph violates the validation contract."""


def validate_required_fields(nodes: list[dict]) -> None:
    for index, node in enumerate(nodes, 1):
        for field in REQUIRED_NODE_FIELDS:
            if field not in node:
                raise IssueGraphError(
                    f"node {index} missing required field {field}"
                )
        acceptance = node["acceptance"]
        if (
            not isinstance(acceptance, list)
            or not acceptance
            or any(not isinstance(item, str) or not item for item in acceptance)
        ):
            raise IssueGraphError(
                f"node {node['id']} acceptance must be a non-empty string array"
            )


def validate_dependency_order(nodes: list[dict]) -> None:
    topology: dict[str, set[str]] = {}
    for node in nodes:
        node_id = node["id"]
        if node_id in topology:
            raise IssueGraphError(f"duplicate node id {node_id}")
        topology[node_id] = set(node["dependencies"])

    try:
        tuple(TopologicalSorter(topology).static_order())
    except CycleError as exc:
        raise IssueGraphError("dependency cycle detected") from exc

    seen: set[str] = set()
    for node in nodes:
        node_id = node["id"]
        for dependency in node["dependencies"]:
            if dependency not in seen:
                raise IssueGraphError(
                    f"node {node_id} has unknown or out-of-order dependency "
                    f"{dependency}"
                )
        seen.add(node_id)


def validate_gates(nodes: list[dict], gate_definitions: dict) -> None:
    for node in nodes:
        for gate in node["gates"]:
            if gate not in gate_definitions:
                raise IssueGraphError(
                    f"node {node['id']} has undefined gate {gate}"
                )


def main() -> int:
    try:
        graph_path = Path(sys.argv[1])
        graph = json.loads(graph_path.read_text(encoding="utf-8"))
        if graph.get("schema_version") != "1.0":
            raise IssueGraphError(
                f"unsupported schema_version {graph.get('schema_version')}"
            )
        nodes = graph["nodes"]
        validate_required_fields(nodes)
        validate_dependency_order(nodes)
        validate_gates(nodes, graph["gate_definitions"])
    except IssueGraphError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(f"Hedgehog issue graph PASS: {len(nodes)} nodes in dependency order.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
