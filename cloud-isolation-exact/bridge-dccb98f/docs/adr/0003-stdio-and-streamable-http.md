# ADR 0003: Stdio and Streamable HTTP Transports

Status: REVISED DRAFT - OWNER DECISION RECORDED; FINAL CONFIRMATION REQUIRED

## Context

Bridge 1.x is stdio-only. Bridge 2.0 is expected to support local clients and an
optional remote service.

## Recommendation

Keep stdio as the default local transport. Add MCP Streamable HTTP only as an
optional profile with TLS, authentication, origin validation, session binding,
request limits, and loopback-only local binding. Do not implement legacy HTTP+SSE
unless compatibility evidence requires it.

## Alternatives

- Stdio only.
- Custom REST/WebSocket API.
- Legacy HTTP+SSE compatibility from day one.
- Remote-only service.

## Consequences

Two transports expand testing and operations. Reusing MCP message semantics avoids
a separate API contract. Remote authentication, hosting, and any cloud spend
require separate owner approval.

Reference: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
