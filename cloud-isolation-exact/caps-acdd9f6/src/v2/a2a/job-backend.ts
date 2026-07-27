// Concrete A2ATaskBackend that binds inbound A2A tasks to the Bridge review-job
// aggregate (Phase A, D-026 — owner directive "do the recommendation").
//
// The design decision the protocol layer deferred: an inbound A2A message must
// become a *job*, because A2A's task lifecycle (submitted -> working ->
// input-required -> completed/failed/canceled) maps 1:1 onto Bridge job states
// (see job-mapping.ts), whereas the mailbox is an outbound prompt courier to
// web tabs (wrong direction, wrong provider set, wrong unit). `CreateJobInput`
// requires >=1 artifactId AND >=1 acceptanceCriterion, so this backend
// synthesizes both: it registers the peer's message as a `prompt` artifact and
// supplies a single default acceptance criterion.
//
// Layering: identity->principal resolution, the clock, and the optional routed
// executor are injected, so this file has no storage or transport dependency and
// is unit-testable with fake JobService/ArtifactService. A plain inbound send is
// a queued job; a send carrying a validated Bridge target is driven to a real
// subscription peer and projected back with its terminal result artifact.
//
// WIRING PRECONDITION: the resolved peer principal must hold `collaborator` (or
// `owner`) in the project — both `jobs.create` (collaboration mode) and
// `artifacts.register` (kind `prompt`) require a work role. See peer-provisioning.

import { createHash } from "node:crypto";
import { canonicalEqual } from "../core/canonical.js";
import { CONTRACT_VERSION } from "../core/constants.js";
import { invariant } from "../core/errors.js";
import type { ArtifactRecord, PrincipalRef, ReviewJob } from "../core/types.js";
import type { ArtifactService } from "../artifacts/artifact-service.js";
import type { JobService } from "../jobs/job-service.js";
import { COMMAND_CENTER_PEERS, type CommandCenterPeer } from "./agent-card.js";
import type { A2ACaller, A2ATaskBackend } from "./handler.js";
import { jobStatusToTaskState } from "./job-mapping.js";
import type {
  A2AArtifact,
  A2AMessage,
  A2ATask,
  A2ATaskStatus,
  A2ATextPart,
  MessageSendParams,
  TaskIdParams,
  TaskQueryParams,
} from "./types.js";

/** Project + actor the transport authenticated this caller to. */
export interface A2AJobContext {
  readonly projectId: string;
  readonly actor: PrincipalRef;
}

/**
 * Injected collaborators. `resolve` maps an authenticated A2A caller to a Bridge
 * project + principal; `now` returns an ISO-8601 timestamp (the wiring passes
 * the store clock so job and artifact times share one source of truth).
 */
export interface JobBackedA2ADeps {
  readonly jobs: JobService;
  readonly artifacts: ArtifactService;
  readonly resolve: (caller: A2ACaller) => A2AJobContext;
  readonly now: () => string;
  /** Execute a routed task. Omitted only by narrow unit-test/passive bindings. */
  readonly execute?: (input: {
    readonly job: ReviewJob;
    readonly targetPeer: CommandCenterPeer;
    readonly instructions: string;
  }) => Promise<ReviewJob>;
  /** Resolve durable Bridge result artifacts back to A2A text parts. */
  readonly readResultText?: (artifactId: string) => string | undefined;
}

const DEFAULT_ACCEPTANCE_CRITERION =
  "Complete the delegated A2A task and attach the result as artifacts.";

export class JobBackedA2ATaskBackend implements A2ATaskBackend {
  constructor(private readonly deps: JobBackedA2ADeps) {}

  async send(params: MessageSendParams, caller: A2ACaller): Promise<A2ATask> {
    const { projectId, actor } = this.deps.resolve(caller);
    const message = params.message;
    const serialized = serializeMessage(message);
    const contentSha = sha256Hex(serialized);
    // Namespaced by project AND peer principal: two peers (or two projects)
    // sending an identical message must not derive the same global artifact/job
    // id. Idempotency records are scoped per (project, principal), so a shared id
    // would collide with the existing record instead of giving each caller its
    // own task. Stable across identical re-sends; distinct when the same
    // messageId carries different content.
    const key = sha256Hex(
      `${projectId} ${actor.principalId} ${message.messageId} ${contentSha}`,
    ).slice(0, 40);
    const artifactId = `artifact.a2a-${key}`;
    const jobId = `job.a2a-${key}`;

    // The canonical prompt envelope we expect to find at this deterministic id.
    const expected: ArtifactRecord = {
      schemaVersion: CONTRACT_VERSION,
      artifactId,
      projectId,
      kind: "prompt",
      createdAt: this.deps.now(),
      createdBy: actor,
      sensitivity: "internal",
      content: { mediaType: "application/json", sizeBytes: byteLength(serialized), sha256: contentSha },
      locations: [{ storageClass: "local", uri: `bridge://a2a/prompt/${key}` }],
      provenance: { origin: "agent", parentArtifactIds: [], captureMethod: "a2a_message_send" },
      citations: [],
    };

    // Reuse an existing prompt artifact ONLY if it is the exact envelope we would
    // have registered. Skipping registration bypasses ArtifactService.register()'s
    // own canonicalEqual collision check, so the WHOLE record is compared here
    // rather than a few hand-picked fields: Bridge stores metadata, not bytes, so
    // `locations` and `provenance` are identity-bearing too — a matching content
    // hash at a foreign URI must not bind this job (independent review, N2).
    //
    // Exactly two fields legitimately vary and are normalized out:
    //   createdAt           — a delayed retry is the normal, expected case
    //   createdBy.sessionId — sessions are per server run (see peer-provisioning)
    // Everything else, including createdBy.principalId and hostId, must match.
    //
    // ATOMICITY: the store forbids nested write transactions
    // (`nested_write_transaction_forbidden`), so the artifact and the job cannot
    // commit together. A failure between them leaves an unreferenced prompt
    // artifact; the next identical send reuses it here and completes the job, so
    // the orphan is transient metadata rather than a stuck task. A truly atomic
    // binding needs a store-level composite operation.
    const existingPrompt = this.deps.artifacts.get(artifactId);
    if (existingPrompt) {
      invariant(
        canonicalEqual(comparablePrompt(existingPrompt), comparablePrompt(expected)),
        "a2a_prompt_artifact_collision",
        { artifactId },
      );
    } else {
      this.deps.artifacts.register({ actor, artifact: expected, idempotencyKey: `a2a-artifact-${key}` });
    }

    // The job request carries no timestamp, so replaying this key with the same
    // message returns the original job rather than failing the hash check.
    let job = this.deps.jobs.create({
      projectId,
      actor,
      idempotencyKey: `a2a-send-${key}`,
      jobId,
      mode: "collaboration",
      requiredRole: "worker",
      target: {
        artifactIds: [artifactId],
        instructions: messageToInstructions(message),
        acceptanceCriteria: [DEFAULT_ACCEPTANCE_CRITERION],
      },
    });
    const targetPeer = requestedTargetPeer(params);
    if (targetPeer) {
      invariant(this.deps.execute, "a2a_dispatch_unavailable", { targetPeer });
      const execution = this.deps.execute({
        job,
        targetPeer,
        instructions: messageToInstructions(message),
      });
      if (params.configuration?.blocking === true) job = await execution;
      else void execution.catch(() => { /* executor persists a failed terminal job */ });
    }
    return this.toTask(job);
  }

  async get(params: TaskQueryParams, caller: A2ACaller): Promise<A2ATask> {
    const { projectId } = this.deps.resolve(caller);
    // Scoped to the caller's project so a peer cannot read another project's job.
    return this.toTask(this.deps.jobs.requireForProject(projectId, params.id));
  }

  async cancel(params: TaskIdParams, caller: A2ACaller): Promise<A2ATask> {
    const { projectId, actor } = this.deps.resolve(caller);
    const job = this.deps.jobs.cancel({
      projectId,
      jobId: params.id,
      actor,
      reason: "Canceled via A2A tasks/cancel.",
      idempotencyKey: `a2a-cancel-${params.id}`,
    });
    return this.toTask(job);
  }

  /** Project a Bridge job onto the A2A Task wire shape. */
  private toTask(job: ReviewJob): A2ATask {
    const failureMessage: A2AMessage | undefined = job.status === "failed" && job.failure
      ? {
          kind: "message",
          role: "agent",
          messageId: `message.failure.${job.jobId}`,
          taskId: job.jobId,
          parts: [{ kind: "text", text: job.failure.reason }],
        }
      : undefined;
    const status: A2ATaskStatus = {
      state: jobStatusToTaskState(job.status),
      timestamp: job.updatedAt,
      ...(failureMessage ? { message: failureMessage } : {}),
    };
    const task: {
      kind: "task";
      id: string;
      contextId: string;
      status: A2ATaskStatus;
      artifacts?: readonly A2AArtifact[];
    } = {
      kind: "task",
      id: job.jobId,
      // Peer-supplied contextId threading is deferred; derived from the job id so
      // send() and get() always return the same contextId for a task.
      contextId: `a2a-context-${job.jobId}`,
      status,
    };
    if (job.status === "completed" && job.result) {
      task.artifacts = job.result.artifactIds.map((id) => resultArtifact(id, this.deps.readResultText?.(id)));
    }
    return task;
  }
}

/** The prompt envelope with the fields that legitimately vary normalized out. */
function comparablePrompt(artifact: ArtifactRecord): Record<string, unknown> {
  return {
    ...artifact,
    createdAt: "",
    createdBy: { ...artifact.createdBy, sessionId: "" },
  };
}

/** A completed job's result artifact, as an A2A artifact pointing at the Bridge id. */
function resultArtifact(bridgeArtifactId: string, text?: string): A2AArtifact {
  return {
    artifactId: bridgeArtifactId,
    name: bridgeArtifactId,
    parts: [
      ...(text === undefined ? [] : [{ kind: "text" as const, text }]),
      { kind: "data", data: { bridgeArtifactId } },
    ],
  };
}

function requestedTargetPeer(params: MessageSendParams): CommandCenterPeer | undefined {
  const candidate = params.metadata?.bridgeTargetPeer ?? params.message.metadata?.bridgeTargetPeer;
  if (candidate === undefined) return undefined;
  invariant(
    typeof candidate === "string" && (COMMAND_CENTER_PEERS as readonly string[]).includes(candidate),
    "a2a_target_peer_invalid",
    { targetPeer: candidate },
  );
  return candidate as CommandCenterPeer;
}

/** Join text parts into job instructions; never empty (create requires it). */
function messageToInstructions(message: A2AMessage): string {
  const texts = message.parts
    .filter((part): part is A2ATextPart => part.kind === "text")
    .map((part) => part.text);
  const joined = texts.join("\n\n").trim();
  if (joined.length > 0) return joined.slice(0, 16_000);
  const kinds = message.parts.map((part) => part.kind).join(", ") || "none";
  return `A2A task delivered with non-text parts (${kinds}); see the registered prompt artifact.`.slice(0, 16_000);
}

/**
 * Canonical bytes that identify a message. Includes taskId/contextId/metadata so
 * two sends that differ only in those fields do not collapse onto one task
 * (distinct A2A contexts must stay distinct).
 */
function serializeMessage(message: A2AMessage): string {
  return JSON.stringify({
    messageId: message.messageId,
    role: message.role,
    parts: message.parts,
    taskId: message.taskId ?? null,
    contextId: message.contextId ?? null,
    metadata: message.metadata ?? null,
  });
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function byteLength(input: string): number {
  return Buffer.byteLength(input, "utf8");
}
