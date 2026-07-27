import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CapsStore } from "./store.js";
import type { CapabilityBase } from "./types.js";
import {
  DEFAULT_OWNER_PROBE_POLICY,
  PROBE_POLICY,
  ensureProbeWorkingDirectory,
  getSafeEnvironment,
  redactDiagnostic,
  requireOwnerProbePolicy,
  resolveProbeCommand,
  type OwnerProbePolicy,
  type ProbeTimeouts,
} from "./probe-policy.js";

type CapsTable = "installed_working" | "installed_broken" | "available_for_install";

interface CapabilityRow extends CapabilityBase {
  failure_reason?: string;
  failure_observed_at?: string;
}

interface ProbeCommand {
  executable: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
}

interface CapturedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface LiveProbeSuccess {
  ok: true;
  tools: CapturedTool[];
  serverInfo: { name: string; version?: string };
  protocolVersion: string;
  pid: number;
  stdoutBytes: number;
  stderrBytes: number;
  cleanupMethod: string;
}

interface LiveProbeFailure {
  ok: false;
  code: string;
  diagnostic: string;
  pid: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  cleanupMethod: string;
}

type LiveProbeResult = LiveProbeSuccess | LiveProbeFailure;

export interface ProbeOutcome {
  capabilityId: string;
  status: "working" | "broken";
  code: "ok" | string;
  observedAt: string;
  toolCount: number;
}

class ProbeFailure extends Error {
  constructor(
    readonly code: string,
    diagnostic = code,
  ) {
    super(diagnostic);
    this.name = "ProbeFailure";
  }
}

function failureFromUnknown(error: unknown, fallbackCode = "probe_internal_error"): ProbeFailure {
  if (error instanceof ProbeFailure) {
    return error;
  }
  if (error instanceof Error && error.message.startsWith("probe_policy_")) {
    return new ProbeFailure(error.message, error.message);
  }
  return new ProbeFailure(
    fallbackCode,
    error instanceof Error ? error.message : String(error ?? fallbackCode),
  );
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function findCapability(store: CapsStore, capabilityId: string): {
  capability: CapabilityRow;
  table: CapsTable;
} | null {
  const tables: CapsTable[] = [
    "installed_working",
    "installed_broken",
    "available_for_install",
  ];
  for (const table of tables) {
    const row = store.db
      .prepare(`SELECT * FROM ${table} WHERE id = ?`)
      .get(capabilityId) as CapabilityRow | undefined;
    if (row) {
      return { capability: row, table };
    }
  }
  return null;
}

function sourceIsTrusted(
  capability: CapabilityRow,
  declaration: Record<string, unknown>,
): boolean {
  if (capability.producer_surface !== "code" || capability.capture_class !== "guaranteed") {
    return false;
  }

  const provenance = parseJsonObject(capability.provenance_json);
  const configBacked = typeof declaration.config_path === "string"
    && declaration.config_path.trim().length > 0;
  const censusApproved = provenance.stdio_probe_approved === true;
  if (capability.source_lane === "config-crawl" && configBacked) {
    return true;
  }
  if (capability.source_lane === "census" && censusApproved) {
    return true;
  }
  if (capability.source_lane === "probe") {
    const priorProbe = provenance.probe;
    return Boolean(
      priorProbe
      && typeof priorProbe === "object"
      && !Array.isArray(priorProbe)
      && (priorProbe as Record<string, unknown>).trusted_source === true,
    );
  }
  return false;
}

function validateTrustedSource(
  capability: CapabilityRow,
  declaration: Record<string, unknown>,
): void {
  if (capability.transport !== "stdio") {
    throw new ProbeFailure("invalid_transport");
  }
  if (capability.producer_surface !== "code" || capability.capture_class !== "guaranteed") {
    throw new ProbeFailure("invalid_source_capture");
  }
  if (sourceIsTrusted(capability, declaration)) {
    return;
  }
  throw new ProbeFailure("invalid_source_lane");
}

function commandFromCapability(capability: CapabilityRow): ProbeCommand {
  if (!capability.raw_json) {
    throw new ProbeFailure("invalid_raw_json");
  }
  if (Buffer.byteLength(capability.raw_json, "utf8") > PROBE_POLICY.MAX_RPC_MESSAGE_BYTES) {
    throw new ProbeFailure("invalid_raw_json_overflow");
  }

  let declaration: Record<string, unknown>;
  try {
    const parsed = JSON.parse(capability.raw_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    declaration = parsed as Record<string, unknown>;
  } catch {
    throw new ProbeFailure("invalid_raw_json");
  }

  validateTrustedSource(capability, declaration);
  const environment = getSafeEnvironment(declaration.env);
  const resolved = resolveProbeCommand(
    declaration.command,
    declaration.args,
    environment,
  );
  return {
    executable: resolved.executable,
    args: resolved.args,
    environment,
  };
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("close", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
    child.once("close", onExit);
  });
}

async function runTaskkill(pid: number, force: boolean): Promise<boolean> {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) {
    return false;
  }
  const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
  if (!fs.existsSync(taskkill)) {
    return false;
  }
  return new Promise((resolve) => {
    let killer;
    try {
      killer = spawn(
        taskkill,
        ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
        {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
        },
      );
    } catch {
      resolve(false);
      return;
    }
    killer.once("error", () => resolve(false));
    killer.once("exit", (code) => resolve(code === 0 || code === 128));
  });
}

async function terminateProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<{ ok: boolean; method: string }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { ok: true, method: "already-exited" };
  }

  try {
    child.stdin.end();
  } catch {
    // Continue to the bounded termination ladder.
  }
  if (await waitForExit(child, PROBE_POLICY.GRACEFUL_CLOSE_MS)) {
    return { ok: true, method: "stdin-eof" };
  }

  if (process.platform === "win32" && child.pid) {
    const normalInvoked = await runTaskkill(child.pid, false);
    if (await waitForExit(child, PROBE_POLICY.GRACEFUL_CLOSE_MS)) {
      return {
        ok: normalInvoked,
        method: "taskkill-tree-normal",
      };
    }
    const forceInvoked = await runTaskkill(child.pid, true);
    const exited = await waitForExit(child, PROBE_POLICY.FORCE_KILL_MS);
    return {
      ok: forceInvoked && exited,
      method: forceInvoked ? "taskkill-tree-force" : "taskkill-unavailable",
    };
  }

  try {
    child.kill("SIGTERM");
  } catch {
    // Continue to SIGKILL.
  }
  if (await waitForExit(child, PROBE_POLICY.GRACEFUL_CLOSE_MS)) {
    return { ok: true, method: "sigterm" };
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The final exit observation below determines success.
  }
  return {
    ok: await waitForExit(child, PROBE_POLICY.FORCE_KILL_MS),
    method: "sigkill",
  };
}

function normalizeServerInfo(value: unknown): { name: string; version?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProbeFailure("malformed_initialize_result");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    throw new ProbeFailure("malformed_server_info");
  }
  if (Buffer.byteLength(raw.name, "utf8") > PROBE_POLICY.MAX_TOOL_NAME_BYTES) {
    throw new ProbeFailure("server_info_overflow");
  }
  const result: { name: string; version?: string } = { name: raw.name };
  if (raw.version !== undefined) {
    if (
      typeof raw.version !== "string"
      || Buffer.byteLength(raw.version, "utf8") > PROBE_POLICY.MAX_TOOL_NAME_BYTES
    ) {
      throw new ProbeFailure("server_info_overflow");
    }
    result.version = raw.version;
  }
  return result;
}

function redactSchemaSecrets(
  value: unknown,
  key = "",
  sensitiveAncestor = false,
  depth = 0,
): unknown {
  if (depth > 64) {
    throw new ProbeFailure("schema_depth_overflow");
  }
  const sensitiveHere = sensitiveAncestor
    || /(?:token|secret|password|api[_-]?key|credential|authorization)/i.test(key);
  if (Array.isArray(value)) {
    return value.map((entry) =>
      redactSchemaSecrets(entry, key, sensitiveHere, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([childKey, childValue]) =>
          [
            childKey,
            redactSchemaSecrets(childValue, childKey, sensitiveHere, depth + 1),
          ]),
    );
  }
  if (
    typeof value === "string"
    && (
      /(?:token|secret|password|api[_-]?key|credential|authorization)/i.test(key)
      || (sensitiveAncestor && /^(?:default|example|examples|const|enum|value)$/i.test(key))
    )
  ) {
    return "[REDACTED]";
  }
  return value;
}

function normalizeTools(value: unknown): CapturedTool[] {
  if (!Array.isArray(value)) {
    throw new ProbeFailure("malformed_tools_list");
  }
  if (value.length > PROBE_POLICY.MAX_TOOL_COUNT) {
    throw new ProbeFailure("tool_count_overflow");
  }

  let totalSchemaBytes = 0;
  return value.map((rawTool) => {
    if (!rawTool || typeof rawTool !== "object" || Array.isArray(rawTool)) {
      throw new ProbeFailure("malformed_tool");
    }
    const tool = rawTool as Record<string, unknown>;
    if (
      typeof tool.name !== "string"
      || tool.name.trim() === ""
      || Buffer.byteLength(tool.name, "utf8") > PROBE_POLICY.MAX_TOOL_NAME_BYTES
    ) {
      throw new ProbeFailure("malformed_tool_name");
    }

    let description: string | undefined;
    if (tool.description !== undefined) {
      if (
        typeof tool.description !== "string"
        || Buffer.byteLength(tool.description, "utf8") > PROBE_POLICY.MAX_TOOL_DESCRIPTION_BYTES
      ) {
        throw new ProbeFailure("tool_description_overflow");
      }
      description = redactDiagnostic(tool.description);
    }

    if (
      !tool.inputSchema
      || typeof tool.inputSchema !== "object"
      || Array.isArray(tool.inputSchema)
    ) {
      throw new ProbeFailure("malformed_tool_schema");
    }
    const inputSchema = redactSchemaSecrets(tool.inputSchema) as Record<string, unknown>;
    const schemaBytes = Buffer.byteLength(JSON.stringify(inputSchema), "utf8");
    if (schemaBytes > PROBE_POLICY.MAX_SCHEMA_BYTES) {
      throw new ProbeFailure("schema_overflow");
    }
    totalSchemaBytes += schemaBytes;
    if (totalSchemaBytes > PROBE_POLICY.MAX_TOTAL_SCHEMA_BYTES) {
      throw new ProbeFailure("total_schema_overflow");
    }

    return {
      name: tool.name,
      ...(description === undefined ? {} : { description }),
      inputSchema,
    };
  });
}

async function executeProbeProtocol(
  command: ProbeCommand,
  timeouts: ProbeTimeouts,
): Promise<LiveProbeResult> {
  const cwd = ensureProbeWorkingDirectory();
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command.executable, command.args, {
      shell: false,
      windowsHide: true,
      detached: false,
      cwd,
      env: command.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const failure = failureFromUnknown(error, "spawn_error");
    return {
      ok: false,
      code: failure.code,
      diagnostic: redactDiagnostic(failure.message),
      pid: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      cleanupMethod: "not-started",
    };
  }

  const pid = child.pid ?? null;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stderrDiagnostic = "";
  let stdoutBuffer = Buffer.alloc(0);
  let closing = false;
  let fatalFailure: ProbeFailure | null = null;
  let pending: {
    id: number;
    resolve: (message: Record<string, unknown>) => void;
    reject: (error: ProbeFailure) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  const fail = (failure: ProbeFailure) => {
    if (!fatalFailure) {
      fatalFailure = failure;
    }
    if (pending) {
      const current = pending;
      pending = null;
      clearTimeout(current.timer);
      current.reject(fatalFailure);
    }
  };

  const settleMessage = (message: Record<string, unknown>) => {
    if (typeof message.method === "string" && message.id === undefined) {
      return;
    }
    if (!pending) {
      fail(new ProbeFailure("unexpected_protocol_message"));
      return;
    }
    if (message.id !== pending.id) {
      fail(new ProbeFailure("unexpected_response_id"));
      return;
    }
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    current.resolve(message);
  };

  const onStdout = (chunk: Buffer) => {
    if (closing || fatalFailure) {
      return;
    }
    stdoutBytes += chunk.length;
    if (stdoutBytes > PROBE_POLICY.MAX_STDOUT_BYTES) {
      fail(new ProbeFailure("stdout_overflow"));
      return;
    }
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    if (stdoutBuffer.length > PROBE_POLICY.MAX_RPC_MESSAGE_BYTES) {
      fail(new ProbeFailure("rpc_message_overflow"));
      return;
    }

    while (!fatalFailure) {
      const newline = stdoutBuffer.indexOf(0x0a);
      if (newline === -1) {
        break;
      }
      const line = stdoutBuffer.subarray(0, newline);
      stdoutBuffer = stdoutBuffer.subarray(newline + 1);
      if (line.length === 0 || (line.length === 1 && line[0] === 0x0d)) {
        continue;
      }
      if (line.length > PROBE_POLICY.MAX_RPC_MESSAGE_BYTES) {
        fail(new ProbeFailure("rpc_message_overflow"));
        break;
      }
      try {
        const parsed = JSON.parse(line.toString("utf8").replace(/\r$/, ""));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("not an object");
        }
        settleMessage(parsed as Record<string, unknown>);
      } catch {
        fail(new ProbeFailure("malformed_protocol"));
      }
    }
  };

  const onStderr = (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > PROBE_POLICY.MAX_STDERR_BYTES) {
      fail(new ProbeFailure("stderr_overflow"));
      return;
    }
    if (Buffer.byteLength(stderrDiagnostic, "utf8") < PROBE_POLICY.MAX_DIAGNOSTIC_BYTES) {
      stderrDiagnostic += chunk.toString("utf8");
      stderrDiagnostic = redactDiagnostic(stderrDiagnostic);
    }
  };

  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);
  child.once("error", (error) => fail(new ProbeFailure("spawn_error", error.message)));
  child.once("exit", (code, signal) => {
    if (!closing) {
      fail(new ProbeFailure("early_exit", `code=${String(code)} signal=${String(signal)}`));
    }
  });

  const totalTimer = setTimeout(
    () => fail(new ProbeFailure("total_timeout")),
    timeouts.totalMs,
  );
  totalTimer.unref?.();

  const send = (message: Record<string, unknown>) => {
    if (fatalFailure) {
      throw fatalFailure;
    }
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      throw failureFromUnknown(error, "protocol_write_error");
    }
  };

  const request = (
    id: number,
    message: Record<string, unknown>,
    timeoutMs: number,
    timeoutCode: string,
  ): Promise<Record<string, unknown>> => {
    if (fatalFailure) {
      return Promise.reject(fatalFailure);
    }
    if (pending) {
      return Promise.reject(new ProbeFailure("probe_internal_concurrent_request"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending?.id === id) {
          pending = null;
          reject(new ProbeFailure(timeoutCode));
        }
      }, timeoutMs);
      timer.unref?.();
      pending = { id, resolve, reject, timer };
      try {
        send(message);
      } catch (error) {
        pending = null;
        clearTimeout(timer);
        reject(failureFromUnknown(error, "protocol_write_error"));
      }
    });
  };

  let success:
    | Omit<LiveProbeSuccess, "ok" | "cleanupMethod" | "pid" | "stdoutBytes" | "stderrBytes">
    | null = null;
  let protocolFailure: ProbeFailure | null = null;

  try {
    const initialize = await request(
      1,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "bridge-caps-stdio-probe", version: "1.0.0" },
        },
      },
      timeouts.initializeMs,
      "initialize_timeout",
    );
    if (initialize.jsonrpc !== "2.0" || initialize.id !== 1) {
      throw new ProbeFailure("malformed_initialize_response");
    }
    if (initialize.error !== undefined) {
      throw new ProbeFailure(
        "initialize_protocol_error",
        JSON.stringify(initialize.error),
      );
    }
    if (!initialize.result || typeof initialize.result !== "object") {
      throw new ProbeFailure("malformed_initialize_result");
    }
    const initializeResult = initialize.result as Record<string, unknown>;
    if (typeof initializeResult.protocolVersion !== "string") {
      throw new ProbeFailure("malformed_protocol_version");
    }
    const serverInfo = normalizeServerInfo(initializeResult.serverInfo);

    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const toolsResponse = await request(
      2,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      timeouts.toolsListMs,
      "tools_list_timeout",
    );
    if (toolsResponse.jsonrpc !== "2.0" || toolsResponse.id !== 2) {
      throw new ProbeFailure("malformed_tools_response");
    }
    if (toolsResponse.error !== undefined) {
      throw new ProbeFailure(
        "tools_list_protocol_error",
        JSON.stringify(toolsResponse.error),
      );
    }
    if (!toolsResponse.result || typeof toolsResponse.result !== "object") {
      throw new ProbeFailure("malformed_tools_result");
    }
    const tools = normalizeTools(
      (toolsResponse.result as Record<string, unknown>).tools,
    );
    success = {
      tools,
      serverInfo,
      protocolVersion: initializeResult.protocolVersion,
    };
  } catch (error) {
    protocolFailure = failureFromUnknown(error);
  } finally {
    closing = true;
    clearTimeout(totalTimer);
    const pendingAtFinish = pending as { timer: NodeJS.Timeout } | null;
    if (pendingAtFinish) {
      clearTimeout(pendingAtFinish.timer);
    }
    pending = null;
  }

  const cleanup = await terminateProcess(child);
  child.stdout.removeListener("data", onStdout);
  child.stderr.removeListener("data", onStderr);

  if (!cleanup.ok) {
    return {
      ok: false,
      code: "cleanup_failure",
      diagnostic: redactDiagnostic(protocolFailure?.message ?? "process did not terminate"),
      pid,
      stdoutBytes,
      stderrBytes,
      cleanupMethod: cleanup.method,
    };
  }
  if (!success || protocolFailure || fatalFailure) {
    const failure = protocolFailure ?? fatalFailure ?? new ProbeFailure("probe_internal_error");
    return {
      ok: false,
      code: failure.code,
      diagnostic: redactDiagnostic(
        [failure.message, stderrDiagnostic].filter(Boolean).join(": "),
      ),
      pid,
      stdoutBytes,
      stderrBytes,
      cleanupMethod: cleanup.method,
    };
  }
  return {
    ok: true,
    ...success,
    pid: pid ?? -1,
    stdoutBytes,
    stderrBytes,
    cleanupMethod: cleanup.method,
  };
}

function buildProvenance(
  capability: CapabilityRow,
  observedAt: string,
  result: LiveProbeResult,
): string {
  const previous = parseJsonObject(capability.provenance_json);
  let declaration: Record<string, unknown> = {};
  try {
    const parsed = capability.raw_json ? JSON.parse(capability.raw_json) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      declaration = parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid source JSON is itself recorded as a failed, untrusted probe.
  }
  const trustedSource = sourceIsTrusted(capability, declaration);
  const probe = result.ok
    ? {
        outcome: "working",
        trusted_source: trustedSource,
        observed_at: observedAt,
        protocol_version: result.protocolVersion,
        server_info: result.serverInfo,
        tool_count: result.tools.length,
        pid: result.pid,
        stdout_bytes: result.stdoutBytes,
        stderr_bytes: result.stderrBytes,
        cleanup_method: result.cleanupMethod,
      }
    : {
        outcome: "broken",
        trusted_source: trustedSource,
        observed_at: observedAt,
        failure_code: result.code,
        diagnostic: result.diagnostic,
        pid: result.pid,
        stdout_bytes: result.stdoutBytes,
        stderr_bytes: result.stderrBytes,
        cleanup_method: result.cleanupMethod,
      };
  return JSON.stringify({ ...previous, probe });
}

function persistWorking(
  store: CapsStore,
  capability: CapabilityRow,
  sourceTable: CapsTable,
  result: LiveProbeSuccess,
  observedAt: string,
): void {
  const provenance = buildProvenance(capability, observedAt, result);
  if (sourceTable === "installed_broken") {
    store.moveBrokenToWorking(capability.id, {
      source_lane: "probe",
      failure_observed_at: observedAt,
      provenance_json: provenance,
    });
  } else if (sourceTable === "available_for_install") {
    store.moveAvailableToInstalled(
      capability.slug,
      capability.install_command,
      "installed_working",
      {
        source_lane: "probe",
        last_verified: observedAt,
        provenance_json: provenance,
        surface_owner: capability.surface_owner,
      },
    );
  }

  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.db.prepare(`
      UPDATE installed_working
      SET source_lane = 'probe',
          last_verified = ?,
          tools_json = ?,
          provenance_json = ?
      WHERE id = ?
    `).run(observedAt, JSON.stringify(result.tools), provenance, capability.id);
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

function persistBroken(
  store: CapsStore,
  capability: CapabilityRow,
  sourceTable: CapsTable,
  result: LiveProbeFailure,
  observedAt: string,
): void {
  const provenance = buildProvenance(capability, observedAt, result);
  const failureReason = redactDiagnostic(
    result.diagnostic && result.diagnostic !== result.code
      ? `${result.code}: ${result.diagnostic}`
      : result.code,
  );

  if (sourceTable === "installed_working") {
    store.moveWorkingToBroken(capability.id, {
      source_lane: "probe",
      failure_reason: failureReason,
      failure_observed_at: observedAt,
      provenance_json: provenance,
    });
  } else if (sourceTable === "available_for_install") {
    store.moveAvailableToInstalled(
      capability.slug,
      capability.install_command,
      "installed_broken",
      {
        source_lane: "probe",
        last_verified: observedAt,
        provenance_json: provenance,
        failure_reason: failureReason,
        failure_observed_at: observedAt,
        surface_owner: capability.surface_owner,
      },
    );
  }

  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.db.prepare(`
      UPDATE installed_broken
      SET source_lane = 'probe',
          last_verified = ?,
          failure_reason = ?,
          failure_observed_at = ?,
          provenance_json = ?
      WHERE id = ?
    `).run(observedAt, failureReason, observedAt, provenance, capability.id);
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

function policyFailureResult(code: string): LiveProbeFailure {
  return {
    ok: false,
    code,
    diagnostic: code,
    pid: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    cleanupMethod: "not-started",
  };
}

/**
 * Probes only a store-backed capability identity. The optional policy must be
 * created in-process by createOwnerProbePolicy; plain caller objects cannot
 * relax any deadline.
 */
export async function probeLocalStdio(
  store: CapsStore,
  capabilityId: string,
  ownerPolicy: OwnerProbePolicy = DEFAULT_OWNER_PROBE_POLICY,
): Promise<ProbeOutcome> {
  const policy = requireOwnerProbePolicy(ownerPolicy);
  const observedAt = new Date().toISOString();
  const located = findCapability(store, capabilityId);
  if (!located) {
    return {
      capabilityId,
      status: "broken",
      code: "capability_not_found",
      observedAt,
      toolCount: 0,
    };
  }

  let command: ProbeCommand;
  try {
    command = commandFromCapability(located.capability);
  } catch (error) {
    const failure = failureFromUnknown(error, "probe_policy_rejected");
    const result = policyFailureResult(failure.code);
    persistBroken(store, located.capability, located.table, result, observedAt);
    return {
      capabilityId,
      status: "broken",
      code: failure.code,
      observedAt,
      toolCount: 0,
    };
  }

  const result = await executeProbeProtocol(command, policy.timeouts);
  if (result.ok) {
    persistWorking(store, located.capability, located.table, result, observedAt);
    return {
      capabilityId,
      status: "working",
      code: "ok",
      observedAt,
      toolCount: result.tools.length,
    };
  }

  persistBroken(store, located.capability, located.table, result, observedAt);
  return {
    capabilityId,
    status: "broken",
    code: result.code,
    observedAt,
    toolCount: 0,
  };
}
