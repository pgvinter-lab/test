#!/usr/bin/env python3
"""Verify Hedgehog evidence manifests and QUEUE.md completion claims."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Iterable

REPO = Path(__file__).resolve().parents[2]
HEDGEHOG = REPO / "hedgehog"
EVIDENCE = HEDGEHOG / "evidence"
QUEUE = HEDGEHOG / "QUEUE.md"
SCHEMA = EVIDENCE / "schema.json"
COMPLETION_RE = re.compile(r"^\s*-\s*\[[xX]\]")
ANNOTATION_RE = re.compile(
    r"<!--\s*evidence:\s*(hedgehog/evidence/[^\s>]+\.json)\s*-->"
)
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

REQUIRED = {
    "schema_version", "evidence_id", "task_id", "title", "status",
    "generated_at", "producer", "commands", "checks", "artifacts",
}
STATUSES = {"pass", "fail", "partial", "blocked"}
OUTCOMES = {"pass", "fail", "skipped"}
HASH_MODES = {"raw", "lf-normalized"}


class EvidenceError(ValueError):
    pass


def normalized_bytes(path: Path, mode: str) -> bytes:
    data = path.read_bytes()
    if mode == "raw":
        return data
    if mode == "lf-normalized":
        return data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    raise EvidenceError(f"unsupported hash_mode {mode!r}")


def sha256_for(path: Path, mode: str) -> str:
    return hashlib.sha256(normalized_bytes(path, mode)).hexdigest()


def parse_datetime(value: str) -> None:
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception as exc:
        raise EvidenceError(f"invalid generated_at {value!r}") from exc


def validate_manifest(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise EvidenceError(f"{path}: invalid JSON: {exc}") from exc

    missing = sorted(REQUIRED - set(data))
    if missing:
        raise EvidenceError(f"{path}: missing required keys: {', '.join(missing)}")
    if data["schema_version"] != "1.0":
        raise EvidenceError(f"{path}: unsupported schema_version")
    if data["status"] not in STATUSES:
        raise EvidenceError(f"{path}: invalid status {data['status']!r}")
    if not isinstance(data["evidence_id"], str) or len(data["evidence_id"]) < 3:
        raise EvidenceError(f"{path}: invalid evidence_id")
    if not isinstance(data["task_id"], str) or len(data["task_id"]) < 3:
        raise EvidenceError(f"{path}: invalid task_id")
    if not isinstance(data["title"], str) or len(data["title"]) < 3:
        raise EvidenceError(f"{path}: invalid title")
    if not isinstance(data["producer"], str) or len(data["producer"]) < 2:
        raise EvidenceError(f"{path}: invalid producer")
    parse_datetime(data["generated_at"])

    commands = data["commands"]
    if not isinstance(commands, list) or any(
        not isinstance(x, str) or not x for x in commands
    ):
        raise EvidenceError(f"{path}: commands must be an array of non-empty strings")

    checks = data["checks"]
    if not isinstance(checks, list) or not checks:
        raise EvidenceError(f"{path}: checks must be a non-empty array")
    for check in checks:
        if not isinstance(check, dict):
            raise EvidenceError(f"{path}: check must be an object")
        if set(check) - {"name", "outcome", "details"}:
            raise EvidenceError(f"{path}: check has unknown keys")
        if not isinstance(check.get("name"), str) or not check["name"]:
            raise EvidenceError(f"{path}: check name is required")
        if check.get("outcome") not in OUTCOMES:
            raise EvidenceError(f"{path}: invalid check outcome")
    if data["status"] == "pass" and any(c["outcome"] == "fail" for c in checks):
        raise EvidenceError(f"{path}: passing manifest contains failed check")

    artifacts = data["artifacts"]
    if not isinstance(artifacts, list):
        raise EvidenceError(f"{path}: artifacts must be an array")
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            raise EvidenceError(f"{path}: artifact must be an object")
        if set(artifact) != {"path", "sha256", "hash_mode"}:
            raise EvidenceError(
                f"{path}: artifact keys must be path, sha256, hash_mode"
            )
        rel = artifact["path"]
        if not isinstance(rel, str) or not rel:
            raise EvidenceError(f"{path}: artifact path is required")
        target = (REPO / rel).resolve()
        try:
            target.relative_to(REPO.resolve())
        except ValueError as exc:
            raise EvidenceError(f"{path}: artifact escapes repository: {rel}") from exc
        if not target.is_file():
            raise EvidenceError(f"{path}: missing artifact: {rel}")
        if artifact["hash_mode"] not in HASH_MODES:
            raise EvidenceError(f"{path}: invalid hash_mode for {rel}")
        if not SHA256_RE.fullmatch(str(artifact["sha256"])):
            raise EvidenceError(f"{path}: invalid sha256 for {rel}")
        actual = sha256_for(target, artifact["hash_mode"])
        if actual != artifact["sha256"]:
            raise EvidenceError(
                f"{path}: hash mismatch for {rel}: expected "
                f"{artifact['sha256']} got {actual}"
            )
    return data


def manifest_paths() -> Iterable[Path]:
    for path in sorted(EVIDENCE.rglob("*.json")):
        if path == SCHEMA or "_fixtures" in path.parts:
            continue
        yield path


def verify_queue(manifests: dict[Path, dict]) -> list[str]:
    errors: list[str] = []
    for lineno, line in enumerate(QUEUE.read_text(encoding="utf-8").splitlines(), 1):
        if not COMPLETION_RE.search(line):
            continue
        refs = ANNOTATION_RE.findall(line)
        if len(refs) != 1:
            errors.append(
                f"QUEUE.md:{lineno}: checked item must contain exactly one evidence annotation"
            )
            continue
        rel = Path(refs[0])
        path = (REPO / rel).resolve()
        if path not in manifests:
            errors.append(
                f"QUEUE.md:{lineno}: evidence manifest not found or invalid: {refs[0]}"
            )
            continue
        if manifests[path]["status"] != "pass":
            errors.append(
                f"QUEUE.md:{lineno}: completion evidence status is "
                f"{manifests[path]['status']!r}"
            )
    return errors


def main() -> int:
    if not SCHEMA.is_file():
        print(f"ERROR: missing schema: {SCHEMA}", file=sys.stderr)
        return 1
    try:
        schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"ERROR: invalid schema JSON: {exc}", file=sys.stderr)
        return 1
    if schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
        print(
            "ERROR: schema must declare JSON Schema draft 2020-12",
            file=sys.stderr,
        )
        return 1

    manifests: dict[Path, dict] = {}
    errors: list[str] = []
    for path in manifest_paths():
        try:
            manifests[path.resolve()] = validate_manifest(path)
        except EvidenceError as exc:
            errors.append(str(exc))
    errors.extend(verify_queue(manifests))

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    checked = sum(
        1
        for line in QUEUE.read_text(encoding="utf-8").splitlines()
        if COMPLETION_RE.search(line)
    )
    print(
        f"Hedgehog evidence gate PASS: {len(manifests)} manifests validated; "
        f"{checked} checked queue items supported."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())