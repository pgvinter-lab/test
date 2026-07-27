# ADR 0007: Active Generation and Fencing

Status: REVISED DRAFT - OWNER DECISION RECORDED; FINAL CONFIRMATION REQUIRED

## Context

Time-based leases alone cannot stop a paused old writer from completing after its
lease expires and another writer takes over.

## Recommendation

Maintain a monotonically increasing project generation and monotonically increasing
claim fencing tokens allocated by the authoritative store. Require both on every
claimed mutation. Owner-confirmed takeover or restore advances generation and
invalidates every old token.

## Alternatives

- TTL leases only.
- Process locks/PID files only.
- Git branch/worktree isolation only.
- Distributed lock service.

## Consequences

All mutation APIs and adapters must carry and verify fencing metadata. This is
small local complexity compared with a distributed lock service and directly
addresses stale-writer risk. Multi-primary operation remains excluded.
