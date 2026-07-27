# Independent Claude Code Review Request

Status: DRAFT REVIEW REQUEST

Review target: Bridge 2.0 contract `0.1.0-draft.1`

Read:

- `docs/architecture/DRAFT-CONTRACT.md`
- `docs/architecture/IDENTITY-ROLES-SECURITY.md`
- `docs/architecture/REVIEW-JOBS-AND-PROVENANCE.md`
- `docs/architecture/ADAPTERS-MCP-TRANSPORTS.md`
- `docs/architecture/RECOVERY-MIGRATION-DOCTOR.md`
- `docs/adr/**`
- `docs/DECISION_REGISTER.md`
- `contracts/v0.1.0-draft.1/**`
- `mock-client/**`
- `test/contract/**`

Red-team:

1. Principal/session/host identity and role escalation.
2. Collaboration versus independent reviewer separation.
3. Review lifecycle, claim expiry, retries, idempotency, and stale-writer fencing.
4. Artifact/citation provenance, sensitive-data leakage, and disagreement retention.
5. Adapter isolation and browser dispatcher threat boundaries.
6. Stdio and Streamable HTTP security, including session binding and origin checks.
7. Drive/GitHub responsibility split and encryption/key-custody failure modes.
8. Active-instance generation, forced takeover, and split-brain scenarios.
9. Backup, restore, migration, doctor, and new-laptop disaster recovery.
10. Schema/test gaps that would let incompatible implementations both pass.
11. Hidden assumptions and decisions that require owner approval.

Required response:

- Findings ordered by severity with exact paths/sections.
- Proposed contract or test change for each accepted defect.
- Explicit disagreements where the recommendation is preference-dependent.
- Decisions the owner must resolve before implementation.
- No implementation, no case analysis, no secrets/browser state, and no claim that
  the contract is approved or ready.

Done when the response is durable in `docs/reviews/` or returned through Bridge so
the architecture window can preserve it and record dispositions.
