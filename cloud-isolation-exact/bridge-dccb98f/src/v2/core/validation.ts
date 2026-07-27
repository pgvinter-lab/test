import { invariant } from "./errors.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const INLINE_CREDENTIAL_FIELD = /^(?:authorization|cookie|credentials?|password|passphrase|secret|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token|session[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key)$/i;
const URI_CREDENTIAL_FIELD = /^(?:authorization|cookie|credentials?|password|passphrase|secret|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token|session[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|sig|signature|sas|access[_-]?key|x[_-]?amz[_-]?(?:credential|signature|security[_-]?token)|x[_-]?goog[_-]?(?:credential|signature)|googleaccessid)$/i;

export function requireIdentifier(value: unknown, field: string, prefix?: string): asserts value is string {
  invariant(typeof value === "string" && IDENTIFIER.test(value), "invalid_identifier", { field });
  if (prefix) invariant(value.startsWith(prefix), "invalid_identifier_prefix", { field, prefix });
}

export function requireSha256(value: unknown, field: string): asserts value is string {
  invariant(typeof value === "string" && SHA256.test(value), "invalid_sha256", { field });
}

export function requireTimestamp(value: unknown, field: string): asserts value is string {
  invariant(typeof value === "string" && Number.isFinite(Date.parse(value)), "invalid_timestamp", { field });
}

export function requireNonEmptyString(value: unknown, field: string, maxLength = 4000): asserts value is string {
  invariant(typeof value === "string" && value.length > 0 && value.length <= maxLength, "invalid_string", { field });
}

export function requireUniqueStrings(values: unknown, field: string, minItems = 0): asserts values is string[] {
  invariant(Array.isArray(values) && values.length >= minItems, "invalid_array", { field });
  invariant(values.every((value) => typeof value === "string" && value.length > 0), "invalid_array_item", { field });
  invariant(new Set(values).size === values.length, "duplicate_array_item", { field });
}

export function requireExactKeys(record: unknown, allowed: readonly string[], required: readonly string[], field: string): asserts record is Record<string, unknown> {
  invariant(record !== null && typeof record === "object" && !Array.isArray(record), "invalid_object", { field });
  const keys = Object.keys(record as Record<string, unknown>);
  invariant(keys.every((key) => allowed.includes(key)), "unknown_field", { field, keys });
  invariant(required.every((key) => keys.includes(key)), "missing_field", { field, keys });
}

export function requireUriReference(value: unknown, field: string): asserts value is string {
  requireNonEmptyString(value, field, 1000);
  invariant(!/\s/.test(value), "invalid_uri_reference", { field });
  let parsed: URL | undefined;
  try { parsed = new URL(value); } catch {}
  invariant(parsed, "invalid_uri_reference", { field });
  invariant(!["data:", "javascript:", "vbscript:", "blob:"].includes(parsed.protocol.toLowerCase()), "inline_or_executable_uri_forbidden", { field });
  invariant(parsed.protocol.length > 1 && !parsed.username && !parsed.password, "credential_material_forbidden_in_uri", { field });
  for (const name of parsed.searchParams.keys()) {
    invariant(!URI_CREDENTIAL_FIELD.test(name), "credential_material_forbidden_in_uri", { field });
  }
  for (const name of new URLSearchParams(parsed.hash.slice(1).replaceAll(";", "&")).keys()) {
    invariant(!URI_CREDENTIAL_FIELD.test(name), "credential_material_forbidden_in_uri", { field });
  }
}

export function requireOpaqueCredentialReference(value: unknown, field: string): asserts value is string {
  invariant(
    typeof value === "string" &&
      /^(?:env|keychain|credential-manager|broker)-ref:[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u.test(value),
    "invalid_credential_reference",
    { field },
  );
}

export function rejectInlineCredentialField(fieldName: string, field: string): void {
  invariant(!INLINE_CREDENTIAL_FIELD.test(fieldName), "credential_material_forbidden_in_broker_envelope", { field });
}

/** Reject raw credential-shaped fields before they can enter grants, audit, or adapter envelopes. */
export function rejectInlineCredentialMaterial(value: unknown, field = "value"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectInlineCredentialMaterial(entry, `${field}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    rejectInlineCredentialField(key, `${field}.${key}`);
    rejectInlineCredentialMaterial(nested, `${field}.${key}`);
  }
}
