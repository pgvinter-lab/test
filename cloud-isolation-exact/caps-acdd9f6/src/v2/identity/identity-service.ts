import { deepCopy } from "../core/canonical.js";
import { invariant } from "../core/errors.js";
import { newId } from "../core/ids.js";
import { requireIdentifier, requireOpaqueCredentialReference, requireSha256, requireTimestamp } from "../core/validation.js";
import type {
  HostRecord,
  IdentityAuthorization,
  PrincipalRecord,
  PrincipalRef,
  SessionRecord,
} from "../core/types.js";
import type { ProjectRole } from "../core/constants.js";
import type { ContractSchemaRegistry } from "../core/schema-registry.js";
import type { BridgeStore } from "../storage/store.js";

export interface BootstrapInput {
  projectId: string;
  principal: PrincipalRecord;
  host: HostRecord;
  session: SessionRecord;
  idempotencyKey: string;
}

export interface TransportContext {
  transport: "stdio" | "streamable_http";
  transportSessionId: string;
  serverInstanceId: string;
}

export class IdentityService {
  constructor(
    private readonly store: BridgeStore,
    private readonly schemas: ContractSchemaRegistry,
  ) {}

  bootstrapOwner(input: BootstrapInput): PrincipalRef {
    this.validateBootstrap(input);
    const actor: PrincipalRef = {
      principalId: input.principal.principalId,
      sessionId: input.session.sessionId,
      hostId: input.host.hostId,
    };
    return this.store.mutateIdempotent({
      projectId: input.projectId,
      actor,
      operation: "identity.bootstrap_owner",
      idempotencyKey: input.idempotencyKey,
      request: input,
      run: () => {
        invariant(!this.store.get("SELECT project_id FROM projects LIMIT 1"), "store_already_bootstrapped");
        const at = this.store.now();
        this.store.run(
          "INSERT INTO projects(project_id, active_generation, next_fencing_token, status, created_at, updated_at) VALUES (?, 1, 0, 'active', ?, ?)",
          input.projectId,
          at,
          at,
        );
        this.insertPrincipal(input.principal);
        this.insertHost(input.host);
        this.insertSession(input.session);
        this.store.run(
          `INSERT INTO project_roles(
            role_grant_id, project_id, principal_id, role, status, granted_at,
            granted_by_principal_id, granted_by_session_id, granted_by_host_id, granted_generation
          ) VALUES (?, ?, ?, 'owner', 'active', ?, ?, ?, ?, 1)`,
          newId("role.grant"),
          input.projectId,
          input.principal.principalId,
          at,
          input.principal.principalId,
          input.session.sessionId,
          input.host.hostId,
        );
        return deepCopy(actor);
      },
    });
  }

  registerPrincipal(args: {
    projectId: string;
    actor: PrincipalRef;
    principal: PrincipalRecord;
    idempotencyKey: string;
  }): PrincipalRecord {
    this.authorize(args.projectId, args.actor, ["owner", "administrator"]);
    this.validatePrincipal(args.principal, args.projectId, "observer");
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: "identity.register_principal",
      idempotencyKey: args.idempotencyKey,
      request: args.principal,
      run: () => {
        this.authorize(args.projectId, args.actor, ["owner", "administrator"]);
        this.validatePrincipal(args.principal, args.projectId, "observer");
        this.insertPrincipal(args.principal);
        return deepCopy(args.principal);
      },
    });
  }

  registerHost(args: {
    projectId: string;
    actor: PrincipalRef;
    host: HostRecord;
    idempotencyKey: string;
  }): HostRecord {
    this.authorize(args.projectId, args.actor, ["owner", "administrator"]);
    this.validateHost(args.host);
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: "identity.register_host",
      idempotencyKey: args.idempotencyKey,
      request: args.host,
      run: () => {
        this.authorize(args.projectId, args.actor, ["owner", "administrator"]);
        this.validateHost(args.host);
        this.insertHost(args.host);
        return deepCopy(args.host);
      },
    });
  }

  createSession(args: {
    projectId: string;
    actor: PrincipalRef;
    session: SessionRecord;
    idempotencyKey: string;
  }): SessionRecord {
    const authorization = this.authorize(args.projectId, args.actor);
    invariant(
      authorization.actor.principalId === args.session.principalId || authorization.roles.some((role) => role === "owner" || role === "administrator"),
      "session_creation_not_authorized",
    );
    this.validateSession(args.session);
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: "identity.create_session",
      idempotencyKey: args.idempotencyKey,
      request: args.session,
      run: () => {
        const current = this.authorize(args.projectId, args.actor);
        invariant(
          current.actor.principalId === args.session.principalId || current.roles.some((role) => role === "owner" || role === "administrator"),
          "session_creation_not_authorized",
        );
        this.validateSession(args.session);
        this.insertSession(args.session);
        return deepCopy(args.session);
      },
    });
  }

  /** Called only from the atomic, owner-authorized recovered-generation takeover. */
  insertRecoveryBindingWithinTakeover(args: {
    projectId: string;
    authorizedOwner: PrincipalRef;
    host: HostRecord;
    session: SessionRecord;
  }): PrincipalRef {
    this.store.assertWriteTransaction();
    this.validateHost(args.host);
    this.validateSession(args.session);
    invariant(args.host.status === "active" && args.session.status === "active", "recovery_binding_not_active");
    invariant(args.session.principalId === args.authorizedOwner.principalId, "recovery_session_principal_mismatch");
    invariant(args.session.hostId === args.host.hostId, "recovery_session_host_mismatch");
    invariant(Date.parse(args.session.startedAt) <= Date.parse(this.store.now()), "recovery_session_not_started");
    invariant(Date.parse(args.session.expiresAt) > Date.parse(this.store.now()), "recovery_session_expired");
    invariant(
      this.store.get("SELECT 1 AS present FROM principals WHERE principal_id = ? AND status = 'active'", args.authorizedOwner.principalId),
      "recovery_owner_not_active",
    );
    invariant(
      this.store.get(
        "SELECT 1 AS present FROM project_roles WHERE project_id = ? AND principal_id = ? AND role = 'owner' AND status = 'active'",
        args.projectId,
        args.authorizedOwner.principalId,
      ),
      "recovery_owner_role_required",
    );
    invariant(!this.store.get("SELECT 1 AS present FROM hosts WHERE host_id = ? OR instance_id = ?", args.host.hostId, args.host.instanceId), "recovery_host_collision");
    invariant(!this.store.get("SELECT 1 AS present FROM sessions WHERE session_id = ?", args.session.sessionId), "recovery_session_collision");
    this.insertHost(args.host);
    this.insertSession(args.session);
    return {
      principalId: args.session.principalId,
      sessionId: args.session.sessionId,
      hostId: args.host.hostId,
    };
  }

  assignRole(args: {
    projectId: string;
    actor: PrincipalRef;
    principalId: string;
    role: ProjectRole;
    idempotencyKey: string;
  }): { principalId: string; role: ProjectRole } {
    const auth = this.authorize(args.projectId, args.actor, ["owner", "administrator"]);
    if (args.role === "owner" || args.role === "administrator") {
      invariant(auth.roles.includes("owner"), "owner_role_required");
    }
    requireIdentifier(args.principalId, "principalId", "principal.");
    invariant(this.store.get("SELECT principal_id FROM principals WHERE principal_id = ? AND status = 'active'", args.principalId), "principal_not_active");
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: "identity.assign_role",
      idempotencyKey: args.idempotencyKey,
      request: { principalId: args.principalId, role: args.role },
      run: () => {
        const current = this.authorize(args.projectId, args.actor, ["owner", "administrator"]);
        if (args.role === "owner" || args.role === "administrator") {
          invariant(current.roles.includes("owner"), "owner_role_required");
        }
        invariant(this.store.get("SELECT principal_id FROM principals WHERE principal_id = ? AND status = 'active'", args.principalId), "principal_not_active");
        const existing = this.store.get(
          "SELECT role_grant_id FROM project_roles WHERE project_id = ? AND principal_id = ? AND role = ? AND status = 'active'",
          args.projectId,
          args.principalId,
          args.role,
        );
        if (!existing) {
          this.store.run(
            `INSERT INTO project_roles(
              role_grant_id, project_id, principal_id, role, status, granted_at,
              granted_by_principal_id, granted_by_session_id, granted_by_host_id, granted_generation
            ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
            newId("role.grant"),
            args.projectId,
            args.principalId,
            args.role,
            this.store.now(),
            args.actor.principalId,
            args.actor.sessionId,
            args.actor.hostId,
            this.activeGeneration(args.projectId),
          );
        }
        return { principalId: args.principalId, role: args.role };
      },
    });
  }

  disablePrincipal(args: {
    projectId: string;
    actor: PrincipalRef;
    principalId: string;
    idempotencyKey: string;
  }): { principalId: string; status: "disabled" } {
    const auth = this.authorize(args.projectId, args.actor, ["owner", "administrator"]);
    requireIdentifier(args.principalId, "principalId", "principal.");
    invariant(args.principalId !== args.actor.principalId, "cannot_disable_acting_principal");
    const targetRoles = this.roles(args.projectId, args.principalId);
    if (targetRoles.includes("owner") || targetRoles.includes("administrator")) {
      invariant(auth.roles.includes("owner"), "owner_role_required");
    }
    invariant(this.store.get("SELECT 1 AS present FROM principals WHERE principal_id = ?", args.principalId), "principal_not_found");
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: "identity.disable_principal",
      idempotencyKey: args.idempotencyKey,
      request: { principalId: args.principalId },
      run: () => {
        const current = this.authorize(args.projectId, args.actor, ["owner", "administrator"]);
        invariant(args.principalId !== args.actor.principalId, "cannot_disable_acting_principal");
        const currentTargetRoles = this.roles(args.projectId, args.principalId);
        if (currentTargetRoles.includes("owner") || currentTargetRoles.includes("administrator")) {
          invariant(current.roles.includes("owner"), "owner_role_required");
        }
        const at = this.store.now();
        const disabled = this.store.run(
          "UPDATE principals SET status = 'disabled', disabled_at = ? WHERE principal_id = ? AND status = 'active'",
          at,
          args.principalId,
        );
        invariant(Number(disabled.changes) === 1, "principal_not_active");
        this.store.run(
          "UPDATE sessions SET status = 'revoked', closed_at = COALESCE(closed_at, ?) WHERE principal_id = ? AND status = 'active'",
          at,
          args.principalId,
        );
        this.revokeActiveRoles(args.projectId, args.principalId, args.actor, at);
        return { principalId: args.principalId, status: "disabled" as const };
      },
    });
  }

  setHostStatus(args: {
    projectId: string;
    actor: PrincipalRef;
    hostId: string;
    status: "retired" | "quarantined";
    idempotencyKey: string;
  }): { hostId: string; status: "retired" | "quarantined" } {
    this.authorize(args.projectId, args.actor, ["owner", "administrator"]);
    requireIdentifier(args.hostId, "hostId", "host.");
    invariant(args.hostId !== args.actor.hostId, "cannot_retire_acting_host");
    invariant(this.store.get("SELECT 1 AS present FROM hosts WHERE host_id = ?", args.hostId), "host_not_found");
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: "identity.set_host_status",
      idempotencyKey: args.idempotencyKey,
      request: { hostId: args.hostId, status: args.status },
      run: () => {
        this.authorize(args.projectId, args.actor, ["owner", "administrator"]);
        invariant(args.hostId !== args.actor.hostId, "cannot_retire_acting_host");
        const changed = this.store.run("UPDATE hosts SET status = ? WHERE host_id = ? AND status = 'active'", args.status, args.hostId);
        invariant(Number(changed.changes) === 1, "host_not_active");
        this.store.run(
          "UPDATE sessions SET status = 'revoked', closed_at = COALESCE(closed_at, ?) WHERE host_id = ? AND status = 'active'",
          this.store.now(),
          args.hostId,
        );
        return { hostId: args.hostId, status: args.status };
      },
    });
  }

  revokeRole(args: {
    projectId: string;
    actor: PrincipalRef;
    principalId: string;
    role: ProjectRole;
    idempotencyKey: string;
  }): { principalId: string; role: ProjectRole; status: "revoked" } {
    const auth = this.authorize(args.projectId, args.actor, ["owner", "administrator"]);
    requireIdentifier(args.principalId, "principalId", "principal.");
    if (args.role === "owner" || args.role === "administrator") invariant(auth.roles.includes("owner"), "owner_role_required");
    invariant(!(args.principalId === args.actor.principalId && args.role === "owner"), "cannot_revoke_acting_owner");
    if (args.role === "owner" && this.hasRole(args.projectId, args.principalId, "owner")) {
      const ownerCount = this.store.get<{ count: number }>(
        "SELECT COUNT(DISTINCT principal_id) AS count FROM project_roles WHERE project_id = ? AND role = 'owner' AND status = 'active'",
        args.projectId,
      );
      invariant(Number(ownerCount?.count) > 1, "last_owner_role_cannot_be_revoked");
    }
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: "identity.revoke_role",
      idempotencyKey: args.idempotencyKey,
      request: { principalId: args.principalId, role: args.role },
      run: () => {
        const current = this.authorize(args.projectId, args.actor, ["owner", "administrator"]);
        if (args.role === "owner" || args.role === "administrator") invariant(current.roles.includes("owner"), "owner_role_required");
        invariant(!(args.principalId === args.actor.principalId && args.role === "owner"), "cannot_revoke_acting_owner");
        if (args.role === "owner") {
          const currentOwnerCount = this.store.get<{ count: number }>(
            "SELECT COUNT(DISTINCT principal_id) AS count FROM project_roles WHERE project_id = ? AND role = 'owner' AND status = 'active'",
            args.projectId,
          );
          invariant(Number(currentOwnerCount?.count) > 1, "last_owner_role_cannot_be_revoked");
        }
        const at = this.store.now();
        const revoked = this.store.run(
          `UPDATE project_roles SET
             status = 'revoked', revoked_at = ?, revoked_by_principal_id = ?,
             revoked_by_session_id = ?, revoked_by_host_id = ?, revoked_generation = ?
           WHERE project_id = ? AND principal_id = ? AND role = ? AND status = 'active'`,
          at,
          args.actor.principalId,
          args.actor.sessionId,
          args.actor.hostId,
          this.activeGeneration(args.projectId),
          args.projectId,
          args.principalId,
          args.role,
        );
        invariant(Number(revoked.changes) === 1, "role_not_active");
        return { principalId: args.principalId, role: args.role, status: "revoked" as const };
      },
    });
  }

  revokeSession(args: {
    projectId: string;
    actor: PrincipalRef;
    sessionId: string;
    idempotencyKey: string;
  }): { sessionId: string; status: "revoked" } {
    const auth = this.authorize(args.projectId, args.actor);
    const target = this.store.get<{ principal_id: string }>("SELECT principal_id FROM sessions WHERE session_id = ?", args.sessionId);
    invariant(target, "session_not_found");
    invariant(
      target.principal_id === args.actor.principalId || auth.roles.some((role) => role === "owner" || role === "administrator"),
      "session_revocation_not_authorized",
    );
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: "identity.revoke_session",
      idempotencyKey: args.idempotencyKey,
      request: { sessionId: args.sessionId },
      run: () => {
        const current = this.authorize(args.projectId, args.actor);
        const currentTarget = this.store.get<{ principal_id: string }>("SELECT principal_id FROM sessions WHERE session_id = ?", args.sessionId);
        invariant(currentTarget, "session_not_found");
        invariant(
          currentTarget.principal_id === args.actor.principalId || current.roles.some((role) => role === "owner" || role === "administrator"),
          "session_revocation_not_authorized",
        );
        const revoked = this.store.run(
          "UPDATE sessions SET status = 'revoked', closed_at = ? WHERE session_id = ? AND status = 'active'",
          this.store.now(),
          args.sessionId,
        );
        invariant(Number(revoked.changes) === 1, "session_not_active");
        return { sessionId: args.sessionId, status: "revoked" as const };
      },
    });
  }

  authorize(
    projectId: string,
    actor: PrincipalRef,
    anyRole: ProjectRole[] = [],
    transport?: TransportContext,
  ): IdentityAuthorization {
    const row = this.store.get<{
      principal_status: string;
      session_status: string;
      started_at: string;
      expires_at: string;
      session_principal_id: string;
      session_host_id: string;
      host_status: string;
      transport: string;
      transport_session_id: string;
      server_instance_id: string;
    }>(
      `SELECT p.status AS principal_status, s.status AS session_status, s.started_at, s.expires_at,
              s.principal_id AS session_principal_id, s.host_id AS session_host_id,
              h.status AS host_status, s.transport, s.transport_session_id, s.server_instance_id
       FROM sessions s
       JOIN principals p ON p.principal_id = s.principal_id
       JOIN hosts h ON h.host_id = s.host_id
       WHERE s.session_id = ?`,
      actor.sessionId,
    );
    invariant(row, "identity_binding_not_found");
    invariant(row.session_principal_id === actor.principalId && row.session_host_id === actor.hostId, "identity_binding_mismatch");
    invariant(row.principal_status === "active", "principal_not_active");
    invariant(row.session_status === "active", "session_not_active");
    invariant(row.host_status === "active", "host_not_active");
    invariant(Date.parse(row.started_at) <= Date.parse(this.store.now()), "session_not_started");
    invariant(Date.parse(row.expires_at) > Date.parse(this.store.now()), "session_expired");
    if (transport) {
      invariant(
        row.transport === transport.transport &&
        row.transport_session_id === transport.transportSessionId &&
        row.server_instance_id === transport.serverInstanceId,
        "transport_binding_mismatch",
      );
    }
    const roles = this.store.all<{ role: ProjectRole }>(
      "SELECT role FROM project_roles WHERE project_id = ? AND principal_id = ? AND status = 'active' ORDER BY role",
      projectId,
      actor.principalId,
    ).map((entry) => entry.role);
    if (anyRole.length > 0) invariant(anyRole.some((role) => roles.includes(role)), "required_role_missing");
    return { actor: deepCopy(actor), roles };
  }

  hasRole(projectId: string, principalId: string, role: ProjectRole): boolean {
    return Boolean(this.store.get(
      "SELECT 1 AS present FROM project_roles WHERE project_id = ? AND principal_id = ? AND role = ? AND status = 'active'",
      projectId,
      principalId,
      role,
    ));
  }

  /**
   * Checks the immutable role ledger at a historical instant. This is for
   * validating authority captured in immutable records; it must not be used to
   * authorize a new command, which always requires `authorize`/`hasRole`.
   */
  hadRoleAt(projectId: string, principalId: string, role: ProjectRole, at: string): boolean {
    requireTimestamp(at, "roleAuthorityAt");
    return Boolean(this.store.get(
      `SELECT 1 AS present FROM project_roles
       WHERE project_id = ? AND principal_id = ? AND role = ?
         AND julianday(granted_at) <= julianday(?)
         AND (revoked_at IS NULL OR julianday(revoked_at) >= julianday(?))
       LIMIT 1`,
      projectId,
      principalId,
      role,
      at,
      at,
    ));
  }

  roles(projectId: string, principalId: string): ProjectRole[] {
    return this.store.all<{ role: ProjectRole }>(
      "SELECT role FROM project_roles WHERE project_id = ? AND principal_id = ? AND status = 'active' ORDER BY role",
      projectId,
      principalId,
    ).map((row) => row.role);
  }

  private insertPrincipal(principal: PrincipalRecord): void {
    this.store.run(
      `INSERT INTO principals(principal_id, kind, display_name, issuer, subject, status, created_at, disabled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      principal.principalId,
      principal.kind,
      principal.displayName,
      principal.issuer,
      principal.subject,
      principal.status,
      principal.createdAt,
      principal.disabledAt ?? null,
    );
  }

  private activeGeneration(projectId: string): number {
    const project = this.store.get<{ active_generation: number }>(
      "SELECT active_generation FROM projects WHERE project_id = ?",
      projectId,
    );
    invariant(project, "project_not_found");
    return Number(project.active_generation);
  }

  private revokeActiveRoles(projectId: string, principalId: string, actor: PrincipalRef, at: string): void {
    this.store.run(
      `UPDATE project_roles SET
         status = 'revoked', revoked_at = ?, revoked_by_principal_id = ?,
         revoked_by_session_id = ?, revoked_by_host_id = ?, revoked_generation = ?
       WHERE project_id = ? AND principal_id = ? AND status = 'active'`,
      at,
      actor.principalId,
      actor.sessionId,
      actor.hostId,
      this.activeGeneration(projectId),
      projectId,
      principalId,
    );
  }

  private insertHost(host: HostRecord): void {
    this.store.run(
      `INSERT INTO hosts(host_id, instance_id, hostname_hash, platform, status, registered_at, public_key_thumbprint)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      host.hostId,
      host.instanceId,
      host.hostnameHash,
      host.platform,
      host.status,
      host.registeredAt,
      host.publicKeyThumbprint ?? null,
    );
  }

  private insertSession(session: SessionRecord): void {
    if (session.authentication.credentialRef !== undefined) {
      requireOpaqueCredentialReference(session.authentication.credentialRef, "session.authentication.credentialRef");
    }
    this.store.run(
      `INSERT INTO sessions(
        session_id, principal_id, host_id, started_at, expires_at, status,
        authentication_method, authentication_assurance, credential_ref,
        transport, transport_session_id, server_instance_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      session.sessionId,
      session.principalId,
      session.hostId,
      session.startedAt,
      session.expiresAt,
      session.status,
      session.authentication.method,
      session.authentication.assurance,
      session.authentication.credentialRef ?? null,
      session.transportBinding.transport,
      session.transportBinding.transportSessionId,
      session.transportBinding.serverInstanceId,
    );
  }

  private validateBootstrap(input: BootstrapInput): void {
    requireIdentifier(input.projectId, "projectId");
    this.validatePrincipal(input.principal, input.projectId, "owner");
    this.validateHost(input.host);
    this.validateSession(input.session);
    invariant(input.session.principalId === input.principal.principalId, "session_principal_mismatch");
    invariant(input.session.hostId === input.host.hostId, "session_host_mismatch");
    this.schemas.validateNamed("principal.schema.json", {
      schemaVersion: "0.1.0-draft.4",
      principal: this.contractPrincipal(input.principal, input.projectId, "owner"),
      session: input.session,
      host: input.host,
    });
  }

  private validatePrincipal(principal: PrincipalRecord, projectId: string, role: ProjectRole): void {
    requireIdentifier(principal.principalId, "principalId", "principal.");
    requireTimestamp(principal.createdAt, "principal.createdAt");
    invariant(principal.displayName.length > 0 && principal.issuer.length > 0 && principal.subject.length > 0, "invalid_principal");
    invariant(!Object.hasOwn(principal as object, "roles"), "principal_roles_must_use_project_role_registry");
    this.schemas.validateNamedFragment(
      "principal.schema.json",
      "#/$defs/principal",
      this.contractPrincipal(principal, projectId, role),
    );
  }

  private validateHost(host: HostRecord): void {
    requireIdentifier(host.hostId, "hostId", "host.");
    requireIdentifier(host.instanceId, "instanceId");
    requireSha256(host.hostnameHash, "hostnameHash");
    requireTimestamp(host.registeredAt, "host.registeredAt");
    if (host.publicKeyThumbprint) requireSha256(host.publicKeyThumbprint, "publicKeyThumbprint");
    this.schemas.validateNamedFragment("principal.schema.json", "#/$defs/host", host);
  }

  private validateSession(session: SessionRecord): void {
    requireIdentifier(session.sessionId, "sessionId", "session.");
    requireIdentifier(session.principalId, "session.principalId", "principal.");
    requireIdentifier(session.hostId, "session.hostId", "host.");
    requireTimestamp(session.startedAt, "session.startedAt");
    requireTimestamp(session.expiresAt, "session.expiresAt");
    invariant(Date.parse(session.expiresAt) > Date.parse(session.startedAt), "invalid_session_lifetime");
    invariant(session.transportBinding.transportSessionId.length >= 16, "transport_session_id_too_short");
    requireIdentifier(session.transportBinding.serverInstanceId, "serverInstanceId");
    this.schemas.validateNamedFragment("principal.schema.json", "#/$defs/session", session);
  }

  private contractPrincipal(principal: PrincipalRecord, projectId: string, role: ProjectRole): Record<string, unknown> {
    return {
      ...principal,
      roles: [{ scope: "project", projectId, role }],
    };
  }
}
