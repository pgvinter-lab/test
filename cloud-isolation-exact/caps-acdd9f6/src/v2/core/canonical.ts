import crypto from "node:crypto";

function compareUnicodeCodePoints(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("non_finite_number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUnicodeCodePoints);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
  }
  throw new TypeError("unsupported_json_value");
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function hashCanonical(value: unknown): string {
  return sha256(Buffer.from(canonicalize(value), "utf8"));
}

export function hashEvent<T extends Record<string, unknown>>(event: T): string {
  const { hash: _ignored, ...preimage } = event;
  return hashCanonical(preimage);
}

export function hashAuditEntry<T extends Record<string, unknown>>(entry: T): string {
  const { mirrorHash: _ignored, ...preimage } = entry;
  return hashCanonical(preimage);
}

export function deepCopy<T>(value: T): T {
  return structuredClone(value);
}

export function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}
