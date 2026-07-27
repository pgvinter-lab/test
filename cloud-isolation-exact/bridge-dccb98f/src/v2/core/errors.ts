export class BridgeRuntimeError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: string, details?: Readonly<Record<string, unknown>>) {
    super(code);
    this.name = "BridgeRuntimeError";
    this.code = code;
    this.details = details;
  }
}

export function invariant(
  condition: unknown,
  code: string,
  details?: Readonly<Record<string, unknown>>,
): asserts condition {
  if (!condition) throw new BridgeRuntimeError(code, details);
}

export function asErrorCode(error: unknown): string {
  return error instanceof BridgeRuntimeError
    ? error.code
    : error instanceof Error
      ? error.message
      : "unknown_error";
}
