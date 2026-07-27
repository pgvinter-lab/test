# Review Jobs and Provenance

Status: REVISED DRAFT FOR OWNER CONFIRMATION

Review jobs are durable aggregates; adapter calls are attempts, not the job itself.
The state machine is defined in `DRAFT-CONTRACT.md` and exercised by the mock
client.

## Proposed command rules

- `CreateReviewJob` records target artifact IDs, acceptance criteria, and a
  versioned/hashed owner-supplied instruction set.
- `AmendReviewJobInstructions` retains prior versions. By default, any amendment,
  material or not, revokes active approval grants bound to the superseded
  instruction version.
- An owner may declare the `0.1.0-draft.4` M-3/L-4 override only up front at job
  creation. It is job-scoped, immutable, non-retroactive, audited, and does not
  bypass identity, role, claim/generation/fencing, adapter allowlist, credential,
  or unrelated security controls.
- `MakeClaimable` runs dependency, role-policy, and provenance-derived
  independence checks.
- `ClaimReviewJob` is atomic and applies role/independence checks.
- `StartReviewJob`, `AwaitInput`, and `CompleteReviewJob` require the current
  claim ID, generation, and fencing token.
- `CompleteReviewJob` requires result artifact IDs and a disagreement array,
  including an empty array when there are none, plus a citation array.
- Claim expiry emits an event and returns the job to `claimable`; it does not
  delete the prior attempt.
- Approval-grant create, consume, exhaust, and revoke operations emit ordered
  events and typed non-operational audit-mirror snapshots.
- Completion events immutably include result artifact IDs, citations, and complete
  disagreement envelopes; the corresponding mirror entry includes a result outcome.

## Idempotency

The same project+principal+operation scoped idempotency key and canonical request
hash returns the original result. Reusing a key with different content is an error.
Event consumers dedupe by `eventId`; project sequence provides ordering, not
global time.

## Provenance

Artifact identity is content-addressed metadata plus an opaque artifact ID. Parent
links form a directed provenance graph. Cycles are invalid. Citation verification
is versioned review output, not a mutable flag on the source bytes.

Confidential/restricted artifact metadata cannot point to GitHub source storage;
Drive/remote locations must assert encryption. Material disagreements are
append-only review records. Accepted/rejected status is
an owner or authorized disposition; the original reviewer position and reason
remain visible.

`github_source` is allowed only for `source_code` artifacts classified public or
internal. Prompts, general sources, attachments, backups, and generated work
products cannot name GitHub as an artifact location regardless of sensitivity.
