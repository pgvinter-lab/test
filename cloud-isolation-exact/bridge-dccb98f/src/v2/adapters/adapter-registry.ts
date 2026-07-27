import { canonicalEqual, deepCopy } from "../core/canonical.js";
import { CONTRACT_VERSION } from "../core/constants.js";
import { invariant } from "../core/errors.js";
import { requireIdentifier, requireUriReference } from "../core/validation.js";
import type { AdapterManifest, PrincipalRef } from "../core/types.js";
import type { ContractSchemaRegistry } from "../core/schema-registry.js";
import type { IdentityService } from "../identity/identity-service.js";
import type { BridgeStore } from "../storage/store.js";

export class AdapterRegistry {
  constructor(
    private readonly store: BridgeStore,
    private readonly identity: IdentityService,
    private readonly schemas: ContractSchemaRegistry,
  ) {}

  register(args: {
    projectId: string;
    actor: PrincipalRef;
    manifest: AdapterManifest;
    idempotencyKey: string;
  }): AdapterManifest {
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: "adapter.register_manifest",
      idempotencyKey: args.idempotencyKey,
      request: args.manifest,
      run: () => {
        // Re-authorize under the same BEGIN IMMEDIATE transaction that changes
        // the active manifest pointer. A role/session revocation racing the
        // command therefore wins either before or after this mutation, never
        // between authorization and persistence.
        this.identity.authorize(args.projectId, args.actor, ["owner", "administrator"]);
        this.validateManifest(args.manifest);
        const existing = this.resolve(args.manifest.adapterId, args.manifest.adapterVersion);
        if (existing) {
          invariant(canonicalEqual(existing, args.manifest), "adapter_manifest_version_collision");
          return existing;
        }
        const at = this.store.now();
        this.store.run(
          `INSERT INTO adapter_registry(adapter_id, active_version, registered_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(adapter_id) DO UPDATE SET active_version = excluded.active_version, updated_at = excluded.updated_at`,
          args.manifest.adapterId,
          args.manifest.adapterVersion,
          at,
          at,
        );
        this.store.run(
          `INSERT INTO adapter_manifests(
            adapter_id, adapter_version, interface_version, kind, credential_mode, health_state, manifest_json, registered_at
          ) VALUES (?, ?, ?, ?, ?, 'ready', ?, ?)`,
          args.manifest.adapterId,
          args.manifest.adapterVersion,
          args.manifest.interfaceVersion,
          args.manifest.kind,
          args.manifest.security.credentialMode,
          JSON.stringify(args.manifest),
          at,
        );
        return deepCopy(args.manifest);
      },
    });
  }

  resolve(adapterId: string, version?: string): AdapterManifest | undefined {
    const row = version
      ? this.store.get<{ manifest_json: string }>(
        "SELECT manifest_json FROM adapter_manifests WHERE adapter_id = ? AND adapter_version = ?",
        adapterId,
        version,
      )
      : this.store.get<{ manifest_json: string }>(
        `SELECT m.manifest_json FROM adapter_registry r
         JOIN adapter_manifests m ON m.adapter_id = r.adapter_id AND m.adapter_version = r.active_version
         WHERE r.adapter_id = ?`,
        adapterId,
      );
    return row ? JSON.parse(row.manifest_json) as AdapterManifest : undefined;
  }

  require(adapterId: string, version?: string): AdapterManifest {
    const manifest = this.resolve(adapterId, version);
    invariant(manifest, "adapter_not_registered", { adapterId, version });
    return manifest;
  }

  list(): AdapterManifest[] {
    return this.store.all<{ manifest_json: string }>(
      `SELECT m.manifest_json FROM adapter_registry r
       JOIN adapter_manifests m ON m.adapter_id = r.adapter_id AND m.adapter_version = r.active_version
       ORDER BY r.adapter_id`,
    ).map((row) => JSON.parse(row.manifest_json) as AdapterManifest);
  }

  validateOperationInput(manifest: AdapterManifest, operation: string, input: unknown): void {
    const definition = manifest.operations[operation];
    invariant(definition, "adapter_operation_not_declared", { operation });
    this.schemas.validateReference(definition.inputSchema, input);
  }

  validateOperationOutput(manifest: AdapterManifest, operation: string, output: unknown): void {
    const definition = manifest.operations[operation];
    invariant(definition, "adapter_operation_not_declared", { operation });
    this.schemas.validateReference(definition.outputSchema, output);
  }

  private validateManifest(manifest: AdapterManifest): void {
    this.schemas.validateNamed("adapter.schema.json", manifest);
    invariant(manifest.schemaVersion === CONTRACT_VERSION && manifest.interfaceVersion === CONTRACT_VERSION, "unsupported_adapter_interface");
    requireIdentifier(manifest.adapterId, "adapterId", "adapter.");
    const credentialed = manifest.security.credentialMode !== "none";
    if (manifest.kind === "browser" || credentialed) {
      invariant(!manifest.transports.includes("in_process"), "credentialed_adapter_in_process_forbidden");
    }
    if (manifest.kind === "browser" || manifest.kind === "api") {
      invariant(manifest.security.networkAccess.length > 0, "network_allowlist_required");
    }
    for (const operation of Object.values(manifest.operations)) {
      this.schemas.assertReference(operation.inputSchema);
      this.schemas.assertReference(operation.outputSchema);
    }
    this.schemas.assertReference(manifest.security.approvalPolicy.grantSchema);
    for (const uri of manifest.security.networkAccess) {
      requireUriReference(uri, "adapter.networkAccess");
      if (manifest.kind === "browser" || manifest.kind === "api") {
        invariant(["http:", "https:"].includes(new URL(uri).protocol.toLowerCase()), "network_adapter_uri_scheme_forbidden");
      }
    }
    invariant(manifest.security.humanApprovalFor.includes("external_irreversible"), "irreversible_approval_declaration_required");
    invariant(manifest.security.humanApprovalFor.includes("sensitive_external"), "sensitive_approval_declaration_required");
    invariant(
      manifest.health.checkOperation === "doctor" || Boolean(manifest.operations[manifest.health.checkOperation]),
      "adapter_health_operation_not_declared",
    );
  }
}
