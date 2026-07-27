# Bridge 1.x Review Inputs Carried Forward

Status: DRAFT CONTEXT, NOT AN APPROVED REQUIREMENT

The prior architecture review was read locally but not copied into the repository
because it mixed system-specific operational context with broad architecture
analysis. The reusable findings carried into this draft are:

- advisory TTL leases need generation/fencing against paused stale writers;
- mutable Drive files are unsafe under cross-host dual writers;
- state needs monotonic revision/generation and explicit migration;
- bridge agent labels and collaboration-bus identities were inconsistent;
- consumers need idempotent inbox/command handling;
- event-log/source-of-truth claims must match actual replay/validation behavior;
- authenticated browser tabs require explicit trust boundaries;
- sensitive external routing must be enforced in code, not remembered in prose;
- source backup and runtime recovery are different responsibilities;
- evaluation and executable contract tests are required before performance or
  reliability claims are credible;
- preserved disagreements should remain first-class output.

This draft adopts contract-level responses to those findings but leaves storage,
authentication, encryption, retention, and deployment choices for owner approval.
