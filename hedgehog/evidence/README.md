# Hedgehog Evidence Contract

Hedgehog completion claims are machine-gated. A checked queue item must point to
a passing JSON evidence manifest under `hedgehog/evidence/`.

## Completion annotation

A completed `QUEUE.md` line must contain exactly one annotation of the form:

```text
<!-- evidence: hedgehog/evidence/<path>/<manifest>.json -->
```

The referenced manifest must have `status: "pass"` and must satisfy
`hedgehog/evidence/schema.json`.

## Artifact hashes

Each manifest may reference repository artifacts. Text artifacts should use
`hash_mode: "lf-normalized"` so SHA-256 is stable across Windows and Linux
checkouts. Binary artifacts should use `hash_mode: "raw"`.

`lf-normalized` means CRLF and CR are converted to LF before hashing.

## Minimum evidence

A passing manifest contains:

- a stable `evidence_id` and `task_id`;
- generation time and producer;
- exact commands or procedures used;
- at least one check with an explicit outcome;
- all repository artifacts needed to reproduce the result;
- SHA-256 for every referenced artifact.

The verifier rejects missing artifacts, hash mismatches, failed checks in a
passing manifest, malformed completion annotations, and checked queue items
without passing evidence.

## Local verification

From the repository root:

```powershell
python hedgehog/scripts/verify_evidence.py
python -m unittest discover -s hedgehog/tests -p "test_*.py"
```

GitHub Actions runs the same gate on Hedgehog changes.