import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { canonicalize, hashAuditMirrorEntry, hashEvent } from "../../mock-client/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const contract = path.join(root, "contracts", "v0.1.0-draft.4");
const schemaDir = path.join(contract, "schemas");
const exampleDir = path.join(contract, "examples");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const schemaFiles = fs.readdirSync(schemaDir).filter((name) => name.endsWith(".schema.json"));
const schemas = schemaFiles.map((name) => readJson(path.join(schemaDir, name)));

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
for (const schema of schemas) {
  assert.equal(ajv.validateSchema(schema), true, JSON.stringify(ajv.errors));
  ajv.addSchema(schema);
}

const pairs = [
  ["principal.valid.json", "principal.schema.json"],
  ["review-job.valid.json", "review-job.schema.json"],
  ["artifact.valid.json", "artifact.schema.json"],
  ["adapter.valid.json", "adapter.schema.json"],
  ["approval-grant.valid.json", "approval-grant.schema.json"],
  ["event.valid.json", "event.schema.json"],
  ["event.compatibility.valid.json", "event.schema.json"],
  ["audit-mirror-entry.valid.json", "audit-mirror-entry.schema.json"],
  ["key-capsule.valid.json", "key-capsule.schema.json"],
  ["backup-manifest.valid.json", "backup-manifest.schema.json"],
  ["restore-manifest.valid.json", "restore-manifest.schema.json"],
  ["migration.valid.json", "migration.schema.json"],
  ["doctor.valid.json", "doctor.schema.json"],
  ["a2a-send.valid.json", "a2a-send.schema.json"],
  ["a2a-task-query.valid.json", "a2a-task-query.schema.json"],
  ["a2a-task-receipt.valid.json", "a2a-task-receipt.schema.json"],
];

for (const [exampleName, schemaName] of pairs) {
  const example = readJson(path.join(exampleDir, exampleName));
  const schema = schemas.find((candidate) => candidate.$id.endsWith(`/${schemaName}`));
  const validate = ajv.getSchema(schema.$id);
  assert.equal(validate(example), true, `${exampleName}: ${JSON.stringify(validate.errors)}`);
}

const invalidCases = [
  ["principal.schema.json", "principal.valid.json", (v) => delete v.principal.roles[0].projectId],
  ["principal.schema.json", "principal.valid.json", (v) => delete v.session.expiresAt],
  ["review-job.schema.json", "review-job.valid.json", (v) => { v.status = "completed"; }],
  ["review-job.schema.json", "review-job.valid.json", (v) => { v.target.instructions = "unversioned"; }],
  ["review-job.schema.json", "review-job.valid.json", (v) => { delete v.approvalPolicyOverride.immutableAfterCreation; }],
  ["review-job.schema.json", "review-job.valid.json", (v) => { v.approvalPolicyOverride.scope.overriddenRules = ["M-3"]; }],
  ["review-job.schema.json", "review-job.valid.json", (v) => {
    v.approvalPolicyOverride.preservedControls = ["principal_role_authorization"];
  }],
  ["artifact.schema.json", "artifact.valid.json", (v) => { v.content.sha256 = "bad"; }],
  ["artifact.schema.json", "artifact.valid.json", (v) => {
    v.sensitivity = "restricted";
    v.locations = [{ storageClass: "drive_replica", uri: "file:///C:/recovery/review.md", encrypted: false }];
  }],
  ["artifact.schema.json", "artifact.valid.json", (v) => {
    v.locations = [{ storageClass: "github_source", uri: "https://github.com/example/private" }];
  }],
  ["artifact.schema.json", "artifact.valid.json", (v) => {
    v.kind = "prompt";
    v.sensitivity = "internal";
    v.locations = [{ storageClass: "github_source", uri: "https://github.com/example/private" }];
  }],
  ["adapter.schema.json", "adapter.valid.json", (v) => { v.unapprovedField = true; }],
  ["adapter.schema.json", "adapter.valid.json", (v) => {
    v.kind = "browser";
    v.transports = ["in_process"];
    v.security.networkAccess = ["https://example.invalid"];
  }],
  ["adapter.schema.json", "adapter.valid.json", (v) => {
    v.security.humanApprovalFor = ["sensitive_external"];
  }],
  ["adapter.schema.json", "adapter.valid.json", (v) => {
    v.security.approvalPolicy.defaultDecision = "allow";
  }],
  ["approval-grant.schema.json", "approval-grant.valid.json", (v) => { delete v.expiresAt; }],
  ["approval-grant.schema.json", "approval-grant.valid.json", (v) => { delete v.grantedTo; }],
  ["approval-grant.schema.json", "approval-grant.valid.json", (v) => { v.scope.adapterIds = []; }],
  ["approval-grant.schema.json", "approval-grant.valid.json", (v) => { v.scope.conditions = []; }],
  ["event.schema.json", "event.valid.json", (v) => { v.sequence = 0; }],
  ["event.schema.json", "event.valid.json", (v) => { v.data.secret = "forbidden"; }],
  ["event.schema.json", "event.compatibility.valid.json", (v) => { delete v.data.outcome; }],
  ["event.schema.json", "event.compatibility.valid.json", (v) => { v.data.request.secret = "forbidden"; }],
  ["event.schema.json", "event.compatibility.valid.json", (v) => {
    v.data.outcome.changedActivities[0].rawContents = "forbidden";
  }],
  ["audit-mirror-entry.schema.json", "audit-mirror-entry.valid.json", (v) => {
    v.rawArtifactContents = "forbidden";
  }],
  ["audit-mirror-entry.schema.json", "audit-mirror-entry.valid.json", (v) => {
    v.excludedContentClasses = ["credentials"];
  }],
  ["backup-manifest.schema.json", "backup-manifest.valid.json", (v) => { v.dirty = true; }],
  ["backup-manifest.schema.json", "backup-manifest.valid.json", (v) => {
    v.encryption = { mode: "none" };
  }],
  ["backup-manifest.schema.json", "backup-manifest.valid.json", (v) => {
    delete v.encryption.wrappedKeyCapsule;
  }],
  ["backup-manifest.schema.json", "backup-manifest.valid.json", (v) => {
    v.encryption.wrappedKeyCapsule.decryptionSecretCustody = "outside_drive_and_github";
  }],
  ["backup-manifest.schema.json", "backup-manifest.valid.json", (v) => {
    v.encryption.wrappedKeyCapsule.capsuleSha256 = "bad";
  }],
  ["key-capsule.schema.json", "key-capsule.valid.json", (v) => {
    v.wrappingAlgorithmId = "rsa-oaep-sha1";
  }],
  ["key-capsule.schema.json", "key-capsule.valid.json", (v) => {
    v.wrappedKeyBase64 = "not base64";
  }],
  ["restore-manifest.schema.json", "restore-manifest.valid.json", (v) => delete v.takeover.approvalRef],
  ["migration.schema.json", "migration.valid.json", (v) => { v.backupRequired = false; }],
  ["doctor.schema.json", "doctor.valid.json", (v) => { v.overall = "healthy"; }],
  ["doctor.schema.json", "doctor.valid.json", (v) => {
    v.checks = v.checks.filter((check) => check.category !== "secrets");
  }],
  ["a2a-send.schema.json", "a2a-send.valid.json", (v) => { v.target = "gemini"; }],
  ["a2a-task-query.schema.json", "a2a-task-query.valid.json", (v) => { v.taskId = ""; }],
  ["a2a-task-receipt.schema.json", "a2a-task-receipt.valid.json", (v) => { v.terminal = false; }],
  ["a2a-task-receipt.schema.json", "a2a-task-receipt.valid.json", (v) => { v.artifactIds = []; }],
];

for (const [schemaName, exampleName, mutate] of invalidCases) {
  const value = readJson(path.join(exampleDir, exampleName));
  mutate(value);
  const schema = schemas.find((candidate) => candidate.$id.endsWith(`/${schemaName}`));
  assert.equal(ajv.getSchema(schema.$id)(value), false, `${exampleName} invalid case was accepted`);
}

const artifactSchema = schemas.find((candidate) => candidate.$id.endsWith("/artifact.schema.json"));
const sourceCode = readJson(path.join(exampleDir, "artifact.valid.json"));
sourceCode.kind = "source_code";
sourceCode.sensitivity = "internal";
sourceCode.locations = [{ storageClass: "github_source", uri: "https://github.com/example/private" }];
assert.equal(ajv.getSchema(artifactSchema.$id)(sourceCode), true,
  "sanitized source_code metadata could not name private GitHub source storage");

const eventExample = readJson(path.join(exampleDir, "event.valid.json"));
assert.equal(hashEvent(eventExample), eventExample.hash, "frozen event hash vector changed");
const auditExample = readJson(path.join(exampleDir, "audit-mirror-entry.valid.json"));
assert.equal(hashAuditMirrorEntry(auditExample), auditExample.mirrorHash, "frozen audit hash vector changed");
const supplementaryKey = String.fromCodePoint(0x10000);
const bmpKey = String.fromCodePoint(0xe000);
const canonicalUnicode = canonicalize({ [supplementaryKey]: 1, [bmpKey]: 2 });
assert.equal(canonicalUnicode.indexOf(JSON.stringify(bmpKey)) < canonicalUnicode.indexOf(JSON.stringify(supplementaryKey)), true,
  "canonical object keys are not sorted by Unicode code point");

const backupSchema = schemas.find((candidate) => candidate.$id.endsWith("/backup-manifest.schema.json"));
const sourceOnly = readJson(path.join(exampleDir, "backup-manifest.valid.json"));
sourceOnly.backupType = "source_only";
sourceOnly.dirty = true;
sourceOnly.consistency.quiesced = false;
sourceOnly.consistency.databaseCheckpoint = "not-applicable";
sourceOnly.contents = sourceOnly.contents.filter((item) => item.kind === "git_bundle");
sourceOnly.encryption = { mode: "none" };
sourceOnly.ownerException = {
  approvalGrantId: "approval.backup.dirty.001",
  reason: "Synthetic dirty source-only recovery exception.",
  approvedBy: {
    principalId: "principal.owner",
    sessionId: "session.owner.001",
    hostId: "host.demo",
  },
};
assert.equal(ajv.getSchema(backupSchema.$id)(sourceOnly), true, "source-only dirty exception rejected");
const unattestedSourceOnly = structuredClone(sourceOnly);
delete unattestedSourceOnly.ownerException;
assert.equal(ajv.getSchema(backupSchema.$id)(unattestedSourceOnly), false,
  "dirty source-only backup without owner exception was accepted");

const validRestore = readJson(path.join(exampleDir, "restore-manifest.valid.json"));
const restoreSemantics = (value) => {
  if (
    value.takeover.mode === "owner_confirmed_takeover" &&
    value.takeover.newGeneration <= value.expectedSourceGeneration
  ) return false;
  if (
    value.mode === "recovery_drill" &&
    (value.takeover.mode !== "no_takeover" ||
      value.steps.some((step) => step.operation === "activate"))
  ) return false;
  return true;
};
assert.equal(restoreSemantics(validRestore), true);
const nonMonotonic = structuredClone(validRestore);
nonMonotonic.takeover.newGeneration = nonMonotonic.expectedSourceGeneration;
assert.equal(restoreSemantics(nonMonotonic), false, "non-monotonic takeover accepted");
const unsafeDrill = structuredClone(validRestore);
unsafeDrill.mode = "recovery_drill";
assert.equal(restoreSemantics(unsafeDrill), false, "activating recovery drill accepted");

console.log(`CONTRACT SCHEMAS PASSED: ${schemas.length} schemas, ${pairs.length} valid examples, ${invalidCases.length} rejection cases, hash and restore semantic vectors`);
