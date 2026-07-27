import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROBE_POLICY = Object.freeze({
  DEFAULT_INITIALIZE_MS: 10_000,
  DEFAULT_TOOLS_LIST_MS: 10_000,
  DEFAULT_TOTAL_MS: 25_000,
  MIN_PHASE_MS: 100,
  MAX_PHASE_MS: 30_000,
  MIN_TOTAL_MS: 250,
  MAX_TOTAL_MS: 60_000,
  MAX_STDOUT_BYTES: 512 * 1024,
  MAX_STDERR_BYTES: 64 * 1024,
  MAX_DIAGNOSTIC_BYTES: 8 * 1024,
  MAX_RPC_MESSAGE_BYTES: 384 * 1024,
  MAX_SCHEMA_BYTES: 64 * 1024,
  MAX_TOTAL_SCHEMA_BYTES: 256 * 1024,
  MAX_TOOL_COUNT: 1_000,
  MAX_TOOL_NAME_BYTES: 256,
  MAX_TOOL_DESCRIPTION_BYTES: 8 * 1024,
  MAX_ARGUMENT_COUNT: 256,
  MAX_ARGUMENT_BYTES: 64 * 1024,
  GRACEFUL_CLOSE_MS: 250,
  FORCE_KILL_MS: 2_000,
  WORKING_DIRECTORY: path.join(os.tmpdir(), "bridge-caps-stdio-probe"),
} as const);

export interface ProbeTimeouts {
  initializeMs: number;
  toolsListMs: number;
  totalMs: number;
}

export interface OwnerProbePolicy {
  readonly timeouts: Readonly<ProbeTimeouts>;
}

export interface ResolvedProbeCommand {
  executable: string;
  args: string[];
}

const authorizedOwnerPolicies = new WeakSet<object>();
const shellMetacharacters = /[&|;$<>\r\n\0]/;
const redactionPlaceholder = /\[(?:redacted|secret|credential)[^\]]*\]/i;
const secretKey = /(?:^|_)(?:api_?key|token|secret|password|passwd|authorization|bearer|cookie|credential|oauth|client_?secret|access_?key|private_?key)(?:$|_)/i;

const safeEnvironmentNames = Object.freeze([
  "PATH",
  "SystemRoot",
  "SystemDrive",
] as const);

function finiteInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
}

function clamp(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, finiteInteger(value, fallback)));
}

export function getProbeTimeouts(requested: Partial<ProbeTimeouts> = {}): ProbeTimeouts {
  const initializeMs = clamp(
    requested.initializeMs,
    PROBE_POLICY.DEFAULT_INITIALIZE_MS,
    PROBE_POLICY.MIN_PHASE_MS,
    PROBE_POLICY.MAX_PHASE_MS,
  );
  const toolsListMs = clamp(
    requested.toolsListMs,
    PROBE_POLICY.DEFAULT_TOOLS_LIST_MS,
    PROBE_POLICY.MIN_PHASE_MS,
    PROBE_POLICY.MAX_PHASE_MS,
  );
  const totalMs = clamp(
    requested.totalMs,
    PROBE_POLICY.DEFAULT_TOTAL_MS,
    PROBE_POLICY.MIN_TOTAL_MS,
    PROBE_POLICY.MAX_TOTAL_MS,
  );

  return Object.freeze({ initializeMs, toolsListMs, totalMs });
}

/**
 * Creates an in-process owner policy. The WeakSet brand deliberately cannot be
 * reconstructed from JSON or from an MCP tool argument.
 */
export function createOwnerProbePolicy(requested: Partial<ProbeTimeouts> = {}): OwnerProbePolicy {
  const policy = Object.freeze({ timeouts: getProbeTimeouts(requested) });
  authorizedOwnerPolicies.add(policy);
  return policy;
}

export const DEFAULT_OWNER_PROBE_POLICY = createOwnerProbePolicy();

export function requireOwnerProbePolicy(value: unknown): OwnerProbePolicy {
  if (!value || typeof value !== "object" || !authorizedOwnerPolicies.has(value as object)) {
    throw new Error("probe_policy_untrusted_override");
  }
  return value as OwnerProbePolicy;
}

function environmentValue(name: string): string | undefined {
  const wanted = name.toLowerCase();
  const entry = Object.entries(process.env).find(([key]) => key.toLowerCase() === wanted);
  return entry?.[1];
}

function sanitizedPath(value: string | undefined): string {
  if (!value) {
    throw new Error("probe_policy_path_unavailable");
  }
  const entries = value
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry))
    .map((entry) => path.resolve(entry))
    .filter((entry, index, all) => all.findIndex((candidate) =>
      candidate.toLowerCase() === entry.toLowerCase()) === index);
  if (entries.length === 0) {
    throw new Error("probe_policy_path_unavailable");
  }
  return entries.join(path.delimiter);
}

/**
 * Builds a credential-blind environment. Declared server env is validated only
 * to return a stable reason; none of it is forwarded.
 */
export function getSafeEnvironment(declaredEnvironment?: unknown): NodeJS.ProcessEnv {
  if (declaredEnvironment !== undefined && declaredEnvironment !== null) {
    if (
      typeof declaredEnvironment !== "object"
      || Array.isArray(declaredEnvironment)
    ) {
      throw new Error("probe_policy_declared_env_invalid");
    }
    for (const key of Object.keys(declaredEnvironment as Record<string, unknown>)) {
      if (secretKey.test(key)) {
        throw new Error("probe_policy_secret_env_rejected");
      }
      throw new Error("probe_policy_declared_env_rejected");
    }
  }

  const result: NodeJS.ProcessEnv = {};
  for (const name of safeEnvironmentNames) {
    const value = environmentValue(name);
    if (value === undefined || secretKey.test(name)) {
      continue;
    }
    result[name] = name === "PATH" ? sanitizedPath(value) : value;
  }
  if (!result.PATH) {
    result.PATH = sanitizedPath(environmentValue("PATH"));
  }
  const isolatedHome = path.join(PROBE_POLICY.WORKING_DIRECTORY, "home");
  const isolatedTemp = path.join(PROBE_POLICY.WORKING_DIRECTORY, "temp");
  fs.mkdirSync(isolatedHome, { recursive: true });
  fs.mkdirSync(isolatedTemp, { recursive: true });
  result.USERPROFILE = isolatedHome;
  result.TEMP = isolatedTemp;
  result.TMP = isolatedTemp;
  return result;
}

function approvedPathRoots(environment: NodeJS.ProcessEnv): string[] {
  const pathValue = environment.PATH ?? environment.Path;
  if (!pathValue) {
    return [];
  }
  return pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => path.resolve(entry))
    .flatMap((entry) => {
      try {
        return [fs.realpathSync(entry)];
      } catch {
        return [];
      }
    });
}

function isInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function executableCandidates(command: string): string[] {
  if (process.platform !== "win32" || path.extname(command)) {
    return [command];
  }
  return [`${command}.exe`, `${command}.com`];
}

/**
 * Resolves a basename through the sanitized PATH, or accepts an absolute file
 * only when its real path is contained by one of those same approved roots.
 * Script launchers (.cmd/.bat/.ps1) are rejected because they require a shell.
 */
export function resolveExecutable(
  command: unknown,
  environment: NodeJS.ProcessEnv = getSafeEnvironment(),
): string {
  if (typeof command !== "string" || command.trim() === "") {
    throw new Error("probe_policy_invalid_command");
  }
  if (command !== command.trim() || shellMetacharacters.test(command)) {
    throw new Error("probe_policy_shell_metacharacters_rejected");
  }
  if (redactionPlaceholder.test(command)) {
    throw new Error("probe_policy_redacted_command_rejected");
  }

  const roots = approvedPathRoots(environment);
  if (roots.length === 0) {
    throw new Error("probe_policy_path_unavailable");
  }

  let candidates: string[];
  if (path.isAbsolute(command)) {
    candidates = [path.resolve(command)];
  } else {
    if (path.basename(command) !== command || command === "." || command === "..") {
      throw new Error("probe_policy_relative_path_rejected");
    }
    candidates = roots.flatMap((root) =>
      executableCandidates(command).map((name) => path.join(root, name)));
  }

  for (const candidate of candidates) {
    let realCandidate: string;
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) {
        continue;
      }
      realCandidate = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    const extension = path.extname(realCandidate).toLowerCase();
    if (process.platform === "win32" && extension !== ".exe" && extension !== ".com") {
      continue;
    }
    if (roots.some((root) => isInsideRoot(realCandidate, root))) {
      return realCandidate;
    }
  }

  if (path.isAbsolute(command)) {
    throw new Error("probe_policy_unapproved_absolute_path");
  }
  throw new Error("probe_policy_executable_not_found");
}

function resolveTrustedNpmShim(
  command: string,
  environment: NodeJS.ProcessEnv,
): { executable: string; cli: string } | null {
  if (process.platform !== "win32") {
    return null;
  }
  const normalized = command.toLowerCase();
  const shim = normalized === "npx"
    || normalized === "npx.cmd"
    || normalized === "npx.ps1"
    ? "npx-cli.js"
    : normalized === "npm"
      || normalized === "npm.cmd"
      || normalized === "npm.ps1"
      ? "npm-cli.js"
      : null;
  if (!shim) {
    return null;
  }

  for (const root of approvedPathRoots(environment)) {
    const nodeCandidate = path.join(root, "node.exe");
    const cliCandidate = path.join(root, "node_modules", "npm", "bin", shim);
    try {
      const executable = fs.realpathSync(nodeCandidate);
      const cli = fs.realpathSync(cliCandidate);
      if (
        fs.statSync(executable).isFile()
        && fs.statSync(cli).isFile()
        && isInsideRoot(executable, root)
        && isInsideRoot(cli, root)
      ) {
        return { executable, cli };
      }
    } catch {
      // Try the next approved PATH root.
    }
  }
  throw new Error("probe_policy_executable_not_found");
}

/**
 * Resolves a complete shell-free spawn plan. On Windows, trusted npm/npx
 * launcher basenames are mapped to their underlying Node CLI module instead
 * of executing .cmd/.ps1 through a command shell.
 */
export function resolveProbeCommand(
  command: unknown,
  args: unknown,
  environment: NodeJS.ProcessEnv = getSafeEnvironment(),
): ResolvedProbeCommand {
  const validatedArgs = validateArguments(args);
  if (typeof command === "string") {
    if (command !== command.trim() || shellMetacharacters.test(command)) {
      throw new Error("probe_policy_shell_metacharacters_rejected");
    }
    if (redactionPlaceholder.test(command)) {
      throw new Error("probe_policy_redacted_command_rejected");
    }
    if (path.basename(command) === command) {
      const shim = resolveTrustedNpmShim(command, environment);
      if (shim) {
        return {
          executable: shim.executable,
          args: [shim.cli, ...validatedArgs],
        };
      }
    }
  }
  return {
    executable: resolveExecutable(command, environment),
    args: validatedArgs,
  };
}

export function validateArguments(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > PROBE_POLICY.MAX_ARGUMENT_COUNT) {
    throw new Error("probe_policy_invalid_arguments");
  }
  let totalBytes = 0;
  const argumentsCopy = value.map((entry) => {
    if (typeof entry !== "string") {
      throw new Error("probe_policy_invalid_arguments");
    }
    if (shellMetacharacters.test(entry)) {
      throw new Error("probe_policy_argument_metacharacters_rejected");
    }
    if (redactionPlaceholder.test(entry)) {
      throw new Error("probe_policy_redacted_argument_rejected");
    }
    totalBytes += Buffer.byteLength(entry, "utf8");
    return entry;
  });
  if (totalBytes > PROBE_POLICY.MAX_ARGUMENT_BYTES) {
    throw new Error("probe_policy_arguments_overflow");
  }
  return argumentsCopy;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const source = Buffer.from(value, "utf8");
  if (source.length <= maximumBytes) {
    return value;
  }
  return source.subarray(0, maximumBytes).toString("utf8");
}

export function redactDiagnostic(input: unknown): string {
  let value = typeof input === "string" ? input : String(input ?? "");
  value = value
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTHORIZATION|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?\b/g, "[REDACTED]")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]");
  return truncateUtf8(value, PROBE_POLICY.MAX_DIAGNOSTIC_BYTES);
}

export function ensureProbeWorkingDirectory(): string {
  fs.mkdirSync(PROBE_POLICY.WORKING_DIRECTORY, { recursive: true });
  return PROBE_POLICY.WORKING_DIRECTORY;
}
