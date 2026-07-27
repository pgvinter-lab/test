import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalEqual, hashCanonical } from "../core/canonical.js";
import { BridgeRuntimeError, invariant } from "../core/errors.js";
import { newId } from "../core/ids.js";
import { rejectInlineCredentialMaterial } from "../core/validation.js";
import type { JobClaim, PrincipalRef } from "../core/types.js";
import type { IdentityService } from "../identity/identity-service.js";
import type { BridgeStore } from "../storage/store.js";
import type { AdapterRegistry } from "./adapter-registry.js";

export interface AdapterInvocationGuard {
  assertActiveClaim(projectId: string, jobId: string, actor: PrincipalRef, claim: JobClaim): { claim?: JobClaim };
}

export interface AdapterInvocation {
  projectId: string;
  jobId: string;
  actor: PrincipalRef;
  claim: JobClaim;
  adapterId: string;
  adapterVersion?: string;
  operation: string;
  deadline: string;
  inputArtifactIds: string[];
  parameters: unknown;
  idempotencyKey: string;
  authorization?: { decision: "allow" | "ask" | "deny"; actionId?: string };
  networkContext?: {
    origin: string;
    destination: string;
    conditions: Record<string, string | number | boolean>;
    approvalPromptClass?: string;
  };
}

export interface StdioLauncher {
  command: string;
  args?: string[];
}

type InProcessHandler = (input: Record<string, unknown>) => unknown | Promise<unknown>;

interface DispatchFence {
  verify: () => void;
  grant: Record<string, unknown>;
}

export class AdapterHost {
  private readonly inProcess = new Map<string, InProcessHandler>();
  private readonly stdio = new Map<string, StdioLauncher>();
  private readonly isolatedBrokers = new Map<string, StdioLauncher>();

  constructor(
    private readonly store: BridgeStore,
    private readonly identity: IdentityService,
    private readonly registry: AdapterRegistry,
    private readonly guard: AdapterInvocationGuard,
  ) {}

  registerInProcessHandler(adapterId: string, handler: InProcessHandler, adapterVersion?: string): void {
    const manifest = this.registry.require(adapterId, adapterVersion);
    invariant(
      manifest.kind !== "browser" && manifest.security.credentialMode === "none" && manifest.security.networkAccess.length === 0,
      "in_process_adapter_isolation_required",
    );
    invariant(
      Object.values(manifest.operations).every((operation) => operation.sideEffectClass === "read_only"),
      "in_process_side_effecting_adapter_forbidden",
    );
    invariant(manifest.transports.includes("in_process"), "adapter_transport_not_declared");
    this.inProcess.set(executorKey(adapterId, manifest.adapterVersion), handler);
  }

  registerStdioLauncher(adapterId: string, launcher: StdioLauncher, adapterVersion?: string): void {
    const manifest = this.registry.require(adapterId, adapterVersion);
    invariant(manifest.transports.includes("stdio"), "adapter_transport_not_declared");
    invariant(
      manifest.kind !== "browser" && manifest.security.credentialMode === "none" && manifest.security.networkAccess.length === 0,
      "credentialed_or_network_adapter_requires_isolated_executor",
    );
    invariant(path.isAbsolute(launcher.command), "absolute_adapter_command_required");
    this.stdio.set(executorKey(adapterId, manifest.adapterVersion), { ...launcher, args: [...(launcher.args ?? [])] });
  }

  registerIsolatedBroker(adapterId: string, launcher: StdioLauncher, adapterVersion?: string): void {
    const manifest = this.registry.require(adapterId, adapterVersion);
    invariant(
      manifest.kind === "browser" || manifest.security.credentialMode !== "none" || manifest.security.networkAccess.length > 0,
      "isolated_broker_not_required",
    );
    invariant(manifest.transports.includes("stdio"), "adapter_transport_not_declared");
    invariant(path.isAbsolute(launcher.command), "absolute_adapter_command_required");
    this.isolatedBrokers.set(executorKey(adapterId, manifest.adapterVersion), { ...launcher, args: [...(launcher.args ?? [])] });
  }

  executionMode(adapterId: string, adapterVersion: string): "in_process" | "stdio" | "isolated" | undefined {
    const key = executorKey(adapterId, adapterVersion);
    if (this.inProcess.has(key)) return "in_process";
    const isolated = this.isolatedBrokers.get(key);
    if (isolated && executableAvailable(isolated.command)) return "isolated";
    const stdio = this.stdio.get(key);
    if (stdio && executableAvailable(stdio.command)) return "stdio";
    return undefined;
  }

  async invoke(input: AdapterInvocation): Promise<unknown> {
    this.identity.authorize(input.projectId, input.actor, ["owner", "collaborator", "worker", "reviewer"]);
    rejectInlineCredentialMaterial(input.parameters, "parameters");
    if (input.networkContext) rejectInlineCredentialMaterial(input.networkContext.conditions, "networkContext.conditions");
    const replay = this.replayExistingInvocation(input);
    if (replay.found) return replay.value;
    const manifest = this.registry.require(input.adapterId, input.adapterVersion);
    const operation = manifest.operations[input.operation];
    invariant(operation, "adapter_operation_not_declared");
    this.registry.validateOperationInput(manifest, input.operation, input.parameters);
    const requestBinding = this.validateAdapterRequest(input, manifest.security.sensitiveData, manifest.security.networkAccess.length > 0);
    const requiresGrant = manifest.kind === "browser" || operation.sideEffectClass !== "read_only" || requestBinding.sensitiveExternal;
    if (manifest.security.networkAccess.length > 0) {
      invariant(input.networkContext, "adapter_network_context_required");
      invariant(
        manifest.security.networkAccess.includes(input.networkContext.origin) &&
        manifest.security.networkAccess.includes(input.networkContext.destination),
        "adapter_network_target_not_allowlisted",
      );
    }
    if (requiresGrant) {
      invariant(input.authorization?.decision === "allow" && input.authorization.actionId && input.networkContext, "adapter_action_not_authorized");
    }
    const operationId = newId("operation");
    const requestHash = invocationRequestHash(input, manifest.adapterVersion);
    const reservation = this.store.transaction(() => {
      const existing = this.store.get<{
        request_hash: string;
        status: string;
        response_json: string | null;
        error_code: string | null;
        job_id: string;
        adapter_version: string;
        session_id: string;
        host_id: string;
        claim_id: string;
        generation: number;
        fencing_token: number;
      }>(
        `SELECT request_hash, status, response_json, error_code, job_id, adapter_version,
                session_id, host_id, claim_id, generation, fencing_token
         FROM adapter_invocations
         WHERE project_id = ? AND principal_id = ? AND adapter_id = ? AND operation = ? AND idempotency_key = ?`,
        input.projectId,
        input.actor.principalId,
        input.adapterId,
        input.operation,
        input.idempotencyKey,
      );
      if (existing) {
        const replayHash = invocationRequestHash(input, existing.adapter_version);
        invariant(existing.request_hash === replayHash, "idempotency_key_reused");
        invariant(
          existing.job_id === input.jobId &&
          (input.adapterVersion === undefined || existing.adapter_version === input.adapterVersion) &&
          existing.claim_id === input.claim.claimId && Number(existing.generation) === input.claim.generation &&
          Number(existing.fencing_token) === input.claim.fencingToken,
          "adapter_invocation_relational_binding_mismatch",
        );
        if (existing.status === "completed") return { replay: true, value: JSON.parse(existing.response_json!) };
        throw new BridgeRuntimeError(existing.status === "started" ? "adapter_invocation_in_progress" : "adapter_invocation_previously_failed");
      }
      const project = this.store.get<{ status: string }>("SELECT status FROM projects WHERE project_id = ?", input.projectId);
      invariant(project?.status === "active", "project_not_active");
      const activeJob = this.guard.assertActiveClaim(input.projectId, input.jobId, input.actor, input.claim);
      invariant(activeJob.claim, "active_claim_required");
      invariant(Date.parse(input.deadline) > Date.parse(this.store.now()), "adapter_deadline_expired");
      const authorizationExpiresAt = requiresGrant
        ? this.consumeAuthorization(
            input,
            manifest.adapterVersion,
            operation.sideEffectClass,
            requestBinding.requestHash,
            requestBinding.sensitiveExternal,
          )
        : undefined;
      this.store.run(
        `INSERT INTO adapter_invocations(
          operation_id, project_id, job_id, adapter_id, adapter_version, operation,
          principal_id, session_id, host_id, claim_id, generation, fencing_token,
          authorization_action_id, idempotency_key, request_hash, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?, ?)`,
        operationId,
        input.projectId,
        input.jobId,
        input.adapterId,
        manifest.adapterVersion,
        input.operation,
        input.actor.principalId,
        input.actor.sessionId,
        input.actor.hostId,
        input.claim.claimId,
        input.claim.generation,
        input.claim.fencingToken,
        input.authorization?.actionId ?? null,
        input.idempotencyKey,
        requestHash,
        this.store.now(),
        this.store.now(),
      );
      return { replay: false as const, leaseExpiresAt: activeJob.claim.leaseExpiresAt, authorizationExpiresAt };
    });
    if (reservation.replay) return reservation.value;
    try {
      const activeJob = this.guard.assertActiveClaim(input.projectId, input.jobId, input.actor, input.claim);
      invariant(activeJob.claim, "active_claim_required");
      const key = executorKey(input.adapterId, manifest.adapterVersion);
      const nowMs = Date.parse(this.store.now());
      const effectiveDeadlineMs = Math.min(
        nowMs + operation.timeoutMs,
        Date.parse(input.deadline),
        Date.parse(activeJob.claim.leaseExpiresAt),
        ...(reservation.authorizationExpiresAt ? [Date.parse(reservation.authorizationExpiresAt)] : []),
      );
      const remainingMs = effectiveDeadlineMs - nowMs;
      invariant(remainingMs > 0, "adapter_deadline_expired");
      const effectiveDeadline = new Date(effectiveDeadlineMs).toISOString();
      const envelope = {
        operationId,
        adapterId: input.adapterId,
        adapterVersion: manifest.adapterVersion,
        operation: input.operation,
        principal: input.actor,
        generation: input.claim.generation,
        claimId: input.claim.claimId,
        fencingToken: input.claim.fencingToken,
        idempotencyKey: input.idempotencyKey,
        deadline: effectiveDeadline,
        inputArtifactIds: input.inputArtifactIds,
        parameters: input.parameters,
        ...(requiresGrant ? {
          fence: { protocol: "bridge2.adapter-fence.v1", required: true },
        } : input.authorization?.actionId ? {
          authorizationActionId: input.authorization.actionId,
        } : {}),
      };
      const fence = requiresGrant ? this.dispatchFence(input, operationId, effectiveDeadline) : undefined;
      const output = this.inProcess.has(key)
        ? await withTimeout(this.inProcess.get(key)!(envelope), remainingMs)
        : this.isolatedBrokers.has(key)
          ? await this.invokeIsolatedBroker(input, manifest.adapterVersion, operationId, effectiveDeadline, remainingMs, fence)
          : await this.invokeStdio(input.adapterId, manifest.adapterVersion, envelope, remainingMs, fence);
      rejectInlineCredentialMaterial(output, "output");
      this.registry.validateOperationOutput(manifest, input.operation, output);
      this.store.transaction(() => {
        this.guard.assertActiveClaim(input.projectId, input.jobId, input.actor, input.claim);
        const completed = this.store.run(
          "UPDATE adapter_invocations SET status = 'completed', response_json = ?, updated_at = ? WHERE operation_id = ? AND status = 'started'",
          JSON.stringify(output),
          this.store.now(),
          operationId,
        );
        invariant(Number(completed.changes) === 1, "adapter_invocation_not_started");
      });
      return output;
    } catch (error) {
      this.store.transaction(() => {
        this.store.run(
          "UPDATE adapter_invocations SET status = 'failed', error_code = ?, updated_at = ? WHERE operation_id = ? AND status = 'started'",
          error instanceof BridgeRuntimeError ? error.code : "adapter_process_failed",
          this.store.now(),
          operationId,
        );
      });
      throw error;
    }
  }

  private replayExistingInvocation(input: AdapterInvocation): { found: false } | { found: true; value: unknown } {
    return this.store.transaction(() => {
      const existing = this.store.get<{
        request_hash: string;
        status: string;
        response_json: string | null;
        job_id: string;
        adapter_version: string;
        claim_id: string;
        generation: number;
        fencing_token: number;
      }>(
        `SELECT request_hash, status, response_json, job_id, adapter_version,
                claim_id, generation, fencing_token
         FROM adapter_invocations
         WHERE project_id = ? AND principal_id = ? AND adapter_id = ? AND operation = ? AND idempotency_key = ?`,
        input.projectId,
        input.actor.principalId,
        input.adapterId,
        input.operation,
        input.idempotencyKey,
      );
      if (!existing) return { found: false as const };
      invariant(existing.request_hash === invocationRequestHash(input, existing.adapter_version), "idempotency_key_reused");
      invariant(
        existing.job_id === input.jobId &&
        (input.adapterVersion === undefined || existing.adapter_version === input.adapterVersion) &&
        existing.claim_id === input.claim.claimId && Number(existing.generation) === input.claim.generation &&
        Number(existing.fencing_token) === input.claim.fencingToken,
        "adapter_invocation_relational_binding_mismatch",
      );
      if (existing.status === "completed") return { found: true as const, value: JSON.parse(existing.response_json!) };
      throw new BridgeRuntimeError(existing.status === "started" ? "adapter_invocation_in_progress" : "adapter_invocation_previously_failed");
    });
  }

  private validateAdapterRequest(
    input: AdapterInvocation,
    sensitiveData: "forbidden" | "local_only" | "approved_external_only" | "supported",
    external: boolean,
  ): { requestHash: string; sensitiveExternal: boolean } {
    invariant(new Set(input.inputArtifactIds).size === input.inputArtifactIds.length, "duplicate_adapter_input_artifact");
    const job = this.store.get<{ project_id: string; document_json: string }>(
      "SELECT project_id, document_json FROM review_jobs WHERE job_id = ?",
      input.jobId,
    );
    invariant(job?.project_id === input.projectId, "job_project_mismatch");
    const targetIds = (JSON.parse(job.document_json) as { target: { artifactIds: string[] } }).target.artifactIds;
    const attached = this.store.all<{ artifact_id: string }>(
      "SELECT artifact_id FROM job_inputs WHERE job_id = ?",
      input.jobId,
    ).map((row) => row.artifact_id);
    const permitted = new Set([...targetIds, ...attached]);
    let containsSensitive = false;
    for (const artifactId of input.inputArtifactIds) {
      const artifact = this.store.get<{ project_id: string; sensitivity: string }>(
        "SELECT project_id, sensitivity FROM artifacts WHERE artifact_id = ?",
        artifactId,
      );
      invariant(artifact?.project_id === input.projectId, "adapter_input_artifact_not_found");
      invariant(permitted.has(artifactId), "adapter_input_artifact_not_job_scoped");
      if (artifact.sensitivity === "confidential" || artifact.sensitivity === "restricted") containsSensitive = true;
    }
    if (containsSensitive) {
      invariant(sensitiveData !== "forbidden", "adapter_sensitive_data_forbidden");
      if (external) invariant(sensitiveData !== "local_only", "adapter_sensitive_data_local_only");
    }
    return {
      requestHash: hashCanonical({ inputArtifactIds: input.inputArtifactIds, parameters: input.parameters }),
      sensitiveExternal: containsSensitive && external,
    };
  }

  private consumeAuthorization(
    input: AdapterInvocation,
    adapterVersion: string,
    sideEffectClass: string,
    requestHash: string,
    sensitiveExternal: boolean,
  ): string {
    const actionId = input.authorization?.actionId;
    const network = input.networkContext;
    invariant(actionId && network, "adapter_action_not_authorized");
    const row = this.store.get<{
      project_id: string;
      job_id: string;
      principal_id: string;
      session_id: string;
      host_id: string;
      claim_id: string;
      generation: number;
      fencing_token: number;
      adapter_id: string;
      adapter_version: string;
      operation: string;
      side_effect_class: string;
      origin: string;
      destination: string;
      condition_hash: string;
      request_hash: string;
      input_artifact_ids_json: string;
      sensitive_external: number;
      approval_prompt_class: string | null;
      status: string;
      expires_at: string;
    }>("SELECT * FROM adapter_action_authorizations WHERE action_id = ?", actionId);
    invariant(row && row.status === "authorized", "adapter_action_not_authorized");
    invariant(Date.parse(row.expires_at) > Date.parse(this.store.now()), "adapter_action_authorization_expired");
    invariant(
      row.project_id === input.projectId && row.job_id === input.jobId &&
      row.principal_id === input.actor.principalId && row.session_id === input.actor.sessionId && row.host_id === input.actor.hostId &&
      row.claim_id === input.claim.claimId && Number(row.generation) === input.claim.generation &&
      Number(row.fencing_token) === input.claim.fencingToken && row.adapter_id === input.adapterId &&
      row.adapter_version === adapterVersion && row.operation === input.operation && row.side_effect_class === sideEffectClass &&
      row.origin === network.origin && row.destination === network.destination &&
      row.condition_hash === hashCanonical(network.conditions) &&
      row.request_hash === requestHash &&
      canonicalEqual(JSON.parse(row.input_artifact_ids_json), input.inputArtifactIds) &&
      Boolean(row.sensitive_external) === sensitiveExternal &&
      row.approval_prompt_class === (network.approvalPromptClass ?? null),
      "adapter_action_authorization_binding_mismatch",
    );
    const consumed = this.store.run(
      "UPDATE adapter_action_authorizations SET status = 'consumed', consumed_at = ? WHERE action_id = ? AND status = 'authorized'",
      this.store.now(),
      actionId,
    );
    invariant(Number(consumed.changes) === 1, "adapter_action_not_authorized");
    return row.expires_at;
  }

  private dispatchFence(input: AdapterInvocation, operationId: string, effectiveDeadline: string): DispatchFence {
    const actionId = input.authorization?.actionId;
    invariant(actionId && input.networkContext, "adapter_action_not_authorized");
    return {
      verify: () => {
        this.guard.assertActiveClaim(input.projectId, input.jobId, input.actor, input.claim);
        invariant(Date.parse(effectiveDeadline) > Date.parse(this.store.now()), "adapter_deadline_expired");
        const action = this.store.get<{
          project_id: string;
          job_id: string;
          principal_id: string;
          claim_id: string;
          generation: number;
          fencing_token: number;
          adapter_id: string;
          operation: string;
          status: string;
          expires_at: string;
        }>("SELECT * FROM adapter_action_authorizations WHERE action_id = ?", actionId);
        invariant(
          action?.project_id === input.projectId && action.job_id === input.jobId &&
          action.principal_id === input.actor.principalId && action.claim_id === input.claim.claimId &&
          Number(action.generation) === input.claim.generation && Number(action.fencing_token) === input.claim.fencingToken &&
          action.adapter_id === input.adapterId && action.operation === input.operation && action.status === "consumed",
          "adapter_dispatch_fence_invalid",
        );
        invariant(Date.parse(action.expires_at) > Date.parse(this.store.now()), "adapter_action_authorization_expired");
      },
      grant: {
        protocol: "bridge2.adapter-fence-grant.v1",
        operationId,
        generation: input.claim.generation,
        claimId: input.claim.claimId,
        fencingToken: input.claim.fencingToken,
        deadline: effectiveDeadline,
        authorization: {
          actionId,
          origin: input.networkContext.origin,
          destination: input.networkContext.destination,
          conditions: { ...input.networkContext.conditions },
          ...(input.networkContext.approvalPromptClass
            ? { approvalPromptClass: input.networkContext.approvalPromptClass }
            : {}),
        },
      },
    };
  }

  private invokeStdio(
    adapterId: string,
    adapterVersion: string,
    envelope: Record<string, unknown>,
    timeoutMs: number,
    fence?: DispatchFence,
  ): Promise<unknown> {
    const launcher = this.stdio.get(executorKey(adapterId, adapterVersion));
    invariant(launcher, "adapter_launcher_not_registered");
    return this.invokeChildProcess(launcher, envelope, timeoutMs, fence);
  }

  private invokeIsolatedBroker(
    input: AdapterInvocation,
    adapterVersion: string,
    operationId: string,
    effectiveDeadline: string,
    timeoutMs: number,
    fence?: DispatchFence,
  ): Promise<unknown> {
    const launcher = this.isolatedBrokers.get(executorKey(input.adapterId, adapterVersion));
    invariant(launcher, "isolated_broker_not_registered");
    const authorization = input.authorization;
    const network = input.networkContext;
    if (authorization?.actionId) invariant(network, "adapter_action_not_authorized");
    const envelope = {
      protocol: "bridge2.isolated-adapter-action.v1",
      operationId,
      adapter: {
        adapterId: input.adapterId,
        adapterVersion,
        operation: input.operation,
      },
      ...(!fence && authorization?.actionId && network ? {
        authorization: {
          actionId: authorization.actionId,
          origin: network.origin,
          destination: network.destination,
          conditions: { ...network.conditions },
          ...(network.approvalPromptClass ? { approvalPromptClass: network.approvalPromptClass } : {}),
        },
      } : {}),
      ...(!fence && !authorization?.actionId && network ? {
        networkContext: {
          origin: network.origin,
          destination: network.destination,
          conditions: { ...network.conditions },
          ...(network.approvalPromptClass ? { approvalPromptClass: network.approvalPromptClass } : {}),
        },
      } : {}),
      generation: input.claim.generation,
      claimId: input.claim.claimId,
      fencingToken: input.claim.fencingToken,
      deadline: effectiveDeadline,
      ...(fence ? { fence: { protocol: "bridge2.adapter-fence.v1", required: true } } : {}),
      idempotencyKey: input.idempotencyKey,
      inputArtifactIds: [...input.inputArtifactIds],
      parameters: input.parameters,
    };
    return this.invokeChildProcess(launcher, envelope, timeoutMs, fence);
  }

  private invokeChildProcess(
    launcher: StdioLauncher,
    envelope: Record<string, unknown>,
    timeoutMs: number,
    fence?: DispatchFence,
  ): Promise<unknown> {
    const environment: NodeJS.ProcessEnv = {};
    for (const name of ["SystemRoot", "WINDIR"]) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge2-adapter-"));
    environment.TMP = workingDirectory;
    environment.TEMP = workingDirectory;
    return new Promise((resolve, reject) => {
      const child = spawn(launcher.command, launcher.args ?? [], {
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        env: environment,
        cwd: workingDirectory,
      });
      let stdout = "";
      let handshakeBuffer = "";
      let stderrBytes = 0;
      let outputBytes = 0;
      let fenceGranted = fence === undefined;
      let settled = false;
      let monitor: NodeJS.Timeout | undefined;
      const clearSupervision = (): void => {
        clearTimeout(timer);
        if (monitor) clearInterval(monitor);
      };
      const fail = (error: BridgeRuntimeError): void => {
        if (settled) return;
        settled = true;
        clearSupervision();
        terminateAdapterProcess(child);
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(new BridgeRuntimeError("adapter_timeout"));
      }, Math.min(timeoutMs, 86_400_000));
      if (fence) {
        monitor = setInterval(() => {
          try { fence.verify(); }
          catch (error) {
            fail(error instanceof BridgeRuntimeError ? error : new BridgeRuntimeError("adapter_dispatch_fence_invalid"));
          }
        }, 25);
        monitor.unref();
      }
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        outputBytes += Buffer.byteLength(chunk, "utf8");
        if (outputBytes > 1_048_576) {
          fail(new BridgeRuntimeError("adapter_output_limit_exceeded"));
          return;
        }
        if (fence && !fenceGranted) {
          handshakeBuffer += chunk;
          const newline = handshakeBuffer.indexOf("\n");
          if (newline < 0) return;
          const requestText = handshakeBuffer.slice(0, newline);
          const remainder = handshakeBuffer.slice(newline + 1);
          let request: { protocol?: string; operationId?: string };
          try { request = JSON.parse(requestText) as { protocol?: string; operationId?: string }; }
          catch {
            fail(new BridgeRuntimeError("adapter_fence_handshake_invalid"));
            return;
          }
          if (request.protocol !== "bridge2.adapter-fence-request.v1" || request.operationId !== envelope.operationId) {
            fail(new BridgeRuntimeError("adapter_fence_handshake_invalid"));
            return;
          }
          try { fence.verify(); }
          catch (error) {
            fail(error instanceof BridgeRuntimeError ? error : new BridgeRuntimeError("adapter_dispatch_fence_invalid"));
            return;
          }
          fenceGranted = true;
          stdout += remainder;
          child.stdin.end(`${JSON.stringify(fence.grant)}\n`);
          return;
        }
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; });
      child.once("error", (error) => {
        fail(new BridgeRuntimeError("adapter_process_failed", { cause: error.message }));
      });
      child.once("close", (code) => {
        clearSupervision();
        fs.rmSync(workingDirectory, { recursive: true, force: true });
        if (settled) return;
        settled = true;
        if (code !== 0) return reject(new BridgeRuntimeError("adapter_process_failed", { code, diagnosticsBytes: stderrBytes }));
        if (!fenceGranted) return reject(new BridgeRuntimeError("adapter_fence_handshake_required"));
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new BridgeRuntimeError("adapter_output_invalid_json")); }
      });
      if (fence) child.stdin.write(`${JSON.stringify(envelope)}\n`);
      else child.stdin.end(`${JSON.stringify(envelope)}\n`);
    });
  }
}

function terminateAdapterProcess(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (pid !== undefined && process.platform === "win32") {
    const root = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    spawnSync(path.join(root, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      env: { SystemRoot: root, WINDIR: root },
    });
  } else if (pid !== undefined) {
    try { process.kill(-pid, "SIGKILL"); }
    catch { child.kill("SIGKILL"); }
  }
  if (!child.killed) child.kill("SIGKILL");
}

function executableAvailable(command: string): boolean {
  try {
    const stat = fs.statSync(command);
    if (!stat.isFile()) return false;
    fs.accessSync(command, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function invocationRequestHash(input: AdapterInvocation, adapterVersion: string): string {
  return hashCanonical({
    adapterId: input.adapterId,
    adapterVersion,
    operation: input.operation,
    principalId: input.actor.principalId,
    generation: input.claim.generation,
    claimId: input.claim.claimId,
    fencingToken: input.claim.fencingToken,
    idempotencyKey: input.idempotencyKey,
    deadline: input.deadline,
    inputArtifactIds: input.inputArtifactIds,
    parameters: input.parameters,
    authorizationActionId: input.authorization?.actionId ?? null,
    networkContext: input.networkContext ?? null,
  });
}

function executorKey(adapterId: string, adapterVersion: string): string {
  return `${adapterId}\u0000${adapterVersion}`;
}

function withTimeout<T>(value: T | Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BridgeRuntimeError("adapter_timeout")), timeoutMs);
    Promise.resolve(value).then(
      (result) => { clearTimeout(timer); resolve(result); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
