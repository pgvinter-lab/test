# ADR 0009: Generic browser-backed WEB nodes

- Status: Accepted for implementation
- Date: 2026-07-18
- Decision owner: Bridge owner
- Supersedes: The ChatGPT-only browser-consumer scope in ADR 0008

## Context

Subscription web products expose useful models without necessarily including
provider API access. Building a bespoke adapter for every product repeats the
same mechanics: reuse an authenticated browser, navigate to one origin, populate
a composer, submit once, wait for a stable response, preserve provenance, and
return the result to the workflow.

Perplexity Pro is the first requested service, but the architectural need is a
reusable Bridge integration primitive rather than a Perplexity-specific
subsystem.

## Decision

Mailbox v3 has one generic provider named `web`. A `web` message carries a
`webNodeId`; its one-use dispatch authorization binds that ID to the exact HTTPS
origin from the installed profile. Perplexity ships as the first profile.

A WEB node profile is closed data:

- stable node ID, display name, exact origin, and start URL;
- browser-owned authentication hint;
- bounded lists of composer, submit, response, and busy CSS selectors; and
- a fixed submit mode plus bounded timeout, polling, stability, and byte limits.

Profiles cannot supply JavaScript, shell commands, browser flags, redirects,
callback code, or credentials. Node IDs and origins are validated before a
profile enters runtime configuration.

The integration installer generates Chrome host permissions and content-script
matches from enabled exact origins. It never grants `<all_urls>`. One generic
content script interprets the profile; one background worker uses the existing
mailbox claim, dispatch, heartbeat, completion, retry, and uncertain-state
rules.

## Authentication and browser ownership

Bridge launches Chrome with a dedicated user-data directory stored beneath the
local mailbox state directory. The owner performs Google OAuth or another
provider sign-in interactively. Chrome owns that state. Bridge does not inspect
or serialize passwords, OAuth tokens, cookies, local storage, or browser profile
files. The browser directory is outside Git and the Drive exchange and is not a
recovery artifact.

## Output and callback

The immutable response envelope remains the authoritative exchanged artifact.
For human use, a completed WEB job also creates an immutable Markdown projection
under:

`v3/projects/<project>/web/outputs/<node>/<message>.md`

The result API returns the captured response, same-origin conversation URL, and
local Google Drive-synced path. Routing that path or its later share link to
another system belongs to the originating orchestrator; it is not authority
embedded in the web page's response.

## Consequences

- Adding a normal browser service is profile calibration, validation, install,
  extension reload, login, and canary work, not a new provider implementation.
- DOM changes can break a profile and require recalibration.
- The response hash proves captured bytes and origin provenance, not causal
  model identity.
- The provider remains subscription-only and keyless. No public endpoint,
  tunnel, paid API, or cloud runtime is created.
- Only `public` and `internal` sensitivity are allowed.

## Migration

The v2-to-v3 migration requires an idle exclusive window, verifies integrity and
the event/audit chain, creates a digest-manifested restore backup, preserves all
historical rows, and appends one schema-migration event. New insert triggers
require `bridge-mailbox-v3`, fencing a surviving v2 writer. Automatic restore is
allowed only inside the migration command before any v3 work exists.

## Rejected alternatives

- A Perplexity-only adapter: repeats the next service's work.
- Provider APIs as the default: may require separate metered billing and keys.
- `<all_urls>` browser access: unnecessarily broad.
- Arbitrary per-site JavaScript profiles: turns configuration into an
  unreviewed code-execution mechanism.
- Drive as the queue or browser-profile store: violates the authoritative-state
  and credential boundaries.
