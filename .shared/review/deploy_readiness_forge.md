# Deployment-Readiness Review — The Forge Orchestration System

**Verdict: NO-GO** — One confirmed BLOCKER (identity-vocabulary mismatch silently drops Cowork results at the watcher filter) plus a wall of MAJOR integration, race, and unenforced-gate defects. Reviewed at commit `466e5ee` (branch `claude/cross-system-workspace-design-6cffre`).

---

## Review provenance & method

- **Produced by** an adversarial multi-agent review: 9 dimension reviewers (read-only) → each finding independently refuted at its `file:line` → deduped/severity-ranked synthesis. 76 agents, 66 raw findings before dedup. Every reviewer was instructed to find what *breaks*, not what works, and to default to refuting its own findings.
- **Scope:** all of `agents/` (`event_schema.md`, `watch_cowork.py`, `watch_codex.py`, `dispatch_to_cowork.sh`, `dispatch_to_codex.sh`, `orchestrator_playbook.md`, `bridge_up.sh`, `start/stop_watchers.{sh,ps1}`) plus `PROTOCOL.md`, `AGENTS.md`, and the producer `.claude/skills/work-with-codex-to/{SKILL.md,scripts/finalize_task.py}`.
- **Read-only.** No controller/contract file was edited; no fix was applied. This report is the only artifact written.
- **Lead verification:** I independently re-checked the load-bearing claims at the cited lines before accepting them: `watch_cowork.py:213` (`actor != "cowork"`), `PROTOCOL.md:18` ("You are `claude` or `codex`"), and `.shared/log.jsonl` (live entries use `from:"claude"`/`agent:"claude"`/`agent:"claude+codex"` — **never** `cowork`). The BLOCKER reproduces from the workspace's own existing data.

### ⚠️ Concurrency caveat (this matters for several findings)

**The working tree was being mutated by another session *during* this review.** `.claude/skills/work-with-codex-to/scripts/finalize_task.py` did not exist when this turn began (verified absent by `find`/`ls`), then appeared mid-review (mtime `Jun 21 18:06`, 4375 B, executable). `PROTOCOL.md` also carries uncommitted churn. Therefore any finding about a file's *presence* is a point-in-time observation, not a stable fact. Re-confirm presence/wiring immediately before deploy.

### Lead-reviewer corrections to the automated synthesis

1. **`finalize_task.py` exists but is UNTRACKED in git** (`git ls-files` → not tracked; not on `origin`). The synthesis treats it as "exists / un-wired." Stronger truth: **a fresh Bridge clone or `git pull` from origin will not contain it at all.** Since it is the *only* writer of `inbox.code.jsonl` (the doorbell), a from-origin deploy has **no return-leg producer whatsoever** — this elevates F2/F3 from "un-wired" toward a second effective BLOCKER for any clean-clone deploy. Tracked as **F2/F3 + this caveat**; flagged because whether it is committed before The Bridge pulls is external state I must not assume.
2. The synthesis's "Considered and dismissed" section refutes several earlier findings *because* `finalize_task.py` exists — those refutations are only valid **once that file (and the `.shared/` seeds) are committed and pulled.** Until then, the dismissed "loop is unbuilt" findings partially re-apply on a clean clone.

Everything below is the synthesized, dedup'd, severity-ranked output, faithful to the automated review and consistent with my spot-checks.

### Addendum — concurrent hardening landed during/after this review (re-verify, do not assume fixed)

While this review was being written, a **parallel Code session pushed `744e90e`** ("Harden dispatch path: rebase-on-push, enforce codex gate, validate events"; `Task: t-20260621-harden-dispatch`) to the same branch — it explicitly acts on "the deploy-readiness reviews." This report's base is `466e5ee`; `744e90e` is now the branch tip. It changed only `agents/dispatch_to_codex.sh`, `agents/dispatch_to_cowork.sh`, and a new `agents/validate_event.py`. Mapping it to my findings (**claims to address — re-verify against `744e90e`'s implementation; I have not deep-reviewed it**):

- **F17 (non-ff push) — likely closed.** `dispatch_to_cowork.sh:142` now `git pull --rebase` + retries on rejection. *Corroborated live:* this very report's first push was rejected non-fast-forward by `744e90e` — exactly F17's condition, now handled.
- **F5/F6 (codex gate) — backstop added for the Codex leg.** `dispatch_to_codex.sh:94-101` now requires `--yes`/`BRIDGE_AUTOCONFIRM` and reads `/dev/tty`, refusing unattended full-access Codex. The mechanical backstop F5 demanded now exists for the dangerous leg. (`dispatch_to_cowork` push remains default-on — policy-sanctioned per PROTOCOL push-everything, as noted in F5.) Re-verify the `-C "$REPO"` live-tree exposure (F6) is still present.
- **Return-relay caveat / F30 — documented, not closed.** Adds a loud "MANUAL RELAY" notice after push, acknowledging nothing auto-wakes Cowork. Surfaces the open hop rather than closing it (correct for v1).
- **Correctness — improved.** `dispatch_to_codex` no longer treats exit-0-empty-output as a `result` (false-convergence guard), and new `agents/validate_event.py` enforces the 7-key/enum contract the playbook only described. NB: `validate_event.py` checks a *formed* event's enums; it does **not** fix **F4** (unknown `status`→`progress` happens upstream in the watcher and yields a *valid* `progress` event the validator passes).

**Still OPEN as of `744e90e`** (its diff touched none of the sensor/producer/identity layer):
- **F1 (the BLOCKER) — UNTOUCHED.** `watch_cowork.py`/`finalize_task.py` were not modified; `actor:"claude"` results are still silently dropped. **Verdict remains NO-GO.**
- **F2/F3 + untracked-producer caveat** — `finalize_task.py` still untracked/un-wired.
- **F7** — no `codex exec` timeout added.
- **F8–F16** — all watcher-side races, cold-start replay, mtime resolution, and PID/launch defects untouched (`watch_*.py`, `start/stop_watchers.*` unchanged).

The control plane is hardening fast; the **sensor, identity, and producer-wiring layers — including the lone BLOCKER — are still open.** Re-run this gate against the live tip before deploy.

---

## Executive summary

The system does not deploy because its central doorbell can silently swallow real work: the actual producer (`finalize_task.py`) accepts `--actor claude`, and the workspace's existing log entries already use `claude`, but both watchers require an exact `actor=="cowork"`/`"codex"` match with a bare `continue` and **no drop log** — so a Cowork/Claude executor that follows the still-unfixed PROTOCOL/SKILL vocabulary (`claude`) is silently discarded end-to-end (F1). Surrounding that blocker is a consistent theme: the working code exists, but the **contract layer is unreconciled and the guarantees are prose, not enforced code.** Identity, trailer, and finalization conventions are split three ways and only partly wired (F2–F4); every safety gate (human-in-loop, irreversible-action confirmation, no-auto-apply) lives in the playbook as instructions an agentic LLM is trusted to honor, with zero mechanical backstop in the actuators (F5–F8); and the idempotency/race surface (shared cursor tmp file, unlocked cursor RMW, unowned stale-lock break, cold-start replay, no codex timeout, cross-runtime PID namespaces) produces duplicate or lost events under realistic conditions (F8–F16). Most MAJORs are individually survivable in the explicitly human-in-the-loop v1, but they compound, and several (cold-start replay, missing finalize wiring, identity drift) fire on the very first run.

**Tally:** 1 blocker, 16 major, 11 minor (+ the untracked-producer caveat above, which is BLOCKER-grade for a clean-clone deploy).

## The seven questions, answered

1. **Correctness (event format):** Mostly sound but lossy at the edges. The normalized event drops `flags_count` (F18), infers `kind` from filename so a review-with-findings looks identical to a clean pass (F19), defaults unknown/out-of-vocabulary status to `progress` which the playbook ignores (F4 — confirmed MAJOR), and fabricates bogus task ids from filename stems for review artifacts lacking a `t-YYYYMMDD` token (F10/F20).
2. **Return trigger — stated plainly:** The loop back to **Code** is **implemented but not closed by construction.** `watch_cowork.py` is a real return trigger (30s `git fetch` poll of `inbox.code.jsonl`) and `finalize_task.py` is a real producer — so the "loop is dead" framing is refuted *given those files are committed*. BUT: (a) the producer is **untracked/not on origin** (lead caveat) and **not wired into SKILL.md Phase 4** (F2); (b) `inbox.code.jsonl` is absent/uncommitted on this branch with no in-repo bootstrap writer (F3); and (c) the **outbound** arm — after `dispatch_to_cowork.sh` pushes `inbox.cowork.jsonl`, **nothing in this repo watches that file.** Delivery to the Cowork cloud surface depends on Cowork's *own* sync. That is correct-by-design for the cloud topology, but **for a solo/local operator there is no automated relay — it is a human or external-sync hop** (F6/F28/F30). Net: the Code-inbound half can be automated once the producer is committed+wired; the Cowork-inbound half is, by design, not closed inside this repo.
3. **Races / idempotency:** Multiple confirmed defects (F8–F16, F21–F22). Shared fixed cursor tmp filename can corrupt the cursor (F8, MAJOR); unlocked cursor read-modify-write clobbers the dispatch pre-seed (F22, MINOR); the stale-lock break is unowned and can let two writers interleave appends or strand a 10s stall (F9, MAJOR); cold-start replays pre-existing review files (F11, MAJOR); raw-byte dedup re-emits on any reformat (F21, MINOR). The stream is documented at-least-once with a content-dedup backstop, which softens but does not eliminate these.
4. **Failure modes:** Several silent-degradation paths. No `codex exec` timeout — a hung Codex wedges the synchronous loop with no signal (F7, MAJOR); corrupt cursor ⇒ full replay flood (F12, MAJOR); `bridge_up` PID-reuse false-positive ⇒ silent total sensor outage shown as a green banner (F13, MAJOR); detached-HEAD ref resolves to `origin/HEAD` and emits nothing forever under a misleading "transient" log (F24, MINOR).
5. **Windows portability:** Real defects. PID namespaces differ between `.sh` (MSYS `$!`) and `.ps1` (Windows PID) so cross-runtime stop kills the wrong process or leaks the watcher (F14, MAJOR — reproduced on this machine); `bridge_up`'s `kill -0` can't reliably see `.ps1`-launched watchers ⇒ duplicate pairs (F13/F15, MAJOR); whole-second mtime signature misses same-second same-size rewrites (F16, MAJOR — reproduced); `start_watchers` (both variants) has no already-running guard and the `.ps1` crashes on locked redirect files (F15, MAJOR); banner points at `.log` while crashes land in `.out`/`.err` (F25, MINOR); nohup detachment on hard window-close is uncertain (F31, MINOR-UNCERTAIN).
6. **Safety / human-in-loop — stated plainly:** **The gate is documented, not enforced.** No dispatch script requires a confirmation token; `git push` and full-access `codex exec --dangerously-bypass-approvals-and-sandbox` fire on a bare invocation (F5, F6). The "orchestrator does not auto-apply Codex changes" promise is unenforceable because Codex runs against the **live working tree** (`-C "$REPO"`) and mutates in place (F6). Enforcement is delegated entirely to an agentic LLM honoring prose, with no mechanical backstop. The scripts are bounded/non-destructive by design (they never force-push or rewrite history), but **"human-in-loop v1" is true only by operator discipline, not in code** — the sole opt-in safety is `--dry-run`, which is *off* by default.
7. **Deploy gaps:** `finalize_task.py` **exists** (writes `inbox.code.jsonl` + refreshes `state.md` + commits `Agent: cowork`) but is **untracked** (lead caveat) and **un-integrated** — SKILL.md Phase 4 still documents the old manual path (F2), and the integration edits sit as unapplied proposals. Trailer conventions are contradictory across PROTOCOL/AGENTS/SKILL/dispatch (F26). `state.md` and `inbox.codex.jsonl` are required reading per AGENTS.md but unseeded on a fresh clone for the direct-Codex entry path (F28). `.shared/` shared subtrees are untracked on this branch (F29, UNCERTAIN — self-heals on the first real finalization push).

## BLOCKERS

### F1. Identity-vocabulary mismatch silently drops Cowork results at the watcher actor filter
- **Where:** `agents/watch_cowork.py:213` (`actor != "cowork"` → bare `continue`, no log); `agents/watch_codex.py:218`; producer `.claude/skills/work-with-codex-to/scripts/finalize_task.py:37,59` (`--actor` choices `["cowork","codex","claude"]`, written verbatim, no normalization); `orchestrator_playbook.md:28`; `PROTOCOL.md:18`; `AGENTS.md:10`; `SKILL.md:164`; `.shared/log.jsonl`  | **Dimensions:** loop-trace, deploy-gaps (cross-confirmed)  | **Confidence:** 0.92 (lead-verified)
- **What breaks:** `finalize_task.py` accepts and writes `actor:"claude"` by design, and every producer-facing doc tells the executor "you are `claude` or `codex`" (`PROTOCOL.md:18`; `SKILL.md:164` commits `Agent: claude`). The workspace's only live `.shared/log.jsonl` entries already use `from:"claude"`/`agent:"claude"`. When a Cowork/Claude executor finalizes with `--actor claude`, `watch_cowork.py:213` rejects it (`!= "cowork"`), emits zero events with **no drop log**, and the orchestrator is never woken. The result is silently lost; the loop dead-ends with no error. No `claude→cowork` normalization exists anywhere in `agents/`.
- **Evidence:** `watch_cowork.py:213-214`: `if str(entry.get("actor","")).strip().lower() != "cowork": continue`. `finalize_task.py:37`: `--actor` … `choices=["cowork","codex","claude"]`; written straight into the inbox entry. `orchestrator_playbook.md:28`: "Producers in the event stream are `cowork` and `codex` only." Live log uses `claude`.
- **Fix:** Pick ONE canonical identity set end-to-end. Minimal: normalize `claude→cowork` in the watcher filter AND constrain `finalize_task.py --actor` to `{cowork,codex}` (drop `claude`), OR map on write. Additionally: **log** (not silently `continue`) any inbox line whose `actor` is non-empty but unrecognized, so drops are visible. Reconcile `PROTOCOL.md:18`, `AGENTS.md:10`, `SKILL.md:164` to the same vocabulary.

## MAJOR

### F2. Finalization producer exists but is untracked + not wired into the documented executor procedure (SKILL.md writes the wrong files/trailer)
- **Where:** `.claude/skills/work-with-codex-to/SKILL.md:62-63,153-166` (Phase 4 commits `Agent: claude`, bootstraps only `inbox.codex.jsonl`/`inbox.claude.jsonl`, never `inbox.code.jsonl`); producer `.claude/skills/work-with-codex-to/scripts/finalize_task.py:68-70,104-109` (**untracked**); consumers `watch_cowork.py:41,213`, `watch_codex.py:39,218`  | **Dimensions:** deploy-gaps, loop-trace  | **Confidence:** 0.9
- **What breaks:** A literal hand-run of SKILL.md Phase 4 produces a commit trailered `Agent: claude` and writes mailboxes named for `{claude,codex}` — none of which the watchers read — so the doorbell never rings even though a correct producer sits unused in the same `scripts/` dir. And per the lead caveat, that producer is untracked, so a clean clone doesn't even have it. Both files contradict each other; nothing marks SKILL.md superseded.
- **Evidence:** `finalize_task.py:68-70` appends `{ts,actor,task,status,did,flags_count,next_recommended,refs}` to `.shared/handoff/inbox.code.jsonl` with `Agent: cowork`; SKILL.md Phase 4 never invokes it.
- **Fix:** Commit `finalize_task.py`; wire SKILL.md Phase 4 (and PROTOCOL.md's finalization step) to call it by name with the canonical `--actor`; delete/redirect the manual `Agent: claude` + `inbox.claude.jsonl` steps. Collapses F1/F2/F3 into one enforced code path.

### F3. `inbox.code.jsonl` is absent/uncommitted with no in-repo bootstrap writer; return watcher logs "0 new" forever until a real finalization runs
- **Where:** `agents/watch_cowork.py:41,194-200` (`git show ref:.shared/handoff/inbox.code.jsonl`; on rc!=0 sets `content=""`, logs "inbox absent … 0 new"); `.shared/handoff/` empty in HEAD and origin  | **Dimensions:** return-trigger, loop-trace  | **Confidence:** 0.85
- **What breaks:** No `agents/` script creates `inbox.code.jsonl`; only `finalize_task.py` (untracked, un-wired) does. `dispatch_to_cowork.sh:58` writes the *outbound* `inbox.cowork.jsonl`; `bridge_up.sh:42` seeds only `orchestrator_inbox.jsonl`. The system starts cleanly but structurally cannot complete a round until the producer is committed+invoked.
- **Evidence:** `git ls-tree -r` confirms `.shared/handoff/` empty in both HEAD and `origin/<branch>`; the watcher reads the git ref, so this is not merely a dirty-worktree artifact.
- **Fix:** Have `bridge_up.sh` create/commit an empty `inbox.code.jsonl` seed; wire + commit the producer so the return leg has a first writer. Until then, document the return leg as inert.

### F4. Out-of-vocabulary status defaults to `kind="progress"`, which the playbook drops (log-only, no dispatch)
- **Where:** `agents/watch_cowork.py:146` (`STATUS_TO_KIND.get(status,"progress")`), `:48-56`; `agents/watch_codex.py:158`; `event_schema.md:59-60`; `orchestrator_playbook.md:73`; producer status vocab undefined at `PROTOCOL.md:97`  | **Dimensions:** correctness  | **Confidence:** 0.7
- **What breaks:** A finalization entry whose `status` is outside the ~20 hard-coded synonyms (e.g. `success`, `reviewed`, `verified`, `flagged`, `pass`) is silently relabeled `progress`, passes the closed-enum validation, and is routed to "log only, no dispatch" — a genuine result is never verified, a genuine error never retried. The producer side enforces no status vocabulary.
- **Evidence:** `event_schema.md:59-60` calls the default "conservative … never silently claims a result," but conservative ≠ safe: `orchestrator_playbook.md:73` drops `progress`.
- **Fix:** Default unknown status to `needs_input` (forces inspection) not `progress` (drop); log a warning on a non-empty unmapped status; document and producer-validate the closed status set.

### F5. Irreversible-action gate is documentation-only; dispatch actuators perform push/full-access-exec on bare invocation
- **Where:** `agents/dispatch_to_cowork.sh:38` (`PUSH="1"` default), `:134-136` (`git push origin HEAD`); `agents/dispatch_to_codex.sh:45,93` (`codex exec --dangerously-bypass-approvals-and-sandbox` immediate); gate prose only at `orchestrator_playbook.md:99-111`, `PROTOCOL.md:36-38`, `bridge_up.sh:58-60`  | **Dimensions:** safety  | **Confidence:** 0.9
- **What breaks:** No `read`/`/dev/tty`/`--confirm`/`ORCH_CONFIRM` token exists in either dispatch script. The only opt-in safety is `--dry-run` (default off). `bridge_up.sh:8-9` casts The Bridge as "an agentic Claude Code session" driving the loop, so the model *is* the operator; a single skipped GATE CHECK fires an irreversible push/exec with no second line of defense. Bounded/non-destructive by design, but the human-in-loop claim is untrue in code.
- **Fix:** Add a mechanical backstop independent of the model: default the irreversible step OFF; require an explicit `--push`/`--run`/`ORCH_CONFIRM=1` token; a bare invocation prints the plan and exits non-zero. Prose guides, script enforces.

### F6. Full-access Codex runs against the live working tree; the "no auto-apply" safety claim is unenforceable
- **Where:** `agents/dispatch_to_codex.sh:33-34` (header safety claim), `:45` (`--dangerously-bypass-approvals-and-sandbox`), `:93` (`-C "$REPO"` = live repo root, no worktree/sandbox/copy)  | **Dimensions:** safety  | **Confidence:** 0.88
- **What breaks:** With approvals+sandbox off and `-C` on the live tree, Codex can edit/delete/reset files in place during "verify/mine." There is no capture-diff-then-apply gate, so "the orchestrator does not auto-apply any Codex-proposed irreversible change" describes a model that does not exist — Codex's writes land directly.
- **Fix:** Run Codex against a disposable git worktree/copy and review the diff before merging, OR drop the bypass flag and use codex's approval/sandbox flags. If full-access is required, gate behind a per-call token and add a real capture-then-apply step.

### F7. No `codex exec` timeout: a hung Codex wedges dispatch (and the synchronous Bridge loop) with zero signal
- **Where:** `agents/dispatch_to_codex.sh:93` (no `timeout` wrapper); operator told to run synchronously (`orchestrator_playbook.md:132/145`, `bridge_up.sh:55`)  | **Dimensions:** failure-modes  | **Confidence:** 0.9
- **What breaks:** `codex exec` runs in danger-full-access mode and can stall indefinitely (network, blocking tool, huge diff). Everything that emits the event/transcript sits *after* the blocking call, so a stall produces a frozen terminal with no event, error, or transcript flush. Recoverable via Ctrl-C but a real no-safe-degradation defect.
- **Fix:** `timeout -k 30 "${CODEX_TIMEOUT:-900}" codex exec …; CRC=$?`; treat rc 124 as `kind=error` with summary "codex timed out after Ns" (the live transcript redirect preserves partial output). Document `CODEX_TIMEOUT`.

### F8. Shared fixed cursor tmp filename: concurrent dispatch + watcher writes corrupt `.codex_cursor` ⇒ mass replay
- **Where:** `agents/dispatch_to_codex.sh:155-158` (`tmp = cursor + ".tmp"` → `os.replace`); `agents/watch_codex.py:85-87` (identical `.codex_cursor.tmp`); shared `.inbox.lock` guards only the inbox append, not the cursor RMW (dispatch releases lock at :142 before pre-seed; `write_cursor` at :229 is lock-free)  | **Dimensions:** races  | **Confidence:** 0.8
- **What breaks:** Both writers open the same non-unique `.codex_cursor.tmp` and `os.replace` it; a torn cursor lands in `read_cursor`'s `except → return {}` = replay-from-scratch (`event_schema.md:81-82` confirms that is "the only way to get duplicates"). On Windows the second open more likely raises an uncaught `PermissionError`, crashing the un-try-wrapped dispatch pre-seed.
- **Fix:** `tempfile.mkstemp(dir=EVENTS_DIR, prefix='.codex_cursor.', suffix='.tmp')` (or append PID) in BOTH `write_cursor` and the dispatch Python block, then `os.replace` the unique tmp.

### F9. Unowned stale-lock break can let two writers interleave appends or strand a 10s stall
- **Where:** `agents/watch_cowork.py:102-116` (on timeout `os.remove(LOCK_PATH)` with no PID/owner/liveness check, then re-race); identical in `agents/watch_codex.py:90-104` and `dispatch_to_codex.sh:125-135`; all three share `.shared/events/.inbox.lock`  | **Dimensions:** races  | **Confidence:** 0.8
- **What breaks:** (1) Death-while-held orphans the lock ⇒ certain full-10s stall on next append. (2) A holder legitimately stalling >10s (GC/AV/disk/swap) gets its live lock removed by a waiter, so two plain `open(...,'a')` appends interleave into a corrupt JSONL line that consumers skip ⇒ silent event loss. `event_schema.md:111` claims the lock exists "so the merged stream never interleaves."
- **Fix:** Owner-stamped lock: write PID into the lock file; on timeout only break if the recorded PID is dead; `_unlock` verifies ownership. Better: a real OS advisory lock (`msvcrt.locking`/`fcntl.flock`) or a single atomic `O_APPEND` of a pre-serialized line.

### F10. Review artifacts without a `t-YYYYMMDD` token get fabricated stem task ids, breaking per-task bookkeeping
- **Where:** `agents/watch_codex.py:44` (`TASK_RE = t-\d{6,8}-[A-Za-z0-9_-]+`), `:136-137` (`task = match.group(0) if match else Path(name).stem`); consumer `orchestrator_playbook.md:55-62`  | **Dimensions:** correctness, loop-trace  | **Confidence:** 0.72
- **What breaks:** The 5 seed review files have no task token, so each yields `task=<stem>` while the real task is `t-20260621-motion10-review` (per `.shared/log.jsonl:1`). The orchestrator's round counter / materials set / `MAX_ROUNDS=6` are keyed on `task`, so these spawn phantom never-converging tasks on first run.
- **Fix:** Treat a stem-derived task as `unknown` (matching the inbox path at `watch_cowork.py:145`) rather than fabricating; require dispatch review files to embed the task id (the dispatch path already does).

### F11. Cold-start replay floods the orchestrator with stale review fixtures as fresh result/needs_input events
- **Where:** `agents/watch_codex.py:167-200` (cold `read_cursor()` returns `{}` at :79; every non-`_` review file fails `files.get(rel)==sig` at :194 and emits); `.shared/events/` absent on fresh start; `start_watchers.sh`/`bridge_up.sh` do no baseline pass  | **Dimensions:** races, failure-modes, consistency, loop-trace (dedup of 4 confirmed)  | **Confidence:** 0.85
- **What breaks:** First cycle injects ~4 `codex/result` + 1 `codex/needs_input` (`needs_human_review.md` → needs_input via `artifact_kind:126`) for stale artifacts belonging to no live task, with back-dated mtime `ts` defeating any "ignore old" heuristic. Per the decision table each `result` proposes a dispatch and `needs_input` a human PAUSE. Bounded by the v1 human gate, but it pages the operator and pollutes the ledger on every cold start / cursor loss.
- **Fix:** On cold start (cursor absent), do one silent baseline pass recording current signatures WITHOUT emitting; emit only on subsequent changes. Or require `--replay`, or document that `.shared/review/` must be emptied/baselined before going live.

### F12. Corrupt/truncated cursor ⇒ `read_cursor` returns `{}` ⇒ full-stream replay (mass duplicate events)
- **Where:** `agents/watch_codex.py:76-81` (bare `except Exception: return {}`), identically `watch_cowork.py:88-93`  | **Dimensions:** failure-modes  | **Confidence:** 0.8
- **What breaks:** A single corrupt/partial/non-UTF8 cursor is indistinguishable from a cold start, silently resetting dedup state and re-emitting every review file + every actor inbox line. Only signal is a large `emitted=` count buried in `.log`.
- **Fix:** Distinguish missing (legit cold start) from present-but-unparseable (corruption): on parse failure log WARNING, rename the bad cursor aside, re-baseline current signatures for one cycle without emitting. Persist the orchestrator's handled-line dedup across sessions.

### F13. `bridge_up` "already running" check uses `kill -0` on a recorded PID ⇒ false positive silently skips watcher launch (total sensor outage shown as green)
- **Where:** `agents/bridge_up.sh:27-34` (`kill -0 "$pid" … && return 0`, no identity check), `:36-40`; no watcher cleans up `watchers.pid` on exit  | **Dimensions:** failure-modes, windows (dedup with F15)  | **Confidence:** 0.75
- **What breaks:** After crash/reboot a stale `watchers.pid` survives; Windows aggressively reuses PIDs and Git Bash `kill -0` matches an unrelated live process holding the recycled PID, so `bridge_up` concludes watchers are up and refuses to launch. The Bridge then runs with **no sensors** — Cowork pushes and Codex artifacts produced, nothing appends to the stream — presented as a healthy "already running" banner. (Reproduced: native Windows PID returned exit 1 from Git Bash `kill -0`.)
- **Fix:** Validate by identity: confirm the PID is a python running `watch_*.py` (record argv/start-time), and treat an old pid file with no recent `.log` heartbeat as not-running.

### F14. Cross-runtime PID namespaces: `.sh` writes MSYS pids, `.ps1` writes Windows pids; mixed start/stop kills the wrong process or leaks the watcher
- **Where:** `start_watchers.sh:27,34` (`$!`); `start_watchers.ps1:40-41` (`$cowork.Id`); `stop_watchers.ps1:18` (`Stop-Process -Id`); `stop_watchers.sh:20,33` (bare `kill`); advertised interchangeable at `event_schema.md:120-128`  | **Dimensions:** windows  | **Confidence:** 0.93
- **What breaks:** Reproduced on this machine: `nohup … & echo $!` gave a small MSYS pid but `ps -W` showed a different WINPID. A `.sh` start + `.ps1` stop force-kills an unrelated Windows process (recycled low PID) or leaks a forever-polling watcher; the reverse leaks too. Same-shell-family use works.
- **Fix:** Make `watchers.pid` self-describing (`winpid:34328`) and have each stop script refuse pids of the wrong namespace; or write WINPID in `.sh` (`ps -W`) so both runtimes agree.

### F15. `start_watchers` (both `.sh` and `.ps1`) lacks an already-running guard: re-running spawns duplicate watchers, truncates the pid file, and (PS1) crashes on locked redirect files
- **Where:** `start_watchers.sh:26,29,34` (unconditional `nohup`, truncating `> watchers.pid`); `start_watchers.ps1:7,28-41` (`$ErrorActionPreference='Stop'`, unconditional `Start-Process` to fixed `.out`/`.err`, `Set-Content` overwrite); guard exists only in `bridge_up.sh:27-34`  | **Dimensions:** failure-modes, windows  | **Confidence:** 0.85
- **What breaks:** A direct `start_watchers` invocation (advertised entry point at `event_schema.md:122`) on top of a running set spawns a second pair (both append to the stream, both race the cursor) and the truncating pid-file write orphans the original pair so `stop_watchers` can never kill it — deterministic on every double-start. On Windows the still-open `.out`/`.err` makes the second `Start-Process` throw under `-ErrorAction Stop`, aborting mid-launch.
- **Fix:** Move the `already_running` guard into `start_watchers` itself (refuse + non-zero exit if any pid is live); append/merge rather than truncate `watchers.pid`; timestamp or share-open the redirect files. Add a `bridge_up.ps1` so PowerShell operators get the guard too.

### F16. Whole-second mtime signature silently misses a same-second, same-size review rewrite
- **Where:** `agents/watch_codex.py:193-194` (`sig = "%d:%d" % (int(st.st_mtime), st.st_size)` then `if files.get(rel)==sig: continue`); identical pre-seed format at `dispatch_to_codex.sh:154`  | **Dimensions:** windows  | **Confidence:** 0.8
- **What breaks:** Reproduced: two same-size rewrites 2ms apart both collapse to `int(mtime):size`, so the second (content-changed) write hits `continue` and emits no event — a real Codex finding silently lost. NTFS keeps sub-second mtime, so the window is real for fast successive same-length edits (status-flag flip, citation-id swap, deterministic regenerator).
- **Fix:** Use `st.st_mtime_ns` and/or a cheap content hash in the signature (`hashlib` already imported at `watch_codex.py:220`); apply the identical change to `dispatch_to_codex.sh:154` so formats stay in sync.

### F17. `dispatch_to_cowork` non-fast-forward push strands the task commit locally with no auto-rebase/retry
- **Where:** `agents/dispatch_to_cowork.sh:135` (`git push origin HEAD`, no fetch/rebase), `:138-139` (`WARN … exit 3`); no retry loop  | **Dimensions:** races (downgraded from refuted "silent strand" to confirmed residual)  | **Confidence:** 0.7
- **What breaks:** On a shared branch a non-ff rejection leaves the task commit local+unpushed, so Cowork never sees the task until a human reconciles. Non-silent (WARN + recovery command + nonzero exit) and non-destructive — a robustness gap, not the silent data-loss originally alleged.
- **Fix:** On push rejection, `git fetch && git rebase origin/<branch>` and retry a bounded number of times before giving up; never leave the task stranded silently.

## MINOR

### F18. `flags_count` is dropped in normalization (schema-completeness nit)
- **Where:** `agents/watch_cowork.py:142-150` / `watch_codex.py:154-162` (emit exactly 7 keys); `event_schema.md:37-45` (no mapping row); source `PROTOCOL.md:97` / `finalize_task.py:63`  | **Dimensions:** correctness  | **Confidence:** 0.5 (corrected MAJOR→MINOR)
- **What breaks:** `flags_count` is genuinely discarded, but the playbook's STOP-vs-revise branch is novelty-based (`orchestrator_playbook.md:75-76`), which a raw count cannot determine anyway. Real but minor.
- **Fix:** Carry `flags_count` through (8th field or inside `refs`) and update `event_schema.md`'s mapping table.

### F19. `artifact_kind` maps a review-with-findings to `kind=result`, indistinguishable from a clean pass — **[UNCERTAIN]**
- **Where:** `agents/watch_codex.py:124-132` (filename-only); seed `.shared/review/codex_review.md:5` ("## Material Issues Found") emits as `result`; consumer `orchestrator_playbook.md:69-70`  | **Dimensions:** correctness  | **Confidence:** 0.5
- **What breaks:** `kind` is inferred from the filename, which carries no disposition signal, so a 6-issue review and a clean review both arrive as `result`. The playbook splits `result` by content comparison and v1 is human-in-the-loop, so the silent-STOP only materializes under not-yet-enabled headless mode. **[UNCERTAIN — hinges on future headless operator behavior.]**
- **Fix:** Default artifact-derived events to a neutral kind (`progress`/`needs_input`) that forces the orchestrator to open the file; document that `result` ≠ convergence.

### F20. `dispatch_to_codex` review filename glues timestamp into the task token; cursor replay re-derives a divergent task id
- **Where:** `dispatch_to_codex.sh:64-65` (`review/codex_${TASK}_${TS}.md`); `watch_codex.py:44,136` (greedy `TASK_RE` swallows `_<TS>`)  | **Dimensions:** correctness, consistency  | **Confidence:** 0.75
- **What breaks:** `codex_t-20260621-motion10_20260621T120000Z.md` → `t-20260621-motion10_20260621T120000Z` ≠ the dispatcher's clean `t-20260621-motion10`. Pre-seed masks it normally; surfaces on cursor deletion/corruption, then re-emits under a corrupted task id, splitting the ledger.
- **Fix:** Tighten `TASK_RE` to stop at `_<8digits>T`, or change the dispatch separator to `codex__${TASK}__${TS}.md` and split on `__`.

### F21. Raw-byte dedup re-emits the same logical entry on any cosmetic reformat
- **Where:** `agents/watch_cowork.py:215-216` (`sha1(raw)` vs `seen`); `watch_codex.py:220`; tip-moved path re-scans the whole file  | **Dimensions:** races  | **Confidence:** 0.7 (corrected MAJOR→MINOR)
- **What breaks:** Any key reorder / whitespace / CRLF / `ensure_ascii` change to an already-emitted line changes the SHA, misses `seen`, re-emits. Requires a rewrite the append-only protocol forbids — a latent hardening gap.
- **Fix:** Dedup on a canonical logical key (`json.dumps(entry, sort_keys=True)` or `(actor,task,ts,status)`), normalizing line endings first.

### F22. Cursor RMW unprotected by the append lock (design-gap restatement)
- **Where:** `agents/watch_codex.py:116-121` (lock guards only the append), `:229` (`write_cursor` outside lock)  | **Dimensions:** races  | **Confidence:** 0.75
- **What breaks:** `.inbox.lock` gives a false sense that "state is protected"; cursor updates are not. Harmless alone (the two watchers' cursors are disjoint); the real damage is the dispatch-vs-watcher sharing in F8.
- **Fix:** Document that `.inbox.lock` guards only the merged-stream append; add a per-cursor lock around every `.codex_cursor` RMW in both `watch_codex` and `dispatch_to_codex`.

### F23. `bridge_up` event-count `|| echo 0` injects a literal `0` line into the cold-start banner
- **Where:** `agents/bridge_up.sh:43` (`COUNT="$(grep -c '' "$STREAM" 2>/dev/null || echo 0)"`)  | **Dimensions:** deploy-gaps  | **Confidence:** 0.5
- **What breaks:** On the freshly-truncated empty stream, `grep -c ''` prints `0` AND exits 1, so `|| echo 0` also fires ⇒ `COUNT="0\n0"`, breaking the boxed banner. Cosmetic.
- **Fix:** `COUNT=$(wc -l < "$STREAM" 2>/dev/null || echo 0)`.

### F24. Detached-HEAD / missing remote branch resolves ref to `origin/HEAD` and silently emits nothing under a misleading "transient" log
- **Where:** `agents/watch_cowork.py:159-163` (fallback to literal `"HEAD"`), `:182-185` (rev-parse failure → "transient, continuing" → `return 0`)  | **Dimensions:** failure-modes  | **Confidence:** 0.72
- **What breaks:** Started in detached HEAD or against a never-pushed branch, every cycle treats the wrong/missing ref as a transient blip forever; Cowork pushes are never seen. Watcher looks alive; "transient" wording masks a permanent misconfiguration.
- **Fix:** After N consecutive rev-parse failures on the same ref, escalate to a distinct ERROR (or emit a synthetic `kind=error`); refuse the bare-`HEAD` fallback — require explicit `SHARED_BRANCH` when HEAD is detached.

### F25. Banner advertises `.log` but watcher stdout/stderr (crashes, tracebacks, ImportError) go to `.out`/`.err`
- **Where:** `start_watchers.sh:26,29` vs banner `:44-45`; `start_watchers.ps1:31,37` vs banner `:50-51`; `watch_codex.py:35,64-73`  | **Dimensions:** windows  | **Confidence:** 0.92
- **What breaks:** When a watcher dies from something `log()` never captured, the diagnostic is in `.out`/`.err`; the banner points at an empty/stale `.log`, so the operator concludes "no error logged" and misdiagnoses a silently-dead watcher.
- **Fix:** Banner should list `.log` (cycles) plus `.out`/`.err` (stdout/stderr & crashes).

### F26. Trailer/identity conventions are contradictory and unenforced across the docs — **[UNCERTAIN impact]**
- **Where:** `PROTOCOL.md:23` (`Agent: <claude|codex>`) vs `:100` (`Agent: cowork`); `AGENTS.md:10` (`Agent: codex`); `SKILL.md:164` (`Agent: claude`); `dispatch_to_cowork.sh:128` (`Agent: code`); `dispatch_to_codex.sh` (no commit at all); no commit-msg hook  | **Dimensions:** deploy-gaps, consistency  | **Confidence:** 0.7
- **What breaks:** Three trailer vocabularies coexist with no canonical map, so audit-by-grep is unreliable. **[UNCERTAIN — no code path parses the `Agent:` trailer for control flow (the event stream keys on a separate `source`/`actor` field), so impact is documentation/audit only today; becomes a runtime break iff a verifier/branch-protection hook keyed on a specific trailer is added.]**
- **Fix:** Publish one canonical role→trailer→event-source table in PROTOCOL.md (`code`/`cowork`/`codex`); update PROTOCOL:23/AGENTS/SKILL to match; add a commit-msg hook validating the `Agent:` value.

### F27. `dispatch_to_cowork` sets repo-wide git identity to `code` with no `--local`/restore, hijacking the operator's git identity
- **Where:** `agents/dispatch_to_cowork.sh:122-123` (`[ -z "$(git config user.name)" ] && git config user.name "code"`)  | **Dimensions:** consistency  | **Confidence:** 0.75
- **What breaks:** On a clone with no resolvable `user.name` at any level, the first dispatch writes a persistent repo-local override; every subsequent human commit is then authored as `code`, mis-attributing human work. (Guard skips when any identity is already set.)
- **Fix:** Pass identity per-commit only: `git -c user.name=code -c user.email=… commit …` instead of mutating repo config.

### F28. `state.md` / `inbox.codex.jsonl` are required reading per AGENTS.md but unseeded on a fresh clone for the direct-Codex entry path
- **Where:** `AGENTS.md:8-9` (no "create if absent"); `PROTOCOL.md:69,98`; only seeded by `SKILL.md:62-64` (gated behind `/work-with-codex-to`) and `finalize_task.py:78` (state.md only, never `inbox.codex.jsonl`); `dispatch_to_codex.sh` seeds neither  | **Dimensions:** return-trigger, consistency, loop-trace  | **Confidence:** 0.83 (corrected MAJOR→MINOR)
- **What breaks:** A Codex session entering per AGENTS.md hits two missing reads and starts with no state/baton context and no addressed mailbox. Non-fatal (read tooling likely treats missing files as empty; the task arrives on stdin) — unsatisfiable documentation rather than a functional break.
- **Fix:** Add a documented bootstrap that seeds `state.md`, `inbox.code.jsonl`, `inbox.codex.jsonl` if absent and commits empty seeds; or change AGENTS.md to "create if absent" and describe stdin delivery.

### F29. `.shared/` shared subtrees are untracked/uncommitted on this branch — **[UNCERTAIN]**
- **Where:** `.gitignore:7` (ignores only `.shared/events/`); `git ls-files .shared/` empty across all commits; `watch_cowork.py:41,163,195` reads the git ref  | **Dimensions:** loop-trace  | **Confidence:** 0.8 (corrected MAJOR→MINOR)
- **What breaks:** The watcher reads `inbox.code.jsonl` from the ref, so an uncommitted handoff yields 0 events. **[UNCERTAIN — not a code/doc defect: `inbox.code.jsonl` is NOT gitignored and `PROTOCOL.md:99` finalization does `git add -A` + push, so a real finalization WILL commit it and the ref read then succeeds; whether the loop is actually broken depends on whether any finalization has run.]**
- **Fix:** Commit empty seeds of the intended-shared subtrees (`handoff/`, `review/`, `state.md`) and document which `.shared` paths are shared (committed) vs per-clone runtime (`events/`).

### F30. `dispatch_to_cowork` `--no-push`/push-failure leaves the task invisible to Cowork with insufficient operator warning
- **Where:** `agents/dispatch_to_cowork.sh:125-132,138-139,142`; consumer reads `origin/<branch>` (`watch_cowork.py:159-163,195`); `bridge_up` banner never surfaces unpushed dispatches  | **Dimensions:** safety (reliability-adjacent)  | **Confidence:** 0.6
- **What breaks:** Committed-locally-but-not-pushed task entries never reach origin, so Cowork never sees them and the loop stalls while the operator may believe a hand-off occurred. Not a gate breach.
- **Fix:** On `--no-push`/push-failure, print a clear "NOT yet visible to Cowork; pending `git push`" reminder and surface un-pushed dispatches in the `bridge_up` banner.

## Flagged uncertainties (unresolved — do not deploy assuming either way)

- **Untracked producer (lead caveat):** `finalize_task.py` exists in the working tree but is **not committed**; whether it (and the `.shared/` seeds) are committed before The Bridge pulls is external state. If not, the return leg has no producer on a clean clone — BLOCKER-grade. **Settle by:** committing the producer + seeds and confirming they appear in `origin/<branch>`.
- **F19 (artifact `kind=result` overloading):** the silent premature-STOP only fires under not-yet-enabled headless mode the docs forbid. **Settle by:** deciding headless policy; ship the neutral-kind fix before any headless enablement.
- **F26 (trailer/identity conventions):** harm is audit-only today; becomes real iff a verifier/branch-protection hook keyed on a trailer is added. **Settle by:** deciding whether such a hook is planned and publishing one canonical identity table first.
- **F29 (`.shared/` untracked):** self-heals the first time a real finalization push runs `git add -A`. **Settle by:** running one end-to-end finalization on a clean clone and confirming `origin/<branch>:.shared/handoff/inbox.code.jsonl` materializes and the watcher emits.
- **F31 (nohup hard-window-close survival, MINOR):** `disown` only edits bash's job table; a mintty X-button close fires `CTRL_CLOSE_EVENT`, not SIGHUP, so native `python.exe` survival on hard close is version/config-dependent and could not be exercised read-only. The `.ps1` `Start-Process` path already detaches robustly. **Settle by:** testing hard-close on the target Git-for-Windows build, or document "leave the window open / use the `.ps1` launcher."

## Considered and dismissed (refuted findings — recorded for audit)

- **"No producer writes `inbox.code.jsonl` with `actor=='cowork'`":** Refuted — `finalize_task.py:59-70` writes it with `--actor cowork`; the reviewer's grep was scoped to `agents/`. (Residual `--actor claude` risk survives as **F1**; untracked-file risk survives as the lead caveat.)
- **"`next_hint` never populated for the cowork path":** Refuted — `finalize_task.py:42,64` sets `next_recommended`, which `watch_cowork.py:149` reads first; empty is the schema's documented `may be ""`.
- **"Loop asymmetry / cowork half-loop has no closing mechanism":** Refuted — `watch_cowork.py` IS the return trigger (30s `git fetch` poll); the playbook (`:21-25`) documents the asymmetry.
- **"watch_codex double-emit pre-seed race is a BLOCKER":** Re-graded — real but MAJOR/MINOR; at-least-once stream + content dedup absorb the duplicate (folded into F8/F22).
- **"Push-failure re-run double-dispatches via watch_cowork":** Refuted — `watch_cowork.py:41,213` reads `inbox.code.jsonl`/`actor==cowork`; it never observes the Code-side `inbox.cowork.jsonl` (`actor:code`) line.
- **"`dispatch_to_cowork` pushes by default, contradicting policy" / "`--dry-run` is the only safety affordance":** Refuted on the *policy* point — `PROTOCOL.md:75-108` explicitly mandates push-by-default for this exact Code→Cowork leg. The *enforcement* concern survives as **F5** (the gate is procedural, not coded).
- **"`finalize_task.py` does not exist" / "the return loop is entirely unbuilt" (3 findings):** Refuted **as of mid-review** — the file appeared at `18:06` (4375 B, executable) and performs the full 3-step finalization. NB: it is untracked (lead caveat), so these partially re-apply on a clean clone.
- **"`state.md` is never written by any script":** Refuted — `finalize_task.py:78` writes it.
- **"`--kind assign/revise/verify` unknown to STATUS_TO_KIND":** Refuted — `--kind` is a dispatch directive on `inbox.cowork.jsonl` (which the watcher never reads); the producer status field uses the mapped family.
- **"No PowerShell equivalent of dispatch/bridge contradicts a portability claim":** Refuted — no "runs on Git Bash AND PowerShell" claim exists in the repo for the dispatchers; `event_schema.md:118-128` scopes PowerShell to the watchers only. (The missing `bridge_up.ps1`/dispatch-`.ps1` is still noted as a portability gap in F15.)

## Minimum bar to deploy (clear NO-GO → GO-WITH-FIXES)

1. **Close F1 (the one confirmed BLOCKER):** unify the identity vocabulary so the watcher accepts what the producer emits — constrain `finalize_task.py --actor` to `{cowork,codex}` (or normalize `claude→cowork` at `watch_cowork.py:213`), AND replace the silent `continue` with a logged drop for unrecognized actors. Reconcile `PROTOCOL.md:18` / `AGENTS.md:10` / `SKILL.md:164`.
2. **Commit + wire the finalization producer (lead caveat + F2/F3):** `git add` `finalize_task.py`; make SKILL.md Phase 4 + PROTOCOL.md's finalization step invoke it; have `bridge_up.sh` create/commit an empty `inbox.code.jsonl` seed. **Verify it lands on `origin`.**
3. **Add the mechanical safety backstop (F5/F6):** default `dispatch_to_cowork.sh` `PUSH=0` (require `--push`); require an explicit `--run`/`ORCH_CONFIRM` token in `dispatch_to_codex.sh` before the real `codex exec`; run full-access Codex against a disposable worktree (or drop the bypass flag) so "no auto-apply" is enforceable.
4. **Add the `codex exec` timeout (F7).**
5. **Fix the cold-start replay (F11):** baseline the cursor on first run without emitting; treat stem-derived task ids as `unknown` (F10).
6. **Harden the cursor/lock races (F8/F9/F12):** unique tmp filename per writer; owner-stamped/liveness-aware lock break; distinguish missing-vs-corrupt cursor.
7. **Make the watcher launch/stop Windows-safe (F13/F14/F15):** identity-validated `already_running` check; namespace-tagged `watchers.pid`; already-running guard inside both `start_watchers` variants with non-truncating pid-file writes.
8. **Use a sub-second/hashed mtime signature (F16)** and **auto-rebase+retry on push rejection (F17).**

After 1–8, the remaining MINORs (F18–F30) are GO-WITH-FIXES backlog, not deploy blockers — but resolve the flagged uncertainties (especially the untracked producer and F29, via one end-to-end finalization on a clean clone) before trusting the loop unattended.

---

*Review method: 76-agent adversarial workflow (9 dimensions → independent per-finding refutation → deduped synthesis), 66 raw findings, read-only. Load-bearing claims spot-verified by the lead reviewer against the live tree. No controller/contract file was modified; no fix applied.*
