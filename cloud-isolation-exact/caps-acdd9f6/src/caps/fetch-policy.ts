import crypto from "node:crypto";
import { invariant } from "../v2/core/errors.js";

export const MCPSERVERS_ORIGIN = "https://mcpservers.org";
export const MCPSERVERS_USER_AGENT =
  "BridgeCaps/0.2.0 local-owner-operated-indexer";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_RETRIES = 3;

export type FetchImplementation = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type SleepImplementation = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<void>;

export interface FetchPolicyOptions {
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchImplementation;
  sleepImpl?: SleepImplementation;
  nowImpl?: () => number;
}

export interface FetchResult {
  status: number;
  bytes: number;
  sha256: string;
  url: string;
  attempts: number;
  text: string;
}

export class RateLimitError extends Error {
  public readonly retryAfterMs: number;
  public readonly attempts: number;

  constructor(retryAfterMs: number, attempts: number) {
    super("fetch_policy_rate_limited");
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.attempts = attempts;
  }
}

function abortError(): Error {
  const error = new Error("fetch_policy_aborted");
  error.name = "AbortError";
  return error;
}

function exactUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("fetch_policy_url_invalid");
  }
  invariant(url.protocol === "https:", "fetch_policy_https_only");
  invariant(
    url.origin === MCPSERVERS_ORIGIN
      && url.username === ""
      && url.password === ""
      && url.port === ""
      && url.hash === "",
    "fetch_policy_origin_mismatch",
  );
  return url;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  code: string,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isInteger(resolved)
    || resolved < minimum
    || resolved > maximum
  ) {
    throw new Error(code);
  }
  return resolved;
}

function retryAfterMilliseconds(
  value: string | null,
  now: number,
): number {
  if (!value) return 1_000;
  if (/^\d+$/.test(value.trim())) {
    return Math.max(750, Number(value.trim()) * 1_000);
  }
  const epoch = Date.parse(value);
  return Number.isFinite(epoch)
    ? Math.max(750, epoch - now)
    : 1_000;
}

async function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function waitBeforeRetry(
  milliseconds: number,
  sleep: SleepImplementation,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw abortError();
  if (!signal) {
    await sleep(milliseconds);
    return;
  }
  await abortable(sleep(milliseconds, signal), signal);
}

async function readBoundedText(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<{ bytes: number; sha256: string; text: string }> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength.trim())) {
      throw new Error("fetch_policy_content_length_invalid");
    }
    if (Number(declaredLength) > limit) {
      throw new Error("fetch_policy_byte_limit_exceeded");
    }
  }

  const hasher = crypto.createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";

  if (!response.body) {
    return {
      bytes: 0,
      sha256: hasher.digest("hex"),
      text: "",
    };
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        throw new Error("fetch_policy_byte_limit_exceeded");
      }
      hasher.update(value);
      try {
        text += decoder.decode(value, { stream: true });
      } catch {
        throw new Error("fetch_policy_invalid_utf8");
      }
    }
    try {
      text += decoder.decode();
    } catch {
      throw new Error("fetch_policy_invalid_utf8");
    }
    return { bytes, sha256: hasher.digest("hex"), text };
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function nonRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError"
    || error instanceof RateLimitError
    || error.message.startsWith("fetch_policy_byte_limit")
    || error.message === "fetch_policy_content_length_invalid"
    || error.message === "fetch_policy_invalid_utf8"
    || error.message === "fetch_policy_redirect_rejected"
    || error.message.startsWith("fetch_policy_transient_status_")
    || error.message.startsWith("fetch_policy_status_");
}

export async function fetchWithPolicy(
  rawUrl: string,
  options: FetchPolicyOptions = {},
): Promise<FetchResult> {
  const url = exactUrl(rawUrl);
  const timeoutMs = boundedInteger(
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    1,
    DEFAULT_TIMEOUT_MS,
    "fetch_policy_timeout_invalid",
  );
  const maxBytes = boundedInteger(
    options.maxBytes,
    DEFAULT_MAX_BYTES,
    1,
    DEFAULT_MAX_BYTES,
    "fetch_policy_max_bytes_invalid",
  );
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  const nowImpl = options.nowImpl ?? Date.now;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt += 1) {
    if (options.signal?.aborted) throw abortError();
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onParentAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await abortable(
        fetchImpl(url.href, {
          method: "GET",
          headers: { "User-Agent": MCPSERVERS_USER_AGENT },
          redirect: "error",
          signal: controller.signal,
        }),
        controller.signal,
      );

      if (
        response.redirected
        || (response.url !== "" && response.url !== url.href)
      ) {
        throw new Error("fetch_policy_redirect_rejected");
      }

      if (response.status === 429) {
        const delay = retryAfterMilliseconds(
          response.headers.get("retry-after"),
          nowImpl(),
        );
        await response.body?.cancel().catch(() => undefined);
        if (attempt > MAX_RETRIES) {
          throw new RateLimitError(delay, attempt);
        }
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onParentAbort);
        await waitBeforeRetry(delay, sleepImpl, options.signal);
        continue;
      }

      if (response.status >= 500 && response.status <= 599) {
        await response.body?.cancel().catch(() => undefined);
        if (attempt > MAX_RETRIES) {
          throw new Error(`fetch_policy_transient_status_${response.status}`);
        }
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onParentAbort);
        await waitBeforeRetry(
          1_000 * (2 ** (attempt - 1)),
          sleepImpl,
          options.signal,
        );
        continue;
      }

      if (response.status < 200 || response.status > 299) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`fetch_policy_status_${response.status}`);
      }

      const body = await readBoundedText(
        response,
        maxBytes,
        controller.signal,
      );
      return {
        status: response.status,
        bytes: body.bytes,
        sha256: body.sha256,
        url: url.href,
        attempts: attempt,
        text: body.text,
      };
    } catch (error) {
      if (
        controller.signal.aborted
        || options.signal?.aborted
        || (error instanceof Error && error.name === "AbortError")
      ) {
        throw abortError();
      }
      if (nonRetryable(error)) throw error;
      if (attempt > MAX_RETRIES) {
        throw new Error("fetch_policy_network_retries_exhausted");
      }
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onParentAbort);
      await waitBeforeRetry(
        1_000 * (2 ** (attempt - 1)),
        sleepImpl,
        options.signal,
      );
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onParentAbort);
    }
  }

  throw new Error("fetch_policy_network_retries_exhausted");
}
