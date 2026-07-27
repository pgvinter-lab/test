# Bridge 2.0 Agent Instructions

Status: DRAFT CONTRACT WORKSPACE. Implementation is authorized only after the
D-021 gates in `docs/DECISION_REGISTER.md` and `docs/IMPLEMENTATION_BOARD.md` are
proven.

Read these files before changing anything:

1. `docs/architecture/DRAFT-CONTRACT.md`
2. `docs/DECISION_REGISTER.md`
3. `contracts/v0.1.0-draft.4/README.md`
4. `docs/IMPLEMENTATION_BOARD.md`

Owner confirmation gate:

- Owner decisions D-001 through D-021 are recorded in the decision register, but
  the revised architecture, schemas, and implementation assignments remain draft
  until the D-021 gates are proven.
- Approved additions are requirements of this revised draft; genuinely deferred
  policy details are not approved requirements.
- Do not remove a `-draft.N` suffix, declare the contract ready/frozen, or start
  product implementation without explicit owner approval.
- Do not turn assumptions in the decision register into requirements.
- Preserve material disagreements in `docs/reviews/`.

Safety boundaries:

- Never modify or delete the Bridge 1.x source directory.
- Never import case information, evidence, credentials, secrets, browser state,
  authenticated profiles, runtime state, or one-off `_RUN_*` files.
- Owner decision D-024 permits the Bridge recovery private key only in the exact
  configured local runtime and Drive recovery-key directories. It remains
  forbidden in Git, logs, manifests, prompts, examples, and audit records.
- GitHub repositories must remain private.
- GitHub setup, authentication, remote creation, and push are deferred until after
  the first implementation phase.
- Do not create paid cloud resources.
- Keep working trees and live databases outside Google Drive. Drive may hold
  recovery artifacts/manifests under the approved recovery root and D-025's
  separate immutable `Bridge Exchange`; the exchange is never authoritative and
  may not contain databases/WAL, claims, tokens, credentials, or browser state.

Bridge coordination:

1. Call `bridge_sync` at the start of each turn.
2. Call `bridge_claim` before editing.
3. Re-read files reported as changed by another agent.
4. Call `bridge_log` after each unit of work and `bridge_release` when done.
5. Use `bridge_handoff` only for a scoped review unless implementation has been
   explicitly approved.
6. Never edit `.connector/` manually.

Contract tests:

```powershell
npm run contract-test
npm run test:all
```
