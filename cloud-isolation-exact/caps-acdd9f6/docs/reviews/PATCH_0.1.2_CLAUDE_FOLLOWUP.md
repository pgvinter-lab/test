# Bridge 2.0 Patch 0.1.2 — Independent Claude Code Follow-up Review

Status: COMPLETE
Reviewer lane: `claude_desktop_code`
Bridge task: `t2-ci1v`
Date: 2026-07-14
Scope: verification only of the disposition and implementation of H-1, H-2, M-1,
M-2, Q7.2, and Q9 from `PATCH_0.1.2_CLAUDE_REVIEW.md` /
`PATCH_0.1.2_CLAUDE_DISPOSITION.md`. Read-only. No broad re-review, no custody
material, credentials, browser state, runtime audit contents, or legal material
were inspected.

## Verdict

- **Closure of the accepted findings (H-1, H-2, M-1, M-2, Q7.2, Q9): PASS.**
  Every accepted finding is implemented in code, exercised by a test that asserts
  the specific corrected behavior, and documented in the contract/decision text.
- **Reversible cutover: remains PASS**, unchanged and still conditional on the
  same three operational conditions from the original review (junction/rollback
  script tested on the real Windows host; rollback preserves the entrypoint but
  not post-cutover coordination state; H-1/H-2 treated as required before leaning
  on cross-Claude isolation — the first two are now the *only* live conditions,
  since H-1 and H-2 are closed here).
- This review authorizes nothing further. It does **not** authorize permanent
  deletion of Bridge 1.x, GitHub publication, cloud/remote deployment, product
  implementation, or a contract freeze.

### Evidence basis and one process caveat

Determinations below are from static inspection of the current
`src/v2/compat/legacy-core.ts`, `src/v2/compat/lanes.ts`, `src/server.ts`, the
full `test/runtime/legacy-compatibility.test.mjs`, and the D-022/D-023 +
`DRAFT-CONTRACT.md` / `IDENTITY-ROLES-SECURITY.md` amendments. I read each test
in full and confirmed it asserts exactly the behavior each determination
requires. **Test execution and `npm run build` were permission-gated in this
session** (as in the prior review), so I did not re-run the green suite; the
`7/7` / `45/45` / `12-schema` pass claims in the request are asserted by the
disposition and *not independently re-executed here*. My PASS is therefore on
"the implementation is correct and the tests are correctly designed to prove it,"
not on a re-observed green run. This is the single caveat on an otherwise
unqualified PASS.

---

## Required determinations

### 1. Does ambiguous generic Claude identity now fail closed for file claims while preserving diagnostic sync access and explicit Code/Cowork operation? — YES

- **Fail-closed claim.** `claim()` checks `handle.laneAmbiguous` *before* any lease
  logic (`legacy-core.ts:238-252`): it records a `denied` `bridge_claim` outcome in
  its own transaction and returns `ok:false` with the `Set BRIDGE_LANE` message,
  inserting **no** lease row. The denial is audited, not silent.
- **Diagnostic sync preserved.** `sync()` never inspects `laneAmbiguous`; it returns
  the ambiguity as a soft `laneWarning` field (`legacy-core.ts:224`) and completes
  normally. An ambiguous session can observe control/leases/tasks but cannot mutate.
- **Explicit lanes operate.** `resolveLane` returns `ambiguous:false` whenever
  `BRIDGE_LANE` is set (`lanes.ts:23-24`) or the client name disambiguates
  (`lanes.ts:30-35`); those handles skip the gate entirely.
- **Startup stderr diagnostic.** `server.ts:204-206` writes the lane warning to
  stderr at connect time in addition to the sync payload — closing the original
  H-1 objection that the warning lived only inside `sync`.
- **Prior secondary fragility is resolved.** The original review flagged that a
  `claude_desktop` substring mapped to Cowork; the heuristic now keys Cowork on the
  `cowork` substring and Code on `code`/`cli` (`lanes.ts:30-35`), so a generic
  `claude-desktop` handshake now falls through to the ambiguous branch (the safe
  direction) rather than being misclassified.
- **Test coverage.** `legacy-compatibility.test.mjs:129-161` drives a genuinely
  ambiguous `resolveLane({configuredAgent:"claude", clientName:"claude-desktop"})`,
  asserts `sync` still returns `laneWarning`, asserts `claim` returns `ok:false`
  with the `Set BRIDGE_LANE` message, and asserts `legacy_file_leases` count is `0`
  and the last recorded event is a failed `bridge_claim`. The
  Code-vs-Cowork-stay-distinct assertion at lines 48-51 confirms explicit lanes are
  not collapsed.

### 2. Do real paths and junction/symlink aliases now resolve to one project identity and one lease space without breaking same-basename isolation? — YES

- **Single canonicalization chokepoint.** `canonicalProjectPath()`
  (`legacy-core.ts:1439-1447`) resolves through `fs.realpathSync.native`, with an
  `ENOENT` fallback to the plain-resolved path. Both `filesystemKey()`
  (`:1424-1427`, the identity/`pathKey`) and `stateSlug()` (`:1429-1437`, the
  state-dir name) flow through it, removing the state-vs-project asymmetry the
  original H-2 objected to.
- **Aliases unify.** A junction and its target now produce the same `pathKey` → the
  same state directory → one `legacy_file_leases` space. Test
  `legacy-compatibility.test.mjs:203-234` creates a real Windows junction, has Codex
  claim on the real path and Cowork claim an overlapping child on the alias, asserts
  the alias claim is **denied** (`heldBy: "codex"`), and asserts exactly **one**
  project state directory exists.
- **Same-basename isolation intact.** `stateDirectory()` still appends a
  content-addressed suffix derived from the (now canonical) `pathKey` on collision
  (`:1096, :1103, :1106`), and the binding invariant `legacy_project_binding_conflict`
  (`:988`) rejects a mismatched path key. Test `:163-201` proves two distinct
  `Shared Name` projects still get two distinct state dirs and two manifests.
- **Residual (minor, acceptable):** the `ENOENT` fallback means aliases only unify
  once the path exists on disk. For all real coordination operations the working
  tree exists, so this does not weaken the guarantee in practice; worth a one-line
  note only. Symlink handling *within* a tree (sub-path claims) is unchanged and out
  of scope for project-identity unification.

### 3. Is legacy control import now seed-only and unable to overwrite newer Bridge 2.0 control on a changed-source re-import? — YES

- **Seed-only INSERT.** `importLegacyProject()` writes `legacy_control` with
  `ON CONFLICT(project_id) DO NOTHING` and derives `controlImported` from
  `inserted.changes === 1` (`legacy-core.ts:833-847`). This replaces the original
  unconditional `DO UPDATE` that M-1 flagged. Sessions remain guarded by
  `!activeSession` (`:849`) and tasks by the collision invariant (`:874-886`), so
  the guard asymmetry the review noted is closed.
- **Test coverage.** `legacy-compatibility.test.mjs:272-326` imports once, hands off
  control to Cowork inside Bridge 2.0, mutates the legacy `state.json` control to
  `codex`, re-imports (new source hash ⇒ `imported:true`), and asserts control is
  **still** `claude_desktop_cowork` and that the second import's
  `outcome.controlImported === false`. This is a direct proof that newer Bridge 2.0
  control survives a changed-source re-import.

### 4. Are all predictable backup/restore outcomes audited when a project database is resolvable, without adding a second authoritative store? — YES

- **Backup.** `backup()` routes every early-return through a `failed()` helper that
  opens a transaction and calls `recordCommand(..., "failed")`: git-missing (`:707`),
  not-a-repo (`:708`), no-commits (`:710`), dirty-without-force (`:712-718`), and
  bundle failure (`:724-726`) are all journaled; success is journaled at `:730-735`.
- **Restore.** Symmetric `failed()` helper (`:753-760`) journals dest-not-empty
  (`:762`), missing-bundle (`:765`), and clone failure (`:768-769`); success at
  `:772-777`. The one unaudited path is the *unregistered* project (`!manifest`,
  `:749`) — which is the intentional Q9 case, not a resolvable one.
- **No second store.** All failure records are appended to the *same* per-project
  runtime journal via `recordCommand` → `journal.append`; no host-level database is
  introduced.
- **Test coverage.** `legacy-compatibility.test.mjs:116-117` asserts the events
  table contains a `bridge_backup` and a `bridge_restore` event each with
  `outcome.ok === false` (both fail in the fixture: not-a-repo / no-bundle),
  confirming failure paths are journaled when the DB is resolvable.

### 5. Are rollback state-loss and intentionally unaudited projectless operations accurately documented and preserved as limitations? — YES

- **Q7.2 (rollback state loss).** `DECISION_REGISTER.md` D-023 (lines 545-548)
  records that the junction switch is reversible but "rollback does not copy
  Bridge 2.0 control, task, or lease changes back into Bridge 1.x JSON state,"
  accepted for the short validation window and required to be stated in the cutover
  record. Accurate to the implementation (post-cutover state lives only in SQLite).
- **Q9 (projectless / unregistered-restore unaudited).** `DRAFT-CONTRACT.md`
  (lines 224-227) states resolvable backup/restore failures are journaled while
  "Projectless discovery reads and unregistered-restore failures remain
  intentionally unaudited because this design has no host-level authoritative
  database." This matches `restore()`'s unaudited `!manifest` return (`:749`) and
  the pure-read `listProjects`/`recent`. D-022 and `IDENTITY-ROLES-SECURITY.md:14-25`
  additionally document the fail-closed lane rule and canonical-real-path identity.

---

## Remaining findings

No new blockers and no regressions in the six reviewed items. The following are
carried forward from the original review and remain correctly dispositioned; none
gates the reversible cutover:

- **R-Q7.2 (accepted limitation).** Rollback preserves the entrypoint, not
  coordination created during the Bridge-2.0 window. Must appear in the cutover
  record (D-023). Unchanged.
- **R-Q9 (accepted limitation).** Projectless discovery reads and
  unregistered-restore failures are intentionally unaudited (DRAFT-CONTRACT
  224-227). Unchanged.
- **N-1 (new, minor — H-2 edge).** `canonicalProjectPath` falls back to the
  non-realpath resolution on `ENOENT` (`legacy-core.ts:1444`); alias unification
  therefore requires the path to exist at resolution time. Harmless for real
  working trees; note-only, not a defect.
- **L-1..L-4 (deferred).** Non-idempotent legacy `task_add`/`log`, unbounded
  compat-session rows, the ten-year bootstrap session, and the `schemaVersion`
  draft.3-in-place drift remain deferred exactly as the disposition records. L-4
  is still a pre-freeze obligation (advance to draft.4 before any freeze so two
  schema bodies never share one frozen version id). None gates this patch.

## Preserved disagreement

The original review's three durable disagreements (silent lane collapse,
project-path canonicalization asymmetry, failure-path auditing) are **resolved by
this patch**, not merely re-argued: fail-closed audited claim denial (H-1),
single-chokepoint real-path canonicalization for both identity and slug (H-2),
and journaled resolvable backup/restore failures (M-2). I record no *new* material
disagreement. My only reservation is procedural, not substantive: the green-suite
evidence was not re-executable in this permission-gated session (see caveat
above), so closure is verified at the level of implementation + test design rather
than a re-observed run.

## Authorization boundary

This artifact makes no implementation handoff and authorizes nothing beyond
confirming closure of the six reviewed items and the continued PASS of the
reversible local entrypoint cutover. It does **not** authorize permanent deletion
of Bridge 1.x, GitHub publication, cloud/remote deployment, product
implementation, or a contract freeze.

## Bridge bookkeeping (permission-gated — Codex to record)

The `bridge` MCP tools and CLI were permission-gated in this session, so
`bridge_sync`, `bridge_claim`, `bridge_log`, `bridge_task_update`,
`bridge_release`, and `bridge_handoff` could not execute from here. Only the one
review file was written; no source, schema, test, existing doc, or `.connector`
file was modified. Codex should record the equivalent bookkeeping for task
`t2-ci1v`:

- `bridge log --files docs/reviews/PATCH_0.1.2_CLAUDE_FOLLOWUP.md` — "Independent
  follow-up review: H-1/H-2/M-1/M-2/Q7.2/Q9 closure PASS; reversible cutover
  remains PASS (conditional)."
- `bridge task update t2-ci1v done`
- `bridge release docs/reviews/PATCH_0.1.2_CLAUDE_FOLLOWUP.md`
- `bridge handoff --to codex --note "Follow-up review complete; closure PASS,
  cutover PASS. No new authorization granted."`
