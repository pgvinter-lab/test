# Hardening Batch — Status (autonomous run)

## ✅ CLOSED + verified this run (pushed)
| ID | Fix | Verified |
|----|-----|----------|
| **F1** (BLOCKER) | watchers accept cowork/claude (cowork) & codex; log unknown drops | pipeline test, both ways |
| **F2/F3** | canonical `finalize_task.py` authored + tracked on origin; wired into PROTOCOL/SKILL/AGENTS/CLAUDE | compiles; docs call it |
| **F4** | unmapped status → `needs_input` + WARN (not silent `progress`) | test: status "verified" → needs_input |
| **F5/M5** | dispatch_to_codex requires confirm; refuses unattended | gate logic + dry-run |
| **F6** | per-run `--sandbox` required + confirmed (operator decision); read-only/workspace-write/danger options | dry-run all 3 + missing→error |
| **F7** | `codex exec` wrapped in `timeout`; rc124 → error | code + dry-run shows wrapper |
| **F8** | unique cursor tmp (mkstemp) in watchers + dispatch pre-seed | code |
| **F10/F20** | review files w/o t- token → "unknown"; TASK_RE stops before _<TS> | test: t-20260621-new extracted |
| **F11/F12** | cold-start/corrupt cursor → baseline review scan (no flood); corrupt renamed aside | test: stale fixture baselined, events empty |
| **F16** | signature uses `st_mtime_ns` (watcher + dispatch in sync) | code |
| **F17/M2** | dispatch_to_cowork rebase-and-retry on non-ff push | code |
| **F26** | identity reconciled to code/cowork/codex; trailer mirrors actor | docs |
| **F27** | dispatch_to_cowork sets git identity per-commit (no repo-config hijack) | code |
| **B3** | exit-0-empty-output ≠ result | code |
| **B1 (half)** | loud MANUAL RELAY notice after dispatch | code |
| validator | `agents/validate_event.py` enforces the 7-key contract | self-test |

## 🪟 REMAINING — needs YOUR Windows box (cannot verify from Linux; specs below)
- **F13** — `bridge_up.sh` `already_running` uses `kill -0` on a recorded PID; on Windows PID reuse this false-positives and silently skips watcher launch (green banner, no sensors). *Fix:* validate identity — confirm the PID is a python running `watch_*.py` (record argv/start-time), and treat a pid file with no recent `.log` heartbeat as not-running.
- **F14** — `.sh` writes MSYS pids (`$!`), `.ps1` writes Windows pids; a mixed start/stop kills the wrong process or leaks the watcher. *Fix:* make `watchers.pid` self-describing (`winpid:NNNN` / `msys:NNNN`); each stop script refuses pids of the wrong namespace; or write WINPID in `.sh` via `ps -W`.
- **F15** — `start_watchers.{sh,ps1}` lack an already-running guard: a direct double-start spawns duplicate watchers and truncates the pid file (orphaning the first pair); `.ps1` crashes on locked redirect files under `-ErrorAction Stop`. *Fix:* move the `already_running` guard into both `start_watchers`; append (don't truncate) the pid file; timestamp/share-open the redirect files; add a `bridge_up.ps1`.

These are real but edge-case (crash/reboot/double-start/cross-runtime). The normal single-start path works. Apply on the box and test, since PID/launch semantics are OS-specific.

## 📋 MINOR backlog (GO-WITH-FIXES, not blockers)
F18 flags_count carry-through · F19 artifact-kind overloading (matters only under future headless) · F21 raw-byte dedup on reformat · F22 cursor RMW lock doc · F23 banner count `0\n0` · F24 detached-HEAD masking · F25 `.out`/`.err` in banner · F28 state/inbox seeding on fresh clone · F29 `.shared` subtree seeds · F30 no-push visibility · F31 nohup hard-close survival.

## Decisions already applied
- B1: v1 manual relay. F6: per-run confirmed sandbox (worktree isolation deferred).
- Identity: code (orchestrator) + cowork/codex (producers). Trailer mirrors actor.
- finalize_task.py: Code-authored canonical version (your local untracked copy is superseded — discard it before pulling).

## GO assessment
The NO-GO blocker (F1) and every Code-verifiable deploy-gate item are closed and tested.
Remaining before trusting it unattended: the 3 Windows launch fixes (your box) and one
real end-to-end run on The Bridge with live Cowork + Codex.
