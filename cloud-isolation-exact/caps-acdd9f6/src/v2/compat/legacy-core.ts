import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BridgeConfig } from "../../config.js";
import { getConfig } from "../../config.js";
import { bundleCreate, cloneFrom, hasGit, headCommit, initRepo, isDirty, isGitRepo } from "../../git.js";
import { changedSince, normalizeClaim, pathsOverlap } from "../../leases.js";
import { ensureDir, ensureGitignore, writeJsonAtomic } from "../../util.js";
import { canonicalEqual, hashCanonical, sha256 } from "../core/canonical.js";
import { asErrorCode, invariant } from "../core/errors.js";
import { newId } from "../core/ids.js";
import type { EventEnvelope, HostRecord, PrincipalRecord, PrincipalRef, SessionRecord } from "../core/types.js";
import { BridgeRuntime } from "../runtime.js";
import { COMMAND_CENTER_PEERS, type CommandCenterPeer } from "../a2a/agent-card.js";
import { A2AClient } from "../a2a/client.js";
import type { RunProcess } from "../a2a/peer-dispatch.js";
import { createSubscriptionProcessRunner } from "../a2a/process-runner.js";
import { runA2AServer } from "../a2a/serve.js";
import { isTerminalTaskState, type A2ATask } from "../a2a/types.js";
import { canonicalLane, defaultHandoffTarget, laneIdentifier, type LaneResolution } from "./lanes.js";

const DEFAULT_TTL_MINUTES = 120;
const SESSION_IDLE_MINUTES = 60;
const MANIFEST_VERSION = "bridge2-project-binding-v1";

interface ProjectManifest {
  schemaVersion: typeof MANIFEST_VERSION;
  projectId: string;
  name: string;
  path: string;
  pathKey: string;
  registered: boolean;
  remote?: string;
  createdAt: string;
  updatedAt: string;
}

interface ProjectResolution {
  name: string;
  path: string;
  pathKey: string;
  manifest?: ProjectManifest;
  guessed: boolean;
}

interface ProjectHandle extends ProjectResolution {
  runtime: BridgeRuntime;
  projectId: string;
  actor: PrincipalRef;
  lane: string;
  laneWarning: string | null;
  laneAmbiguous: boolean;
  stateDirectory: string;
  manifest: ProjectManifest;
}

interface LeaseRow {
  lease_id: string;
  path: string;
  path_key: string;
  agent: string;
  principal_id: string;
  session_id: string;
  host_id: string;
  generation: number;
  fencing_token: number;
  claimed_at: string;
  expires_at: string;
  note: string | null;
}

interface SessionRow {
  collaboration_session_id: string;
  boss_agent: string;
  boss_set_by: "first-command" | "user";
  status: "active" | "closed";
  started_at: string;
  last_activity_at: string;
}

interface SyncCursorRow {
  event_sequence: number;
  filesystem_observed_at_ms: number;
}

interface LegacyState {
  control?: string | null;
  leases?: Array<{ paths?: string[]; agent?: string; expires?: number }>;
  tasks?: Array<{ id?: string; title?: string; status?: "todo" | "doing" | "done"; owner?: string; ts?: number }>;
  session?: {
    boss?: string;
    bossSetBy?: "first-command" | "user";
    startedAt?: number;
    lastActivity?: number;
    status?: "active" | "closed";
    closedBy?: string;
  };
}

interface LegacyRegistry {
  projects?: Record<string, { name?: string; path?: string; remote?: string }>;
}

export interface LegacyBridgeFacadeOptions {
  config?: BridgeConfig;
  stateRoot?: string;
  recoveryRoot?: string;
  lane?: () => LaneResolution;
  now?: () => Date;
  /** Test seam for A2A peer execution; production uses the shell-free runner. */
  runProcess?: RunProcess;
}

export class LegacyBridgeFacade {
  private readonly config: BridgeConfig;
  private readonly stateRoot: string;
  private readonly recoveryRoot: string;
  private readonly resolveCurrentLane: () => LaneResolution;
  private readonly now: () => Date;
  private readonly injectedRunProcess?: RunProcess;
  private readonly runtimes = new Map<string, BridgeRuntime>();

  constructor(options: LegacyBridgeFacadeOptions = {}) {
    this.config = options.config ?? getConfig();
    this.stateRoot = path.resolve(options.stateRoot ?? process.env.BRIDGE2_HOME ?? defaultStateRoot());
    this.recoveryRoot = path.resolve(options.recoveryRoot ?? process.env.BRIDGE2_RECOVERY_ROOT ?? defaultRecoveryRoot(this.stateRoot));
    this.resolveCurrentLane = options.lane ?? (() => ({ lane: canonicalLane(this.config.agent), warning: null, ambiguous: false }));
    this.now = options.now ?? (() => new Date());
    this.injectedRunProcess = options.runProcess;
    ensureDir(path.join(this.stateRoot, "projects"));
  }

  close(): void {
    for (const runtime of this.runtimes.values()) {
      try { runtime.close(); } catch { /* process closeout */ }
    }
    this.runtimes.clear();
  }

  async sync(project?: string): Promise<Record<string, unknown>> {
    const handle = this.open(project);
    const now = this.now();
    const priorCursor = handle.runtime.store.get<SyncCursorRow>(
      "SELECT event_sequence, filesystem_observed_at_ms FROM legacy_sync_cursors WHERE project_id = ? AND session_id = ?",
      handle.projectId,
      handle.actor.sessionId,
    );
    const firstSync = priorCursor === undefined;
    const changedFiles = firstSync ? [] : changedSince(handle.path, Number(priorCursor.filesystem_observed_at_ms));

    return handle.runtime.store.transaction(() => {
      const expiredLeases = this.expireLeases(handle, now);
      const cursor = handle.runtime.store.get<SyncCursorRow>(
        "SELECT event_sequence, filesystem_observed_at_ms FROM legacy_sync_cursors WHERE project_id = ? AND session_id = ?",
        handle.projectId,
        handle.actor.sessionId,
      );
      const observed = cursor ? this.collaborationEventsAfter(handle, Number(cursor.event_sequence)) : [];
      const changedByOther = observed
        .filter((event) => String(event.data.agent) !== handle.lane)
        .map((event) => legacyActivityView(event));
      const openedNewSession = this.applySession(handle, now);
      const control = handle.runtime.store.get<{ control_agent: string | null }>(
        "SELECT control_agent FROM legacy_control WHERE project_id = ?",
        handle.projectId,
      )?.control_agent ?? null;
      const session = this.sessionView(handle, now);
      const leases = this.activeLeases(handle, now);
      const tasks = handle.runtime.store.all<{
        task_id: string;
        title: string;
        status: "todo" | "doing" | "done";
        owner_agent: string | null;
        created_at: string;
      }>(
        "SELECT task_id, title, status, owner_agent, created_at FROM legacy_tasks WHERE project_id = ? AND status <> 'done' ORDER BY created_at, task_id",
        handle.projectId,
      );
      const event = this.recordCommand(handle, "bridge_sync", { project: handle.path }, {
        ok: true,
        firstSync: cursor === undefined,
        openedNewSession,
        control,
        changedFiles,
        changedActivityIds: changedByOther.map((entry) => String(entry.activityId)),
        changedActivities: changedByOther,
        expiredLeases,
      });
      handle.runtime.store.run(
        `INSERT INTO legacy_sync_cursors(
          project_id, principal_id, session_id, host_id, event_sequence, filesystem_observed_at_ms, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, session_id) DO UPDATE SET
          principal_id = excluded.principal_id,
          host_id = excluded.host_id,
          event_sequence = excluded.event_sequence,
          filesystem_observed_at_ms = excluded.filesystem_observed_at_ms,
          updated_at = excluded.updated_at`,
        handle.projectId,
        handle.actor.principalId,
        handle.actor.sessionId,
        handle.actor.hostId,
        event.sequence,
        now.getTime(),
        now.toISOString(),
      );
      return {
        project: handle.name,
        path: handle.path,
        you: { agent: handle.lane, host: this.config.host, session: this.config.sessionId },
        session,
        openedNewSession,
        control,
        youHoldControl: control === null ? null : control === handle.lane,
        yourLeases: leases.filter((lease) => lease.agent === handle.lane).map((lease) => lease.path),
        othersLeases: groupOtherLeases(leases.filter((lease) => lease.agent !== handle.lane), now),
        openTasks: tasks.map((task) => ({
          id: task.task_id,
          title: task.title,
          status: task.status,
          ...(task.owner_agent ? { owner: task.owner_agent } : {}),
          ts: Date.parse(task.created_at),
        })),
        changedSinceLastSync: changedFiles,
        changedByOther,
        firstSync,
        registered: handle.manifest.registered,
        hostWarning: null,
        projectWarning: handle.guessed
          ? `Project '${handle.name}' was inferred from '${handle.path}'. Pass project explicitly or set BRIDGE_PROJECT.`
          : null,
        laneWarning: handle.laneWarning,
      };
    });
  }

  async claim(args: { paths: string[]; project?: string; note?: string; ttlMinutes?: number }): Promise<Record<string, unknown>> {
    const handle = this.open(args.project);
    const requested = unique((args.paths ?? []).map(normalizeClaim));
    if (requested.length === 0) return { ok: false, project: handle.name, granted: [], conflicts: [], message: "no paths given" };
    const ttlMinutes = args.ttlMinutes ?? DEFAULT_TTL_MINUTES;
    invariant(Number.isFinite(ttlMinutes) && ttlMinutes > 0 && ttlMinutes <= 10080, "invalid_legacy_lease_ttl");
    const now = this.now();
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();

    if (handle.laneAmbiguous) {
      const message = handle.laneWarning ?? "Ambiguous Claude lane; set BRIDGE_LANE before claiming files.";
      handle.runtime.store.transaction(() => {
        const openedNewSession = this.applySession(handle, now);
        this.recordCommand(handle, "bridge_claim", clean({ project: handle.path, paths: requested, note: args.note, ttlMinutes }), {
          ok: false,
          granted: [],
          conflicts: [],
          message,
          openedNewSession,
          expiredLeases: 0,
        }, "denied");
      });
      return { ok: false, project: handle.name, granted: [], conflicts: [], message, laneWarning: message };
    }

    return handle.runtime.store.transaction(() => {
      const expiredLeases = this.expireLeases(handle, now);
      const openedNewSession = this.applySession(handle, now);
      const active = this.activeLeases(handle, now);
      const conflicts: Array<{ requested: string; conflictsWith: string; heldBy: string }> = [];
      for (const pathValue of requested) {
        for (const lease of active) {
          if (lease.agent === handle.lane) continue;
          if (pathsOverlap(lease.path_key, claimKey(pathValue))) {
            conflicts.push({ requested: pathValue, conflictsWith: lease.path, heldBy: lease.agent });
          }
        }
      }
      if (conflicts.length > 0) {
        const outcome = {
          ok: false,
          granted: [],
          conflicts,
          message: "Denied - overlaps a lease held by another lane.",
          openedNewSession,
          expiredLeases,
        };
        this.recordCommand(handle, "bridge_claim", clean({ project: handle.path, paths: requested, note: args.note, ttlMinutes }), outcome, "denied");
        return { ok: false, project: handle.name, granted: [], conflicts, message: outcome.message };
      }

      const newPaths = requested.filter((pathValue) =>
        !active.some((lease) => lease.session_id === handle.actor.sessionId && lease.path_key === claimKey(pathValue)));
      if (newPaths.length > 0) {
        const project = handle.runtime.store.get<{ active_generation: number; next_fencing_token: number }>(
          "SELECT active_generation, next_fencing_token FROM projects WHERE project_id = ?",
          handle.projectId,
        );
        invariant(project, "project_not_found");
        const fencingToken = Number(project.next_fencing_token) + 1;
        handle.runtime.store.run(
          "UPDATE projects SET next_fencing_token = ?, updated_at = ? WHERE project_id = ?",
          fencingToken,
          now.toISOString(),
          handle.projectId,
        );
        const claimGroupId = newId("claim.legacy");
        for (const pathValue of newPaths) {
          handle.runtime.store.run(
            `INSERT INTO legacy_file_leases(
              lease_id, claim_group_id, project_id, path, path_key, agent,
              principal_id, session_id, host_id, generation, fencing_token,
              claimed_at, expires_at, status, note, ended_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
            newId("lease.legacy"),
            claimGroupId,
            handle.projectId,
            pathValue,
            claimKey(pathValue),
            handle.lane,
            handle.actor.principalId,
            handle.actor.sessionId,
            handle.actor.hostId,
            Number(project.active_generation),
            fencingToken,
            now.toISOString(),
            expiresAt,
            args.note ?? null,
          );
        }
      }
      this.recordCommand(handle, "bridge_claim", clean({ project: handle.path, paths: requested, note: args.note, ttlMinutes }), {
        ok: true,
        granted: requested,
        conflicts: [],
        expiresInMin: ttlMinutes,
        openedNewSession,
        expiredLeases,
      });
      return { ok: true, project: handle.name, granted: requested, conflicts: [], expiresInMin: ttlMinutes };
    });
  }

  async release(args: { paths?: string[]; project?: string }): Promise<Record<string, unknown>> {
    const handle = this.open(args.project);
    const requested = args.paths ? unique(args.paths.map(normalizeClaim)) : undefined;
    const now = this.now();
    return handle.runtime.store.transaction(() => {
      const expiredLeases = this.expireLeases(handle, now);
      this.applySession(handle, now);
      const active = this.activeLeases(handle, now).filter((lease) => lease.agent === handle.lane);
      const selected = requested && requested.length > 0
        ? active.filter((lease) => requested.some((item) => claimKey(item) === lease.path_key))
        : active;
      for (const lease of selected) {
        handle.runtime.store.run(
          "UPDATE legacy_file_leases SET status = 'released', ended_at = ? WHERE lease_id = ? AND status = 'active'",
          now.toISOString(),
          lease.lease_id,
        );
      }
      const remaining = this.activeLeases(handle, now)
        .filter((lease) => lease.agent === handle.lane)
        .map((lease) => lease.path);
      const released = requested && requested.length > 0 ? requested : "all";
      this.recordCommand(handle, "bridge_release", clean({ project: handle.path, paths: requested }), {
        ok: true,
        released,
        remaining,
        expiredLeases,
      });
      return { ok: true, project: handle.name, released, remaining };
    });
  }

  async handoff(args: { to?: string; note?: string; project?: string }): Promise<Record<string, unknown>> {
    const handle = this.open(args.project);
    const target = args.to ? canonicalLane(args.to) : defaultHandoffTarget(handle.lane);
    const now = this.now();
    return handle.runtime.store.transaction(() => {
      const previous = handle.runtime.store.get<{ control_agent: string | null }>(
        "SELECT control_agent FROM legacy_control WHERE project_id = ?",
        handle.projectId,
      )?.control_agent ?? null;
      handle.runtime.store.run(
        `INSERT INTO legacy_control(
          project_id, control_agent, updated_at, updated_by_principal_id, updated_by_session_id, updated_by_host_id
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          control_agent = excluded.control_agent,
          updated_at = excluded.updated_at,
          updated_by_principal_id = excluded.updated_by_principal_id,
          updated_by_session_id = excluded.updated_by_session_id,
          updated_by_host_id = excluded.updated_by_host_id`,
        handle.projectId,
        target,
        now.toISOString(),
        handle.actor.principalId,
        handle.actor.sessionId,
        handle.actor.hostId,
      );
      this.applySession(handle, now);
      this.recordCommand(handle, "bridge_handoff", clean({ project: handle.path, to: target, note: args.note }), {
        ok: true,
        control: target,
        previousControl: previous,
        dispatchState: "not_dispatched",
        dispatchReason: "control_token_only",
      });
      return {
        ok: true,
        project: handle.name,
        control: target,
        previous,
        note: args.note ?? null,
        dispatch: { state: "not_dispatched", reason: "control_token_only" },
      };
    });
  }

  async log(args: { summary: string; files?: string[]; project?: string }): Promise<Record<string, unknown>> {
    invariant(typeof args.summary === "string" && args.summary.trim().length > 0, "legacy_log_summary_required");
    const handle = this.open(args.project);
    const files = unique(args.files ?? []);
    const hashes: Record<string, string> = {};
    for (const file of files) {
      const hash = fullFileHash(path.join(handle.path, file));
      if (hash) hashes[file] = hash;
    }
    const now = this.now();
    return handle.runtime.store.transaction(() => {
      this.applySession(handle, now);
      this.recordCommand(handle, "bridge_log", { project: handle.path, summary: args.summary, files }, {
        ok: true,
        hashes,
      });
      return { ok: true, project: handle.name, logged: args.summary, files };
    });
  }

  async setBoss(args: { to: string; project?: string }): Promise<Record<string, unknown>> {
    const handle = this.open(args.project);
    const target = canonicalLane(args.to);
    const now = this.now();
    return handle.runtime.store.transaction(() => {
      const active = this.activeSession(handle);
      if (active) {
        handle.runtime.store.run(
          "UPDATE legacy_collaboration_sessions SET boss_agent = ?, boss_set_by = 'user', last_activity_at = ? WHERE collaboration_session_id = ?",
          target,
          now.toISOString(),
          active.collaboration_session_id,
        );
      } else {
        handle.runtime.store.run(
          `INSERT INTO legacy_collaboration_sessions(
            collaboration_session_id, project_id, boss_agent, boss_set_by, status,
            started_at, last_activity_at, closed_at, closed_by_agent
          ) VALUES (?, ?, ?, 'user', 'active', ?, ?, NULL, NULL)`,
          newId("collaboration.session"),
          handle.projectId,
          target,
          now.toISOString(),
          now.toISOString(),
        );
      }
      this.recordCommand(handle, "bridge_set_boss", { project: handle.path, to: target }, { ok: true, boss: target });
      return { ok: true, project: handle.name, boss: target, bossSetBy: "user" };
    });
  }

  async taskAdd(args: { title: string; project?: string; owner?: string }): Promise<Record<string, unknown>> {
    invariant(typeof args.title === "string" && args.title.trim().length > 0, "legacy_task_title_required");
    const handle = this.open(args.project);
    const now = this.now();
    const taskId = newId("task.legacy");
    const owner = args.owner ? canonicalLane(args.owner) : undefined;
    return handle.runtime.store.transaction(() => {
      this.applySession(handle, now);
      handle.runtime.store.run(
        "INSERT INTO legacy_tasks(task_id, project_id, title, status, owner_agent, created_at, updated_at) VALUES (?, ?, ?, 'todo', ?, ?, ?)",
        taskId,
        handle.projectId,
        args.title,
        owner ?? null,
        now.toISOString(),
        now.toISOString(),
      );
      this.recordCommand(handle, "bridge_task_add", clean({ project: handle.path, title: args.title, owner }), {
        ok: true,
        taskId,
        taskTitle: args.title,
        taskStatus: "todo",
        taskOwner: owner ?? null,
        boardOnly: true,
        dispatchState: "not_dispatched",
        dispatchReason: "board_entry_only",
      });
      return {
        ok: true,
        project: handle.name,
        id: taskId,
        title: args.title,
        status: "todo",
        boardOnly: true,
        dispatch: { state: "not_dispatched", reason: "board_entry_only" },
      };
    });
  }

  async taskUpdate(args: { id: string; status?: "todo" | "doing" | "done"; owner?: string; project?: string }): Promise<Record<string, unknown>> {
    const handle = this.open(args.project);
    const owner = args.owner === undefined ? undefined : canonicalLane(args.owner);
    const now = this.now();
    return handle.runtime.store.transaction(() => {
      this.applySession(handle, now);
      const task = handle.runtime.store.get<{ title: string; status: "todo" | "doing" | "done"; owner_agent: string | null; created_at: string }>(
        "SELECT title, status, owner_agent, created_at FROM legacy_tasks WHERE project_id = ? AND task_id = ?",
        handle.projectId,
        args.id,
      );
      if (!task) {
        const message = `task ${args.id} not found`;
        this.recordCommand(handle, "bridge_task_update", clean({ project: handle.path, taskId: args.id, status: args.status, owner }), {
          ok: false,
          taskId: args.id,
          message,
        }, "denied");
        return { ok: false, project: handle.name, message };
      }
      const status = args.status ?? task.status;
      if (handle.lane === "google_antigravity") {
        const denyWorkerUpdate = (message: string): Record<string, unknown> => {
          this.recordCommand(handle, "bridge_task_update", clean({ project: handle.path, taskId: args.id, status: args.status, owner }), {
            ok: false,
            taskId: args.id,
            taskStatus: task.status,
            taskOwner: task.owner_agent,
            message,
          }, "denied");
          return { ok: false, project: handle.name, message };
        };
        if (task.owner_agent !== handle.lane) {
          return denyWorkerUpdate("google_antigravity may update only tasks currently owned by google_antigravity");
        }
        if (owner !== undefined && owner !== task.owner_agent) {
          return denyWorkerUpdate("google_antigravity may not reassign task ownership");
        }
        const workerStatusRank: Record<"todo" | "doing" | "done", number> = {
          todo: 0,
          doing: 1,
          done: 2,
        };
        if (workerStatusRank[status] < workerStatusRank[task.status]) {
          return denyWorkerUpdate(`google_antigravity may not move task status backward from ${task.status} to ${status}`);
        }
      }
      const nextOwner = owner === undefined ? task.owner_agent : owner;
      handle.runtime.store.run(
        "UPDATE legacy_tasks SET status = ?, owner_agent = ?, updated_at = ? WHERE project_id = ? AND task_id = ?",
        status,
        nextOwner,
        now.toISOString(),
        handle.projectId,
        args.id,
      );
      this.recordCommand(handle, "bridge_task_update", clean({ project: handle.path, taskId: args.id, status: args.status, owner }), {
        ok: true,
        taskId: args.id,
        taskTitle: task.title,
        taskStatus: status,
        taskOwner: nextOwner,
      });
      return {
        ok: true,
        project: handle.name,
        task: {
          id: args.id,
          title: task.title,
          status,
          ...(nextOwner ? { owner: nextOwner } : {}),
          ts: Date.parse(task.created_at),
        },
      };
    });
  }

  /**
   * Execute one peer delegation over the real loopback A2A JSON-RPC boundary.
   * The call is blocking by design: success means a terminal completed task and
   * includes the durable task/artifact receipt, never merely an enqueue ACK.
   */
  async a2aSend(args: {
    target: CommandCenterPeer;
    prompt: string;
    idempotencyKey: string;
    project?: string;
  }): Promise<Record<string, unknown>> {
    invariant((COMMAND_CENTER_PEERS as readonly string[]).includes(args.target), "a2a_target_peer_invalid", { target: args.target });
    invariant(typeof args.prompt === "string" && args.prompt.trim().length > 0 && args.prompt.length <= 16_000, "a2a_prompt_invalid");
    invariant(typeof args.idempotencyKey === "string" && args.idempotencyKey.trim().length > 0 && args.idempotencyKey.length <= 300, "a2a_idempotency_key_invalid");
    const handle = this.open(args.project);
    const sourcePeer = laneToPeer(handle.lane);
    const owner = this.ownerActor(handle.runtime, handle.projectId);
    const requestAudit = {
      project: handle.path,
      target: args.target,
      idempotencyKey: args.idempotencyKey,
      promptSha256: sha256(args.prompt),
      promptBytes: Buffer.byteLength(args.prompt, "utf8"),
    };
    this.assertCommandIdempotency(handle, "bridge_a2a_send", args.idempotencyKey, {
      target: args.target,
      promptSha256: requestAudit.promptSha256,
      promptBytes: requestAudit.promptBytes,
    });
    let task: A2ATask;
    try {
      const server = await runA2AServer(handle.runtime, { projectId: handle.projectId, actor: owner }, {
        port: 0,
        projectPath: handle.path,
        runProcess: this.injectedRunProcess ?? createSubscriptionProcessRunner({ cwd: handle.path }),
      });
      try {
        const client = new A2AClient({
          endpoint: `${server.url}a2a`,
          fetchJson: (url, body) => a2aFetch(url, sourcePeer, body),
        });
        const messageId = `message.bridge-${sha256(`${handle.projectId}\0${sourcePeer}\0${args.target}\0${args.idempotencyKey}`).slice(0, 40)}`;
        task = await client.send({
          message: {
            kind: "message",
            role: "user",
            messageId,
            parts: [{ kind: "text", text: args.prompt }],
          },
          configuration: { blocking: true, acceptedOutputModes: ["text/plain"] },
          metadata: { bridgeTargetPeer: args.target },
        });
      } finally {
        await server.close();
      }
    } catch (error) {
      handle.runtime.store.transaction(() => {
        this.recordCommand(handle, "bridge_a2a_send", requestAudit, {
          ok: false,
          channel: "a2a",
          terminal: false,
          artifactIds: [],
          failure: asErrorCode(error),
        }, "failed");
      });
      throw error;
    }
    const receipt = a2aReceipt(task);
    handle.runtime.store.transaction(() => {
      this.recordCommand(handle, "bridge_a2a_send", requestAudit, {
        ok: receipt.completed,
        channel: "a2a",
        taskId: task.id,
        taskState: task.status.state,
        terminal: receipt.terminal,
        artifactIds: receipt.artifactIds,
      }, receipt.completed ? "succeeded" : receipt.terminal ? "failed" : "denied");
    });
    return {
      ok: receipt.completed,
      project: handle.name,
      channel: "a2a",
      source: sourcePeer,
      target: args.target,
      ...receipt,
      task,
    };
  }

  async a2aGet(args: { id: string; project?: string }): Promise<Record<string, unknown>> {
    invariant(typeof args.id === "string" && args.id.length > 0, "a2a_task_id_required");
    const handle = this.open(args.project);
    const sourcePeer = laneToPeer(handle.lane);
    const owner = this.ownerActor(handle.runtime, handle.projectId);
    const server = await runA2AServer(handle.runtime, { projectId: handle.projectId, actor: owner }, {
      port: 0,
      projectPath: handle.path,
      runProcess: this.injectedRunProcess ?? createSubscriptionProcessRunner({ cwd: handle.path }),
    });
    let task: A2ATask;
    try {
      const client = new A2AClient({
        endpoint: `${server.url}a2a`,
        fetchJson: (url, body) => a2aFetch(url, sourcePeer, body),
      });
      task = await client.getTask({ id: args.id });
    } finally {
      await server.close();
    }
    return { ok: true, project: handle.name, channel: "a2a", ...a2aReceipt(task), task };
  }

  /** Dispatch an existing board row through A2A and close it only on receipt. */
  async taskDispatch(args: {
    id: string;
    target?: CommandCenterPeer;
    prompt?: string;
    idempotencyKey: string;
    project?: string;
  }): Promise<Record<string, unknown>> {
    const handle = this.open(args.project);
    const row = handle.runtime.store.get<{ title: string; status: "todo" | "doing" | "done"; owner_agent: string | null }>(
      "SELECT title, status, owner_agent FROM legacy_tasks WHERE project_id = ? AND task_id = ?",
      handle.projectId,
      args.id,
    );
    invariant(row, "legacy_task_not_found", { taskId: args.id });
    const target = args.target ?? laneToPeer(row.owner_agent ?? "");
    const prompt = args.prompt?.trim() || row.title;
    const promptSha256 = sha256(prompt);
    this.assertCommandIdempotency(handle, "bridge_task_dispatch", args.idempotencyKey, {
      taskId: args.id,
      target,
      promptSha256,
    });
    const dispatchRequest = {
      project: handle.path,
      taskId: args.id,
      target,
      idempotencyKey: args.idempotencyKey,
      promptSha256,
    };
    let result: Record<string, unknown>;
    try {
      result = await this.a2aSend({
        target,
        prompt,
        idempotencyKey: `board-${sha256(`${args.id}\0${args.idempotencyKey}`).slice(0, 48)}`,
        project: handle.path,
      });
    } catch (error) {
      handle.runtime.store.transaction(() => {
        this.recordCommand(handle, "bridge_task_dispatch", dispatchRequest, {
          ok: false,
          taskId: args.id,
          boardStatus: row.status,
          terminal: false,
          failure: asErrorCode(error),
        }, "failed");
      });
      throw error;
    }
    const completed = result.ok === true && result.terminal === true && result.state === "completed";
    handle.runtime.store.transaction(() => {
      if (completed) {
        handle.runtime.store.run(
          "UPDATE legacy_tasks SET status = 'done', updated_at = ? WHERE project_id = ? AND task_id = ?",
          this.now().toISOString(),
          handle.projectId,
          args.id,
        );
      }
      this.recordCommand(handle, "bridge_task_dispatch", dispatchRequest, {
        ok: completed,
        taskId: args.id,
        boardStatus: completed ? "done" : row.status,
        a2aTaskId: result.taskId,
        a2aState: result.state,
        terminal: result.terminal,
      }, completed ? "succeeded" : result.terminal === true ? "failed" : "denied");
    });
    return {
      ...result,
      boardTask: {
        id: args.id,
        title: row.title,
        status: completed ? "done" : row.status,
        ...(row.owner_agent ? { owner: row.owner_agent } : {}),
      },
    };
  }

  async reap(args?: { idleMinutes?: number }): Promise<Record<string, unknown>> {
    const idleMinutes = args?.idleMinutes ?? SESSION_IDLE_MINUTES;
    invariant(Number.isFinite(idleMinutes) && idleMinutes >= 0 && idleMinutes <= 10080, "invalid_legacy_idle_threshold");
    const now = this.now();
    const closed: Array<{ project: string; idleMin: number; releasedLeases: number }> = [];
    for (const manifest of this.manifests()) {
      const handle = this.open(manifest.path);
      const result = handle.runtime.store.transaction(() => {
        const expiredLeases = this.expireLeases(handle, now);
        const active = this.activeSession(handle);
        if (!active) {
          this.recordCommand(handle, "bridge_reap", { project: handle.path, idleMinutes }, {
            ok: true,
            closedProjects: 0,
            releasedLeases: 0,
            expiredLeases,
          });
          return undefined;
        }
        const idle = Math.round((now.getTime() - Date.parse(active.last_activity_at)) / 60_000);
        if (idle <= idleMinutes) {
          this.recordCommand(handle, "bridge_reap", { project: handle.path, idleMinutes }, {
            ok: true,
            closedProjects: 0,
            releasedLeases: 0,
            expiredLeases,
          });
          return undefined;
        }
        handle.runtime.store.run(
          "UPDATE legacy_collaboration_sessions SET status = 'closed', closed_at = ?, closed_by_agent = ? WHERE collaboration_session_id = ? AND status = 'active'",
          now.toISOString(),
          handle.lane,
          active.collaboration_session_id,
        );
        this.recordCommand(handle, "bridge_reap", { project: handle.path, idleMinutes }, {
          ok: true,
          closedProjects: 1,
          releasedLeases: 0,
          expiredLeases,
        });
        return { project: handle.name, idleMin: idle, releasedLeases: 0 };
      });
      if (result) closed.push(result);
    }
    return { ok: true, idleThresholdMin: idleMinutes, checked: this.manifests().length, closed };
  }

  async registerProject(args: { name: string; path: string; remote?: string }): Promise<Record<string, unknown>> {
    invariant(args.name.trim().length > 0, "legacy_project_name_required");
    const projectPath = path.resolve(args.path);
    ensureDir(projectPath);
    let git = "git not found - backup/restore disabled";
    if (hasGit()) {
      if (!isGitRepo(projectPath)) {
        initRepo(projectPath);
        git = "initialized new git repo";
      } else {
        git = "existing git repo";
      }
    }
    ensureGitignore(projectPath, ".connector/");
    const handle = this.openResolved({
      name: args.name,
      path: projectPath,
      pathKey: filesystemKey(projectPath),
      guessed: false,
      manifest: this.manifestByPath(projectPath),
    }, true, args.remote);
    const now = this.now();
    handle.runtime.store.transaction(() => {
      this.applySession(handle, now);
      this.recordCommand(handle, "bridge_register_project", clean({
        project: args.name,
        projectPath,
        remote: args.remote,
      }), { ok: true });
    });
    return {
      ok: true,
      name: handle.name,
      path: handle.path,
      git,
      remote: args.remote ?? null,
      bridgeHome: this.stateRoot,
    };
  }

  async listProjects(): Promise<Record<string, unknown>> {
    const now = this.now();
    const projects = this.manifests().map((manifest) => {
      const databasePath = this.databasePathForManifest(manifest);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        database.exec("PRAGMA busy_timeout = 5000");
        const project = database.prepare(
          "SELECT active_generation FROM projects WHERE project_id = ?",
        ).get(manifest.projectId) as { active_generation: number } | undefined;
        const control = database.prepare(
          "SELECT control_agent FROM legacy_control WHERE project_id = ?",
        ).get(manifest.projectId) as { control_agent: string | null } | undefined;
        const leases = database.prepare(
          `SELECT agent, path FROM legacy_file_leases
           WHERE project_id = ? AND status = 'active' AND generation = ? AND julianday(expires_at) > julianday(?)
           ORDER BY agent, path`,
        ).all(manifest.projectId, Number(project?.active_generation ?? 1), now.toISOString()) as Array<{ agent: string; path: string }>;
        const taskCount = database.prepare(
          "SELECT COUNT(*) AS count FROM legacy_tasks WHERE project_id = ? AND status <> 'done'",
        ).get(manifest.projectId) as { count: number };
        const last = database.prepare(
          "SELECT envelope_json FROM events WHERE project_id = ? AND event_type = 'collaboration.command_recorded' ORDER BY sequence DESC LIMIT 1",
        ).get(manifest.projectId) as { envelope_json: string } | undefined;
        const event = last ? JSON.parse(last.envelope_json) as EventEnvelope : undefined;
        return {
          name: manifest.name,
          path: manifest.path,
          remote: manifest.remote ?? null,
          control: control?.control_agent ?? null,
          activeLeases: groupLeasePaths(leases),
          openTasks: Number(taskCount.count),
          lastActive: event ? {
            host: event.actor.hostId,
            agent: String(event.data.agent),
            ts: Date.parse(event.occurredAt),
            action: String(event.data.operation).replace(/^bridge_/u, ""),
          } : null,
        };
      } finally {
        database.close();
      }
    });
    return { bridgeHome: this.stateRoot, you: { agent: this.resolveCurrentLane().lane, host: this.config.host }, projects };
  }

  async recent(args?: { limit?: number; project?: string }): Promise<Record<string, unknown>> {
    const limit = Math.max(1, Math.min(args?.limit ?? 50, 2000));
    const manifests = args?.project ? [this.open(args.project).manifest] : this.manifests();
    const entries: Array<Record<string, unknown> & { ts: number }> = [];
    for (const manifest of manifests) {
      const database = new DatabaseSync(this.databasePathForManifest(manifest), { readOnly: true });
      try {
        const rows = database.prepare(
          `SELECT envelope_json FROM events
           WHERE project_id = ? AND event_type = 'collaboration.command_recorded'
           ORDER BY sequence DESC LIMIT ?`,
        ).all(manifest.projectId, limit) as Array<{ envelope_json: string }>;
        for (const row of rows) {
          const event = JSON.parse(row.envelope_json) as EventEnvelope;
          const view = legacyActivityView(event);
          entries.push({
            ts: Date.parse(event.occurredAt),
            iso: event.occurredAt,
            project: manifest.name,
            agent: String(event.data.agent),
            action: view.action,
            files: view.files,
            note: view.note,
          });
        }
      } finally {
        database.close();
      }
    }
    entries.sort((left, right) => left.ts - right.ts);
    const selected = entries.slice(-limit);
    return { count: selected.length, entries: selected };
  }

  async backup(args: { project?: string; force?: boolean }): Promise<Record<string, unknown>> {
    const handle = this.open(args.project);
    const request = { project: handle.path, force: Boolean(args.force) };
    const failed = (outcome: Record<string, unknown>): Record<string, unknown> => {
      const now = this.now();
      handle.runtime.store.transaction(() => {
        this.applySession(handle, now);
        this.recordCommand(handle, "bridge_backup", request, outcome, "failed");
      });
      return { project: handle.name, ...outcome };
    };
    if (!hasGit()) return failed({ ok: false, message: "git not installed" });
    if (!isGitRepo(handle.path)) return failed({ ok: false, message: `${handle.path} is not a git repo - run bridge_register_project first` });
    const head = headCommit(handle.path);
    if (!head) return failed({ ok: false, message: "repo has no commits yet - make a commit first" });
    const dirty = isDirty(handle.path);
    if (dirty && !args.force) {
      return failed({
        ok: false,
        dirty: true,
        message: "Refusing to back up a dirty tree because a Git bundle contains committed refs only.",
      });
    }
    const bundleDirectory = path.join(this.recoveryRoot, "source-backups");
    ensureDir(bundleDirectory);
    const bundle = path.join(bundleDirectory, `${stateSlug(handle.path)}.bundle`);
    try {
      bundleCreate(handle.path, bundle);
    } catch (error) {
      return failed({ ok: false, dirty, message: boundedErrorMessage("git bundle failed", error) });
    }
    const now = this.now();
    handle.runtime.store.transaction(() => {
      this.applySession(handle, now);
      this.recordCommand(handle, "bridge_backup", request, {
        ok: true,
        bundle,
        head,
        dirty,
      });
    });
    return {
      ok: true,
      project: handle.name,
      bundle,
      head: head.slice(0, 8),
      push: "GitHub publication owner-deferred",
      dirtyWarning: dirty ? "Forced source backup captured committed refs only." : null,
    };
  }

  async restore(args: { project: string; dest?: string }): Promise<Record<string, unknown>> {
    const manifest = this.resolve(args.project).manifest;
    if (!manifest) return { ok: false, message: `project '${args.project}' is not registered` };
    const destination = args.dest ? path.resolve(args.dest) : path.resolve(manifest.path);
    const handle = this.open(manifest.path);
    const request = { project: manifest.name, destination };
    const failed = (outcome: Record<string, unknown>): Record<string, unknown> => {
      const now = this.now();
      handle.runtime.store.transaction(() => {
        this.applySession(handle, now);
        this.recordCommand(handle, "bridge_restore", request, outcome, "failed");
      });
      return { project: manifest.name, ...outcome };
    };
    if (fs.existsSync(destination) && fs.readdirSync(destination).length > 0) {
      return failed({ ok: false, message: `dest '${destination}' exists and is not empty - choose an empty directory` });
    }
    const bundle = path.join(this.recoveryRoot, "source-backups", `${stateSlug(manifest.path)}.bundle`);
    if (!fs.existsSync(bundle)) return failed({ ok: false, message: `no source bundle at ${bundle}` });
    try {
      cloneFrom(bundle, destination);
    } catch (error) {
      return failed({ ok: false, message: boundedErrorMessage("restore clone failed", error) });
    }
    const now = this.now();
    handle.runtime.store.transaction(() => {
      this.applySession(handle, now);
      this.recordCommand(handle, "bridge_restore", request, {
        ok: true,
        how: `cloned from bundle ${bundle}`,
      });
    });
    return { ok: true, project: manifest.name, dest: destination, how: `cloned from bundle ${bundle}` };
  }

  async importLegacyRegistry(registryPath: string): Promise<Record<string, unknown>> {
    const resolvedRegistry = path.resolve(registryPath);
    const registryBytes = fs.readFileSync(resolvedRegistry);
    const registry = JSON.parse(registryBytes.toString("utf8")) as LegacyRegistry;
    const entries = Object.entries(registry.projects ?? {});
    const blockers: Array<{ project: string; paths: string[] }> = [];
    const nowMs = this.now().getTime();
    for (const [key, entry] of entries) {
      if (!entry.path) continue;
      const state = readLegacyState(entry.path);
      const live = (state.leases ?? []).filter((lease) => Number(lease.expires ?? 0) > nowMs);
      if (live.length > 0) blockers.push({ project: entry.name ?? key, paths: live.flatMap((lease) => lease.paths ?? []) });
    }
    invariant(blockers.length === 0, "legacy_import_active_leases_present", { blockers });

    const imported: Array<{ project: string; imported: boolean; tasks: number }> = [];
    for (const [key, entry] of entries) {
      if (!entry.path) continue;
      imported.push(this.importLegacyProject(entry.name ?? key, entry.path, entry.remote));
    }
    return {
      ok: true,
      registry: resolvedRegistry,
      sourceHash: sha256(registryBytes),
      projects: imported.length,
      imported,
    };
  }

  private importLegacyProject(name: string, projectPath: string, remote?: string): { project: string; imported: boolean; tasks: number } {
    const resolvedPath = path.resolve(projectPath);
    const statePath = path.join(resolvedPath, ".connector", "state.json");
    const stateBytes = fs.existsSync(statePath) ? fs.readFileSync(statePath) : Buffer.from("{}", "utf8");
    const state = JSON.parse(stateBytes.toString("utf8")) as LegacyState;
    const sourceHash = sha256(stateBytes);
    const handle = this.openResolved({
      name,
      path: resolvedPath,
      pathKey: filesystemKey(resolvedPath),
      guessed: false,
      manifest: this.manifestByPath(resolvedPath),
    }, true, remote);
    const already = handle.runtime.store.get(
      "SELECT import_id FROM legacy_imports WHERE project_id = ? AND source_kind = 'bridge1.state' AND source_hash = ?",
      handle.projectId,
      sourceHash,
    );
    if (already) return { project: name, imported: false, tasks: state.tasks?.length ?? 0 };
    const now = this.now();
    let controlImported = false;
    handle.runtime.store.transaction(() => {
      if (state.control !== undefined) {
        const inserted = handle.runtime.store.run(
          `INSERT INTO legacy_control(
            project_id, control_agent, updated_at, updated_by_principal_id, updated_by_session_id, updated_by_host_id
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id) DO NOTHING`,
          handle.projectId,
          state.control ? canonicalLane(state.control) : null,
          now.toISOString(),
          handle.actor.principalId,
          handle.actor.sessionId,
          handle.actor.hostId,
        );
        controlImported = Number(inserted.changes) === 1;
      }
      let sessionImported = false;
      if (state.session && !this.activeSession(handle)) {
        const startedAt = new Date(Number(state.session.startedAt ?? now.getTime())).toISOString();
        const lastActivityAt = new Date(Number(state.session.lastActivity ?? now.getTime())).toISOString();
        const active = state.session.status !== "closed";
        handle.runtime.store.run(
          `INSERT INTO legacy_collaboration_sessions(
            collaboration_session_id, project_id, boss_agent, boss_set_by, status,
            started_at, last_activity_at, closed_at, closed_by_agent
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newId("collaboration.session.imported"),
          handle.projectId,
          canonicalLane(state.session.boss ?? handle.lane),
          state.session.bossSetBy ?? "first-command",
          active ? "active" : "closed",
          startedAt,
          lastActivityAt,
          active ? null : lastActivityAt,
          active ? null : canonicalLane(state.session.closedBy ?? "legacy_import"),
        );
        sessionImported = true;
      }
      let taskCount = 0;
      for (const task of state.tasks ?? []) {
        if (!task.id || !task.title) continue;
        const createdAt = new Date(Number(task.ts ?? now.getTime())).toISOString();
        const existing = handle.runtime.store.get<{ title: string; status: string; owner_agent: string | null }>(
          "SELECT title, status, owner_agent FROM legacy_tasks WHERE task_id = ?",
          task.id,
        );
        const owner = task.owner ? canonicalLane(task.owner) : null;
        if (existing) {
          invariant(
            existing.title === task.title && existing.status === (task.status ?? "todo") && existing.owner_agent === owner,
            "legacy_task_import_collision",
            { taskId: task.id },
          );
          continue;
        }
        handle.runtime.store.run(
          "INSERT INTO legacy_tasks(task_id, project_id, title, status, owner_agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          task.id,
          handle.projectId,
          task.title,
          task.status ?? "todo",
          owner,
          createdAt,
          createdAt,
        );
        taskCount += 1;
      }
      const importId = newId("import.legacy");
      handle.runtime.store.run(
        `INSERT INTO legacy_imports(
          import_id, project_id, source_kind, source_hash, imported_at,
          imported_by_principal_id, imported_by_session_id, imported_by_host_id, details_json
        ) VALUES (?, ?, 'bridge1.state', ?, ?, ?, ?, ?, ?)`,
        importId,
        handle.projectId,
        sourceHash,
        now.toISOString(),
        handle.actor.principalId,
        handle.actor.sessionId,
        handle.actor.hostId,
        JSON.stringify({ taskCount, sessionImported, controlImported }),
      );
      this.recordCommand(handle, "legacy_import", { project: resolvedPath, sourceHash }, {
        ok: true,
        taskCount,
        sessionImported,
        controlImported,
      });
    });
    return { project: name, imported: true, tasks: state.tasks?.length ?? 0 };
  }

  private open(project?: string): ProjectHandle {
    return this.openResolved(this.resolve(project), false);
  }

  private openResolved(resolution: ProjectResolution, forceRegistered: boolean, remote?: string): ProjectHandle {
    const stateDirectory = resolution.manifest
      ? path.dirname(path.dirname(this.manifestPath(resolution.manifest)))
      : this.stateDirectory(resolution.path);
    const databasePath = path.join(stateDirectory, "state", "bridge2.sqlite");
    const auditMirrorPath = path.join(stateDirectory, "audit", "events.jsonl");
    let runtime = this.runtimes.get(stateDirectory);
    if (!runtime) {
      const exists = fs.existsSync(databasePath);
      runtime = new BridgeRuntime({ databasePath, auditMirrorPath, initialize: !exists });
      this.runtimes.set(stateDirectory, runtime);
      if (!exists) this.bootstrap(runtime, resolution.path);
      const pending = runtime.store.migrations.pending();
      invariant(pending.length === 0, "legacy_coordination_migration_required", { databasePath, pending: pending.map((item) => item.migrationId) });
    }
    const project = runtime.store.get<{ project_id: string }>("SELECT project_id FROM projects LIMIT 1");
    invariant(project, "project_not_found");
    const lane = this.resolveCurrentLane();
    const actor = this.ensureAgent(runtime, project.project_id, lane.lane);
    const now = this.now().toISOString();
    const existingManifest = resolution.manifest;
    const nextRegistered = forceRegistered || existingManifest?.registered === true;
    const nextRemote = remote ?? existingManifest?.remote;
    const manifestChanged = !existingManifest
      || existingManifest.name !== resolution.name
      || existingManifest.path !== resolution.path
      || existingManifest.pathKey !== resolution.pathKey
      || existingManifest.registered !== nextRegistered
      || existingManifest.remote !== nextRemote;
    const manifest: ProjectManifest = {
      schemaVersion: MANIFEST_VERSION,
      projectId: project.project_id,
      name: resolution.name,
      path: resolution.path,
      pathKey: resolution.pathKey,
      registered: nextRegistered,
      ...(nextRemote ? { remote: nextRemote } : {}),
      createdAt: existingManifest?.createdAt ?? now,
      updatedAt: manifestChanged ? now : existingManifest.updatedAt,
    };
    runtime.store.transaction(() => {
      runtime!.store.run(
        `INSERT OR IGNORE INTO legacy_project_bindings(
          project_id, project_name, project_path, project_path_key, remote, registered_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        project.project_id,
        manifest.name,
        manifest.path,
        manifest.pathKey,
        manifest.remote ?? null,
        manifest.createdAt,
        manifest.updatedAt,
      );
      const binding = runtime!.store.get<{
        project_name: string;
        project_path: string;
        project_path_key: string;
        remote: string | null;
      }>("SELECT project_name, project_path, project_path_key, remote FROM legacy_project_bindings WHERE project_id = ?", project.project_id);
      invariant(binding, "legacy_project_binding_missing", { databasePath, projectId: project.project_id });
      invariant(binding.project_path_key === manifest.pathKey, "legacy_project_binding_conflict", {
        databasePath,
        requestedPath: manifest.path,
        boundPath: binding.project_path,
      });
      if (binding.project_name !== manifest.name
        || binding.project_path !== manifest.path
        || binding.remote !== (manifest.remote ?? null)) {
        runtime!.store.run(
          `UPDATE legacy_project_bindings
           SET project_name = ?, project_path = ?, remote = ?, updated_at = ?
           WHERE project_id = ? AND project_path_key = ?`,
          manifest.name,
          manifest.path,
          manifest.remote ?? null,
          manifest.updatedAt,
          project.project_id,
          manifest.pathKey,
        );
      }
    });
    if (manifestChanged || !existingManifest) writeJsonAtomic(this.manifestPath(manifest), manifest);
    return {
      ...resolution,
      name: manifest.name,
      path: manifest.path,
      pathKey: manifest.pathKey,
      runtime,
      projectId: project.project_id,
      actor,
      lane: canonicalLane(lane.lane),
      laneWarning: lane.warning,
      laneAmbiguous: lane.ambiguous,
      stateDirectory,
      manifest,
    };
  }

  private resolve(project?: string): ProjectResolution {
    const candidate = project?.trim() || this.config.project?.trim();
    if (candidate) {
      if (!path.isAbsolute(candidate)) {
        const byName = this.manifests().find((manifest) => manifest.name.toLocaleLowerCase("en-US") === candidate.toLocaleLowerCase("en-US"));
        if (byName) return { name: byName.name, path: byName.path, pathKey: byName.pathKey, manifest: byName, guessed: false };
      }
      const resolved = path.resolve(candidate);
      const manifest = this.manifestByPath(resolved);
      return { name: manifest?.name ?? path.basename(resolved), path: resolved, pathKey: filesystemKey(resolved), manifest, guessed: false };
    }
    const cwd = path.resolve(process.cwd());
    const manifest = this.manifestByPath(cwd);
    return { name: manifest?.name ?? path.basename(cwd), path: cwd, pathKey: filesystemKey(cwd), manifest, guessed: !manifest };
  }

  private manifests(): ProjectManifest[] {
    const root = path.join(this.stateRoot, "projects");
    if (!fs.existsSync(root)) return [];
    const manifests: ProjectManifest[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const file = path.join(root, entry.name, "config", "project.json");
      if (!fs.existsSync(file)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as ProjectManifest;
        if (manifest.schemaVersion === MANIFEST_VERSION) manifests.push(manifest);
      } catch { /* invalid manifests are ignored by discovery and remain on disk for diagnosis */ }
    }
    return manifests.sort((left, right) => left.name.localeCompare(right.name));
  }

  private manifestByPath(projectPath: string): ProjectManifest | undefined {
    const key = filesystemKey(projectPath);
    return this.manifests().find((manifest) => manifest.pathKey === key);
  }

  private manifestPath(manifest: Pick<ProjectManifest, "path">): string {
    const known = this.manifestByPathWithoutRecursion(manifest.path);
    const directory = known ? path.dirname(path.dirname(known)) : this.stateDirectory(manifest.path);
    return path.join(directory, "config", "project.json");
  }

  private manifestByPathWithoutRecursion(projectPath: string): string | undefined {
    const root = path.join(this.stateRoot, "projects");
    if (!fs.existsSync(root)) return undefined;
    const key = filesystemKey(projectPath);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const file = path.join(root, entry.name, "config", "project.json");
      try {
        const value = JSON.parse(fs.readFileSync(file, "utf8")) as ProjectManifest;
        if (value.schemaVersion === MANIFEST_VERSION && value.pathKey === key) return file;
      } catch { /* continue */ }
    }
    return undefined;
  }

  private stateDirectory(projectPath: string): string {
    const projectsRoot = path.join(this.stateRoot, "projects");
    const base = stateSlug(projectPath);
    const direct = path.join(projectsRoot, base);
    const directManifest = path.join(direct, "config", "project.json");
    const requestedPathKey = filesystemKey(projectPath);
    if (!fs.existsSync(direct)) return direct;
    if (fs.existsSync(directManifest)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(directManifest, "utf8")) as ProjectManifest;
        if (manifest.pathKey === requestedPathKey) return direct;
      } catch { /* use collision-safe suffix */ }
      return path.join(projectsRoot, `${base}-${sha256(requestedPathKey).slice(0, 10)}`);
    }

    const databasePath = path.join(direct, "state", "bridge2.sqlite");
    if (fs.existsSync(databasePath)) {
      const boundPathKey = this.boundProjectPathKey(databasePath);
      if (boundPathKey === undefined || boundPathKey === requestedPathKey) return direct;
      return path.join(projectsRoot, `${base}-${sha256(requestedPathKey).slice(0, 10)}`);
    }
    if (fs.readdirSync(direct).length === 0) return direct;
    return path.join(projectsRoot, `${base}-${sha256(requestedPathKey).slice(0, 10)}`);
  }

  private boundProjectPathKey(databasePath: string): string | undefined {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const table = database.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'legacy_project_bindings'",
      ).get() as { present: number } | undefined;
      if (!table) return undefined;
      const binding = database.prepare(
        "SELECT project_path_key FROM legacy_project_bindings ORDER BY project_id LIMIT 1",
      ).get() as { project_path_key: string } | undefined;
      return binding?.project_path_key;
    } finally {
      database.close();
    }
  }

  private databasePathForManifest(manifest: ProjectManifest): string {
    const file = this.manifestByPathWithoutRecursion(manifest.path);
    invariant(file, "project_manifest_not_found");
    return path.join(path.dirname(path.dirname(file)), "state", "bridge2.sqlite");
  }

  private bootstrap(runtime: BridgeRuntime, projectPath: string): PrincipalRef {
    const now = this.now();
    const hostHash = sha256(os.hostname().toLocaleLowerCase("en-US"));
    const suffix = hostHash.slice(0, 16);
    const principal: PrincipalRecord = {
      principalId: `principal.local_owner.${suffix}`,
      kind: "human",
      displayName: "Local Bridge Owner",
      issuer: "bridge2-local-os",
      subject: `os-user-sha256:${sha256(os.userInfo().username.toLocaleLowerCase("en-US"))}`,
      status: "active",
      createdAt: now.toISOString(),
    };
    const host: HostRecord = {
      hostId: `host.${suffix}`,
      instanceId: `instance.host.${suffix}`,
      hostnameHash: hostHash,
      platform: platformName(),
      status: "active",
      registeredAt: now.toISOString(),
    };
    const session: SessionRecord = {
      sessionId: `session.local_owner.${suffix}`,
      principalId: principal.principalId,
      hostId: host.hostId,
      startedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString(),
      status: "active",
      authentication: { method: "os_user", assurance: "local" },
      transportBinding: {
        transport: "stdio",
        transportSessionId: `stdio-owner-bootstrap-${suffix}`,
        serverInstanceId: `instance.server.bootstrap.${suffix}`,
      },
    };
    return runtime.identity.bootstrapOwner({
      projectId: projectIdentifier(projectPath),
      principal,
      host,
      session,
      idempotencyKey: `idempotency.bootstrap.${sha256(filesystemKey(projectPath)).slice(0, 32)}`,
    });
  }

  private ensureAgent(runtime: BridgeRuntime, projectId: string, requestedLane: string): PrincipalRef {
    const lane = laneIdentifier(requestedLane);
    const owner = this.ownerActor(runtime, projectId);
    const principalId = `principal.compat.${lane}`;
    if (!runtime.store.get("SELECT principal_id FROM principals WHERE principal_id = ?", principalId)) {
      runtime.identity.registerPrincipal({
        projectId,
        actor: owner,
        principal: {
          principalId,
          kind: "agent",
          displayName: laneDisplayName(lane),
          issuer: "bridge2-legacy-stdio",
          subject: `lane:${lane}`,
          status: "active",
          createdAt: this.now().toISOString(),
        },
        idempotencyKey: `idempotency.compat.principal.${lane}`,
      });
    }
    if (!runtime.identity.hasRole(projectId, principalId, "collaborator")) {
      runtime.identity.assignRole({
        projectId,
        actor: owner,
        principalId,
        role: "collaborator",
        idempotencyKey: `idempotency.compat.role.${lane}`,
      });
    }
    const sessionHash = sha256(`${this.config.sessionId}\0${lane}`).slice(0, 24);
    const sessionId = `session.compat.${lane}.${sessionHash}`;
    const existing = runtime.store.get<{ status: string; expires_at: string; host_id: string }>(
      "SELECT status, expires_at, host_id FROM sessions WHERE session_id = ?",
      sessionId,
    );
    if (!existing) {
      const now = this.now();
      runtime.identity.createSession({
        projectId,
        actor: owner,
        session: {
          sessionId,
          principalId,
          hostId: owner.hostId,
          startedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          status: "active",
          authentication: { method: "local_process", assurance: "local" },
          transportBinding: {
            transport: "stdio",
            transportSessionId: `stdio-compat-${sessionHash}`,
            serverInstanceId: `instance.compat.${sessionHash}`,
          },
        },
        idempotencyKey: `idempotency.compat.session.${sessionHash}`,
      });
    } else {
      invariant(existing.status === "active" && Date.parse(existing.expires_at) > this.now().getTime(), "compatibility_session_not_active");
      invariant(existing.host_id === owner.hostId, "compatibility_session_host_mismatch");
    }
    const actor = { principalId, sessionId, hostId: owner.hostId };
    runtime.identity.authorize(projectId, actor, ["collaborator"]);
    return actor;
  }

  private ownerActor(runtime: BridgeRuntime, projectId: string): PrincipalRef {
    const row = runtime.store.get<{
      principal_id: string;
      session_id: string;
      host_id: string;
    }>(
      `SELECT r.principal_id, s.session_id, s.host_id
       FROM project_roles r
       JOIN principals p ON p.principal_id = r.principal_id AND p.status = 'active'
       JOIN sessions s ON s.principal_id = r.principal_id AND s.status = 'active'
       JOIN hosts h ON h.host_id = s.host_id AND h.status = 'active'
       WHERE r.project_id = ? AND r.role = 'owner' AND r.status = 'active'
         AND julianday(s.started_at) <= julianday(?)
         AND julianday(s.expires_at) > julianday(?)
       ORDER BY s.started_at DESC, s.session_id DESC LIMIT 1`,
      projectId,
      this.now().toISOString(),
      this.now().toISOString(),
    );
    invariant(row, "active_owner_session_required_for_compatibility_bootstrap");
    return { principalId: row.principal_id, sessionId: row.session_id, hostId: row.host_id };
  }

  private applySession(handle: ProjectHandle, now: Date): boolean {
    let active = this.activeSession(handle);
    if (active && now.getTime() - Date.parse(active.last_activity_at) > SESSION_IDLE_MINUTES * 60_000) {
      handle.runtime.store.run(
        "UPDATE legacy_collaboration_sessions SET status = 'closed', closed_at = ?, closed_by_agent = ? WHERE collaboration_session_id = ? AND status = 'active'",
        now.toISOString(),
        "idle_timeout",
        active.collaboration_session_id,
      );
      active = undefined;
    }
    if (!active) {
      handle.runtime.store.run(
        `INSERT INTO legacy_collaboration_sessions(
          collaboration_session_id, project_id, boss_agent, boss_set_by, status,
          started_at, last_activity_at, closed_at, closed_by_agent
        ) VALUES (?, ?, ?, 'first-command', 'active', ?, ?, NULL, NULL)`,
        newId("collaboration.session"),
        handle.projectId,
        handle.lane,
        now.toISOString(),
        now.toISOString(),
      );
      return true;
    }
    handle.runtime.store.run(
      "UPDATE legacy_collaboration_sessions SET last_activity_at = ? WHERE collaboration_session_id = ? AND status = 'active'",
      now.toISOString(),
      active.collaboration_session_id,
    );
    return false;
  }

  private activeSession(handle: ProjectHandle): SessionRow | undefined {
    return handle.runtime.store.get<SessionRow>(
      `SELECT collaboration_session_id, boss_agent, boss_set_by, status, started_at, last_activity_at
       FROM legacy_collaboration_sessions WHERE project_id = ? AND status = 'active'`,
      handle.projectId,
    );
  }

  private sessionView(handle: ProjectHandle, now: Date): Record<string, unknown> | null {
    const session = this.activeSession(handle);
    if (!session) return null;
    return {
      boss: session.boss_agent,
      youAreBoss: session.boss_agent === handle.lane,
      bossSetBy: session.boss_set_by,
      status: session.status,
      startedMinAgo: Math.round((now.getTime() - Date.parse(session.started_at)) / 60_000),
      idleMin: Math.round((now.getTime() - Date.parse(session.last_activity_at)) / 60_000),
      autoCloseAfterMin: SESSION_IDLE_MINUTES,
    };
  }

  private expireLeases(handle: ProjectHandle, now: Date): number {
    const project = handle.runtime.store.get<{ active_generation: number }>(
      "SELECT active_generation FROM projects WHERE project_id = ?",
      handle.projectId,
    );
    invariant(project, "project_not_found");
    const expired = handle.runtime.store.run(
      `UPDATE legacy_file_leases SET status = 'expired', ended_at = ?
       WHERE project_id = ? AND status = 'active'
         AND (generation <> ? OR julianday(expires_at) <= julianday(?))`,
      now.toISOString(),
      handle.projectId,
      Number(project.active_generation),
      now.toISOString(),
    );
    return Number(expired.changes);
  }

  private activeLeases(handle: ProjectHandle, now: Date): LeaseRow[] {
    const project = handle.runtime.store.get<{ active_generation: number }>(
      "SELECT active_generation FROM projects WHERE project_id = ?",
      handle.projectId,
    );
    invariant(project, "project_not_found");
    return handle.runtime.store.all<LeaseRow>(
      `SELECT lease_id, path, path_key, agent, principal_id, session_id, host_id,
              generation, fencing_token, claimed_at, expires_at, note
       FROM legacy_file_leases
       WHERE project_id = ? AND status = 'active' AND generation = ? AND julianday(expires_at) > julianday(?)
       ORDER BY claimed_at, lease_id`,
      handle.projectId,
      Number(project.active_generation),
      now.toISOString(),
    );
  }

  private collaborationEventsAfter(handle: ProjectHandle, sequence: number): EventEnvelope[] {
    return handle.runtime.store.all<{ envelope_json: string }>(
      `SELECT envelope_json FROM events
       WHERE project_id = ? AND sequence > ? AND event_type = 'collaboration.command_recorded'
       ORDER BY sequence`,
      handle.projectId,
      sequence,
    ).map((row) => JSON.parse(row.envelope_json) as EventEnvelope);
  }

  private recordCommand(
    handle: ProjectHandle,
    operation: string,
    request: Record<string, unknown>,
    outcome: Record<string, unknown>,
    status: "succeeded" | "denied" | "failed" = "succeeded",
  ): EventEnvelope {
    const cleanedRequest = clean(request);
    const cleanedOutcome = clean(outcome);
    const actionId = newId("action.legacy");
    return handle.runtime.journal.append({
      projectId: handle.projectId,
      eventType: "collaboration.command_recorded",
      aggregateId: handle.projectId,
      actor: handle.actor,
      data: {
        operation,
        agent: handle.lane,
        request: cleanedRequest,
        outcome: cleanedOutcome,
      },
      correlationId: `correlation.${actionId}`,
      audit: {
        actions: [{
          actionId,
          adapterId: "adapter.bridge.compatibility",
          operation,
          sideEffectClass: "local_write",
          origin: `bridge://project/${handle.projectId}`,
          destination: `bridge://project/${handle.projectId}/${operation}`,
          conditionHash: hashCanonical(cleanedRequest),
          authorizationDecision: "allow",
        }],
        outcomes: [{
          outcomeId: newId("outcome.legacy"),
          status,
          detailHash: hashCanonical(cleanedOutcome),
          artifactIds: [],
        }],
      },
    });
  }

  private assertCommandIdempotency(
    handle: ProjectHandle,
    operation: string,
    idempotencyKey: string,
    expected: Record<string, unknown>,
  ): void {
    const row = handle.runtime.store.get<{ envelope_json: string }>(
      `SELECT envelope_json FROM events
       WHERE project_id = ? AND event_type = 'collaboration.command_recorded'
         AND json_extract(envelope_json, '$.data.operation') = ?
         AND json_extract(envelope_json, '$.data.request.idempotencyKey') = ?
       ORDER BY sequence LIMIT 1`,
      handle.projectId,
      operation,
      idempotencyKey,
    );
    if (!row) return;
    const event = JSON.parse(row.envelope_json) as EventEnvelope;
    const request = event.data.request as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) {
      invariant(canonicalEqual(request[key], value), "idempotency_key_reused", { operation, idempotencyKey });
    }
  }
}

function defaultStateRoot(): string {
  const local = process.env.LOCALAPPDATA?.trim();
  return local ? path.join(local, "Bridge2") : path.join(os.homedir(), ".bridge2");
}

function laneToPeer(lane: string): CommandCenterPeer {
  const canonical = canonicalLane(lane);
  if (canonical === "google_antigravity") return "antigravity";
  if (canonical === "codex") return "codex";
  if (canonical === "claude_desktop_code" || canonical === "claude_desktop_cowork") return "claude";
  invariant(false, "a2a_lane_not_a_peer", { lane: canonical });
}

async function a2aFetch(url: string, sourcePeer: CommandCenterPeer, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bridge-peer": sourcePeer,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  invariant(response.ok, "a2a_http_request_failed", { status: response.status });
  try { return JSON.parse(text) as unknown; }
  catch { invariant(false, "a2a_http_invalid_json"); }
}

function a2aReceipt(task: A2ATask): {
  taskId: string;
  state: A2ATask["status"]["state"];
  terminal: boolean;
  completed: boolean;
  artifactIds: string[];
  output: string | null;
  failure: string | null;
} {
  const artifactIds = (task.artifacts ?? []).map((artifact) => artifact.artifactId);
  const output = (task.artifacts ?? [])
    .flatMap((artifact) => artifact.parts)
    .find((part) => part.kind === "text")?.text ?? null;
  const failure = task.status.state === "failed"
    ? task.status.message?.parts.find((part) => part.kind === "text")?.text ?? "a2a_task_failed"
    : null;
  return {
    taskId: task.id,
    state: task.status.state,
    terminal: isTerminalTaskState(task.status.state),
    completed: task.status.state === "completed",
    artifactIds,
    output,
    failure,
  };
}

function defaultRecoveryRoot(stateRoot: string): string {
  try {
    const candidates = fs.readdirSync(os.homedir(), { withFileTypes: true })
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && /^My Drive \(.+\)$/u.test(entry.name))
      .map((entry) => path.join(os.homedir(), entry.name, "Bridge 2.0 Recovery"))
      .filter((candidate) => fs.existsSync(candidate));
    if (candidates.length === 1) return candidates[0];
  } catch { /* use the local fallback until an explicit recovery root is configured */ }
  return path.join(stateRoot, "backups");
}

function filesystemKey(value: string): string {
  const canonical = canonicalProjectPath(value);
  return process.platform === "win32" ? canonical.toLocaleLowerCase("en-US") : canonical;
}

function stateSlug(projectPath: string): string {
  const slug = path.basename(canonicalProjectPath(projectPath))
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLocaleLowerCase("en-US")
    .slice(0, 80);
  return slug || `project-${sha256(filesystemKey(projectPath)).slice(0, 12)}`;
}

function canonicalProjectPath(value: string): string {
  const resolved = path.normalize(path.resolve(value));
  try {
    return path.normalize(fs.realpathSync.native(resolved));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolved;
    throw error;
  }
}

function projectIdentifier(projectPath: string): string {
  const body = stateSlug(projectPath).replaceAll("-", "_").slice(0, 96);
  return `project.${body}`;
}

function platformName(): HostRecord["platform"] {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

function laneDisplayName(lane: string): string {
  if (lane === "codex") return "Codex";
  if (lane === "claude_desktop_code") return "Claude Desktop Code";
  if (lane === "claude_desktop_cowork") return "Claude Desktop Cowork";
  return lane.replaceAll("_", " ");
}

function claimKey(value: string): string {
  const normalized = normalizeClaim(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function clean<T extends Record<string, unknown>>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function boundedErrorMessage(prefix: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${detail}`.slice(0, 4000);
}

function fullFileHash(filePath: string): string | undefined {
  try { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }
  catch { return undefined; }
}

function groupOtherLeases(leases: LeaseRow[], now: Date): Array<{ agent: string; paths: string[]; expiresInMin: number }> {
  const groups = new Map<string, { paths: string[]; expiresAt: number }>();
  for (const lease of leases) {
    const current = groups.get(lease.agent) ?? { paths: [], expiresAt: 0 };
    current.paths.push(lease.path);
    current.expiresAt = Math.max(current.expiresAt, Date.parse(lease.expires_at));
    groups.set(lease.agent, current);
  }
  return [...groups.entries()].map(([agent, value]) => ({
    agent,
    paths: unique(value.paths),
    expiresInMin: Math.max(0, Math.round((value.expiresAt - now.getTime()) / 60_000)),
  }));
}

function groupLeasePaths(leases: Array<{ agent: string; path: string }>): Array<{ agent: string; paths: string[] }> {
  const groups = new Map<string, string[]>();
  for (const lease of leases) groups.set(lease.agent, [...(groups.get(lease.agent) ?? []), lease.path]);
  return [...groups.entries()].map(([agent, paths]) => ({ agent, paths: unique(paths) }));
}

function legacyActivityView(event: EventEnvelope): Record<string, unknown> {
  const request = event.data.request as Record<string, unknown>;
  const operation = String(event.data.operation);
  const files = Array.isArray(request.files)
    ? request.files
    : Array.isArray(request.paths)
      ? request.paths
      : [];
  const note = typeof request.summary === "string"
    ? request.summary
    : typeof request.note === "string"
      ? request.note
      : undefined;
  return clean({
    activityId: event.eventId,
    agent: String(event.data.agent),
    action: operation.replace(/^bridge_/u, ""),
    files,
    note,
    iso: event.occurredAt,
  });
}

function readLegacyState(projectPath: string): LegacyState {
  const file = path.join(path.resolve(projectPath), ".connector", "state.json");
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")) as LegacyState;
}
