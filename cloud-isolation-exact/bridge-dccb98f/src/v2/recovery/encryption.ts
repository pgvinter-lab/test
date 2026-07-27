import crypto from "node:crypto";
import fs from "node:fs";
import { canonicalize, sha256 } from "../core/canonical.js";
import { BridgeRuntimeError, invariant } from "../core/errors.js";

const MAGIC = "BRIDGE2-AES-256-GCM-V1\n";

export interface EncryptedEnvelopeHeader {
  algorithm: "aes-256-gcm";
  nonce: string;
  authenticationTag: string;
  plaintextSha256: string;
  plaintextSize: number;
  aadSha256: string;
}

function requireKey(key: Buffer): void {
  invariant(Buffer.isBuffer(key) && key.length === 32, "aes_256_key_required");
}

export function encryptBuffer(plaintext: Buffer, key: Buffer, authenticatedMetadata: unknown): Buffer {
  requireKey(key);
  const nonce = crypto.randomBytes(12);
  const aad = Buffer.from(canonicalize(authenticatedMetadata), "utf8");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const header: EncryptedEnvelopeHeader = {
    algorithm: "aes-256-gcm",
    nonce: nonce.toString("base64"),
    authenticationTag: cipher.getAuthTag().toString("base64"),
    plaintextSha256: sha256(plaintext),
    plaintextSize: plaintext.length,
    aadSha256: sha256(aad),
  };
  return Buffer.concat([
    Buffer.from(MAGIC, "utf8"),
    Buffer.from(`${canonicalize(header)}\n`, "utf8"),
    ciphertext,
  ]);
}

export function decryptBuffer(envelope: Buffer, key: Buffer, authenticatedMetadata: unknown): Buffer {
  requireKey(key);
  const magic = Buffer.from(MAGIC, "utf8");
  invariant(envelope.subarray(0, magic.length).equals(magic), "encrypted_envelope_magic_invalid");
  const headerEnd = envelope.indexOf(0x0a, magic.length);
  invariant(headerEnd > magic.length, "encrypted_envelope_header_invalid");
  let header: EncryptedEnvelopeHeader;
  try {
    header = JSON.parse(envelope.subarray(magic.length, headerEnd).toString("utf8")) as EncryptedEnvelopeHeader;
  } catch {
    throw new BridgeRuntimeError("encrypted_envelope_header_invalid");
  }
  invariant(header.algorithm === "aes-256-gcm", "encrypted_envelope_algorithm_unsupported");
  const aad = Buffer.from(canonicalize(authenticatedMetadata), "utf8");
  invariant(sha256(aad) === header.aadSha256, "encrypted_envelope_aad_mismatch");
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(header.nonce, "base64"), { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(header.authenticationTag, "base64"));
    const plaintext = Buffer.concat([decipher.update(envelope.subarray(headerEnd + 1)), decipher.final()]);
    invariant(plaintext.length === header.plaintextSize && sha256(plaintext) === header.plaintextSha256, "encrypted_envelope_plaintext_mismatch");
    return plaintext;
  } catch (error) {
    if (error instanceof BridgeRuntimeError) throw error;
    throw new BridgeRuntimeError("encrypted_envelope_authentication_failed");
  }
}

export function encryptFile(inputPath: string, outputPath: string, key: Buffer, authenticatedMetadata: unknown): EncryptedEnvelopeHeader {
  const envelope = encryptBuffer(fs.readFileSync(inputPath), key, authenticatedMetadata);
  fs.writeFileSync(outputPath, envelope, { flag: "wx", mode: 0o600 });
  const magicLength = Buffer.byteLength(MAGIC, "utf8");
  const headerEnd = envelope.indexOf(0x0a, magicLength);
  return JSON.parse(envelope.subarray(magicLength, headerEnd).toString("utf8")) as EncryptedEnvelopeHeader;
}

export function decryptFile(inputPath: string, outputPath: string, key: Buffer, authenticatedMetadata: unknown): void {
  const plaintext = decryptBuffer(fs.readFileSync(inputPath), key, authenticatedMetadata);
  fs.writeFileSync(outputPath, plaintext, { flag: "wx", mode: 0o600 });
}

export function keyFromEnvironment(variableName: string): Buffer {
  invariant(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(variableName), "invalid_key_environment_reference");
  const encoded = process.env[variableName];
  invariant(encoded, "encryption_key_reference_unavailable");
  const key = Buffer.from(encoded, "base64");
  requireKey(key);
  return key;
}
