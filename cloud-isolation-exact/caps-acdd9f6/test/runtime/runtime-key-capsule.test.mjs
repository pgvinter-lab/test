import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalize } from "../../dist/v2/core/canonical.js";
import { ContractSchemaRegistry } from "../../dist/v2/core/schema-registry.js";
import {
  createKeyCapsule,
  createRecoveryKeyCopies,
  dataKeyFromFile,
  readKeyCapsule,
  unwrapKeyCapsule,
  validateCapsuleBinding,
  verifyRecoveryKeyCopies,
  writeUnwrappedDataKey,
} from "../../dist/v2/recovery/key-capsule.js";

const schemas = () => new ContractSchemaRegistry(path.resolve("contracts/v0.1.0-draft.4/schemas"));

test("RSA-OAEP capsule round trip binds backup, key reference, recipient, and exact bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge2-capsule-"));
  try {
    const sourceRoot = path.join(root, "source");
    fs.mkdirSync(sourceRoot);
    const localDirectory = path.join(root, "local-keys");
    const driveDirectory = path.join(root, "drive-keys");
    const copies = createRecoveryKeyCopies({
      localDirectory,
      driveDirectory,
      keyName: "bridge2-test",
      forbiddenSourceRoot: sourceRoot,
    });
    assert.equal(copies.created, true);
    assert.equal(createRecoveryKeyCopies({
      localDirectory,
      driveDirectory,
      keyName: "bridge2-test",
      forbiddenSourceRoot: sourceRoot,
    }).created, false, "key initialization must adopt only a complete matching copy set");
    assert.equal(verifyRecoveryKeyCopies({
      localDirectory,
      driveDirectory,
      keyName: "bridge2-test",
      forbiddenSourceRoot: sourceRoot,
    }).fingerprintSha256, copies.fingerprintSha256);

    const dataKey = crypto.randomBytes(32);
    const capsulePath = path.join(driveDirectory, "capsules", "backup.synthetic.capsule.json");
    const dataKeyPath = path.join(localDirectory, "backup.synthetic.capsule.b64");
    const created = createKeyCapsule({
      backupId: "backup.synthetic.capsule",
      keyRef: "bridge-key://synthetic/capsule",
      publicKeyPath: copies.localPublicKeyPath,
      capsulePath,
      dataKeyPath,
      dataKey,
      now: () => "2026-07-14T20:00:00.000Z",
      schemas: schemas(),
      forbiddenSourceRoot: sourceRoot,
    });
    assert.deepEqual(dataKeyFromFile(dataKeyPath), dataKey);
    assert.deepEqual(unwrapKeyCapsule(capsulePath, copies.localPrivateKeyPath, schemas(), sourceRoot), dataKey);
    assert.deepEqual(unwrapKeyCapsule(capsulePath, copies.drivePrivateKeyPath, schemas(), sourceRoot), dataKey);
    assert.equal(validateCapsuleBinding(capsulePath, {
      backupId: "backup.synthetic.capsule",
      keyRef: "bridge-key://synthetic/capsule",
      recipientKeyFingerprint: copies.fingerprintSha256,
      capsuleSha256: created.capsuleSha256,
      dataKey,
    }, schemas()).capsuleId, created.capsule.capsuleId);

    const unwrappedPath = path.join(localDirectory, "unwrapped.b64");
    writeUnwrappedDataKey(capsulePath, copies.drivePrivateKeyPath, unwrappedPath, schemas(), sourceRoot);
    assert.deepEqual(fs.readFileSync(unwrappedPath), fs.readFileSync(dataKeyPath));

    const tampered = structuredClone(readKeyCapsule(capsulePath, schemas()).capsule);
    tampered.backupId = "backup.synthetic.tampered";
    const tamperedPath = path.join(driveDirectory, "capsules", "tampered.json");
    fs.writeFileSync(tamperedPath, `${canonicalize(tampered)}\n`);
    assert.throws(() => unwrapKeyCapsule(tamperedPath, copies.localPrivateKeyPath, schemas(), sourceRoot), /key_capsule_unwrap_failed/);
    const timestampTampered = structuredClone(readKeyCapsule(capsulePath, schemas()).capsule);
    timestampTampered.createdAt = "2026-07-14T20:00:01.000Z";
    const timestampTamperedPath = path.join(driveDirectory, "capsules", "timestamp-tampered.json");
    fs.writeFileSync(timestampTamperedPath, `${canonicalize(timestampTampered)}\n`);
    assert.throws(
      () => unwrapKeyCapsule(timestampTamperedPath, copies.localPrivateKeyPath, schemas(), sourceRoot),
      /key_capsule_unwrap_failed/,
    );
    assert.throws(() => validateCapsuleBinding(capsulePath, {
      backupId: "backup.synthetic.other",
      keyRef: "bridge-key://synthetic/capsule",
      recipientKeyFingerprint: copies.fingerprintSha256,
      capsuleSha256: created.capsuleSha256,
    }, schemas()), /key_capsule_backup_mismatch/);
    assert.throws(() => validateCapsuleBinding(capsulePath, {
      backupId: "backup.synthetic.capsule",
      keyRef: "bridge-key://synthetic/capsule",
      recipientKeyFingerprint: copies.fingerprintSha256,
      capsuleSha256: "0".repeat(64),
    }, schemas()), /key_capsule_hash_mismatch/);

    const other = createRecoveryKeyCopies({
      localDirectory: path.join(root, "other-local"),
      driveDirectory: path.join(root, "other-drive"),
      keyName: "bridge2-other",
      forbiddenSourceRoot: sourceRoot,
    });
    assert.throws(() => unwrapKeyCapsule(capsulePath, other.localPrivateKeyPath, schemas(), sourceRoot), /capsule_recipient_key_mismatch/);
    const forbiddenPrivateKeyPath = path.join(sourceRoot, "forbidden.private.pem");
    fs.copyFileSync(copies.localPrivateKeyPath, forbiddenPrivateKeyPath);
    assert.throws(
      () => unwrapKeyCapsule(capsulePath, forbiddenPrivateKeyPath, schemas(), sourceRoot),
      /recovery_key_path_inside_source_forbidden/,
    );
    assert.throws(
      () => writeUnwrappedDataKey(
        capsulePath,
        copies.localPrivateKeyPath,
        path.join(sourceRoot, "forbidden-data-key.b64"),
        schemas(),
        sourceRoot,
      ),
      /recovery_key_path_inside_source_forbidden/,
    );
    assert.throws(() => createRecoveryKeyCopies({
      localDirectory: path.join(sourceRoot, "forbidden"),
      driveDirectory: path.join(root, "allowed-drive"),
      keyName: "bridge2-forbidden",
      forbiddenSourceRoot: sourceRoot,
    }), /recovery_key_path_inside_source_forbidden/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recovery key verification rejects partial and mismatched copy sets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge2-key-copies-"));
  try {
    const input = {
      localDirectory: path.join(root, "local"),
      driveDirectory: path.join(root, "drive"),
      keyName: "bridge2-partial",
    };
    const copies = createRecoveryKeyCopies(input);
    fs.rmSync(copies.drivePublicKeyPath);
    assert.throws(() => verifyRecoveryKeyCopies(input), /recovery_key_copy_missing/);
    assert.throws(() => createRecoveryKeyCopies(input), /recovery_key_copy_set_partial/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recovery key verification and wrapping reject non-RSA-3072 keys", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge2-key-size-"));
  try {
    const localDirectory = path.join(root, "local");
    const driveDirectory = path.join(root, "drive");
    fs.mkdirSync(localDirectory);
    fs.mkdirSync(driveDirectory);
    const keyName = "bridge2-rsa-2048";
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicExponent: 0x10001,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    for (const directory of [localDirectory, driveDirectory]) {
      fs.writeFileSync(path.join(directory, `${keyName}.public.pem`), publicKey);
      fs.writeFileSync(path.join(directory, `${keyName}.private.pem`), privateKey);
    }
    const input = { localDirectory, driveDirectory, keyName };
    assert.throws(() => verifyRecoveryKeyCopies(input), /recovery_key_size_invalid/);
    assert.throws(() => createRecoveryKeyCopies(input), /recovery_key_size_invalid/);
    assert.throws(() => createKeyCapsule({
      backupId: "backup.synthetic.rsa2048",
      keyRef: "bridge-key://synthetic/rsa2048",
      publicKeyPath: path.join(localDirectory, `${keyName}.public.pem`),
      capsulePath: path.join(root, "capsule.json"),
      dataKeyPath: path.join(root, "data-key.b64"),
      schemas: schemas(),
    }), /recovery_key_size_invalid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
