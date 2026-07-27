import fs from "node:fs";
import path from "node:path";
import { getConfig, otherAgent, type BridgeConfig } from "./config.js";
import {
  type ProjectEntry, type Lease, type ProjectState,
  loadRegistry, upsertRegistry, touchLastActive,
  ledgerAppend, ledgerReadAll, ledgerSince,
  withState, loadState, appendJournal, connectorDir,
} from "./store.js";
import { normalizeClaim, pathsOverlap, changedSince } from "./leases.js";
import {
  hasGit, isGitRepo, initRepo, headCommit, isDirty,
  bundleCreate, ensureRemote, push, cloneFrom,
} from "./git.js";
import { ensureDir, ensureGitignore, hashFile, nowIso } from "./util.js";

const DEFAULT_TTL_MIN = 120;
const SESSION_IDLE_MIN = 60; // auto-close a collaboration session after this much inactivity

/**
 * Maintain the collaboration session on every command:
 *  - if there's no active session (or the last one went idle past the threshold), the CALLER
 *    becomes boss ("first command wins") and a fresh session starts;
 *  - otherwise just record activity (keeps the session alive, boss unchanged).
 * Returns whether a brand-new session was opened.
 */
function applySession(s: ProjectState, cfg: BridgeConfig, now: number): { opened: boolean } {
  const idleMs = SESSION_IDLE_MIN * 60000;
  const sess = s.session;
  const stale = sess && sess.status === "active" && now - sess.lastActivity > idleMs;
  if (!sess || sess.status === "closed" || stale) {
    if (stale && sess) sess.status = "closed"; // lazily retire the idle one
    s.session = { boss: cfg.agent, bossSetBy: "first-command", startedAt: now, lastActivity: now, status: "active" };
    return { opened: true };
  }
  sess.lastActivity = now;
  return { opened: false };
}

function sessionView(s: ProjectState, cfg: BridgeConfig, now: number) {
  const sess = s.session;
  if (!sess) return null;
  return {
    boss: sess.boss,
    youAreBoss: sess.boss === cfg.agent,
    bossSetBy: sess.bossSetBy,
    status: sess.status,
    startedMinAgo: Math.round((now - sess.startedAt) / 60000),
    idleMin: Math.round((now - sess.lastActivity) / 60000),
    autoCloseAfterMin: SESSION_IDLE_MIN,
  };
}

/** Map a project arg (name | path | undefined) to a concrete project.
 *  Resolution order when no arg is given: $BRIDGE_PROJECT (wiring-pinned) → a registered
 *  project matching cwd → cwd itself (flagged `guessed`, see H4). A long-lived stdio
 *  server inherits the HOST TOOL's cwd, which is often NOT the project, so cwd is the
 *  last resort and callers can warn when it was only guessed. */
export function resolveProject(arg?: string): { name: string; path: string; entry?: ProjectEntry; guessed?: boolean } {
  const reg = loadRegistry();
  const byNameOrPath = (a: string) => {
    if (reg.projects[a]) { const e = reg.projects[a]; return { name: e.name, path: e.path, entry: e }; }
    const abs = path.resolve(a);
    const bp = Object.values(reg.projects).find((p) => path.resolve(p.path) === abs);
    if (bp) return { name: bp.name, path: bp.path, entry: bp };
    return { name: path.basename(abs), path: abs };
  };
  if (arg) return byNameOrPath(arg);
  const cfg = getConfig();
  if (cfg.project) return byNameOrPath(cfg.project); // H4: explicit pin beats cwd
  const cwd = process.cwd();
  const byPath = Object.values(reg.projects).find((p) => path.resolve(p.path) === path.resolve(cwd));
  if (byPath) return { name: byPath.name, path: byPath.path, entry: byPath };
  return { name: path.basename(cwd), path: cwd, guessed: true };
}

// ---------------------------------------------------------------------------
// Registry / discovery
// ---------------------------------------------------------------------------

export async function registerProject(args: { name: string; path: string; remote?: string }) {
  const cfg = getConfig();
  const abs = path.resolve(args.path);
  ensureDir(abs);
  let git = "git not found — backup/restore disabled";
  if (hasGit()) {
    if (!isGitRepo(abs)) { initRepo(abs); git = "initialized new git repo"; }
    else git = "existing git repo";
  }
  ensureDir(connectorDir(abs));
  ensureGitignore(abs, ".connector/");
  await upsertRegistry({ name: args.name, path: abs, remote: args.remote });
  await touchLastActive(args.name, abs, "register");
  ledgerAppend({ project: args.name, action: "register", note: abs });
  return { ok: true, name: args.name, path: abs, git, remote: args.remote ?? null, bridgeHome: cfg.bridgeHome };
}

export async function listProjects() {
  const cfg = getConfig();
  const reg = loadRegistry();
  const now = Date.now();
  const projects = Object.values(reg.projects).map((p) => {
    const s = loadState(p.path);
    const active = s.leases.filter((l) => l.expires > now);
    return {
      name: p.name, path: p.path, remote: p.remote ?? null,
      control: s.control,
      activeLeases: active.map((l) => ({ agent: l.agent, paths: l.paths })),
      openTasks: s.tasks.filter((t) => t.status !== "done").length,
      lastActive: p.lastActive ?? null,
    };
  });
  return { bridgeHome: cfg.bridgeHome, you: { agent: cfg.agent, host: cfg.host }, projects };
}

// ---------------------------------------------------------------------------
// The turn-start sync (control + leases + tasks + freshness)
// ---------------------------------------------------------------------------

export async function sync(project?: string) {
  const cfg = getConfig();
  const { name, path: ppath, entry, guessed } = resolveProject(project);
  const now = Date.now();

  const result = await withState(ppath, (s) => {
    const prev = s.lastSync[cfg.sessionId];
    const firstSync = prev === undefined;
    const changed = firstSync ? [] : changedSince(ppath, prev);
    const byOther = firstSync ? [] : ledgerSince(name, prev, cfg.agent);
    s.leases = s.leases.filter((l) => l.expires > now); // prune expired
    // H2: advance the freshness baseline only to the high-water mark we actually
    // OBSERVED (the newest other-agent ledger ts we just read), capped at `now` and
    // never moving backwards. Jumping straight to `now` would permanently skip an
    // entry that was written-but-not-yet-visible yet timestamped <= now.
    const observedMax = byOther.reduce((m, e) => Math.max(m, e.ts || 0), 0);
    s.lastSync[cfg.sessionId] = Math.max(prev ?? 0, observedMax > 0 ? Math.min(observedMax, now) : now);
    // F24: drop stale per-session baselines so lastSync can't grow unbounded.
    const HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
    for (const k of Object.keys(s.lastSync)) if (now - s.lastSync[k] > HORIZON_MS) delete s.lastSync[k];
    const { opened } = applySession(s, cfg, now); // first-command-wins boss + activity
    return {
      project: name,
      path: ppath,
      you: { agent: cfg.agent, host: cfg.host, session: cfg.sessionId },
      session: sessionView(s, cfg, now),
      openedNewSession: opened,
      control: s.control,
      youHoldControl: s.control === null ? null : s.control === cfg.agent,
      yourLeases: s.leases.filter((l) => l.agent === cfg.agent).flatMap((l) => l.paths),
      othersLeases: s.leases
        .filter((l) => l.agent !== cfg.agent)
        .map((l) => ({ agent: l.agent, paths: l.paths, expiresInMin: Math.round((l.expires - now) / 60000) })),
      openTasks: s.tasks.filter((t) => t.status !== "done"),
      changedSinceLastSync: changed,
      changedByOther: byOther.map((e) => ({ agent: e.agent, action: e.action, files: e.files ?? [], note: e.note, iso: e.iso })),
      firstSync,
    };
  });

  const la = entry?.lastActive;
  const hostWarning =
    la && la.host !== cfg.host
      ? `Project was last active on host '${la.host}' (by ${la.agent}). If you sync via backup, run 'bridge restore' to get the latest before editing.`
      : null;
  const projectWarning = guessed
    ? `Project '${name}' was GUESSED from the server's working directory ('${ppath}') and is not registered. A stdio server inherits the host tool's cwd, which may not be this project — pass 'project' explicitly or pin BRIDGE_PROJECT in the MCP wiring, or coordination may apply to the wrong place.`
    : null;
  await touchLastActive(name, ppath, "sync");
  return { ...result, registered: !!entry, hostWarning, projectWarning };
}

// ---------------------------------------------------------------------------
// Leases (anti-clobber)
// ---------------------------------------------------------------------------

export async function claim(args: { paths: string[]; project?: string; note?: string; ttlMinutes?: number }) {
  const cfg = getConfig();
  const { name, path: ppath } = resolveProject(args.project);
  const reqPaths = (args.paths ?? []).map(normalizeClaim);
  if (reqPaths.length === 0) return { ok: false, project: name, granted: [], conflicts: [], message: "no paths given" };
  const now = Date.now();
  const ttlMs = (args.ttlMinutes ?? DEFAULT_TTL_MIN) * 60000;

  const result = await withState(ppath, (s) => {
    s.leases = s.leases.filter((l) => l.expires > now);
    applySession(s, cfg, now); // a claim is a command: keep session alive / set first-mover boss
    const conflicts: { requested: string; conflictsWith: string; heldBy: string }[] = [];
    for (const req of reqPaths) {
      for (const l of s.leases) {
        if (l.agent === cfg.agent) continue;
        for (const lp of l.paths) {
          if (pathsOverlap(lp, req)) conflicts.push({ requested: req, conflictsWith: lp, heldBy: l.agent });
        }
      }
    }
    if (conflicts.length > 0) {
      return { ok: false, project: name, granted: [] as string[], conflicts, message: "Denied — overlaps a lease held by the other agent." };
    }
    s.leases.push({ paths: reqPaths, agent: cfg.agent, session: cfg.sessionId, ts: now, expires: now + ttlMs, note: args.note });
    return { ok: true, project: name, granted: reqPaths, conflicts: [] as typeof conflicts, expiresInMin: args.ttlMinutes ?? DEFAULT_TTL_MIN };
  });

  if (result.ok) {
    appendJournal(ppath, `${nowIso()} ${cfg.agent} claimed ${reqPaths.join(", ")}${args.note ? " — " + args.note : ""}`);
    ledgerAppend({ project: name, action: "claim", files: reqPaths, note: args.note });
    await touchLastActive(name, ppath, "claim");
  }
  return result;
}

export async function release(args: { paths?: string[]; project?: string }) {
  const cfg = getConfig();
  const { name, path: ppath } = resolveProject(args.project);
  const rel = args.paths?.map(normalizeClaim);

  const result = await withState(ppath, (s) => {
    const next: Lease[] = [];
    for (const l of s.leases) {
      if (l.agent !== cfg.agent) { next.push(l); continue; }
      if (!rel || rel.length === 0) continue; // drop all of mine
      const keep = l.paths.filter((p) => !rel.includes(p));
      if (keep.length) next.push({ ...l, paths: keep });
    }
    s.leases = next;
    return { ok: true, project: name, released: rel ?? "all", remaining: s.leases.filter((l) => l.agent === cfg.agent).flatMap((l) => l.paths) };
  });

  appendJournal(ppath, `${nowIso()} ${cfg.agent} released ${rel ? rel.join(", ") : "all leases"}`);
  ledgerAppend({ project: name, action: "release", files: rel ?? [] });
  return result;
}

// ---------------------------------------------------------------------------
// Handoff + log
// ---------------------------------------------------------------------------

export async function handoff(args: { to?: string; note?: string; project?: string }) {
  const cfg = getConfig();
  const { name, path: ppath } = resolveProject(args.project);
  const to = (args.to ?? otherAgent()).toLowerCase();
  const now = Date.now();

  const result = await withState(ppath, (s) => {
    const previous = s.control;
    s.control = to;
    applySession(s, cfg, now);
    return { ok: true, project: name, control: to, previous };
  });

  appendJournal(ppath, `${nowIso()} ${cfg.agent} handed control to ${to}${args.note ? " — " + args.note : ""}`);
  ledgerAppend({ project: name, action: "handoff", note: `to ${to}${args.note ? ": " + args.note : ""}` });
  await touchLastActive(name, ppath, "handoff");
  return { ...result, note: args.note ?? null };
}

export async function log(args: { summary: string; files?: string[]; project?: string }) {
  const cfg = getConfig();
  const { name, path: ppath } = resolveProject(args.project);
  const files = args.files ?? [];
  const hashes: Record<string, string> = {};
  for (const f of files) { const h = hashFile(path.join(ppath, f)); if (h) hashes[f] = h; }
  appendJournal(ppath, `${nowIso()} ${cfg.agent}: ${args.summary}${files.length ? " [" + files.join(", ") + "]" : ""}`);
  ledgerAppend({ project: name, action: "log", files, hashes, note: args.summary });
  await touchLastActive(name, ppath, "log");
  return { ok: true, project: name, logged: args.summary, files };
}

// ---------------------------------------------------------------------------
// Session / roles (boss = first command; user can switch anytime; idle auto-close)
// ---------------------------------------------------------------------------

/** Explicitly set the boss for the current session (user override; switchable anytime). */
export async function setBoss(args: { to: string; project?: string }) {
  const cfg = getConfig();
  const { name, path: ppath } = resolveProject(args.project);
  const to = args.to.toLowerCase();
  const now = Date.now();
  const result = await withState(ppath, (s) => {
    if (!s.session || s.session.status === "closed") {
      s.session = { boss: to, bossSetBy: "user", startedAt: now, lastActivity: now, status: "active" };
    } else {
      s.session.boss = to;
      s.session.bossSetBy = "user";
      s.session.lastActivity = now;
    }
    return { ok: true, project: name, boss: to, bossSetBy: "user" as const };
  });
  appendJournal(ppath, `${nowIso()} ${cfg.agent} set boss = ${to}`);
  ledgerAppend({ project: name, action: "set-boss", note: to });
  return result;
}

/**
 * Close out any session idle longer than `idleMinutes` across all registered projects.
 * Releases that session's leases and logs the closeout. Meant to be run on a schedule
 * (Task Scheduler / cron) or by a wrap-up agent — "the session gets closed out after an hour".
 */
export async function reap(args?: { idleMinutes?: number }) {
  const cfg = getConfig();
  const idleMin = args?.idleMinutes ?? SESSION_IDLE_MIN;
  const idleMs = idleMin * 60000;
  const now = Date.now();
  const reg = loadRegistry();
  const closed: { project: string; idleMin: number; releasedLeases: number }[] = [];

  for (const p of Object.values(reg.projects)) {
    const s = loadState(p.path);
    if (!s.session || s.session.status !== "active" || now - s.session.lastActivity <= idleMs) continue;
    const idle = Math.round((now - s.session.lastActivity) / 60000);
    const releasedLeases = await withState(p.path, (st) => {
      if (!st.session || st.session.status !== "active" || now - st.session.lastActivity <= idleMs) return 0;
      st.session.status = "closed";
      st.session.closedBy = cfg.agent === "unknown" ? "reaper" : cfg.agent;
      // H6/M7: do NOT blanket-clear leases on idle close — `st.leases = []` wipes the
      // OTHER agent's still-valid, in-flight leases and opens a clobber window. Only
      // drop leases that have themselves expired; live ones keep protecting until
      // their own TTL lapses (sync()/claim() already prune `expires <= now`).
      const before = st.leases.length;
      st.leases = st.leases.filter((l) => l.expires > now);
      return before - st.leases.length;
    });
    appendJournal(p.path, `${nowIso()} session closed by ${cfg.agent === "unknown" ? "reaper" : cfg.agent} (idle ${idle}m > ${idleMin}m); dropped ${releasedLeases} expired lease(s), kept live ones`);
    ledgerAppend({ project: p.name, action: "session-close", note: `idle ${idle}m; dropped ${releasedLeases} expired leases (live leases kept)` });
    closed.push({ project: p.name, idleMin: idle, releasedLeases });
  }
  return { ok: true, idleThresholdMin: idleMin, checked: Object.keys(reg.projects).length, closed };
}

// ---------------------------------------------------------------------------
// Lightweight task board
// ---------------------------------------------------------------------------

export async function taskAdd(args: { title: string; project?: string; owner?: string }) {
  const cfg = getConfig();
  const { name, path: ppath } = resolveProject(args.project);
  const result = await withState(ppath, (s) => {
    const id = `t${s.tasks.length + 1}-${Math.random().toString(36).slice(2, 6)}`;
    s.tasks.push({ id, title: args.title, status: "todo", owner: args.owner, ts: Date.now() });
    return { ok: true, project: name, id, title: args.title };
  });
  appendJournal(ppath, `${nowIso()} ${cfg.agent} added task ${result.id}: ${args.title}`);
  return result;
}

export async function taskUpdate(args: { id: string; status?: "todo" | "doing" | "done"; owner?: string; project?: string }) {
  const cfg = getConfig();
  const { name, path: ppath } = resolveProject(args.project);
  const result = await withState(ppath, (s) => {
    const t = s.tasks.find((t) => t.id === args.id);
    if (!t) return { ok: false as const, project: name, message: `task ${args.id} not found` };
    if (args.status) t.status = args.status;
    if (args.owner !== undefined) t.owner = args.owner;
    return { ok: true as const, project: name, task: t };
  });
  if (result.ok) appendJournal(ppath, `${nowIso()} ${cfg.agent} updated ${args.id} -> ${args.status ?? "(owner)"}`);
  return result;
}

// ---------------------------------------------------------------------------
// Backup / restore
// ---------------------------------------------------------------------------

export async function backup(args: { project?: string; force?: boolean }) {
  const cfg = getConfig();
  const { name, path: ppath, entry } = resolveProject(args.project);
  if (!hasGit()) return { ok: false, project: name, message: "git not installed" };
  if (!isGitRepo(ppath)) return { ok: false, project: name, message: `${ppath} is not a git repo — run 'bridge register' first` };
  const head = headCommit(ppath);
  if (!head) return { ok: false, project: name, message: "repo has no commits yet — make a commit first" };

  // H5: `git bundle --all` captures only COMMITTED refs. Backing up a dirty tree would
  // silently omit uncommitted/untracked work, and restore() prefers the bundle — so
  // that work is lost on restore. Refuse unless explicitly forced (computed BEFORE the
  // bundle so the decision reflects the state we are about to capture).
  const dirty = isDirty(ppath);
  if (dirty && !args.force) {
    return {
      ok: false, project: name, dirty: true,
      message: "Refusing to back up a dirty tree: uncommitted/untracked changes would NOT be in the bundle (git bundle --all = committed refs only). Commit them first, or pass force to bundle the committed state anyway.",
    };
  }

  const bundle = path.join(cfg.bridgeHome, "backups", `${name}.bundle`);
  bundleCreate(ppath, bundle);

  let pushResult = "no remote configured";
  if (entry?.remote) {
    try { ensureRemote(ppath, "origin", entry.remote); push(ppath, "origin"); pushResult = `pushed to ${entry.remote}`; }
    catch (e: unknown) { pushResult = `push failed: ${(e as Error).message}`; }
  }

  ledgerAppend({ project: name, action: "backup", note: `bundle @ ${head.slice(0, 8)}; ${pushResult}` });
  await touchLastActive(name, ppath, "backup");
  return {
    ok: true, project: name, bundle, head: head.slice(0, 8), push: pushResult,
    dirtyWarning: dirty ? "Forced backup of a DIRTY tree: uncommitted/untracked changes were NOT captured in the bundle." : null,
  };
}

export async function restore(args: { project: string; dest?: string }) {
  const cfg = getConfig();
  if (!args.project) return { ok: false, message: "project name required" };
  const reg = loadRegistry();
  const entry = reg.projects[args.project];
  const dest = args.dest ? path.resolve(args.dest) : entry?.path ? path.resolve(entry.path) : null;
  if (!dest) return { ok: false, message: "no --dest given and project is not in the registry" };
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
    return { ok: false, message: `dest '${dest}' exists and is not empty — choose an empty directory` };
  }
  const bundle = path.join(cfg.bridgeHome, "backups", `${args.project}.bundle`);
  let how: string;
  if (fs.existsSync(bundle)) { cloneFrom(bundle, dest); how = `cloned from bundle ${bundle}`; }
  else if (entry?.remote) { cloneFrom(entry.remote, dest); how = `cloned from remote ${entry.remote}`; }
  else return { ok: false, message: `no bundle at ${bundle} and no remote configured for '${args.project}'` };

  if (entry) await upsertRegistry({ ...entry, path: dest });
  ledgerAppend({ project: args.project, action: "restore", note: how });
  await touchLastActive(args.project, dest, "restore");
  return { ok: true, project: args.project, dest, how };
}

// ---------------------------------------------------------------------------
// Ledger view (dashboard feed)
// ---------------------------------------------------------------------------

export async function recent(args?: { limit?: number; project?: string }) {
  const all = ledgerReadAll(Math.max(args?.limit ?? 50, args?.project ? 2000 : 50));
  const filtered = args?.project ? all.filter((e) => e.project === args.project) : all;
  const limited = filtered.slice(-(args?.limit ?? 50));
  return { count: limited.length, entries: limited };
}
