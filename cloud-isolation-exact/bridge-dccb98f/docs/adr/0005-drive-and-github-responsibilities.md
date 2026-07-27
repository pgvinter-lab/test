# ADR 0005: Drive and GitHub Responsibilities

Status: REVISED DRAFT - OWNER DECISION RECORDED; FINAL CONFIRMATION REQUIRED

## Context

Source recovery and runtime recovery have different security and consistency
needs. Drive conflict copies make mutable multi-writer state unsafe.

## Recommendation

Use a private GitHub repository for complete sanitized source history, tags,
schemas, migrations, and synthetic tests. Do not prune commit history. Use the
approved Drive recovery root for immutable verified backup packages, encrypted
runtime/audit snapshots, manifests, historical archives, restore reports, key
capsules, and the exact D-024 recovery-key copy set. Keep
all live state local or in an owner-approved authoritative remote store.

D-025 additionally permits a separate `Bridge Exchange` Drive folder containing
immutable, hash-marked provider mailbox messages and responses. That folder is a
non-authoritative exchange, not part of the recovery root. It may never contain
the mailbox SQLite database/WAL, claims, leases, broker/delivery tokens,
credentials, cookies, browser profiles, or recovery keys.

GitHub is excluded from backup-manifest destinations. Source backup uses ordinary
Git commits/tags/push after the first implementation phase; GitHub setup,
authentication, remote creation, and push are deferred until that phase closes.
Runtime packages never share that channel.
Artifact metadata can name `github_source` only for `source_code` classified public
or internal; prompts, general sources, attachments, backups, and generated outputs
are structurally excluded.

## Alternatives

- GitHub only.
- Drive only.
- Live working tree/database in Drive.
- Paid object storage.

## Consequences

Two recovery legs require verification and restore drills. They avoid paid cloud
resources and separate source access from runtime data. Runtime state, case
information, credentials, browser state, and recovery snapshots are forbidden in
GitHub. Retention/legal-hold rules and drill cadence remain deferred.
