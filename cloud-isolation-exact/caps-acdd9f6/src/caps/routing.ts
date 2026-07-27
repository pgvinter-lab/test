import { mapTrustedContext } from "./census.js";
import type {
  CapabilityBase,
  CapabilityPricing,
  CensusTrustedContext,
  SurfaceOwner,
} from "./types.js";

export type CapsTableOrigin =
  | "installed_working"
  | "installed_broken"
  | "available_for_install";

export type RoutingRecipeType =
  | "native"
  | "mailbox-antigravity"
  | "a2a-claude"
  | "a2a-codex"
  | "unavailable-clickup"
  | "unavailable-gemini"
  | "available-install"
  | "diagnostic-broken"
  | "diagnostic-stale"
  | "diagnostic-unverified"
  | "unavailable";

export interface RoutingTemplate {
  tool: "bridge_mailbox_send" | "bridge_a2a_send";
  arguments: {
    provider?: "antigravity";
    target?: "claude" | "codex";
    prompt: "<owner-approved task>";
  };
}

export interface RoutingRecipe {
  type: RoutingRecipeType;
  instructions: string;
  is_callable: boolean;
  exact_tool_name?: string;
  template?: RoutingTemplate;
  pricing?: CapabilityPricing;
  install_command?: string | null;
  requires_owner_confirmation?: boolean;
  last_evidence?: {
    last_verified: string | null;
    stale_at: string | null;
    failure_reason?: string;
  };
  repair?: string;
}

type RoutingCapability = CapabilityBase & {
  failure_reason?: unknown;
};
type LastEvidence = NonNullable<RoutingRecipe["last_evidence"]>;

const TEXT_LIMIT = 2_048;

function truncateUtf8(value: string, maximum: number): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > maximum) break;
    output += character;
    bytes += next;
  }
  return output;
}

function safeOneLine(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    /\b(?:Bearer\s+|token\s*[:=]\s*|secret\s*[:=]\s*|password\s*[:=]\s*|api[_-]?key\s*[:=]\s*)\S+/i
      .test(normalized)
  ) {
    return "[REDACTED]";
  }
  return truncateUtf8(normalized, TEXT_LIMIT) || fallback;
}

function timestamp(value: unknown): number | null {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function lastEvidence(cap: RoutingCapability): LastEvidence {
  return {
    last_verified: typeof cap.last_verified === "string"
      ? cap.last_verified
      : null,
    stale_at: typeof cap.stale_at === "string" ? cap.stale_at : null,
  };
}

function exactNativeToolName(cap: RoutingCapability): string | null {
  if (cap.kind === "tool") {
    const name = safeOneLine(cap.name, "");
    return name && name !== "[REDACTED]" ? name : null;
  }
  if (cap.kind !== "server" || typeof cap.tools_json !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(cap.tools_json) as unknown;
    if (!Array.isArray(parsed)) return null;
    const names = parsed.flatMap((entry) => {
      if (
        !entry
        || typeof entry !== "object"
        || Array.isArray(entry)
        || typeof (entry as Record<string, unknown>).name !== "string"
      ) {
        return [];
      }
      const name = safeOneLine(
        (entry as Record<string, unknown>).name,
        "",
      );
      return name && name !== "[REDACTED]" ? [name] : [];
    });
    return names.length === 1 ? names[0] : null;
  } catch {
    return null;
  }
}

function callerOwner(context: CensusTrustedContext): SurfaceOwner {
  return mapTrustedContext(context).surface_owner;
}

export function computeRoutingRecipe(
  cap: RoutingCapability,
  tableOrigin: CapsTableOrigin,
  callerContext: CensusTrustedContext,
  now = Date.now(),
): RoutingRecipe {
  const owner = callerOwner(callerContext);
  const evidence = lastEvidence(cap);

  if (tableOrigin === "installed_broken") {
    const failureReason = safeOneLine(
      cap.failure_reason,
      "unknown failure",
    );
    return {
      type: "diagnostic-broken",
      instructions:
        `Capability is broken. Last evidence: ${failureReason}.`,
      is_callable: false,
      last_evidence: { ...evidence, failure_reason: failureReason },
      repair: "Refresh or re-probe through the Code orchestrator before use.",
    };
  }

  if (cap.surface_owner === "gemini") {
    return {
      type: "unavailable-gemini",
      instructions: "Gemini is retired and has no dispatch route.",
      is_callable: false,
      last_evidence: evidence,
      repair: "Select a non-Gemini capability.",
    };
  }

  const observedAt = timestamp(cap.observed_at);
  const verifiedAt = timestamp(cap.last_verified);
  const staleAt = timestamp(cap.stale_at);
  if (
    observedAt === null
    || observedAt > now + 5 * 60_000
    || verifiedAt === null
    || verifiedAt > now + 5 * 60_000
    || staleAt === null
    || verifiedAt > staleAt
    || staleAt <= now
  ) {
    return {
      type: "diagnostic-stale",
      instructions:
        "Capability evidence is stale, missing, or invalid; refresh before use.",
      is_callable: false,
      last_evidence: evidence,
      repair: "Refresh through the Code orchestrator and verify a new roster/probe.",
    };
  }

  if (tableOrigin === "available_for_install") {
    const installCommand = cap.install_command
      ? safeOneLine(cap.install_command, "")
      : "";
    return {
      type: "available-install",
      instructions:
        "Capability is not installed. Any install requires explicit owner confirmation.",
      is_callable: false,
      pricing: cap.pricing,
      install_command: installCommand || null,
      requires_owner_confirmation: true,
      last_evidence: evidence,
    };
  }

  if (cap.surface_owner === owner) {
    const toolName = exactNativeToolName(cap);
    if (toolName) {
      return {
        type: "native",
        instructions: `Call the verified native tool "${toolName}".`,
        is_callable: true,
        exact_tool_name: toolName,
        last_evidence: evidence,
      };
    }
    return {
      type: "diagnostic-unverified",
      instructions:
        "The caller owns this surface, but no single verified exact tool name is available.",
      is_callable: false,
      last_evidence: evidence,
      repair: "Use caps_get to inspect the verified tool roster before selecting a tool.",
    };
  }

  switch (cap.surface_owner) {
    case "agy":
      return {
        type: "mailbox-antigravity",
        instructions:
          "Dispatch through the existing Antigravity mailbox-v3 provider.",
        is_callable: true,
        template: {
          tool: "bridge_mailbox_send",
          arguments: {
            provider: "antigravity",
            prompt: "<owner-approved task>",
          },
        },
        last_evidence: evidence,
      };
    case "claude":
      return {
        type: "a2a-claude",
        instructions: "Dispatch to Claude through the approved D-026 A2A lane.",
        is_callable: true,
        template: {
          tool: "bridge_a2a_send",
          arguments: {
            target: "claude",
            prompt: "<owner-approved task>",
          },
        },
        last_evidence: evidence,
      };
    case "codex":
      return {
        type: "a2a-codex",
        instructions: "Dispatch to Codex through the approved D-026 A2A lane.",
        is_callable: true,
        template: {
          tool: "bridge_a2a_send",
          arguments: {
            target: "codex",
            prompt: "<owner-approved task>",
          },
        },
        last_evidence: evidence,
      };
    case "clickup-hosted":
      return {
        type: "unavailable-clickup",
        instructions:
          "ClickUp routing is unavailable until its approved integration exists.",
        is_callable: false,
        last_evidence: evidence,
        repair: "Wait for the separately approved ClickUp integration.",
      };
    default:
      return {
        type: "unavailable",
        instructions: "No approved route exists for this capability surface.",
        is_callable: false,
        last_evidence: evidence,
      };
  }
}
