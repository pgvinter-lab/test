# Identity, Roles, and Security Boundaries

Status: REVISED DRAFT FOR OWNER CONFIRMATION

## Identity invariants

- Authorization keys on `issuer + subject + principalId`, never a display label.
- Sessions are revocable and bound to one principal and host installation.
- Hosts publish identifiers, key thumbprints, and at most a pseudonymous hostname
  digest, not credentials or raw profiles. Bare hostname SHA-256 is not claimed to
  be non-reversible.
- Every accepted command records principal, session, host, generation, and time.
- Sessions have an expiry and bind to a transport session plus server instance.
- `unknown` identities may run doctor/read-only bootstrap only.
- Interactive lanes are distinct principals. The canonical local lane IDs are
  `codex`, `claude_desktop_code`, and `claude_desktop_cowork`; Claude Code and
  Claude Cowork never share lease ownership merely because both are Claude.
- `BRIDGE_LANE` is the authoritative stdio lane override. MCP client identity may
  infer Code versus Cowork when the override is absent. `code` and `cowork` are
  accepted aliases; generic `claude` is compatibility-only, resolves to Code, and
  emits a stderr/sync warning when the client handshake cannot disambiguate it.
  An ambiguous generic Claude session may sync but cannot claim files until its
  lane is explicit; lease isolation therefore fails closed.
- Project identity is keyed by the canonical real path. A junction or symlink to
  the same working tree must resolve to the same project database and lease space.

## Role separation

| Role | May do | May not do |
|---|---|---|
| owner | approve policy, takeover, disposition | erase reviewer history |
| administrator | configure identities/policy | self-approve owner-gated actions |
| collaborator | edit work artifacts and jobs | certify independent review |
| worker | execute claimed work | widen its own scope |
| reviewer | create findings and dispositions | mutate reviewed artifacts |
| observer | read authorized metadata | mutate state |

Independence is evaluated per job from declared exclusions plus every creator in
the target's transitive provenance closure. Claims verify the project-scoped role.
Waivers reference an owner-authored approval artifact. A different session or
model label does not make the same principal independent.

Owner-supplied job instructions are versioned and hashed. Scoped approval grants
bind to the exact instruction version, consuming principal/session/host, required
role, adapter, and current claim/generation/fencing token. Grants are revocable and
bounded by job, action, conditions, origins/destinations, side-effect class, expiry,
and use count. The authorization default is `ask`; every instruction amendment
explicitly revokes active grants bound to the superseded version.

The only exception is the owner-declared job-creation override recorded in
`0.1.0-draft.4`. It is owner-only, job-scoped, immutable after creation,
non-retroactive, and audited. It overrides only M-3 and L-4 for that job and does
not weaken identity, role, claim/generation/fencing, adapter allowlist, credential,
or unrelated security controls.

## Trust boundaries

1. Client process to Bridge transport.
2. Bridge core to transactional store.
3. Bridge core to adapter host.
4. Adapter host to browser/API/CLI surface.
5. Local state to Drive recovery replication.
6. Source checkout to private GitHub.

Credentials terminate at the narrowest applicable boundary. They are loaded from
environment, OS keychain, or an approved broker and are never serialized into
events, manifests, logs, prompts, schemas, or Git.

## Deferred policy details

- Remote authentication and authorization provider.
- Whether host public-key binding is mandatory for local stdio.
- Session lifetime and revocation UX.
- Sensitive-data classification taxonomy and production routing allowlists.
- Approval UI and material-amendment classification beyond the explicit flag.
- Audit retention, redaction, legal hold, mirror-failure, and owner-access policy.
