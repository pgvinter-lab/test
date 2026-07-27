import { canonicalEqual, deepCopy } from "../core/canonical.js";
import { CONTRACT_VERSION } from "../core/constants.js";
import { invariant } from "../core/errors.js";
import { requireIdentifier, requireNonEmptyString, requireSha256, requireTimestamp, requireUniqueStrings, requireUriReference } from "../core/validation.js";
import type { ArtifactRecord, Citation, PrincipalRef } from "../core/types.js";
import type { IdentityService } from "../identity/identity-service.js";
import type { BridgeStore } from "../storage/store.js";
import type { ContractSchemaRegistry } from "../core/schema-registry.js";

export class ArtifactService {
  constructor(
    private readonly store: BridgeStore,
    private readonly identity: IdentityService,
    private readonly schemas: ContractSchemaRegistry,
  ) {}

  register(args: {
    actor: PrincipalRef;
    artifact: ArtifactRecord;
    idempotencyKey: string;
  }): ArtifactRecord {
    const artifact = deepCopy(args.artifact);
    return this.store.mutateIdempotent({
      projectId: artifact.projectId,
      actor: args.actor,
      operation: "artifact.register",
      idempotencyKey: args.idempotencyKey,
      request: artifact,
      run: () => {
        // Validation includes current identity/role authorization and is kept
        // inside the write transaction to close authorization-to-write races.
        this.validate(artifact, args.actor);
        const existing = this.get(artifact.artifactId);
        if (existing) {
          invariant(canonicalEqual(existing, artifact), "artifact_id_content_collision");
          return existing;
        }
        for (const parentId of artifact.provenance.parentArtifactIds) {
          invariant(parentId !== artifact.artifactId, "artifact_provenance_cycle");
          const parent = this.get(parentId);
          invariant(parent?.projectId === artifact.projectId, "artifact_parent_not_found");
          invariant(!this.provenanceClosure([parentId]).includes(artifact.artifactId), "artifact_provenance_cycle");
        }
        this.assertCitations(artifact.citations, artifact.projectId, false, args.actor);
        this.store.run(
          `INSERT INTO artifacts(
            artifact_id, project_id, kind, creator_principal_id, creator_session_id, creator_host_id,
            sensitivity, media_type, size_bytes, sha256, created_at, registered_at, document_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          artifact.artifactId,
          artifact.projectId,
          artifact.kind,
          artifact.createdBy.principalId,
          artifact.createdBy.sessionId,
          artifact.createdBy.hostId,
          artifact.sensitivity,
          artifact.content.mediaType,
          artifact.content.sizeBytes,
          artifact.content.sha256,
          artifact.createdAt,
          this.store.now(),
          JSON.stringify(artifact),
        );
        for (const parentId of artifact.provenance.parentArtifactIds) {
          this.store.run(
            "INSERT INTO artifact_parents(child_artifact_id, parent_artifact_id) VALUES (?, ?)",
            artifact.artifactId,
            parentId,
          );
        }
        for (const citation of artifact.citations) {
          this.store.run(
            `INSERT INTO citations(
              citation_id, containing_artifact_id, source_artifact_id, verification_status, document_json
            ) VALUES (?, ?, ?, ?, ?)`,
            citation.citationId,
            artifact.artifactId,
            citation.sourceArtifactId,
            citation.verification.status,
            JSON.stringify(citation),
          );
        }
        return deepCopy(artifact);
      },
    });
  }

  get(artifactId: string): ArtifactRecord | undefined {
    return this.store.readDocument<ArtifactRecord>("artifacts", "artifact_id", artifactId);
  }

  require(artifactId: string): ArtifactRecord {
    const artifact = this.get(artifactId);
    invariant(artifact, "artifact_not_found", { artifactId });
    return artifact;
  }

  list(projectId: string): ArtifactRecord[] {
    return this.store.all<{ document_json: string }>(
      "SELECT document_json FROM artifacts WHERE project_id = ? ORDER BY registered_at, artifact_id",
      projectId,
    ).map((row) => JSON.parse(row.document_json) as ArtifactRecord);
  }

  registeredAt(artifactId: string): string {
    const row = this.store.get<{ registered_at: string }>(
      "SELECT registered_at FROM artifacts WHERE artifact_id = ?",
      artifactId,
    );
    invariant(row, "artifact_not_found", { artifactId });
    return row.registered_at;
  }

  provenanceClosure(rootArtifactIds: string[]): string[] {
    const visited = new Set<string>();
    const visit = (artifactId: string): void => {
      if (visited.has(artifactId)) return;
      const artifact = this.require(artifactId);
      visited.add(artifactId);
      for (const parentId of artifact.provenance.parentArtifactIds) visit(parentId);
    };
    for (const artifactId of rootArtifactIds) visit(artifactId);
    return [...visited].sort();
  }

  creatorClosure(rootArtifactIds: string[]): { artifactIds: string[]; principalIds: string[] } {
    const artifactIds = this.provenanceClosure(rootArtifactIds);
    const principalIds = [...new Set(artifactIds.map((artifactId) => this.require(artifactId).createdBy.principalId))].sort();
    return { artifactIds, principalIds };
  }

  assertCitations(citations: Citation[], projectId: string, requireStored = false, attestingActor?: PrincipalRef): void {
    assertRelationalCitations(this.store, this.identity, citations, projectId, requireStored, attestingActor);
  }

  private validate(artifact: ArtifactRecord, actor: PrincipalRef): void {
    this.schemas.validateNamed("artifact.schema.json", artifact);
    invariant(artifact.schemaVersion === CONTRACT_VERSION, "unsupported_contract_version");
    requireIdentifier(artifact.artifactId, "artifactId", "artifact.");
    requireIdentifier(artifact.projectId, "projectId");
    requireTimestamp(artifact.createdAt, "createdAt");
    requireSha256(artifact.content.sha256, "content.sha256");
    invariant(Number.isSafeInteger(artifact.content.sizeBytes) && artifact.content.sizeBytes >= 0, "invalid_artifact_size");
    invariant(canonicalEqual(artifact.createdBy, actor), "artifact_creator_actor_mismatch");
    const authorization = this.identity.authorize(artifact.projectId, actor, ["owner", "collaborator", "worker", "reviewer"]);
    const hasWorkRole = authorization.roles.some((role) => role === "owner" || role === "collaborator" || role === "worker");
    if (!hasWorkRole) invariant(["review", "report"].includes(artifact.kind), "reviewer_artifact_kind_forbidden");
    requireUniqueStrings(artifact.provenance.parentArtifactIds, "provenance.parentArtifactIds");
    invariant(Array.isArray(artifact.locations) && artifact.locations.length > 0, "artifact_location_required");
    for (const location of artifact.locations) {
      requireUriReference(location.uri, "location.uri");
      if (artifact.sensitivity === "confidential" || artifact.sensitivity === "restricted") {
        invariant(location.storageClass !== "github_source", "sensitive_artifact_github_forbidden");
        if (location.storageClass === "drive_replica" || location.storageClass === "remote_object") {
          invariant(location.encrypted === true, "sensitive_remote_artifact_must_be_encrypted");
        }
      }
      if (["response", "review", "decision", "report"].includes(artifact.kind)) {
        invariant(location.storageClass !== "github_source", "generated_artifact_github_forbidden");
      }
      if (location.storageClass === "github_source") {
        invariant(artifact.kind === "source_code", "github_source_kind_forbidden");
        invariant(artifact.sensitivity === "public" || artifact.sensitivity === "internal", "github_source_sensitivity_forbidden");
      }
    }
    invariant(Array.isArray(artifact.citations), "artifact_citations_required");
  }

}

export function assertRelationalCitations(
  store: BridgeStore,
  identity: IdentityService,
  citations: Citation[],
  projectId: string,
  requireStored = false,
  attestingActor?: PrincipalRef,
): void {
  invariant(Array.isArray(citations), "citations_required");
  const citationIds = citations.map((citation) => citation?.citationId);
  invariant(new Set(citationIds).size === citationIds.length, "duplicate_citation_id");
  for (const citation of citations) {
    invariant(citation && typeof citation === "object", "invalid_citation");
    invariant(citation.locator && typeof citation.locator === "object", "invalid_citation_locator");
    invariant(citation.verification && typeof citation.verification === "object", "invalid_citation_verification");
    requireIdentifier(citation.citationId, "citationId");
    requireIdentifier(citation.sourceArtifactId, "sourceArtifactId", "artifact.");
    const source = store.get<{ project_id: string }>("SELECT project_id FROM artifacts WHERE artifact_id = ?", citation.sourceArtifactId);
    invariant(source?.project_id === projectId, "citation_source_not_found");
    invariant(["line", "page", "section", "timestamp", "uri", "record"].includes(citation.locator?.type), "invalid_citation_locator");
    requireNonEmptyString(citation.locator?.value, "citation.locator.value", 500);
    if (citation.locator.type === "uri") requireUriReference(citation.locator.value, "citation.locator.value");
    requireNonEmptyString(citation.claim, "citation.claim", 4000);
    if (citation.quoteHash) requireSha256(citation.quoteHash, "citation.quoteHash");
    invariant(["unverified", "verified", "contradicted", "inconclusive"].includes(citation.verification?.status), "invalid_citation_verification_status");
    requireNonEmptyString(citation.verification?.method, "citation.verification.method", 300);
    const hasVerifier = citation.verification.verifiedBy !== undefined;
    const hasVerifiedAt = citation.verification.verifiedAt !== undefined;
    invariant(hasVerifier === hasVerifiedAt, "citation_verifier_fields_incomplete");
    const stored = store.get<{ document_json: string; source_project_id: string; containing_project_id: string }>(
      `SELECT c.document_json, source.project_id AS source_project_id, containing.project_id AS containing_project_id
       FROM citations c
       JOIN artifacts source ON source.artifact_id = c.source_artifact_id
       JOIN artifacts containing ON containing.artifact_id = c.containing_artifact_id
       WHERE c.citation_id = ?`,
      citation.citationId,
    );
    const storedDocument = stored ? JSON.parse(stored.document_json) as Citation : undefined;
    const exactStoredAttestation = Boolean(
      stored && stored.source_project_id === projectId && stored.containing_project_id === projectId &&
      canonicalEqual(storedDocument, citation),
    );
    if (requireStored) invariant(stored, "citation_record_not_found");
    if (stored) invariant(exactStoredAttestation, "citation_record_binding_mismatch");
    if (citation.verification.status !== "unverified") {
      invariant(hasVerifier && hasVerifiedAt, "citation_verifier_required");
      requireTimestamp(citation.verification.verifiedAt, "citation.verifiedAt");
      // A new attestation requires a currently authorized verifier. An exact
      // citation already sealed in the immutable artifact/citation ledger is
      // historical evidence and remains usable after that verifier's session
      // or role is later revoked.
      if (!exactStoredAttestation) {
        invariant(attestingActor, "citation_attesting_actor_required");
        invariant(canonicalEqual(citation.verification.verifiedBy, attestingActor), "citation_verifier_actor_mismatch");
        identity.authorize(projectId, attestingActor, ["owner", "reviewer", "collaborator", "worker"]);
      }
    } else {
      invariant(!hasVerifier && !hasVerifiedAt, "unverified_citation_cannot_name_verifier");
    }
  }
}
