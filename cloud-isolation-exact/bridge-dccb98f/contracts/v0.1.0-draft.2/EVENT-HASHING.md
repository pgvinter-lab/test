# Event Hashing Contract

Status: REVISED DRAFT FOR OWNER CONFIRMATION

Algorithm identifier: `sha256-bridge-cjson-v1`

The event hash is lowercase SHA-256 over the UTF-8 bytes of Bridge Canonical JSON
v1 for the complete event envelope excluding only the `hash` member. The
`hashAlgorithm` and `previousHash` members, when present, are included.

Bridge Canonical JSON v1:

1. Values are valid JSON only; non-finite numbers and undefined values are invalid.
2. Null, booleans, finite numbers, and strings use their JSON encoding.
3. Array order is preserved with no whitespace.
4. Object keys are sorted in ascending Unicode code-point order and emitted with no
   whitespace. Implementations compare Unicode scalar values, not UTF-16 code
   units; the executable vectors include a supplementary-plane ordering check.
5. Text is encoded as UTF-8 before hashing.

`sequence:1` has no `previousHash`. Every later event includes the exact hash of
the immediately preceding project event. Doctor recomputes every hash and verifies
both sequence and linkage.

The frozen vector is `examples/event.valid.json`; contract tests recompute its
expected hash. Changing canonicalization requires a new algorithm identifier and
contract version.
