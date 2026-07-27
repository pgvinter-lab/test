# Bridge 2.0 Draft Mock Client

Status: DRAFT TEST DOUBLE. It is not a production Bridge implementation.

`MockBridgeClient` is an in-memory client for the Procedural Guidance System to
develop against before Bridge 2.0 exists. It supports artifact metadata
registration, provenance-derived reviewer exclusion, project-role checks, the
review lifecycle, versioned owner instructions, revocable bounded approval grants,
browser authorization decisions without browser I/O, scoped request-hash
idempotency, generation fencing, canonical event/audit-mirror hashing, claim expiry,
event inspection, and a schema-shaped doctor result.

It performs no network, browser, GitHub, Drive, credential, or case-data access.
The authoritative envelopes are the JSON Schemas under
`contracts/v0.1.0-draft.4/schemas/`.

Example:

```js
import { MockBridgeClient } from "./mock-client/index.mjs";

const bridge = new MockBridgeClient({ projectId: "project.procedural" });
bridge.setRoles(reviewerIdentity.principalId, ["reviewer"]);
bridge.registerArtifactMetadata({
  artifactId: "artifact.draft.001",
  createdBy: ownerIdentity,
  parentArtifactIds: [],
});
const job = bridge.createReviewJob({
  mode: "independent_review",
  requestedBy: ownerIdentity,
  requiredRole: "reviewer",
  independence: {
    policy: "required",
    excludedPrincipalIds: [ownerIdentity.principalId],
  },
  target: {
    artifactIds: ["artifact.draft.001"],
    instructions: "Review the synthetic draft.",
    acceptanceCriteria: ["Return preserved disagreements."],
  },
});
bridge.makeReviewJobClaimable({
  jobId: job.jobId,
  actor: ownerIdentity,
  idempotencyKey: "idempotency.make-claimable.001",
});
```

`createApprovalGrant`, `revokeApprovalGrant`, `authorizeAction`, and
`amendReviewJobInstructions` exercise the draft policy boundary. `authorizeAction`
returns `allow` only for an exact active grant match; it otherwise returns `ask`
and never dispatches the action. Grant consumption first requires the bound
principal/session/host, current project role, adapter allowlist, and active claim/
generation/fencing token. `listAuditMirror()` returns the non-operational typed
projection for contract testing.

An owner may declare the draft.4 M-3/L-4 override only at job creation. The mock
keeps default all-amendment revocation and exact condition-name matching when no
override exists; on an override job, only those two rules relax and all identity,
role, fencing, adapter allowlist, and credential-isolation boundaries remain.
