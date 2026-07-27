import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalize, sha256 } from "../core/canonical.js";
import { CONTRACT_VERSION } from "../core/constants.js";
import { BridgeRuntimeError, invariant } from "../core/errors.js";
import type { ContractSchemaRegistry } from "../core/schema-registry.js";
import { requireIdentifier, requireUriReference } from "../core/validation.js";

export const KEY_CAPSULE_ALGORITHM = "rsa-oaep-sha256" as const;
export const KEY_CAPSULE_SCHEMA_VERSION = "bridge2-key-capsule-v1" as const;
export const RECOVERY_KEY_ALGORITHM = "rsa-3072" as const;
export const RECOVERY_KEY_MODULUS_BITS = 3072 as const;

export interface KeyCapsule {
  schemaVersion: typeof KEY_CAPSULE_SCHEMA_VERSION;
  contractVersion: typeof CONTRACT_VERSION;
  capsuleId: string;
  backupId: string;
  keyRef: string;
  wrappingAlgorithmId: typeof KEY_CAPSULE_ALGORITHM;
  oaepHash: "sha256";
  recipientKeyFingerprint: string;
  dataKeySha256: string;
  wrappedKeyBase64: string;
  createdAt: string;
}

export interface RecoveryKeyCopies {
  algorithm: typeof RECOVERY_KEY_ALGORITHM;
  wrappingAlgorithmId: typeof KEY_CAPSULE_ALGORITHM;
  fingerprintSha256: string;
  localPrivateKeyPath: string;
  localPublicKeyPath: string;
  drivePrivateKeyPath: string;
  drivePublicKeyPath: string;
  created: boolean;
}

export interface CreateRecoveryKeyCopiesInput {
  localDirectory: string;
  driveDirectory: string;
  keyName: string;
  forbiddenSourceRoot?: string;
}

export interface CreateKeyCapsuleInput {
  backupId: string;
  keyRef: string;
  publicKeyPath: string;
  capsulePath: string;
  dataKeyPath: string;
  dataKey?: Buffer;
  now?: () => string;
  schemas?: ContractSchemaRegistry;
  forbiddenSourceRoot?: string;
}

export interface CreatedKeyCapsule {
  capsule: KeyCapsule;
  capsulePath: string;
  capsuleSha256: string;
  dataKeyPath: string;
}

export function createRecoveryKeyCopies(input: CreateRecoveryKeyCopiesInput): RecoveryKeyCopies {
  requireKeyName(input.keyName);
  const localDirectory = prepareDirectory(input.localDirectory, input.forbiddenSourceRoot);
  const driveDirectory = prepareDirectory(input.driveDirectory, input.forbiddenSourceRoot);
  invariant(!samePath(localDirectory, driveDirectory), "recovery_key_copy_directories_must_differ");
  const paths = keyPaths(localDirectory, driveDirectory, input.keyName);
  const existing = Object.values(paths).map((filePath) => fs.existsSync(filePath));
  if (existing.every(Boolean)) return verifyRecoveryKeyCopies({ ...input, localDirectory, driveDirectory });
  invariant(existing.every((present) => !present), "recovery_key_copy_set_partial");

  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicExponent: 0x10001,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const publicBytes = Buffer.from(publicKey, "utf8");
  const privateBytes = Buffer.from(privateKey, "utf8");
  const created: string[] = [];
  try {
    for (const filePath of [paths.localPrivateKeyPath, paths.drivePrivateKeyPath]) {
      writeExclusive(filePath, privateBytes);
      created.push(filePath);
    }
    for (const filePath of [paths.localPublicKeyPath, paths.drivePublicKeyPath]) {
      writeExclusive(filePath, publicBytes);
      created.push(filePath);
    }
    return { ...verifyRecoveryKeyCopies({ ...input, localDirectory, driveDirectory }), created: true };
  } catch (error) {
    for (const filePath of created.reverse()) {
      try { fs.rmSync(filePath); } catch { /* retain the original initialization failure */ }
    }
    throw error;
  }
}

export function verifyRecoveryKeyCopies(input: CreateRecoveryKeyCopiesInput): RecoveryKeyCopies {
  requireKeyName(input.keyName);
  const localDirectory = canonicalDirectory(input.localDirectory, input.forbiddenSourceRoot);
  const driveDirectory = canonicalDirectory(input.driveDirectory, input.forbiddenSourceRoot);
  invariant(!samePath(localDirectory, driveDirectory), "recovery_key_copy_directories_must_differ");
  const paths = keyPaths(localDirectory, driveDirectory, input.keyName);
  for (const filePath of Object.values(paths)) assertRegularFile(filePath, "recovery_key_copy_missing");
  const localPrivate = fs.readFileSync(paths.localPrivateKeyPath);
  const drivePrivate = fs.readFileSync(paths.drivePrivateKeyPath);
  const localPublic = fs.readFileSync(paths.localPublicKeyPath);
  const drivePublic = fs.readFileSync(paths.drivePublicKeyPath);
  invariant(localPrivate.equals(drivePrivate), "recovery_private_key_copies_mismatch");
  invariant(localPublic.equals(drivePublic), "recovery_public_key_copies_mismatch");
  const publicKey = crypto.createPublicKey(localPublic);
  const privateKey = crypto.createPrivateKey(localPrivate);
  assertRecoveryKey(publicKey);
  assertRecoveryKey(privateKey);
  const derivedPublic = crypto.createPublicKey(privateKey);
  const fingerprint = publicKeyFingerprint(publicKey);
  invariant(publicKeyFingerprint(derivedPublic) === fingerprint, "recovery_key_pair_mismatch");
  return {
    algorithm: RECOVERY_KEY_ALGORITHM,
    wrappingAlgorithmId: KEY_CAPSULE_ALGORITHM,
    fingerprintSha256: fingerprint,
    ...paths,
    created: false,
  };
}

export function createKeyCapsule(input: CreateKeyCapsuleInput): CreatedKeyCapsule {
  requireIdentifier(input.backupId, "backupId", "backup.");
  requireUriReference(input.keyRef, "keyRef");
  const publicKeyPath = canonicalFile(input.publicKeyPath, input.forbiddenSourceRoot);
  const capsulePath = futureFile(input.capsulePath, input.forbiddenSourceRoot);
  const dataKeyPath = futureFile(input.dataKeyPath, input.forbiddenSourceRoot);
  invariant(!samePath(capsulePath, dataKeyPath), "capsule_data_key_path_collision");
  const publicKey = crypto.createPublicKey(fs.readFileSync(publicKeyPath));
  assertRecoveryKey(publicKey);
  const recipientKeyFingerprint = publicKeyFingerprint(publicKey);
  const dataKey = input.dataKey ?? crypto.randomBytes(32);
  invariant(Buffer.isBuffer(dataKey) && dataKey.length === 32, "aes_256_key_required");
  const capsule: KeyCapsule = {
    schemaVersion: KEY_CAPSULE_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    capsuleId: `capsule.${crypto.randomUUID().replaceAll("-", "")}`,
    backupId: input.backupId,
    keyRef: input.keyRef,
    wrappingAlgorithmId: KEY_CAPSULE_ALGORITHM,
    oaepHash: "sha256",
    recipientKeyFingerprint,
    dataKeySha256: sha256(dataKey),
    wrappedKeyBase64: "",
    createdAt: (input.now ?? (() => new Date().toISOString()))(),
  };
  const label = capsuleLabel(capsule);
  capsule.wrappedKeyBase64 = crypto.publicEncrypt({
    key: publicKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha256",
    oaepLabel: label,
  }, dataKey).toString("base64");
  input.schemas?.validateNamed("key-capsule.schema.json", capsule);
  const capsuleBytes = Buffer.from(`${canonicalize(capsule)}\n`, "utf8");
  const keyBytes = Buffer.from(`${dataKey.toString("base64")}\n`, "ascii");
  const created: string[] = [];
  try {
    writeExclusive(dataKeyPath, keyBytes);
    created.push(dataKeyPath);
    writeExclusive(capsulePath, capsuleBytes);
    created.push(capsulePath);
  } catch (error) {
    for (const filePath of created.reverse()) {
      try { fs.rmSync(filePath); } catch { /* retain the original capsule failure */ }
    }
    throw error;
  }
  return { capsule, capsulePath, capsuleSha256: sha256(capsuleBytes), dataKeyPath };
}

export function readKeyCapsule(capsulePath: string, schemas?: ContractSchemaRegistry): { capsule: KeyCapsule; capsuleSha256: string } {
  const resolved = canonicalFile(capsulePath);
  const bytes = fs.readFileSync(resolved);
  let capsule: KeyCapsule;
  try {
    capsule = JSON.parse(bytes.toString("utf8")) as KeyCapsule;
  } catch {
    throw new BridgeRuntimeError("key_capsule_json_invalid");
  }
  schemas?.validateNamed("key-capsule.schema.json", capsule);
  validateCapsule(capsule);
  invariant(bytes.equals(Buffer.from(`${canonicalize(capsule)}\n`, "utf8")), "key_capsule_not_canonical");
  return { capsule, capsuleSha256: sha256(bytes) };
}

export function unwrapKeyCapsule(
  capsulePath: string,
  privateKeyPath: string,
  schemas?: ContractSchemaRegistry,
  forbiddenSourceRoot?: string,
): Buffer {
  const { capsule } = readKeyCapsule(capsulePath, schemas);
  const privateKey = crypto.createPrivateKey(fs.readFileSync(canonicalFile(privateKeyPath, forbiddenSourceRoot)));
  assertRecoveryKey(privateKey);
  invariant(publicKeyFingerprint(crypto.createPublicKey(privateKey)) === capsule.recipientKeyFingerprint, "capsule_recipient_key_mismatch");
  try {
    const dataKey = crypto.privateDecrypt({
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
      oaepLabel: capsuleLabel(capsule),
    }, Buffer.from(capsule.wrappedKeyBase64, "base64"));
    invariant(dataKey.length === 32 && sha256(dataKey) === capsule.dataKeySha256, "capsule_data_key_mismatch");
    return dataKey;
  } catch (error) {
    if (error instanceof BridgeRuntimeError) throw error;
    throw new BridgeRuntimeError("key_capsule_unwrap_failed");
  }
}

export function writeUnwrappedDataKey(
  capsulePath: string,
  privateKeyPath: string,
  outputPath: string,
  schemas?: ContractSchemaRegistry,
  forbiddenSourceRoot?: string,
): string {
  const destination = futureFile(outputPath, forbiddenSourceRoot);
  const dataKey = unwrapKeyCapsule(capsulePath, privateKeyPath, schemas, forbiddenSourceRoot);
  writeExclusive(destination, Buffer.from(`${dataKey.toString("base64")}\n`, "ascii"));
  return destination;
}

export function dataKeyFromFile(filePath: string): Buffer {
  const encoded = fs.readFileSync(canonicalFile(filePath), "ascii").trim();
  invariant(/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded), "encryption_key_file_invalid");
  const key = Buffer.from(encoded, "base64");
  invariant(key.length === 32 && key.toString("base64") === encoded, "aes_256_key_required");
  return key;
}

export function validateCapsuleBinding(
  capsulePath: string,
  expected: {
    backupId: string;
    keyRef: string;
    recipientKeyFingerprint: string;
    capsuleSha256: string;
    dataKey?: Buffer;
  },
  schemas?: ContractSchemaRegistry,
): KeyCapsule {
  const { capsule, capsuleSha256 } = readKeyCapsule(capsulePath, schemas);
  invariant(capsuleSha256 === expected.capsuleSha256, "key_capsule_hash_mismatch");
  invariant(capsule.backupId === expected.backupId, "key_capsule_backup_mismatch");
  invariant(capsule.keyRef === expected.keyRef, "key_capsule_reference_mismatch");
  invariant(capsule.recipientKeyFingerprint === expected.recipientKeyFingerprint, "key_capsule_recipient_mismatch");
  if (expected.dataKey) invariant(sha256(expected.dataKey) === capsule.dataKeySha256, "key_capsule_data_key_mismatch");
  return capsule;
}

function validateCapsule(capsule: KeyCapsule): void {
  invariant(capsule.schemaVersion === KEY_CAPSULE_SCHEMA_VERSION && capsule.contractVersion === CONTRACT_VERSION, "key_capsule_version_invalid");
  requireIdentifier(capsule.capsuleId, "capsuleId", "capsule.");
  requireIdentifier(capsule.backupId, "backupId", "backup.");
  requireUriReference(capsule.keyRef, "keyRef");
  invariant(capsule.wrappingAlgorithmId === KEY_CAPSULE_ALGORITHM && capsule.oaepHash === "sha256", "key_capsule_algorithm_invalid");
  invariant(/^[a-f0-9]{64}$/u.test(capsule.recipientKeyFingerprint), "key_capsule_recipient_invalid");
  invariant(/^[a-f0-9]{64}$/u.test(capsule.dataKeySha256), "key_capsule_data_key_hash_invalid");
  invariant(typeof capsule.wrappedKeyBase64 === "string" && capsule.wrappedKeyBase64.length > 0, "key_capsule_wrapped_key_invalid");
  invariant(Number.isFinite(Date.parse(capsule.createdAt)), "key_capsule_created_at_invalid");
}

function capsuleLabel(capsule: Pick<KeyCapsule, "schemaVersion" | "contractVersion" | "capsuleId" | "backupId" | "keyRef" | "wrappingAlgorithmId" | "oaepHash" | "recipientKeyFingerprint" | "createdAt">): Buffer {
  return Buffer.from(canonicalize({
    schemaVersion: capsule.schemaVersion,
    contractVersion: capsule.contractVersion,
    capsuleId: capsule.capsuleId,
    backupId: capsule.backupId,
    keyRef: capsule.keyRef,
    wrappingAlgorithmId: capsule.wrappingAlgorithmId,
    oaepHash: capsule.oaepHash,
    recipientKeyFingerprint: capsule.recipientKeyFingerprint,
    createdAt: capsule.createdAt,
  }), "utf8");
}

function publicKeyFingerprint(publicKey: crypto.KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return sha256(Buffer.isBuffer(der) ? der : Buffer.from(der));
}

function requireKeyName(value: string): void {
  invariant(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(value), "recovery_key_name_invalid");
}

function assertRecoveryKey(key: crypto.KeyObject): void {
  invariant(key.asymmetricKeyType === "rsa", "recovery_key_algorithm_invalid");
  invariant(key.asymmetricKeyDetails?.modulusLength === RECOVERY_KEY_MODULUS_BITS, "recovery_key_size_invalid");
}

function keyPaths(localDirectory: string, driveDirectory: string, keyName: string): Omit<RecoveryKeyCopies, "algorithm" | "wrappingAlgorithmId" | "fingerprintSha256" | "created"> {
  return {
    localPrivateKeyPath: path.join(localDirectory, `${keyName}.private.pem`),
    localPublicKeyPath: path.join(localDirectory, `${keyName}.public.pem`),
    drivePrivateKeyPath: path.join(driveDirectory, `${keyName}.private.pem`),
    drivePublicKeyPath: path.join(driveDirectory, `${keyName}.public.pem`),
  };
}

function prepareDirectory(value: string, forbiddenSourceRoot?: string): string {
  const resolved = path.resolve(value);
  assertOutsideSource(resolved, forbiddenSourceRoot);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  return canonicalDirectory(resolved, forbiddenSourceRoot);
}

function canonicalDirectory(value: string, forbiddenSourceRoot?: string): string {
  const resolved = path.resolve(value);
  assertOutsideSource(resolved, forbiddenSourceRoot);
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  invariant(stat?.isDirectory() && !stat.isSymbolicLink(), "recovery_key_directory_invalid");
  const canonical = fs.realpathSync.native(resolved);
  invariant(samePath(canonical, resolved), "recovery_key_directory_reparse_forbidden");
  return canonical;
}

function canonicalFile(value: string, forbiddenSourceRoot?: string): string {
  const resolved = path.resolve(value);
  assertOutsideSource(resolved, forbiddenSourceRoot);
  assertRegularFile(resolved, "recovery_key_file_invalid");
  const canonical = fs.realpathSync.native(resolved);
  invariant(samePath(canonical, resolved), "recovery_key_file_reparse_forbidden");
  return canonical;
}

function futureFile(value: string, forbiddenSourceRoot?: string): string {
  const resolved = path.resolve(value);
  assertOutsideSource(resolved, forbiddenSourceRoot);
  const parent = prepareDirectory(path.dirname(resolved), forbiddenSourceRoot);
  const destination = path.join(parent, path.basename(resolved));
  invariant(!fs.existsSync(destination), "recovery_key_destination_exists");
  return destination;
}

function writeExclusive(filePath: string, bytes: Buffer): void {
  fs.writeFileSync(filePath, bytes, { flag: "wx", mode: 0o600 });
  assertRegularFile(filePath, "recovery_key_write_failed");
  if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
}

function assertRegularFile(filePath: string, code: string): void {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  invariant(stat?.isFile() && !stat.isSymbolicLink(), code);
}

function assertOutsideSource(candidate: string, forbiddenSourceRoot?: string): void {
  if (!forbiddenSourceRoot) return;
  const root = path.resolve(forbiddenSourceRoot);
  invariant(!isWithin(candidate, root), "recovery_key_path_inside_source_forbidden");
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}
