# Claude Code Revision Review Disposition

Status: REVISED DRAFT FOR OWNER CONFIRMATION

Review target: `e5d30a8`

Independent record: `CLAUDE_CODE_REVISION_REVIEW.md`

No review text was rewritten or removed. This file records the architecture lead's
draft dispositions; every change remains subject to owner confirmation.

| Finding | Claude position | Draft disposition | Contract/test response |
|---|---|---|---|
| H-1 | High: grant consumption lacked subject, role, claim, and fencing checks | Accepted | Grant schema now binds `grantedTo`, required role, adapter IDs, and claim ID/generation/fencing token. The mock rejects another principal/session/host and stale claims before scope matching; tests cover both. |
| M-1 | Results/disagreements absent from immutable event/mirror | Accepted | Completion events now include artifact IDs, citations, and complete disagreements; mirror completion entries include a typed outcome. |
| M-2 | Mirror completeness was opportunistic | Accepted | Event-family conditionals require instruction snapshots for review jobs, grant snapshots for approval events, action/outcome snapshots for browser decisions, and outcomes for completion. Mock auto-populates job/grant snapshots. |
| M-3 | Non-material amendments silently disabled active grants | Accepted with conservative draft rule | Every instruction-version amendment explicitly revokes active grants bound to the superseded version and emits revocation events. Materiality remains auditable. This clarification requires owner confirmation. |
| M-4 | Grants were not constrained to adapter allowlists | Accepted | Grants name adapter IDs; creation checks all origins/destinations against registered adapter allowlists; authorization rechecks both. |
| M-5 | Internal prompt/source metadata could name GitHub | Accepted | `github_source` is now limited to public/internal `source_code`; all prompts, general sources, attachments, backups, and generated outputs are excluded. |
| L-1 | `node:sqlite` stability risk omitted | Accepted | ADR 0001 and D-003 now record the Node 22.13 experimental-API risk and require verification on Node upgrades. |
| L-2 | Complete instruction text increases audit sensitivity | Preserved; no contract reversal | Owner decision D-004 requires complete instructions in the audit mirror. Confidential archives remain AES-256-GCM encrypted; redaction/access/retention remain deferred. |
| L-3 | Dirty source-only exception lacked attestation | Accepted | Backup manifests now require approval-grant ID, reason, and owner identity when `source_only` is dirty; positive and rejection vectors cover it. |
| L-4 | Extra condition keys could bypass scope-expansion semantics | Accepted with conservative draft rule | Exact condition-name equality is required; an unlisted condition key returns `ask`. |
| Observation: canonical key order | UTF-16 sort only matched code-point order for ASCII | Accepted | Canonicalization now compares Unicode scalar values and includes a supplementary-plane ordering vector. |
| Observation: mock doctor never `ready` | Non-defect | No change | The mock intentionally reports degraded because backup/adapter/external checks are skipped or warn. |

## Preserved positions

- Claude's final recommendation at `e5d30a8` remains **confirm after changes**.
- Claude warns that verbatim instructions can carry confidential context. The draft
  retains verbatim instructions because the owner explicitly required complete
  instruction envelopes; field-level redaction remains deferred and must not
  silently alter the historical instruction record.
- The draft chooses exact consumer identity plus claim/fencing binding, all-
  amendment revocation, exact condition keys, adapter-allowlist subsets, and a
  source-code-only GitHub artifact rule. These are post-review recommendations,
  not silently approved owner requirements.

## Validation note

Claude reviewed tests statically because safe mode denied command execution. Codex
runs the inherited, contract, recovery, and sanitization checks after disposition.
No implementation handoff is authorized.
