# Focused Claude Code Draft.3 Review Request

Status: DRAFT REVIEW REQUEST

Review target: the `0.1.0-draft.3` owner-policy delta from `0.1.0-draft.2`.
This is an independent architecture/contract red team of the revision, not
runtime implementation.

## Required inputs

- `AGENTS.md`
- `docs/DECISION_REGISTER.md`
- `docs/IMPLEMENTATION_BOARD.md`
- `docs/architecture/DRAFT-CONTRACT.md`
- `docs/architecture/IDENTITY-ROLES-SECURITY.md`
- `docs/architecture/ADAPTERS-MCP-TRANSPORTS.md`
- `docs/architecture/REVIEW-JOBS-AND-PROVENANCE.md`
- `docs/adr/0002-identity-and-security-boundaries.md`
- `docs/adr/0004-browser-dispatcher-isolation.md`
- `docs/adr/0005-drive-and-github-responsibilities.md`
- `contracts/v0.1.0-draft.3/**`
- `mock-client/**`
- `test/contract/**`
- prior review/disposition records in `docs/reviews/`

## Focus questions

1. Do defaults M-3 and L-4 remain intact when no owner override is declared?
2. Is the override available only when the owner explicitly invokes it at job
   creation, and is it job-scoped, immutable after creation, non-retroactive, and
   fully audited?
3. Does the override affect only M-3 and L-4, without bypassing principal/role
   authorization, claim/generation/fencing controls, adapter allowlists, credential
   isolation, or unrelated security controls?
4. Is L-2 faithfully recorded: complete verbatim instruction text may remain in
   the encrypted audit mirror under existing controls, without silently approving
   broader redaction/access/retention policy?
5. Is GitHub setup, authentication, remote creation, and push clearly deferred
   until after the first implementation phase?
6. Do schemas, examples, mock behavior, and contract tests agree with the decision
   register and architecture docs?
7. Does the D-021 conditional Phase 1 authorization gate avoid authorizing
   implementation unless the revision is committed, all tests/scans pass, this
   review has no unresolved material finding, the tree is clean, and no leases
   remain?

## Output

Write `docs/reviews/CLAUDE_CODE_DRAFT3_REVIEW.md` with:

- target commit or working-tree delta reviewed;
- test commands reviewed or executed;
- findings ordered by severity with exact file/line references;
- accepted architecture positions versus preference disagreements;
- explicit unresolved policies requiring owner confirmation;
- a final recommendation of `gate passed`, `gate passed after changes`, or
  `gate blocked`.

Preserve disagreements. Do not edit contracts, schemas, mock code, tests, or prior
review records. Do not access case data, credentials, browser state, authenticated
sessions, external repositories, or GitHub. Do not implement either product.
