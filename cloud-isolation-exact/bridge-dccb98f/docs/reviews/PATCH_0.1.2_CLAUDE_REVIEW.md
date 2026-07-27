# Bridge 2.0 Patch 0.1.2 — Independent Claude Code Review

Status: COMPLETE
Reviewer lane: `claude_desktop_code`
Bridge task: `t1-hl3k`
Date: 2026-07-14
Scope reviewed: complete uncommitted delta from tag `v0.1.1` (compatibility
cutover patch `0.1.2`), read-only. No custody evidence, case facts, credentials,
browser state, or runtime audit contents were inspected.

## Verdict

- **Reversible cutover: PASS** (conditional — see conditions below). No blockers found.
- This review authorizes nothing beyond the reversible local entrypoint cutover.
  It does **not** authorize permanent deletion of Bridge 1.x, GitHub publication,
  cloud/remote deployment, product implementation, or a contract freeze.
- Disposition on the code delta: **accept with follow-up hardening**. The eight
  residual items below are hardening/documentation, not merge blockers.

## Files reviewed

`migrations/002_legacy_coordination.sql`, `src/v2/compat/legacy-core.ts`,
`src/v2/compat/lanes.ts`, `src/server.ts`, `src/v2/cli/main.ts`,
`src/v2/storage/journal.ts` (+ supporting `src/v2/storage/store.ts`),
`contracts/v0.1.0-draft.3/schemas/event.schema.json`,
`contracts/v0.1.0-draft.3/examples/event.compatibility.valid.json`,
`test/runtime/legacy-compatibility.test.mjs`,
`test/runtime/legacy-claim-worker.mjs`, `test/contract/schemas.mjs`,
`test/mcp-smoke.mjs`, migration-number updates in
`test/runtime/runtime-adversarial.test.mjs` and
`test/runtime/runtime-recovery.test.mjs`, and D-022/D-023 plus the
`DRAFT-CONTRACT.md` / `IDENTITY-ROLES-SECURITY.md` amendments.

Evidence claims in the review request (build, 39 inherited checks, connector,
12-schema contract suite, 43 runtime tests, WAL stress, new compat tests) were
**not re-run** in this session — shell/bridge execution is permission-gated here
(see "Process note"). Findings below are from static review of the diff and the
primitives it relies on.

---

## Findings, ordered by severity

### Blockers

**None.** Nothing in the delta blocks the reversible entrypoint cutover.

### High — residual risks to resolve before relying on cross-Claude isolation in production

**H-1. Lane ambiguity collapses two Claude surfaces to one principal with only a
soft, easily-missed warning.**
`resolveLane` (lanes.ts:35–38) resolves a generic `BRIDGE_AGENT=claude` with a
non-disambiguating client name to `claude_desktop_code` **and returns a warning**.
But the warning is surfaced *only* inside the `sync` payload as `laneWarning`
(legacy-core.ts:223); it is **not** printed to stderr at startup (server.ts:202
prints agent/host/home only) and is **not** carried on `claim`/`release`. If the
operator runs both Claude Code and Claude Cowork with `BRIDGE_AGENT=claude`, no
`BRIDGE_LANE`, and client names that don't disambiguate, both resolve to the same
`principal.compat.claude_desktop_code`, and the conflict check
`if (lease.agent === handle.lane) continue;` (legacy-core.ts:244) makes them skip
*each other's* leases — a silent mutual-clobber. Secondary fragility: the
client-name heuristic maps any `claude_desktop` substring to **Cowork**
(lanes.ts:29), which would misclassify a Claude Desktop *Code* client that
presents `claude_desktop`.
- Mitigations already present: `BRIDGE_LANE` is authoritative and overrides
  everything; client-name inference works for the CLI (`code`) and Cowork cases;
  D-022 documents the assumption and the ambiguity warning.
- Recommendation (follow-up hardening): emit the ambiguity warning to **stderr at
  startup**, and/or refuse isolation-dependent operations (`claim`) when the lane
  is ambiguous, or require `BRIDGE_LANE` for any `claude` lane. This is the single
  most important item to close before leaning on Code/Cowork isolation.
- Refs: lanes.ts:28–39, legacy-core.ts:244, server.ts:27–31,202.

**H-2. Project-path aliasing (junctions/symlinks) is not canonicalized, so one
project reachable by two spellings yields two isolated lease spaces.**
`filesystemKey` (legacy-core.ts:1378–1381) normalizes case and separators but does
**not** resolve reparse points (no `realpath`). By contrast, the state-file guard
`canonicalStateFilePath` *does* call `fs.realpathSync.native` and rejects symlinked
state dirs (store.ts:363–380) — so the authors clearly know about reparse points
but deliberately canonicalize only state paths, not project paths. Consequence: a
project opened via a directory junction and via its real target produces two
different `pathKey`s → two state directories (the collision-safe suffix at
legacy-core.ts:1056–1066) → two independent `legacy_file_leases` spaces. Agents on
different spellings never see each other's leases. The collision suffix makes this
*isolate-not-corrupt*, but the failure direction (leases silently **not** shared)
is the dangerous one for an anti-clobber tool.
- This is directly relevant because the cutover strategy is junction-based (D-023).
  The cutover junction is on the *connector/server* path, not project paths, so it
  does not itself trigger this — but `BRIDGE_PROJECT`/cwd given as a junction would.
- Recommendation: canonicalize project paths via `realpath` in `filesystemKey`
  (with a Windows junction test), or explicitly document that `BRIDGE_PROJECT` must
  be the canonical path and that aliased project paths are unsupported.
- Refs: legacy-core.ts:1378–1381 vs store.ts:363–380; stateDirectory
  legacy-core.ts:1044–1067.

### Medium

**M-1. Re-import can overwrite newer control state (no generation/timestamp guard).**
`importLegacyProject` writes `legacy_control` with `ON CONFLICT(project_id) DO
UPDATE` and **no** guard (legacy-core.ts:790–808). Session import is guarded by
`!activeSession` (810) and task import by a collision invariant (835–847), but
control is unconditionally overwritten. If an edited legacy `state.json` (new
source hash) is re-imported after the operator has already handed off control
inside Bridge 2.0, the newer control value is clobbered back to the legacy value.
Import is a one-shot, owner-run migration command, so likelihood is low, but the
guard asymmetry should be closed (skip/guard control if a newer
`collaboration.command_recorded` exists, or by `updated_at`).
- Refs: legacy-core.ts:740–808.

**M-2. Audit asymmetry: predictable backup/restore failures are not journaled, even
when a project DB is open.** `backup()` opens the project runtime
(legacy-core.ts:680) and then early-returns for git-missing / not-a-repo /
no-commits / dirty **without** `recordCommand` (681–693); only the success path
journals (699–707). `restore()` failures similarly return unaudited (718–726).
Successful backup/restore *are* audited. For a coordination system, a refused
backup is a meaningful operational fact worth an immutable record.
- Refs: legacy-core.ts:679–738. See Q9 for the projectless-operation nuance.

### Low / minor

**L-1. Compat commands are not idempotency-protected.** `recordCommand` →
`journal.append` bypasses `store.mutateIdempotent` (legacy-core.ts:1324–1365;
cf. store.ts:152). `bridge_claim`/`release`/`handoff`/`set_boss` are naturally
idempotent, but a retried `bridge_task_add` mints a fresh `task.legacy` id
(legacy-core.ts:436) → duplicate task, and `bridge_log` appends a duplicate event.
This matches Bridge 1.x semantics (no regression) but is worth noting for a
transport that may retry.

**L-2. Unbounded compat-session growth.** Each server process derives a new
per-process compat session (keyed on the per-process `cfg.sessionId`,
legacy-core.ts:1164–1190) and none are ever reaped, so `sessions` grows one row per
process per lane. Housekeeping only.

**L-3. Ten-year bootstrap owner session.** The local owner session is minted with a
~10-year expiry (legacy-core.ts:1117) so compat principals can piggyback on it.
Acceptable for a local single-user stdio tool, but it must never be exposed via a
networked transport. Note only.

**L-4. Contract version-id drift.** `event.schema.json` content changed while the
`schemaVersion` const stays `0.1.0-draft.3` (see Q10). Acceptable for an unfrozen,
owner-directed draft; recommend advancing to draft.4 before any freeze so two
different schema bodies never share one version id.

---

## Strengths confirmed (why the blockers list is empty)

- **Serialized writers.** `transaction()` = `BEGIN IMMEDIATE` + `busy_timeout=5000`
  + `synchronous=FULL` + a nesting guard (store.ts:116–146, 70–76). The claim
  conflict-check and lease inserts run in one IMMEDIATE transaction
  (legacy-core.ts:237–310); expiry filters on generation (1278–1312). The
  two-process worker test asserts exactly one winner (legacy-compatibility.test.mjs
  :164–198).
- **Runtime schema enforcement, not just contract tests.** `journal.append` runs
  both `requireExactKeys` and `schemas.validateNamed("event.schema.json", event)`
  before insert (journal.ts:143,173). Because the new `legacyCommandRequest` /
  `legacyCommandOutcome` `$defs` are `additionalProperties:false` at every level
  (event.schema.json:490–635), forbidden content (`secret`, `rawContents`) is
  rejected at runtime, not merely by the contract suite.
- **Durable, crash-safe, hash-chained audit mirror.** The JSONL projection is
  flushed after commit under its own IMMEDIATE loop with replay repair and a full
  prefix re-verification (store.ts:262–350). The compat test asserts
  `events == audit_mirror_entries(file_appended=1) == JSONL lines`
  (legacy-compatibility.test.mjs:83–91).
- **Immutable lease/import history.** Triggers permit only `active →
  released/expired` with every other column unchanged, and forbid any update/delete
  of import rows (002_legacy_coordination.sql:104–136).
- **Per-project singleton DB.** `singleton_project_database_required`
  (store.ts:126) plus collision-safe state dirs keep each project's coordination
  physically isolated.
- **Backup/restore stay inside the approved Drive/GitHub split.** Bundles capture
  committed refs only, land in the Drive recovery root, never push to GitHub
  (`"push: GitHub publication owner-deferred"`), refuse a dirty tree unless forced
  with a warning, and restore only into an empty directory
  (legacy-core.ts:679–738).
- **Import is non-destructive to source.** It refuses when any live lease exists
  (legacy-core.ts:750–753), never imports leases, and writes only to the Bridge 2.0
  state root — it does not touch the source workspace.

---

## Answers to the ten required red-team questions

**Q1 — Can two SQLite processes both acquire overlapping leases despite
`BEGIN IMMEDIATE` / normalization / generation / fencing?**
No, provided every writer goes through `transaction()`. `BEGIN IMMEDIATE`
(store.ts:118) takes the single WAL write lock at transaction start, so the second
claimant blocks (up to `busy_timeout=5000`, else fails closed with `SQLITE_BUSY`)
until the first commits, then reads the winner's now-active lease and returns a
conflict (legacy-core.ts:241–261). Overlap uses the shared `pathsOverlap` on
platform-normalized `path_key`s; generation mismatch and expiry both demote leases
(1278–1312); fencing tokens are monotonic per project (263–274). The application
conflict check — not a DB constraint — is what prevents cross-session overlap, so
the guarantee is exactly as strong as "all mutations use `transaction()`," which
they do. The two-process race test confirms 1 grant / 1 deny.

**Q2 — Can Code and Cowork collapse to one principal or bypass each other under any
documented configuration?**
Yes, under one documented-but-under-guarded configuration: `BRIDGE_AGENT=claude`,
no `BRIDGE_LANE`, and a client name that does not disambiguate. Both then resolve
to `claude_desktop_code` and share `principal.compat.claude_desktop_code`, so the
`lease.agent === handle.lane` skip lets them bypass each other (see H-1). With
`BRIDGE_LANE` set (as every test and the documented cutover do), the three
principals stay distinct — the compat test proves Code, Cowork, and Codex remain
separate lease owners (legacy-compatibility.test.mjs:30–62). D-022 records the
assumption that lanes are disambiguated; my objection is that the collapse is
**silent** (soft field-level warning only). Recommendation in H-1.

**Q3 — Does any accepted compatibility mutation lack a complete immutable event +
audit mirror projection, or leak excluded content classes?**
No leak, and no unmirrored mutation. Every accepted command calls `recordCommand`
→ `journal.append`, which requires a configured mirror path
(`audit_mirror_path_required`, journal.ts:141), validates the full envelope against
`event.schema.json` at runtime (173), and writes both the `events` row and a
hash-chained `audit_mirror_entries` row flushed to JSONL (store.ts:262–350).
`additionalProperties:false` on request/outcome/nested activities blocks excluded
content classes at runtime. One gap worth noting (M-2): predictable *failure* paths
of backup/restore are not journaled even when the DB is open — so "every accepted
mutation" is fully covered, but "every predictable outcome" is not.

**Q4 — Can legacy import overwrite newer state, import a live lease, mutate source
workspaces, or place runtime/case data in Git?**
- Live lease: no — import aborts if any lease has `expires > now`
  (legacy-core.ts:750–753) and never inserts leases.
- Mutate source: no — the import path uses `openResolved` (not
  `registerProject`), so it writes no `.gitignore`/repo into the source; it writes
  only to the Bridge 2.0 state root.
- Runtime/case data in Git: no — state lives in `BRIDGE2_HOME`; source bundles
  capture committed refs only and are never pushed.
- Overwrite newer state: **partially yes** — control is overwritten without a
  freshness guard on re-import of a mutated registry (M-1). Sessions (guarded by
  `!activeSession`) and tasks (collision invariant) are safe. Import is idempotent
  per `(project, source_kind, source_hash)` (782–787).

**Q5 — Can project-path resolution bind a command to the wrong per-project DB
(basename collisions, junctions, omitted `project`)?**
- Basename collisions: handled — same-basename projects get distinct,
  content-addressed state dirs (legacy-core.ts:1044–1067), proven by test
  (legacy-compatibility.test.mjs:124–162).
- Omitted `project`: falls back to `config.project` then cwd with `guessed=true`
  and a `projectWarning` in the sync payload (legacy-core.ts:986–1000, 220–222) —
  soft-guarded.
- Junctions/symlinks: **not** canonicalized (H-2). Two spellings of one project →
  two DBs → independent lease spaces. This is the real weakness in path
  resolution. It does not misbind to the *wrong* project so much as fail to
  *unify* the same project across aliases — a silent isolation, not a
  cross-contamination.

**Q6 — Does migration 002 preserve forward-only/backup requirements and immutable
lease/import history?**
Yes. 002 is purely additive DDL at schema version 2; it introduces the immutability
triggers (002:104–136). Forward-only enforcement is inherited and re-proven by the
renumbered tests (runtime-adversarial 003/004 synthetic; runtime-recovery expecting
`MAX(version)=3` for the packaged N+1). Crucially, the facade does **not** silently
migrate existing databases: for an existing DB it opens with `initialize:false`
and throws `legacy_coordination_migration_required` if 002 is pending
(legacy-core.ts:897–902), forcing the operator through the backup-gated
`migrate` path. Fresh DBs apply 002 at initialization (no data to back up). Lease
and import history are immutable via triggers; current-state tables (control,
session, tasks) remain mutable projections, which is appropriate.

**Q7 — Is the junction cutover/rollback actually reversible while both Codex and
Claude use the historical `dist/server.js` path?**
Yes, with conditions. The historical path is preserved by a reversible directory
junction (D-023); Bridge 1.x source is *renamed intact*, not deleted; the Bridge
2.0 git checkout and `BRIDGE2_HOME` state are separate trees; rollback = remove
junction + restore the old name. The two state models don't collide (Bridge 1.x
uses `.connector/state.json`; Bridge 2.0 uses per-project SQLite). Conditions I
attach:
  1. The actual junction+rollback script is deferred and must be tested on the real
     Windows host with no Bridge process holding the old directory open (the D-023
     assumption).
  2. Rollback restores the **entrypoint** but not **coordination state created
     during the Bridge-2.0 window** — post-cutover leases/control/tasks live only
     in SQLite and are not written back to `.connector/state.json`, so a rollback
     silently loses interim coordination. Acceptable, but must be acknowledged
     operationally.
  3. Resolve/accept H-1 and H-2 before relying on cross-Claude isolation
     post-cutover.

**Q8 — Do backup/restore aliases violate the approved GitHub/Drive split or owner
approval boundaries?**
No. `backup` writes a git bundle to the Drive-based recovery root, explicitly does
**not** push to GitHub (`"push: GitHub publication owner-deferred"`,
legacy-core.ts:713), refuses a dirty tree unless `force` (and then warns it
captured committed refs only), and takes no owner-approval-gated action. `restore`
only clones a bundle into an empty destination (718–738). No publication, deletion,
or e-sign/outbound action is performed. (Minor: the recovery root default hardcodes
the owner's Drive path, legacy-core.ts:1373–1376 — consistent with the owner env,
not a boundary violation.)

**Q9 — Are project-discovery/history reads and predictable backup/restore failures
required in the audit mirror, and if so where should projectless operations be
journaled without a second authoritative DB?**
My assessment:
  - Pure cross-project **reads** (`listProjects`, `recent`) legitimately need not
    be journaled, and there is no single project to journal them to.
  - Predictable **backup failures** *should* be journaled, because `backup()` has
    already opened the resolved project's DB (legacy-core.ts:680) — the record has
    a home. That is the concrete, fixable half of M-2.
  - Truly **projectless** operations (unregistered `restore`, cross-project
    discovery) have no authoritative DB and, by the design constraint of "no second
    authoritative database," genuinely cannot be journaled without violating that
    constraint. The right resolution is to (a) journal resolvable failures on the
    project DB, and (b) explicitly **document** that projectless discovery/history
    reads and unregistered-restore failures are intentionally unaudited — rather
    than introduce a host-level ledger. I do **not** recommend a second store.

**Q10 — Is revising the unfrozen `v0.1.0-draft.3` event schema in place acceptable,
or should the draft advance?**
Acceptable for this patch. The draft is explicitly unfrozen and owner-directed, the
change is purely additive (a new event type + two `$defs`), and the example/reject
cases give good coverage (event.compatibility.valid.json; schemas.mjs:88–92). My
one caution (L-4): the `schemaVersion` const stays `0.1.0-draft.3` while the schema
body changed, so two different bodies now share one version id — fine while
drafting, but the draft should advance to draft.4 before any freeze. I am **not**
authorizing a freeze.

---

## Explicit disagreements / points of divergence from the patch authors

1. **Silent lane collapse (H-1/Q2).** I disagree with treating a soft `laneWarning`
   in the `sync` payload as sufficient protection for Code/Cowork isolation. For an
   anti-clobber tool, an ambiguous identity that silently *shares* a lease owner is
   a fail-open. I would gate `claim` (or startup) on an unambiguous lane. This is a
   design-strength disagreement, not a defect claim.
2. **Path aliasing (H-2/Q5).** I disagree with canonicalizing state paths via
   `realpath` (store.ts:378) while leaving project paths un-canonicalized. The
   asymmetry is deliberate but, in my view, incomplete for the anti-clobber
   guarantee.
3. **Failure-path auditing (M-2/Q9).** I read the "complete audited command
   outcomes" goal as reasonably including predictable backup failures where a
   project DB is already open. The authors journal successes only. Preference-
   leaning, but I'd close the resolvable half.

All three are preserved here as durable disagreements; none is a merge blocker.

## Residual risks (accepted, to track)

- R-1: Cross-Claude isolation depends on operator discipline (`BRIDGE_LANE`) until
  H-1 is closed.
- R-2: Aliased project paths silently fork coordination state until H-2 is closed.
- R-3: Re-import of a mutated legacy registry can clobber newer control (M-1).
- R-4: Rollback loses coordination performed during the Bridge-2.0 window (Q7.2).
- R-5: Backup/restore predictable failures and projectless reads are unaudited
  (M-2/Q9).
- R-6: Non-idempotent `task_add`/`log` under transport retries (L-1).

## Blockers vs follow-up hardening

- **Blockers:** none.
- **Follow-up hardening (recommended, not gating):** H-1, H-2, M-1, M-2, and the
  documentation of Q7.2 / Q9 semantics. L-1..L-4 are optional polish.

## Reversible cutover decision

**PASS**, conditional on: (a) testing the actual junction+rollback script on the
real Windows host with no Bridge process holding the old directory open; (b)
operationally acknowledging that rollback preserves the entrypoint but not
post-cutover coordination state; and (c) treating H-1 and H-2 as required hardening
before leaning on cross-Claude lease isolation in day-to-day use. The patch keeps
Bridge 1.x intact and offline-recoverable, isolates Bridge 2.0 state, performs no
publication/deletion/outbound action, and preserves immutable, mirrored audit for
every accepted command.

This review makes no implementation handoff and does not authorize permanent
deletion of Bridge 1.x, GitHub publication, cloud/remote deployment, product
implementation, or a contract freeze.

## Process note

The bridge MCP tools and the `bridge` CLI were permission-gated in this session, so
`bridge_sync`, `bridge_claim`, `bridge_log`, `bridge_task_update`,
`bridge_release`, and `bridge_handoff` could not be executed from here; only
individually-approved read-only `git` commands ran. The scoped handoff for task
`t1-hl3k` (review only `docs/reviews/PATCH_0.1.2_CLAUDE_REVIEW.md`) was honored: no
implementation, schema, test, existing-doc, or `.connector` file was modified. The
operator/Codex should record the equivalent bridge bookkeeping:
`bridge log --files docs/reviews/PATCH_0.1.2_CLAUDE_REVIEW.md`,
`bridge task update t1-hl3k done`, release the file, and hand control back to codex.
