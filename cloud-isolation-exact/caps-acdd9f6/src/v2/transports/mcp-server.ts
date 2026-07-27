import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asErrorCode, invariant } from "../core/errors.js";
import type { PrincipalRef } from "../core/types.js";
import type { TransportContext } from "../identity/identity-service.js";
import type { BridgeRuntime } from "../runtime.js";
import { assertToolAuthorized, deriveProfiles, visibleToolNames, type McpProfile } from "./profiles.js";

export interface McpConnectionContext {
  projectId: string;
  actor: PrincipalRef;
  transport: TransportContext;
  adminEnabled?: boolean;
}

export function connectionProfiles(runtime: BridgeRuntime, context: McpConnectionContext): McpProfile[] {
  const authorization = runtime.identity.authorize(context.projectId, context.actor, [], context.transport);
  return deriveProfiles(authorization.roles, { adminEnabled: context.adminEnabled });
}

export function availableRuntimeTools(runtime: BridgeRuntime, context: McpConnectionContext): string[] {
  return visibleToolNames(connectionProfiles(runtime, context));
}

export function createRuntimeMcpServer(runtime: BridgeRuntime, context: McpConnectionContext): McpServer {
  const profiles = connectionProfiles(runtime, context);
  const visible = new Set(visibleToolNames(profiles));
  const server = new McpServer({ name: "bridge-2-runtime", version: "0.1.0-draft.4" });
  const run = async (toolName: string, action: () => unknown | Promise<unknown>) => {
    try {
      const current = connectionProfiles(runtime, context);
      assertToolAuthorized(toolName, current);
      const value = await action();
      return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify({ ok: false, code: asErrorCode(error) }) }],
      };
    }
  };
  const register = (name: string, config: any, handler: (input: any) => unknown | Promise<unknown>): void => {
    if (visible.has(name)) server.registerTool(name, config, (input) => run(name, () => handler(input)));
  };

  register("bridge_v2_status", {
    description: "Read the local project generation and runtime status.",
  }, () => runtime.store.get("SELECT project_id AS projectId, active_generation AS generation, status FROM projects WHERE project_id = ?", context.projectId));

  register("bridge_v2_whoami", {
    description: "Read the server-bound principal, active project roles, and derived MCP profiles.",
  }, () => {
    const authorization = runtime.identity.authorize(context.projectId, context.actor, [], context.transport);
    return {
      projectId: context.projectId,
      actor: authorization.actor,
      roles: authorization.roles,
      profiles: deriveProfiles(authorization.roles, { adminEnabled: context.adminEnabled }),
    };
  });

  register("bridge_v2_get_job", {
    description: "Read one review or collaboration job.",
    inputSchema: { jobId: z.string() },
  }, ({ jobId }) => {
    const job = runtime.jobs.require(jobId);
    if (job.projectId !== context.projectId) throw new Error("job_project_mismatch");
    return job;
  });

  register("bridge_v2_list_jobs", {
    description: "List jobs in the server-bound project only.",
  }, () => runtime.jobs.list(context.projectId));

  register("bridge_v2_get_artifact", {
    description: "Read one immutable artifact in the server-bound project.",
    inputSchema: { artifactId: z.string() },
  }, ({ artifactId }) => {
    const artifact = runtime.artifacts.require(artifactId);
    invariant(artifact.projectId === context.projectId, "artifact_project_mismatch");
    return artifact;
  });

  register("bridge_v2_list_artifacts", {
    description: "List immutable artifacts in the server-bound project only.",
  }, () => runtime.artifacts.list(context.projectId));

  register("bridge_v2_list_events", {
    description: "Read the immutable event journal.",
  }, () => runtime.journal.list(context.projectId));

  register("bridge_v2_list_operation_reports", {
    description: "Read immutable recovery and migration operation reports.",
  }, () => runtime.store.all<{ report_json: string }>(
    "SELECT report_json FROM runtime_operation_reports WHERE project_id = ? ORDER BY occurred_at, report_id",
    context.projectId,
  ).map((row) => JSON.parse(row.report_json)));

  register("bridge_v2_get_approval_grant", {
    description: "Read one immutable/bounded approval grant in the server-bound project.",
    inputSchema: { grantId: z.string() },
  }, ({ grantId }) => {
    const grant = runtime.approvals.require(grantId);
    invariant(grant.projectId === context.projectId, "approval_grant_project_mismatch");
    return grant;
  });

  register("bridge_v2_list_approval_grants", {
    description: "List approval grants in the server-bound project.",
  }, () => runtime.store.all<{ document_json: string }>(
    "SELECT document_json FROM approval_grants WHERE project_id = ? ORDER BY created_at, grant_id",
    context.projectId,
  ).map((row) => JSON.parse(row.document_json)));

  register("bridge_v2_get_adapter", {
    description: "Read a registered adapter manifest by ID and optional immutable version.",
    inputSchema: { adapterId: z.string(), adapterVersion: z.string().optional() },
  }, ({ adapterId, adapterVersion }) => runtime.adapters.require(adapterId, adapterVersion));

  register("bridge_v2_list_adapters", {
    description: "List active adapter manifests.",
  }, () => runtime.adapters.list());

  register("bridge_v2_register_artifact", {
    description: "Register immutable artifact metadata and provenance.",
    inputSchema: { artifact: z.any(), idempotencyKey: z.string() },
  }, ({ artifact, idempotencyKey }) => {
    invariant(artifact?.projectId === context.projectId, "artifact_project_mismatch");
    return runtime.artifacts.register({ actor: context.actor, artifact, idempotencyKey });
  });

  register("bridge_v2_create_job", {
    description: "Create a versioned review or collaboration job.",
    inputSchema: { input: z.any() },
  }, ({ input }) => runtime.jobs.create({ ...input, projectId: context.projectId, actor: context.actor }));

  register("bridge_v2_make_claimable", {
    description: "Move a queued job to claimable after policy checks.",
    inputSchema: { jobId: z.string(), idempotencyKey: z.string() },
  }, ({ jobId, idempotencyKey }) => runtime.jobs.makeClaimable({ projectId: context.projectId, jobId, actor: context.actor, idempotencyKey }));

  register("bridge_v2_claim_job", {
    description: "Atomically claim work with generation and fencing.",
    inputSchema: { jobId: z.string(), leaseMs: z.number().optional(), idempotencyKey: z.string() },
  }, ({ jobId, leaseMs, idempotencyKey }) => runtime.jobs.claim({ projectId: context.projectId, jobId, actor: context.actor, leaseMs, idempotencyKey }));

  register("bridge_v2_release_job", {
    description: "Explicitly release an unstarted claim using its generation and fencing token.",
    inputSchema: { jobId: z.string(), claim: z.any(), idempotencyKey: z.string() },
  }, ({ jobId, claim, idempotencyKey }) => runtime.jobs.releaseClaim({
    projectId: context.projectId,
    jobId,
    actor: context.actor,
    claim,
    idempotencyKey,
  }));

  register("bridge_v2_start_job", {
    description: "Start a currently claimed job.",
    inputSchema: { jobId: z.string(), claim: z.any(), idempotencyKey: z.string() },
  }, ({ jobId, claim, idempotencyKey }) => runtime.jobs.start({ projectId: context.projectId, jobId, actor: context.actor, claim, idempotencyKey }));

  register("bridge_v2_await_input", {
    description: "Record a blocking input request.",
    inputSchema: { jobId: z.string(), claim: z.any(), reason: z.string(), idempotencyKey: z.string() },
  }, ({ jobId, claim, reason, idempotencyKey }) => runtime.jobs.awaitInput({ projectId: context.projectId, jobId, actor: context.actor, claim, reason, idempotencyKey }));

  register("bridge_v2_resume_job", {
    description: "Attach registered input artifacts and resume work.",
    inputSchema: { jobId: z.string(), claim: z.any(), inputArtifactIds: z.array(z.string()), idempotencyKey: z.string() },
  }, ({ jobId, claim, inputArtifactIds, idempotencyKey }) => runtime.jobs.resume({ projectId: context.projectId, jobId, actor: context.actor, claim, inputArtifactIds, idempotencyKey }));

  register("bridge_v2_complete_job", {
    description: "Complete running work with result artifacts, disagreements, and citations.",
    inputSchema: { jobId: z.string(), claim: z.any(), result: z.any(), idempotencyKey: z.string() },
  }, ({ jobId, claim, result, idempotencyKey }) => runtime.jobs.complete({ projectId: context.projectId, jobId, actor: context.actor, claim, result, idempotencyKey }));

  register("bridge_v2_fail_job", {
    description: "Fail running work with a durable reason.",
    inputSchema: { jobId: z.string(), claim: z.any(), reason: z.string(), retryable: z.boolean(), idempotencyKey: z.string() },
  }, ({ jobId, claim, reason, retryable, idempotencyKey }) => runtime.jobs.fail({ projectId: context.projectId, jobId, actor: context.actor, claim, reason, retryable, idempotencyKey }));

  register("bridge_v2_cancel_job", {
    description: "Cancel a non-terminal job when the bound principal is the requester or an owner.",
    inputSchema: { jobId: z.string(), reason: z.string(), idempotencyKey: z.string() },
  }, ({ jobId, reason, idempotencyKey }) => runtime.jobs.cancel({
    projectId: context.projectId,
    jobId,
    actor: context.actor,
    reason,
    idempotencyKey,
  }));

  register("bridge_v2_invoke_adapter", {
    description: "Invoke a server-configured, version-bound adapter under an active fenced claim.",
    inputSchema: { input: z.any() },
  }, ({ input }) => runtime.adapterHost.invoke({ ...input, projectId: context.projectId, actor: context.actor }));

  register("bridge_v2_authorize_browser_action", {
    description: "Evaluate and atomically consume a bounded browser approval grant; never dispatches the action.",
    inputSchema: { input: z.any() },
  }, ({ input }) => runtime.approvals.authorizeBrowserAction({ ...input, projectId: context.projectId, actor: context.actor }));

  register("bridge_v2_authorize_adapter_action", {
    description: "Evaluate a bounded one-use approval for a side-effecting adapter operation.",
    inputSchema: { input: z.any() },
  }, ({ input }) => runtime.approvals.authorizeAdapterAction({ ...input, projectId: context.projectId, actor: context.actor }));

  register("bridge_v2_amend_instructions", {
    description: "Create the next immutable instruction version under owner policy.",
    inputSchema: { jobId: z.string(), text: z.string(), materialAmendment: z.boolean(), idempotencyKey: z.string() },
  }, ({ jobId, text, materialAmendment, idempotencyKey }) => runtime.jobs.amendInstructions({
    projectId: context.projectId,
    jobId,
    actor: context.actor,
    text,
    materialAmendment,
    idempotencyKey,
  }));

  register("bridge_v2_expire_claim", {
    description: "Expire a claim only after the authoritative server clock reaches its lease deadline.",
    inputSchema: { jobId: z.string(), idempotencyKey: z.string() },
  }, ({ jobId, idempotencyKey }) => runtime.jobs.expireClaim({
    projectId: context.projectId,
    jobId,
    actor: context.actor,
    idempotencyKey,
  }));

  register("bridge_v2_create_approval_grant", {
    description: "Create a bounded, claim-bound approval grant as the project owner.",
    inputSchema: { input: z.any() },
  }, ({ input }) => runtime.approvals.createGrant({ ...input, projectId: context.projectId, actor: context.actor }));

  register("bridge_v2_revoke_approval_grant", {
    description: "Revoke an active approval grant and its unused action authorizations.",
    inputSchema: { grantId: z.string(), reason: z.string(), idempotencyKey: z.string() },
  }, ({ grantId, reason, idempotencyKey }) => runtime.approvals.revoke({
    projectId: context.projectId,
    grantId,
    actor: context.actor,
    reason,
    idempotencyKey,
  }));

  register("bridge_v2_register_adapter", {
    description: "Register an immutable adapter manifest version; executors remain server-configured.",
    inputSchema: { manifest: z.any(), idempotencyKey: z.string() },
  }, ({ manifest, idempotencyKey }) => runtime.adapters.register({
    projectId: context.projectId,
    actor: context.actor,
    manifest,
    idempotencyKey,
  }));

  register("bridge_v2_backup", {
    description: "Create a local source-only backup. Full encrypted backup remains on the local CLI so key bytes never cross MCP.",
    inputSchema: { input: z.any() },
  }, ({ input }) => {
    invariant(input?.backupType === "source_only" && input.encryption === undefined, "mcp_full_backup_requires_cli_key_custody");
    return runtime.backups.create({ ...input, projectId: context.projectId, actor: context.actor });
  });

  register("bridge_v2_restore_plan", {
    description: "Verify a full backup and return a non-activating isolated restore plan.",
    inputSchema: {
      manifestPath: z.string(),
      targetHostId: z.string(),
      mode: z.enum(["new_host", "recovery_drill"]),
    },
  }, ({ manifestPath, targetHostId, mode }) => {
      const backup = runtime.backups.verify(manifestPath);
      invariant(backup.projectId === context.projectId, "restore_project_mismatch");
      invariant(backup.backupType === "full", "full_backup_required_for_state_restore");
      invariant(backup.destinations.some((destination) => destination.status === "verified"), "verified_backup_required_for_restore");
      return {
        schemaVersion: "0.1.0-draft.4",
        projectId: context.projectId,
        backupId: backup.backupId,
        targetHostId,
        mode,
        expectedSourceGeneration: backup.generation,
        expectedEventSequence: backup.consistency.eventSequence,
        encryptionMode: backup.encryption.mode,
        activation: "excluded",
        steps: ["verify_backup", "restore_source", "restore_state", "migrate", "doctor", "contract_tests"],
      };
    });

  register("bridge_v2_migration_plan", {
    description: "Read the current forward-only migration plan.",
  }, () => runtime.migrations.plan());

  register("bridge_v2_migrate", {
    description: "Apply forward migrations with an owner-authorized verified full-backup precondition.",
    inputSchema: { backupManifestPath: z.string(), idempotencyKey: z.string() },
  }, ({ backupManifestPath, idempotencyKey }) => runtime.migrations.apply({
    projectId: context.projectId,
    actor: context.actor,
    backupManifestPath,
    idempotencyKey,
  }));

  register("bridge_v2_doctor", {
    description: "Run deterministic read-only health checks.",
    inputSchema: {
      sourceRoot: z.string().optional(),
      recoveryRoot: z.string().optional(),
      recoveryKeyDirectories: z.array(z.string()).optional(),
    },
  }, ({ sourceRoot, recoveryRoot, recoveryKeyDirectories }) => runtime.doctor.run({
    projectId: context.projectId,
    hostId: context.actor.hostId,
    actor: context.actor,
    transport: context.transport,
    sourceRoot,
    recoveryRoot,
    recoveryKeyDirectories,
  }));

  register("bridge_v2_takeover", {
    description: "Advance generation under an owner-confirmed approval record.",
    inputSchema: {
      expectedGeneration: z.number(),
      newGeneration: z.number(),
      approvalRef: z.string(),
      targetHostId: z.string(),
      restoreId: z.string().optional(),
      recoveryHost: z.any().optional(),
      recoverySession: z.any().optional(),
      reason: z.string(),
      idempotencyKey: z.string(),
    },
  }, (input) => runtime.jobs.advanceGeneration({ ...input, projectId: context.projectId, actor: context.actor }));

  register("bridge_v2_reconcile_takeover", {
    description: "Attach a later immutable reconciliation report to a forced active-project takeover.",
    inputSchema: {
      approvalRef: z.string(),
      reportArtifactId: z.string(),
      summary: z.string(),
      idempotencyKey: z.string(),
    },
  }, (input) => runtime.jobs.reconcileTakeover({ ...input, projectId: context.projectId, actor: context.actor }));

  register("bridge_v2_register_principal", {
    description: "Register a principal through the disabled-by-default administrator profile.",
    inputSchema: { principal: z.any(), idempotencyKey: z.string() },
  }, ({ principal, idempotencyKey }) => runtime.identity.registerPrincipal({
    projectId: context.projectId,
    actor: context.actor,
    principal,
    idempotencyKey,
  }));

  register("bridge_v2_assign_role", {
    description: "Assign a project role through the disabled-by-default administrator profile.",
    inputSchema: { principalId: z.string(), role: z.enum(["owner", "administrator", "collaborator", "reviewer", "worker", "observer"]), idempotencyKey: z.string() },
  }, ({ principalId, role, idempotencyKey }) => runtime.identity.assignRole({
    projectId: context.projectId,
    actor: context.actor,
    principalId,
    role,
    idempotencyKey,
  }));

  register("bridge_v2_revoke_role", {
    description: "Revoke one active project role while preserving its provenance row.",
    inputSchema: { principalId: z.string(), role: z.enum(["owner", "administrator", "collaborator", "reviewer", "worker", "observer"]), idempotencyKey: z.string() },
  }, ({ principalId, role, idempotencyKey }) => runtime.identity.revokeRole({
    projectId: context.projectId,
    actor: context.actor,
    principalId,
    role,
    idempotencyKey,
  }));

  register("bridge_v2_disable_principal", {
    description: "Disable a principal, revoke its sessions, and preserve-revoke its active roles.",
    inputSchema: { principalId: z.string(), idempotencyKey: z.string() },
  }, ({ principalId, idempotencyKey }) => runtime.identity.disablePrincipal({
    projectId: context.projectId,
    actor: context.actor,
    principalId,
    idempotencyKey,
  }));

  register("bridge_v2_set_host_status", {
    description: "Retire or quarantine a host and revoke its active sessions.",
    inputSchema: { hostId: z.string(), status: z.enum(["retired", "quarantined"]), idempotencyKey: z.string() },
  }, ({ hostId, status, idempotencyKey }) => runtime.identity.setHostStatus({
    projectId: context.projectId,
    actor: context.actor,
    hostId,
    status,
    idempotencyKey,
  }));

  register("bridge_v2_register_host", {
    description: "Register a host through the disabled-by-default administrator profile.",
    inputSchema: { host: z.any(), idempotencyKey: z.string() },
  }, ({ host, idempotencyKey }) => runtime.identity.registerHost({
    projectId: context.projectId,
    actor: context.actor,
    host,
    idempotencyKey,
  }));

  register("bridge_v2_create_session", {
    description: "Create a server-bound authenticated session record through the administrator profile.",
    inputSchema: { session: z.any(), idempotencyKey: z.string() },
  }, ({ session, idempotencyKey }) => runtime.identity.createSession({
    projectId: context.projectId,
    actor: context.actor,
    session,
    idempotencyKey,
  }));

  register("bridge_v2_revoke_session", {
    description: "Revoke an authenticated session through the administrator profile.",
    inputSchema: { sessionId: z.string(), idempotencyKey: z.string() },
  }, ({ sessionId, idempotencyKey }) => runtime.identity.revokeSession({
    projectId: context.projectId,
    actor: context.actor,
    sessionId,
    idempotencyKey,
  }));

  return server;
}
