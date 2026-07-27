# ADR 0006: Cloud and New-Laptop Restoration

Status: REVISED DRAFT - OWNER DECISION RECORDED; FINAL CONFIRMATION REQUIRED

## Context

A restore must recover source and state without accidentally activating two
writers or importing stale/corrupt data.

## Recommendation

Restore source and a verified Drive package into an isolated directory, verify
hashes, apply migrations, run doctor and contract tests, then require an
owner-confirmed generation takeover before activation. Browser/API credentials are
re-established separately and are never restored from Git or Drive manifests.
Confidential packages use AES-256-GCM and resolve a canonical
RSA-OAEP-SHA-256 key capsule. D-024 permits the private recovery key in exact
configured local-runtime and Drive recovery-key directories; GitHub, manifests,
logs, prompts, and audit records remain forbidden destinations.

## Alternatives

- Clone source and start with empty state.
- Automatically activate the newest Drive snapshot.
- Restore a complete machine image.
- Use a managed cloud control plane.

## Consequences

The staged process is slower but testable and reduces split-brain and secret
leakage. Drive compromise can expose retained backups under the owner-approved
D-024 posture. Rotation, recovery-time objectives, supported platforms, and any
cloud topology remain deferred decisions.
