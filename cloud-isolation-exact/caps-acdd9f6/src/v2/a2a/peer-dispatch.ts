// Subscription-surface dispatcher (Phase B, D-026): drive a peer via its
// subscription-authenticated CLI in a one-shot headless call.
//
// HARD INVARIANT: subscriptions only, NEVER API keys.
//
// TRUST MODEL (rewritten after independent review, N5). The previous version took
// a caller-supplied `PeerCliSpec` and validated only `spec.command` against an
// allowlist — so a forged spec could pass `command: "codex"` and still return
// arbitrary argv. It also skipped any argv token equal to the prompt, which meant
// a prompt of literally "--api-key" could smuggle a credential flag past the
// scanner. Both holes came from trusting caller-shaped input.
//
// Now the caller passes only a PEER NAME. The argv is built here from a frozen
// internal table: fixed flag tokens, then the prompt placed BY CONSTRUCTION (on
// stdin, or as the value of one fixed option). The prompt is never compared
// against flags, so it can contain anything — and no caller-supplied token can
// become an independent argv option.
//
// The frozen flags are checked once at module load, so "no key-shaped flag" is a
// static property of this table rather than a scan of untrusted input.
//
// RELIABILITY TIERS (owner directive). A peer whose invocation we have not been
// able to verify is marked `unreliable`: the send still goes out unchanged, but
// nothing is expected back and a failure is NOT an error — it is reported in the
// result. A `verified` peer keeps strict behaviour (non-zero exit throws). This
// keeps an unverified peer wired up and best-effort instead of silently pretending
// it works, or being switched off entirely.
//
// LIMITATIONS (stated, not solved): `runProcess` is injected — this module never
// spawns. Resolving `command` to an approved executable (rather than whatever
// PATH yields) and launching without a shell and with a sanitized environment are
// therefore the injected runner's responsibility. Antigravity's real CLI requires
// the prompt as an option value, so that prompt is visible to local process-command
// inspection even though it cannot become a separate option. This module bounds
// what is *constructed*; it cannot bound what the OS hands the child.

import { asErrorCode, invariant } from "../core/errors.js";
import type { CommandCenterPeer } from "./agent-card.js";

/**
 * `verified` — the invocation is confirmed against the vendor's own docs and a
 * response can be relied on. `unreliable` — best-effort: dispatch anyway, expect
 * nothing back, never throw.
 */
export type PeerReliability = "verified" | "unreliable";

export interface PeerCliSpec {
  readonly peer: CommandCenterPeer;
  /** Executable name. The injected runner is responsible for resolving it safely. */
  readonly command: string;
  /** Fixed tokens that precede the prompt. Frozen; never caller-supplied. */
  readonly flags: readonly string[];
  /** Where the prompt is delivered. */
  readonly promptMode: "option-value" | "stdin";
  /** Fixed option name when `promptMode` is `option-value`. */
  readonly promptFlag?: string;
  readonly reliability: PeerReliability;
  /** Why the peer is unreliable — surfaced so this is never silently forgotten. */
  readonly reliabilityNote?: string;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export type RunProcess = (command: string, args: readonly string[], input?: string) => Promise<ProcessResult>;

/** Outcome of a dispatch. `delivered` is the only proof a response is real. */
export interface PeerDispatchResult {
  readonly peer: CommandCenterPeer;
  readonly reliability: PeerReliability;
  /** True only when the process ran and exited 0. Never assumed for an unreliable peer. */
  readonly delivered: boolean;
  /** Stdout; empty when nothing came back. Meaningless unless `delivered`. */
  readonly stdout: string;
  /** Why delivery failed. Reported rather than swallowed, so a caller can log it. */
  readonly failure?: string;
}

const ANTIGRAVITY_MODEL = "Gemini 3.1 Pro (High)";

// Subscription-authenticated, headless one-shot invocations. NONE take an API key.
// Antigravity (`agy`) is the Google surface; the retired Gemini CLI is not a peer.
// Prompts use STDIN whenever the CLI supports it. The real Antigravity CLI does
// not: its headless mode requires a string value for `--print`. Supplying that as
// one `--print=<prompt>` token (and spawning without a shell) keeps flag-shaped
// prompt content inside the known option value rather than making it a new option.
const PEER_CLI_SPECS: Readonly<Record<CommandCenterPeer, PeerCliSpec>> = Object.freeze({
  antigravity: Object.freeze({
    peer: "antigravity",
    command: "agy",
    // AGY print mode is otherwise unable to execute terminal tools: a fresh
    // headless conversation has no initialized project scratch area and
    // auto-denies command confirmations. A2A dispatch is itself the audited
    // execution approval, so initialize an isolated CLI project and allow its
    // noninteractive tools to run for the duration of this one-shot process.
    flags: Object.freeze([
      "--new-project",
      "--model",
      ANTIGRAVITY_MODEL,
      "--mode",
      "accept-edits",
      "--dangerously-skip-permissions",
      "--print-timeout",
      "20m",
    ]),
    promptMode: "option-value",
    promptFlag: "--print",
    reliability: "verified",
  }),
  // Claude Code headless print mode (subscription auth); reads the prompt on stdin.
  claude: Object.freeze({
    peer: "claude",
    command: "claude",
    flags: Object.freeze(["-p"]),
    promptMode: "stdin",
    reliability: "verified",
  }),
  // Codex CLI non-interactive (subscription auth via CODEX_HOME). `codex exec`
  // reads instructions from stdin when no prompt argument is given. Bridge jobs
  // often live in Antigravity brain/project directories that are not Git repos,
  // so the fixed skip-repo-check flag is required for that supported input.
  codex: Object.freeze({
    peer: "codex",
    command: "codex",
    flags: Object.freeze(["exec", "--skip-git-repo-check"]),
    promptMode: "stdin",
    reliability: "verified",
  }),
}) as Readonly<Record<CommandCenterPeer, PeerCliSpec>>;

/** Any flag that would indicate a metered API-key path — forbidden by the invariant. */
const FORBIDDEN_ARG = /--?(api[-_]?key|key|token|bearer|access[-_]?token)\b/i;

// Static assertion over the frozen table: no built-in spec may carry a key-shaped
// flag. Checked once, at load, against OUR tokens — not against caller input.
for (const spec of Object.values(PEER_CLI_SPECS)) {
  invariant(spec.promptMode !== "option-value" || spec.promptFlag, "a2a_peer_dispatch_prompt_flag_missing", {
    peer: spec.peer,
  });
  invariant(spec.promptMode !== "stdin" || !spec.promptFlag, "a2a_peer_dispatch_prompt_flag_unexpected", {
    peer: spec.peer,
  });
  const fixedOptions = spec.promptFlag ? [...spec.flags, spec.promptFlag] : spec.flags;
  for (const flag of fixedOptions) {
    invariant(!FORBIDDEN_ARG.test(flag), "a2a_peer_dispatch_api_key_forbidden", { peer: spec.peer });
  }
}

/** Read-only view of a peer's frozen spec (inspection/tests). */
export function peerCliSpec(peer: CommandCenterPeer): PeerCliSpec {
  const spec = PEER_CLI_SPECS[peer];
  invariant(spec, "a2a_peer_dispatch_unknown_peer", { peer });
  return spec;
}

/** Whether a peer's response can be relied on at all. */
export function peerReliability(peer: CommandCenterPeer): PeerReliability {
  return peerCliSpec(peer).reliability;
}

/** The argv this module would run for a peer — prompt placed by construction. */
export function buildPeerArgv(spec: PeerCliSpec, prompt: string): readonly string[] {
  if (spec.promptMode === "stdin") return [...spec.flags];
  invariant(spec.promptFlag, "a2a_peer_dispatch_prompt_flag_missing", { peer: spec.peer });
  return [...spec.flags, `${spec.promptFlag}=${prompt}`];
}

/**
 * Dispatch a prompt to a peer's subscription CLI. The caller names a peer; it
 * cannot supply the command, the flags, or the argv.
 *
 * A `verified` peer throws on a non-zero exit. An `unreliable` peer never throws:
 * the send is attempted unchanged and the outcome is returned, because no response
 * is expected from it in the first place.
 */
export async function dispatchToPeer(
  peer: CommandCenterPeer,
  prompt: string,
  runProcess: RunProcess,
): Promise<PeerDispatchResult> {
  const spec = peerCliSpec(peer);
  const args = buildPeerArgv(spec, prompt);
  const input = spec.promptMode === "stdin" ? prompt : undefined;
  const reliability = spec.reliability;

  if (reliability === "unreliable") {
    // Best-effort: fire it and move on. The failure is RETURNED, not swallowed —
    // a caller that wants to log "antigravity never answered" still can.
    try {
      const result = await runProcess(spec.command, args, input);
      if (result.code === 0) return { peer, reliability, delivered: true, stdout: result.stdout };
      return { peer, reliability, delivered: false, stdout: "", failure: `exit_${result.code}` };
    } catch (error) {
      return { peer, reliability, delivered: false, stdout: "", failure: asErrorCode(error) };
    }
  }

  const result = await runProcess(spec.command, args, input);
  invariant(result.code === 0, "a2a_peer_dispatch_failed", { peer, code: result.code });
  return { peer, reliability, delivered: true, stdout: result.stdout };
}
