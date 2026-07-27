import { loadCatalog } from "./catalog.js";

/**
 * Minimal OpenRouter client — the authenticated surface the router builds on.
 *
 * Unlike the catalog (public, keyless), every call here needs an API key:
 *   - inference (chat completions, OpenAI-compatible)
 *   - the Auto Router (`openrouter/auto`) — decision + execution bundled
 *   - any metered execution / failover
 *
 * Key resolution is ENV ONLY (`OPENROUTER_API_KEY`) on purpose: BRIDGE_HOME can
 * resolve to a Drive-synced folder, and we never want a secret written there.
 * Set it persistently on Windows with:  setx OPENROUTER_API_KEY "sk-or-..."
 * (then open a NEW shell — setx only affects future processes).
 */

const BASE = "https://openrouter.ai/api/v1";
const CHAT_URL = `${BASE}/chat/completions`;
const DEFAULT_TIMEOUT_MS = 120_000;

export function hasApiKey(): boolean {
  return !!process.env.OPENROUTER_API_KEY?.trim();
}

export function getApiKey(): string {
  const k = process.env.OPENROUTER_API_KEY?.trim();
  if (!k) {
    throw new Error(
      "OPENROUTER_API_KEY not set. Get one at https://openrouter.ai/keys, then (Windows, persistent):\n" +
      '  setx OPENROUTER_API_KEY "sk-or-v1-..."\n' +
      "and open a NEW terminal before retrying."
    );
  }
  return k;
}

// --- chat completions -------------------------------------------------------

export interface ChatMsg { role: "system" | "user" | "assistant"; content: string; }

export interface ChatOpts {
  model: string;
  messages: ChatMsg[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Extra OpenAI-compatible body fields (response_format, tools, provider routing, …). */
  extra?: Record<string, unknown>;
}

export interface ChatResult {
  text: string;
  /** The model that ACTUALLY answered — differs from the request when using openrouter/auto. */
  model: string;
  usage: unknown;
  finishReason: string | null;
  raw: unknown;
}

export async function chat(opts: ChatOpts): Promise<ChatResult> {
  const key = getApiKey();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(CHAT_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        // Optional ranking headers; harmless, identify this local tool.
        "HTTP-Referer": "https://localhost/codex-connector",
        "X-Title": "Codex Connector Router",
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.extra ?? {}),
      }),
    });
    const bodyText = await res.text();
    let body: any;
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new Error(`OpenRouter returned non-JSON (HTTP ${res.status}): ${bodyText.slice(0, 200)}`);
    }
    if (!res.ok) {
      const msg = body?.error?.message ?? `HTTP ${res.status} ${res.statusText}`;
      throw new Error(`OpenRouter error: ${msg}`);
    }
    const choice = body?.choices?.[0];
    return {
      text: choice?.message?.content ?? "",
      model: body?.model ?? opts.model,
      usage: body?.usage ?? null,
      finishReason: choice?.finish_reason ?? null,
      raw: body,
    };
  } finally {
    clearTimeout(timer);
  }
}

// --- connectivity ping ------------------------------------------------------

/** Pick a free (`:free`) text model from the cached catalog so a ping costs nothing. */
export function defaultPingModel(): string | null {
  const free = loadCatalog().models.find(
    (m) => m.id.endsWith(":free") && m.inputModalities.includes("text")
  );
  return free?.id ?? null;
}

/** A tiny, cheap round-trip to prove key + connectivity end-to-end. */
export async function ping(model?: string): Promise<ChatResult & { picked: string }> {
  const m = model ?? defaultPingModel();
  if (!m) {
    throw new Error("no model given and no ':free' model in catalog — run `bridge catalog refresh`, or pass a model id.");
  }
  const r = await chat({
    model: m,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    maxTokens: 16,
    temperature: 0,
  });
  return { ...r, picked: m };
}
