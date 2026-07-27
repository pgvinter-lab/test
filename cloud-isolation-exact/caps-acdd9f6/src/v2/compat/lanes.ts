export interface LaneResolution {
  lane: string;
  warning: string | null;
  ambiguous: boolean;
}

const ALIASES: Record<string, string> = {
  code: "claude_desktop_code",
  claude_code: "claude_desktop_code",
  "claude-code": "claude_desktop_code",
  claude_desktop_code: "claude_desktop_code",
  cowork: "claude_desktop_cowork",
  claude_cowork: "claude_desktop_cowork",
  "claude-cowork": "claude_desktop_cowork",
  claude_desktop_cowork: "claude_desktop_cowork",
};

export function resolveLane(input: {
  configuredAgent?: string;
  configuredLane?: string;
  clientName?: string;
}): LaneResolution {
  const explicit = normalize(input.configuredLane);
  if (explicit) return { lane: canonicalLane(explicit), warning: null, ambiguous: false };

  const configured = normalize(input.configuredAgent) || "unknown";
  if (configured !== "claude") return { lane: canonicalLane(configured), warning: null, ambiguous: false };

  const client = normalize(input.clientName);
  if (client.includes("cowork")) {
    return { lane: "claude_desktop_cowork", warning: null, ambiguous: false };
  }
  if (client.includes("code") || client.includes("cli")) {
    return { lane: "claude_desktop_code", warning: null, ambiguous: false };
  }
  return {
    lane: "claude_desktop_code",
    warning: "BRIDGE_AGENT=claude did not identify Code versus Cowork. Set BRIDGE_LANE=claude_desktop_code or BRIDGE_LANE=claude_desktop_cowork before claiming files.",
    ambiguous: true,
  };
}

export function canonicalLane(value: string): string {
  const normalized = normalize(value);
  if (ALIASES[normalized]) return ALIASES[normalized];
  if (normalized === "claude") return "claude_desktop_code";
  return normalized || "unknown";
}

export function defaultHandoffTarget(currentLane: string): string {
  return canonicalLane(currentLane) === "codex" ? "claude_desktop_code" : "codex";
}

export function laneIdentifier(value: string): string {
  return canonicalLane(value).replace(/[^a-z0-9._:-]+/gu, "_").replace(/^_+|_+$/gu, "") || "unknown";
}

function normalize(value?: string): string {
  return (value ?? "").trim().toLowerCase().replace(/[\s/]+/gu, "_");
}
