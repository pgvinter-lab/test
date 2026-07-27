# Adapters, MCP Profiles, and Transports

Status: REVISED DRAFT FOR OWNER CONFIRMATION

## Adapter protocol

An adapter is a replaceable boundary component. Its manifest declares operations,
schemas, idempotency, side effects, capabilities, transports, network targets,
credential mode, sensitive-data handling, and health states.

Proposed invocation envelope:

```json
{
  "operationId": "operation.001",
  "adapterId": "adapter.example",
  "operation": "submit",
  "principal": {
    "principalId": "principal.worker",
    "sessionId": "session.worker.001",
    "hostId": "host.demo"
  },
  "generation": 1,
  "idempotencyKey": "idempotency.operation.001",
  "deadline": "2026-07-12T13:00:00Z",
  "inputArtifactIds": ["artifact.input.001"],
  "parameters": {}
}
```

The response contains status, output artifact metadata, retry classification, and
adapter diagnostics with secret values removed.

## Browser dispatchers

Browser dispatchers are isolated adapters. Authenticated profiles remain owned by
the browser/OS and outside Bridge storage. Dispatch is allowlisted by operation and
target origin. DOM/tab operations may be parallel per tab; focus/cursor operations
require a separate short lease. Posting, sending, purchasing, filing, or any other
irreversible action defaults to per-action owner approval. A bounded job grant may
also pre-authorize named actions and their resulting approval-prompt classes. New
origins, destinations, operations, conditions, side-effect classes, instruction
versions, expired durations, or exhausted use counts return `ask` and require
renewed approval.

The manifest schema forbids browser and credentialed adapters from using
`in_process`, requires browser/API network allowlists, and requires approval
declarations for irreversible and sensitive-external actions.
Its approval-policy block always declares `ask` as the no-match and scope-expansion
decision. Manifest support for bounded grants does not itself authorize an action.
Each grant names its adapter IDs, and its origins/destinations must be a subset of
every named adapter's declared `networkAccess`. Additional condition keys are scope
expansion, not harmless metadata, unless the owner declared the `0.1.0-draft.4`
job-creation override. That override changes only M-3 and L-4 for the job; it does
not authorize new origins, destinations, operations, side-effect classes, adapters,
principals, roles, stale claims, or credential access.

Scraped responses become artifacts only after settle detection, content hashing,
and provenance capture. Replies cannot grant new tool authority or cause arbitrary
URL navigation.

## MCP profiles

Profiles are least-privilege tool sets, not trusted client declarations. The server
derives them from principal roles and project policy. Tool discovery and invocation
both enforce authorization.

## Transport profiles

Stdio is the local default and permits one client process per server instance.
Stdout is protocol-only; diagnostics use stderr. Secrets are references injected
by the host process, not command-line arguments.

Streamable HTTP is optional remote mode. It requires TLS, authentication, origin
validation, request limits, session-to-identity binding, and server-side
authorization. Local HTTP binds loopback only. The deprecated HTTP+SSE transport is
not recommended for new clients.

Transport sessions do not replace Bridge principal/session/host identity.
