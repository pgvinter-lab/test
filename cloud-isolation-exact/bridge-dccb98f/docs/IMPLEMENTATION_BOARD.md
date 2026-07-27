# Proposed Implementation Board

Status: DRAFT - CONDITIONAL PHASE 1 AUTHORIZATION GATE

This board proposes non-overlapping ownership only. Window 2 and Window 3 launch
automatically only if the D-021 gates are proven: the current contract revision is
committed, all existing tests and scans pass, focused independent Claude review
closes with no unresolved material finding, the worktree is clean, and no Bridge
leases remain. If any gate is not proven, implementation remains unauthorized.

## Window 1: Architecture and integration

Current scope:

- `contracts/**`
- `docs/architecture/**`
- `docs/adr/**`
- `docs/reviews/**`
- `docs/DECISION_REGISTER.md`
- `mock-client/**`
- `test/contract/**`

Exit condition: closed current contract revision with D-021 gates proven. This
window does not itself authorize runtime implementation before those gates close.

## Window 2: Bridge 2.0 runtime (Phase 1 after D-021 gate)

Proposed exclusive ownership:

- `src/v2/core/**`
- `src/v2/storage/**`
- `src/v2/identity/**`
- `src/v2/jobs/**`
- `src/v2/artifacts/**`
- `src/v2/adapters/**`
- `src/v2/transports/**`
- `src/v2/recovery/**`
- `src/v2/cli/**`
- `migrations/**`
- `test/runtime/**`

Must not change contract schemas or mock behavior silently. Proposed contract
changes go to Window 1/integration as explicit change requests with migration and
client impact.

GitHub setup, authentication, remote creation, and push are deferred until after
the first implementation phase.

## Window 3: Procedural Guidance System (Phase 1 after D-021 gate)

Proposed exclusive ownership: its separate repository and all procedural-domain
source, tests, UI, knowledge models, and deployment files.

Bridge 2.0 repository access is read-only. The client consumes:

- `contracts/v0.1.0-draft.4/**`
- `mock-client/**`
- `docs/architecture/DRAFT-CONTRACT.md`
- `docs/architecture/REVIEW-JOBS-AND-PROVENANCE.md`
- `docs/architecture/ADAPTERS-MCP-TRANSPORTS.md`

The Procedural window must not add case facts, legal evidence, credentials, or
browser state to Bridge fixtures. Client-specific schema extensions remain in the
client repository until integration review.

GitHub setup, authentication, remote creation, and push are outside this phase.

## Later integration window

Proposed exclusive responsibilities:

- run both sides against approved contract fixtures;
- replace the mock behind the client's interface;
- reconcile change requests and preserved disagreements;
- execute backup/restore and transport interoperability tests;
- update the approved compatibility matrix.

## Collision rules

- One repository owner per file path.
- Contract changes require integration ownership.
- No window edits another window's branch/worktree directly.
- Bridge leases remain mandatory even with Git worktrees.
