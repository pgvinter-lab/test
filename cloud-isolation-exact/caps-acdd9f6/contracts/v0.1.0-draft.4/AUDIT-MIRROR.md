# Audit Mirror Contract

Status: DRAFT FOR OWNER CONFIRMATION

The audit mirror is a non-operational, append-only JSONL projection. Each line
validates against `schemas/audit-mirror-entry.schema.json`, contains the complete
event envelope, and snapshots any instructions, approval grants, actions,
outcomes, and citations associated with that event. Core state transitions never
read this mirror and mirror failure must stop or alert the writer according to a
future durability policy; the mirror never becomes an alternate command source.

Entries form a canonical SHA-256 chain using the same JSON canonicalization rules
as `EVENT-HASHING.md`, substituting `mirrorHash` for `hash` and the algorithm label
`sha256-bridge-audit-cjson-v1`. JSONL file order must match `mirrorSequence`.

The schema structurally excludes credentials, secrets, browser state, and raw
artifact contents. Artifact bytes remain behind artifact references. Confidential
or restricted audit archives must be encrypted with AES-256-GCM and use the
wrapped-key capsule fields in the backup manifest. Retention, redaction, legal
hold, mirror write-failure behavior, and owner-access policy remain deferred.
Owner-approved L-2 permits complete verbatim instruction text in encrypted audit
mirror archives under those existing controls; it does not approve broader
redaction, access, retention, or deletion policy.

Mandatory snapshot matrix:

| Event family | Required associated snapshots |
|---|---|
| `review_job.*` | Current versioned instruction set |
| `approval_grant.*` | Complete approval grant, including subject and claim binding |
| `browser.authorization_decided` | Typed action and outcome |
| `review_job.completed` | Result outcome; the event contains artifact IDs, citations, and disagreements |

Arrays remain empty only when that snapshot class is not associated with the event.
