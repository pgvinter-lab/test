# Unified Deploy Fix List

Synthesis of two independent deploy-readiness reviews — Code's background adversarial
review and The Forge's 76-agent review (`deploy_readiness_forge.md`) — plus what the
hardening commits already closed. The two reviews converged on the integration/race/gate
themes; The Forge additionally caught the **F1 identity blocker** that Code's review missed
(the decorrelation paying off).

## ✅ CLOSED (pushed)
- **F1 — identity-vocab silent drop (THE NO-GO BLOCKER)** — `7613b2a`. Watchers now accept
  `actor` ∈ {cowork, claude} (cowork) / {codex} (codex), skip the other watcher's actor
  quietly, and **LOG** any unrecognized actor instead of silently dropping it.
- **M2 / F17 — non-ff push strands work** — `744e90e`. `dispatch_to_cowork.sh` rebases + retries.
- **M5 / F5 (codex leg) — unenforced gate** — `744e90e`. `dispatch_to_codex.sh` requires
  `--yes` / `BRIDGE_AUTOCONFIRM`; refuses unattended full-access Codex.
- **B3 (part) — false convergence** — `744e90e`. exit-0-with-empty-output no longer a `result`.
- **Contract validator** — `744e90e`. `agents/validate_event.py` (note: validates a *formed*
  event; does NOT fix F4's upstream default — see below).
- **B1 (half) / F30 — return-relay gap made loud** — `744e90e`. MANUAL RELAY notice after push.

## ⛔ BLOCKED ON OPERATOR
- **F2 / F3 — finalization producer untracked.** `finalize_task.py` exists locally but is
  **not committed/pushed**, so a clean clone has no return-leg producer. Operator action:
  `git add` it + `codex_proposals.md`, commit, rebase, push. Then Code wires it in.

## 🔧 REMAINING — Code-owned, after finalize_task.py lands (prioritized)
Deploy-gate batch (mostly watcher-side hardening; all clear fixes):
- **F4** — unknown `status` → defaults to `progress` (dropped). Change default to `needs_input`
  + log on unmapped non-empty status. (upstream of validate_event.py)
- **F7** — no `codex exec` timeout; a hang wedges the loop silently. Add `timeout` wrapper.
- **F8** — shared fixed cursor tmp filename races → cursor corruption. Unique tmp per writer.
- **F9** — unowned stale-lock break can interleave appends. Owner-stamped lock / flock.
- **F10** — review files without a `t-…` token get fabricated stem task ids. Treat as `unknown`.
- **F11** — cold-start replays stale review fixtures as fresh events. Baseline pass w/o emit.
- **F12** — corrupt cursor == cold start → full replay. Distinguish missing vs corrupt.
- **F13/F14/F15** — Windows PID-namespace / no already-running guard / launch defects.
  Identity-validated `already_running`, namespace-tagged `watchers.pid`, guard in start scripts.
- **F16** — whole-second mtime signature misses same-second rewrites. Use `st_mtime_ns` + hash.

Control-plane integration (from `codex_proposals.md`, Code curates as single writer):
- Wire `finalize_task.py` into PROTOCOL.md finalization + SKILL.md Phase 4 + AGENTS.md/CLAUDE.md
  exit steps (the 5 proposals). Standardize `--actor` on {cowork, codex}.
- **F26** — reconcile trailer/identity vocab (claude/code/cowork/codex) into one canonical table.
- **F27** — `dispatch_to_cowork.sh` sets repo-wide git identity to `code`; make it per-commit
  (`git -c user.name=…`) so it never hijacks the operator's identity.

Minor backlog (F18–F31): flags_count dropped, artifact kind overloading, filename task-id glue,
raw-byte dedup, cursor RMW lock, banner count bug, detached-HEAD masking, `.out`/`.err` logging,
state/inbox seeding, `.shared` untracked, no-push visibility.

## ❓ OPERATOR DECISIONS
1. **B1 full** — keep v1 loud-manual-relay (Cowork pulls on prompt) **or** build a local poller
   that auto-relays Code→Cowork dispatches.
2. **F6** — run full-access Codex against a **disposable git worktree** (so "no auto-apply" is
   real) **or** accept live-tree full-access (current posture). Recommend worktree before any
   headless flip.
3. **Canonical identity** — confirm producers = {cowork, codex}, orchestrator = code; then Code
   reconciles the docs (F1-doc / F26).

## Minimum bar to GO (Forge items 1–8, status)
1. F1 ✅ done · 2. commit+wire finalize ⛔ (operator) → then Code · 3. F5 codex-leg ✅ / F6 decision
· 4. F7 · 5. F11+F10 · 6. F8/F9/F12 · 7. F13/F14/F15 · 8. F16 + F17 ✅. Items 4–8 are the
Code-owned hardening batch above.
