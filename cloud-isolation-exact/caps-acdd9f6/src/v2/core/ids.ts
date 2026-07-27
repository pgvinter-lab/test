import crypto from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}.${crypto.randomUUID()}`;
}

export function isoNow(): string {
  return new Date().toISOString();
}
