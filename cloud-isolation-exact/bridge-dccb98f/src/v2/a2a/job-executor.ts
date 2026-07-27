import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { sha256 } from "../core/canonical.js";
import { CONTRACT_VERSION } from "../core/constants.js";
import { asErrorCode, invariant } from "../core/errors.js";
import type { PrincipalRef, ReviewJob } from "../core/types.js";
import type { BridgeRuntime } from "../runtime.js";
import type { CommandCenterPeer } from "./agent-card.js";
import { dispatchToPeer, type RunProcess } from "./peer-dispatch.js";

const activeExecutions = new Map<string, Promise<ReviewJob>>();

export interface A2AJobExecutionContext {
  readonly runtime: BridgeRuntime;
  readonly projectId: string;
  readonly owner: PrincipalRef;
  readonly peerActors: ReadonlyMap<CommandCenterPeer, PrincipalRef>;
  readonly runProcess: RunProcess;
  readonly resultDirectory?: string;
}

export interface A2AJobExecutionInput {
  readonly job: ReviewJob;
  readonly targetPeer: CommandCenterPeer;
  readonly instructions: string;
  readonly model?: string;
  readonly effort?: string;
}

/**
 * Drive one queued A2A-backed Bridge job through a real worker lifecycle.
 * A terminal replay is returned without invoking the peer again.
 */
export async function executeA2AJob(
  context: A2AJobExecutionContext,
  input: A2AJobExecutionInput,
): Promise<ReviewJob> {
  const key = `${path.resolve(context.runtime.store.databasePath)}\0${context.projectId}\0${input.job.jobId}`;
  const active = activeExecutions.get(key);
  if (active) return active;
  const execution = executeA2AJobOnce(context, input);
  activeExecutions.set(key, execution);
  try {
    return await execution;
  } finally {
    if (activeExecutions.get(key) === execution) activeExecutions.delete(key);
  }
}

async function executeA2AJobOnce(
  context: A2AJobExecutionContext,
  input: A2AJobExecutionInput,
): Promise<ReviewJob> {
  const { runtime, projectId } = context;
  let job = runtime.jobs.requireForProject(projectId, input.job.jobId);
  if (isTerminal(job)) return job;
  const worker = context.peerActors.get(input.targetPeer);
  invariant(worker, "a2a_target_peer_not_provisioned", { targetPeer: input.targetPeer });
  let startedHere = false;

  if (job.status === "queued") {
    job = runtime.jobs.makeClaimable({
      projectId,
      jobId: job.jobId,
      actor: context.owner,
      idempotencyKey: `a2a-execute-claimable-${job.jobId}`,
    });
  }
  if (job.status === "claimable") {
    job = runtime.jobs.claim({
      projectId,
      jobId: job.jobId,
      actor: worker,
      leaseMs: 15 * 60 * 1000,
      idempotencyKey: `a2a-execute-claim-${job.jobId}-${input.targetPeer}`,
    });
  }
  if (job.status === "claimed") {
    invariant(job.claim, "a2a_job_claim_missing");
    try {
      job = runtime.jobs.start({
        projectId,
        jobId: job.jobId,
        actor: worker,
        claim: job.claim,
        // A unique transition key is intentional. Two Bridge processes racing
        // the same task cannot both replay one successful start and both launch
        // the peer: exactly one transitions claimed -> running; the loser reads
        // the winner's state and never dispatches.
        idempotencyKey: `a2a-execute-start-${job.jobId}-${randomUUID()}`,
      });
      startedHere = true;
    } catch (error) {
      if (asErrorCode(error) !== "invalid_transition") throw error;
      job = runtime.jobs.requireForProject(projectId, job.jobId);
    }
  }
  // A duplicate request observed while another execution is already running
  // must never launch the peer twice.
  if (!startedHere || job.status !== "running" || job.claim?.claimedBy.principalId !== worker.principalId) return job;

  try {
    const dispatch = await dispatchToPeer(input.targetPeer, input.instructions, context.runProcess, {
      model: input.model,
      effort: input.effort,
    });
    invariant(dispatch.delivered, "a2a_peer_dispatch_not_delivered", {
      targetPeer: input.targetPeer,
      failure: dispatch.failure,
    });
    const artifactId = registerResult(context, job, worker, dispatch.stdout, input.targetPeer);
    return runtime.jobs.complete({
      projectId,
      jobId: job.jobId,
      actor: worker,
      claim: job.claim,
      idempotencyKey: `a2a-execute-complete-${job.jobId}`,
      result: {
        outcome: "accepted",
        artifactIds: [artifactId],
        disagreements: [],
        citations: [],
      },
    });
  } catch (error) {
    const current = runtime.jobs.requireForProject(projectId, job.jobId);
    if (current.status === "running" && current.claim?.claimedBy.principalId === worker.principalId) {
      return runtime.jobs.fail({
        projectId,
        jobId: current.jobId,
        actor: worker,
        claim: current.claim,
        reason: asErrorCode(error).slice(0, 2_000),
        retryable: true,
        idempotencyKey: `a2a-execute-fail-${current.jobId}`,
      });
    }
    throw error;
  }
}

/** Read and verify a result artifact created by executeA2AJob. */
export function readA2AResultText(runtime: BridgeRuntime, artifactId: string): string | undefined {
  const artifact = runtime.artifacts.get(artifactId);
  if (!artifact || artifact.kind !== "response") return undefined;
  const root = resultRoot(runtime);
  for (const location of artifact.locations) {
    if (location.storageClass !== "local" || !location.uri.startsWith("file:")) continue;
    let candidate: string;
    try { candidate = path.resolve(fileURLToPath(location.uri)); } catch { continue; }
    const relative = path.relative(root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    try {
      const bytes = fs.readFileSync(candidate);
      invariant(sha256(bytes) === artifact.content.sha256, "a2a_result_artifact_hash_mismatch", { artifactId });
      invariant(bytes.length === artifact.content.sizeBytes, "a2a_result_artifact_size_mismatch", { artifactId });
      return bytes.toString("utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  return undefined;
}

function registerResult(
  context: A2AJobExecutionContext,
  job: ReviewJob,
  worker: PrincipalRef,
  output: string,
  targetPeer: CommandCenterPeer,
): string {
  const bytes = Buffer.from(output, "utf8");
  const contentHash = sha256(bytes);
  const stable = sha256(Buffer.from(`${job.jobId}\0${targetPeer}\0${contentHash}`, "utf8")).slice(0, 40);
  const artifactId = `artifact.a2a-result-${stable}`;
  const root = context.resultDirectory ? path.resolve(context.resultDirectory) : resultRoot(context.runtime);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const resultPath = path.join(root, `${artifactId}.txt`);
  const relative = path.relative(root, resultPath);
  invariant(!relative.startsWith("..") && !path.isAbsolute(relative), "a2a_result_path_outside_root");

  if (fs.existsSync(resultPath)) {
    const existing = fs.readFileSync(resultPath);
    invariant(sha256(existing) === contentHash, "a2a_result_file_collision", { artifactId });
  } else {
    const temporary = path.join(root, `.${artifactId}.${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    try { fs.renameSync(temporary, resultPath); }
    finally { try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ } }
  }

  context.runtime.artifacts.register({
    actor: worker,
    idempotencyKey: `a2a-result-artifact-${job.jobId}`,
    artifact: {
      schemaVersion: CONTRACT_VERSION,
      artifactId,
      projectId: context.projectId,
      kind: "response",
      createdAt: context.runtime.store.now(),
      createdBy: worker,
      sensitivity: "internal",
      content: { mediaType: "text/plain", sizeBytes: bytes.length, sha256: contentHash },
      locations: [{ storageClass: "local", uri: pathToFileURL(resultPath).href }],
      provenance: {
        origin: "agent",
        parentArtifactIds: [...job.target.artifactIds],
        captureMethod: `a2a_subscription_cli_${targetPeer}`,
        adapterId: "adapter.a2a.client",
        tool: targetPeer,
      },
      citations: [],
      retention: { policy: "project" },
    },
  });
  return artifactId;
}

function resultRoot(runtime: BridgeRuntime): string {
  return path.resolve(path.dirname(runtime.store.databasePath), "..", "a2a-results");
}

function isTerminal(job: ReviewJob): boolean {
  return job.status === "completed" || job.status === "failed" || job.status === "cancelled";
}
