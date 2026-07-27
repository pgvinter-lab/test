# Focused Claude Code Revision Review Request

Status: DRAFT REVIEW REQUEST

Review target: the committed `0.1.0-draft.2` owner-decision revision at the handoff
commit. This is an independent architecture/contract red team, not implementation.

## Required inputs

- `docs/DECISION_REGISTER.md`
- `docs/architecture/DRAFT-CONTRACT.md`
- `docs/architecture/IDENTITY-ROLES-SECURITY.md`
- `docs/architecture/ADAPTERS-MCP-TRANSPORTS.md`
- `docs/architecture/RECOVERY-MIGRATION-DOCTOR.md`
- `docs/adr/0001-storage-and-event-journal.md`
- `docs/adr/0002-identity-and-security-boundaries.md`
- `docs/adr/0004-browser-dispatcher-isolation.md`
- `docs/adr/0005-drive-and-github-responsibilities.md`
- `docs/adr/0006-cloud-and-new-laptop-restoration.md`
- `contracts/v0.1.0-draft.2/**`
- `mock-client/**`
- `test/contract/**`

## Focus questions

1. Does the audit mirror remain non-operational while preserving complete typed
   event, instruction, approval, action, outcome, citation, and hash envelopes?
   Identify secret/raw-content leakage paths and archive-encryption gaps.
2. Are approval grants genuinely revocable, auditable, and bounded by job, action,
   condition, destination/origin, side-effect class, duration, use count, prompt
   class, and instruction version? Does every scope expansion return `ask`?
3. Do versioned custom instructions and material amendments invalidate approvals
   deterministically without silently widening or rewriting authority?
4. Can bounded browser pre-approval authorize only typed decisions without granting
   browser profile access, arbitrary navigation, or new destinations/origins?
5. Does the GitHub/Drive split structurally prevent runtime, case, credential,
   browser, recovery-snapshot, and key-material leakage into GitHub?
6. Does AES-256-GCM plus an opaque manifest reference and separately stored wrapped
   key capsule form a recoverable design without placing the capsule decryption
   secret in either Drive account or GitHub? Identify still-unapproved policies.
7. Is `node:sqlite`/WAL a coherent local authoritative-store contract with no
   hidden database-server dependency and no accidental remote multi-writer claim?
8. Do the schemas, examples, mock behavior, and tests contradict the decision
   register or omit an owner-approved addition?

## Output

Write `docs/reviews/CLAUDE_CODE_REVISION_REVIEW.md` with:

- target commit and test commands reviewed;
- findings ordered by severity with exact file/line references;
- accepted architecture positions versus preference disagreements;
- explicit unresolved policies requiring owner confirmation;
- a final recommendation of `confirm`, `confirm after changes`, or `do not confirm`.

Preserve disagreements. Do not edit contracts, schemas, mock code, tests, or prior
review records. Do not access case data, credentials, browser state, authenticated
sessions, or external repositories. Do not implement either product or authorize
an implementation window.
