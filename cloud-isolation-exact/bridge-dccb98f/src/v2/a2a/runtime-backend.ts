// Wire the inbound A2A handler to a live BridgeRuntime (Phase A, D-026).
//
// The transport authenticates a caller to a project + principal, then builds a
// handler bound to that identity. `resolve()` deliberately ignores the opaque
// A2A caller and returns the transport-authenticated context: identity is
// established by the transport (loopback + Bridge auth), never self-asserted by
// the peer in the A2A payload. The clock comes from the store so job and
// artifact timestamps share one source of truth.

import type { PrincipalRef } from "../core/types.js";
import type { BridgeRuntime } from "../runtime.js";
import type { CommandCenterPeer } from "./agent-card.js";
import { A2ARequestHandler, type A2ACaller } from "./handler.js";
import { executeA2AJob, readA2AResultText } from "./job-executor.js";
import { JobBackedA2ATaskBackend, type A2AJobContext } from "./job-backend.js";
import type { RunProcess } from "./peer-dispatch.js";

export interface A2AAuthenticatedContext {
  readonly projectId: string;
  readonly actor: PrincipalRef;
}

export interface A2ARuntimeExecutionContext {
  readonly owner: PrincipalRef;
  readonly peerActors: ReadonlyMap<CommandCenterPeer, PrincipalRef>;
  readonly runProcess: RunProcess;
}

/** Build an A2A request handler bound to one authenticated caller identity. */
export function buildA2AHandler(
  runtime: BridgeRuntime,
  context: A2AAuthenticatedContext,
  execution?: A2ARuntimeExecutionContext,
): A2ARequestHandler {
  const backend = new JobBackedA2ATaskBackend({
    jobs: runtime.jobs,
    artifacts: runtime.artifacts,
    resolve: (_caller: A2ACaller): A2AJobContext => ({
      projectId: context.projectId,
      actor: context.actor,
    }),
    now: () => runtime.store.now(),
    ...(execution ? {
      execute: (input) => executeA2AJob({
        runtime,
        projectId: context.projectId,
        owner: execution.owner,
        peerActors: execution.peerActors,
        runProcess: execution.runProcess,
      }, input),
      readResultText: (artifactId: string) => readA2AResultText(runtime, artifactId),
    } : {}),
  });
  return new A2ARequestHandler(backend);
}
