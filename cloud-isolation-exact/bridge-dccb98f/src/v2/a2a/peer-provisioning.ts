// Provision command-center peers as A2A callers (Phase A, Task 2 of D-026).
//
// For an inbound A2A task to be accepted, the peer must exist in the served
// project as a real identity with a work role: `jobs.create` (collaboration) and
// `artifacts.register` (kind `prompt`) both require the actor to hold
// `collaborator` (or `owner`). So provisioning a peer is a full identity binding
// — principal (kind `agent`) + `collaborator` role + session — not just a role
// grant. The returned map gives the serve entrypoint the PrincipalRef to act as
// when a given peer calls in. Safe to call on every server start.
//
// RESTART SAFETY. `store.mutateIdempotent` rejects a stable idempotency key whose
// request hash changed (`idempotency_key_reused`). Provisioning IS the same
// command on every start, so the request is made byte-stable and re-provisioning
// becomes a genuine replay:
//   - the principal's `createdAt` is a FIXED provisioning epoch, not the wall
//     clock (this is a synthetic provisioning identity, not an observed event);
//   - `assignRole`'s request carries no timestamp and is already stable.
// An earlier version guarded these behind `hasRole`, which conflated "principal
// needs registering" with "role needs granting" and broke for an existing
// principal whose role was absent (independent review, N1).
//
// REVOCATION POLICY. If the collaborator role is not active after the (replayed)
// grant, it was revoked deliberately. Startup then FAILS LOUD rather than
// silently re-granting a revoked peer or serving one that cannot authorize work.

import { randomUUID } from "node:crypto";
import { invariant } from "../core/errors.js";
import type { PrincipalRecord, PrincipalRef, SessionRecord } from "../core/types.js";
import type { BridgeRuntime } from "../runtime.js";
import { COMMAND_CENTER_PEERS, type CommandCenterPeer } from "./agent-card.js";

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Fixed creation stamp for the synthetic peer principals. Deliberately not the
 * wall clock: it keeps the registration request byte-identical across restarts,
 * which is what makes re-provisioning an idempotent replay instead of an
 * `idempotency_key_reused` failure.
 */
const PROVISIONING_EPOCH = "2026-01-01T00:00:00.000Z";

export interface PeerProvisioningInput {
  readonly projectId: string;
  /** Owner/administrator actor authorizing the registrations. */
  readonly owner: PrincipalRef;
  /** Existing active host id the peers' sessions bind to. */
  readonly hostId: string;
  /** A2A server instance id recorded on each peer session's transport binding. */
  readonly serverInstanceId: string;
  /** Peers to provision; defaults to all command-center peers. */
  readonly peers?: readonly CommandCenterPeer[];
  /** Session lifetime; defaults to 24h. */
  readonly sessionTtlMs?: number;
}

/** Canonical principal id for a command-center peer. */
export function peerPrincipalId(peer: CommandCenterPeer): string {
  return `principal.pgvin.${peer}`;
}

/**
 * Register each peer as an agent principal with `collaborator` and `worker`
 * roles plus an active per-run session, returning the PrincipalRef to act as
 * per peer. The first role authorizes submission; the second authorizes actual
 * execution when Bridge routes a task to that peer.
 *
 * Throws `a2a_peer_role_not_active` if a peer's collaborator role was revoked.
 */
export function provisionPeers(
  runtime: BridgeRuntime,
  input: PeerProvisioningInput,
): Map<CommandCenterPeer, PrincipalRef> {
  const peers = input.peers ?? COMMAND_CENTER_PEERS;
  const ttlMs = input.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const now = runtime.store.now();
  const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
  const result = new Map<CommandCenterPeer, PrincipalRef>();

  for (const peer of peers) {
    const principalId = peerPrincipalId(peer);

    // Durable half. Both calls are byte-stable, so after the first start they are
    // replays that return the recorded response rather than re-inserting.
    const principal: PrincipalRecord = {
      principalId,
      kind: "agent",
      displayName: `${peer} (A2A peer)`,
      issuer: "bridge.a2a.local",
      subject: peer,
      status: "active",
      createdAt: PROVISIONING_EPOCH,
    };
    runtime.identity.registerPrincipal({
      projectId: input.projectId,
      actor: input.owner,
      principal,
      idempotencyKey: `a2a-provision-principal-${peer}`,
    });
    for (const role of ["collaborator", "worker"] as const) {
      runtime.identity.assignRole({
        projectId: input.projectId,
        actor: input.owner,
        principalId,
        role,
        idempotencyKey: role === "collaborator"
          ? `a2a-provision-role-${peer}`
          : `a2a-provision-role-${peer}-${role}`,
      });
    }

    // Deliberate policy: a revoked role is a security decision, not drift. Refuse
    // to start rather than override it or serve a peer that cannot authorize.
    invariant(
      runtime.identity.hasRole(input.projectId, principalId, "collaborator"),
      "a2a_peer_role_not_active",
      { peer, role: "collaborator" },
    );
    invariant(
      runtime.identity.hasRole(input.projectId, principalId, "worker"),
      "a2a_peer_role_not_active",
      { peer, role: "worker" },
    );

    // Per-run half: a fresh session each start, so a restart or an expired session
    // recovers naturally. The suffix is random, NOT a millisecond timestamp — two
    // starts within the same millisecond would otherwise collide on one session
    // id (independent review, N3). Sessions are historical rows that go inert at
    // `expiresAt`; pruning them is not handled here.
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const sessionId = `session.pgvin.${peer}.a2a.${suffix}`;
    const session: SessionRecord = {
      sessionId,
      principalId,
      hostId: input.hostId,
      startedAt: now,
      expiresAt,
      status: "active",
      authentication: { method: "local_process", assurance: "local" },
      transportBinding: {
        transport: "streamable_http",
        transportSessionId: `a2a-${peer}-${suffix}`, // >= 16 chars per session validation
        serverInstanceId: input.serverInstanceId,
      },
    };
    runtime.identity.createSession({
      projectId: input.projectId,
      actor: input.owner,
      session,
      idempotencyKey: `a2a-provision-session-${peer}-${suffix}`,
    });

    result.set(peer, { principalId, sessionId, hostId: input.hostId });
  }

  return result;
}
