# ADR 0004: Browser Dispatcher Isolation

Status: REVISED DRAFT - OWNER DECISION RECORDED; FINAL CONFIRMATION REQUIRED

## Context

Bridge 1.x browser connectors drive authenticated tabs and depend on volatile DOM
selectors. Browser profiles contain credentials and state that must not enter Git
or recovery packages.

## Recommendation

Run browser dispatchers out of process behind the adapter interface. Keep profile
state browser-owned, allowlist target origins and operations, separate DOM/tab work
from focus/cursor leases, and default each side-effecting action to owner approval.
Permit bounded, revocable job grants for exact actions and resulting prompt classes.
Any scope expansion returns `ask` and requires renewed approval. Grant origins and
destinations must be subsets of the named adapter's allowlist, and consumption
requires the bound principal/session/host plus the active fencing token. The
`0.1.0-draft.4` owner-declared job-creation override may relax only M-3 and L-4
for that job; it never authorizes new adapters, origins, destinations, operations,
side-effect classes, principals, stale claims, or credential access.

## Alternatives

- Embed browser automation in the Bridge core.
- Remove browser adapters.
- Use provider APIs only.
- Run a dedicated remote browser service.

## Consequences

Isolation adds process supervision and adapter health checks but limits credential
exposure and selector failures. A grant authorizes only the typed action envelope;
it never exports browser state or permits arbitrary navigation. Remote browser
services remain excluded pending separate owner approval.
