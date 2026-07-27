# ADR 0002: Identity and Security Boundaries

Status: REVISED DRAFT - OWNER DECISION RECORDED; FINAL CONFIRMATION REQUIRED

## Context

Bridge 1.x treats an environment agent label as identity. That cannot distinguish
principals, sessions, hosts, collaboration, or independent review.

## Recommendation

Use principal/session/host identity envelopes, project-scoped roles, explicit
reviewer independence, opaque credential references, and least-privilege adapter
processes. Treat display labels as metadata only. Represent owner authority through
revocable audited approval grants bound to a job, exact action scope, expiry/use
limits, the current versioned instruction set, consuming principal/session/host,
required role, adapter, and active claim/generation/fencing token. Default to `ask`
when no exact grant matches, and reject stale or different claimants before matching.
Default M-3 and L-4 remain in force unless the owner explicitly declares the
`0.1.0-draft.4` job-creation override. That override is owner-only, job-scoped,
immutable, non-retroactive, fully audited, and limited to M-3/L-4; it cannot
bypass identity, role, claim/generation/fencing, allowlist, credential, or
unrelated security controls.

## Alternatives

- Keep agent-string identity.
- Use OS user identity only.
- Require remote OIDC for local and remote operation.
- Use mutual TLS host identity only.

## Consequences

Identity registration and revocation add operational work. The model enables audit,
independent-review enforcement, host retirement, and remote transport without
putting credentials in state. Authentication provider and host-key requirements
remain owner choices.

Versioned custom instructions and grant revocation add audit volume and policy
tests. Remote authentication, approval UI, and retention/legal-hold rules remain
deferred.
