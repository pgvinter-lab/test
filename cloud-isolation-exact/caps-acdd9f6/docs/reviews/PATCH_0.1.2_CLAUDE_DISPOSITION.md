# Bridge 2.0 Patch 0.1.2 Claude Review Disposition

Status: COMPLETE - FOLLOW-UP REVIEW PASS

Date: 2026-07-14

Source review: `PATCH_0.1.2_CLAUDE_REVIEW.md`

## Accepted findings

- H-1 accepted. Ambiguous generic Claude sessions now receive stderr and sync
  diagnostics and cannot acquire file leases. Explicit Code and Cowork lanes remain
  distinct principals.
- H-2 accepted. Project keys and state slugs use the canonical real path, with a
  regression test proving that a Windows junction and its target share one lease
  space.
- M-1 accepted. Legacy control import is seed-only (`INSERT ... DO NOTHING`), so a
  changed legacy source cannot overwrite control changed later in Bridge 2.0.
- M-2 accepted where a project database exists. Predictable backup and restore
  failures, including bundle/clone errors, are immutable failed command outcomes.
- Q7.2 accepted as an operational limitation. Rollback restores the Bridge 1.x
  entrypoint but does not back-port coordination created during the Bridge 2.0
  validation window.
- Q9 accepted. Projectless discovery reads and unregistered-restore failures remain
  intentionally unaudited; no second authoritative host database is introduced.

## Deferred findings

- L-1 remains a compatibility limitation: legacy task/log calls do not accept an
  idempotency key. The versioned Bridge 2.0 job API remains the idempotent surface;
  adding retry keys to legacy tool signatures is deferred to a separately versioned
  compatibility extension.
- L-2 session-row cleanup is deferred housekeeping. Sessions are bounded local
  metadata, not source or artifact content.
- L-3 is retained only for local stdio bootstrap. The ten-year owner bootstrap
  session must never be reused by remote transports.
- L-4 is accepted as a pre-freeze obligation. The contract remains unfrozen draft.3;
  it must advance before a freeze so distinct schema bodies do not share a frozen
  version identifier.

No finding or disposition authorizes permanent deletion of Bridge 1.x, GitHub
publication, cloud deployment, product implementation, or contract freeze.

Follow-up result: `PATCH_0.1.2_CLAUDE_FOLLOWUP.md` closes all accepted findings
with PASS and leaves the reversible cutover at conditional PASS.
