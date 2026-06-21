# Shared AI Workspace Protocol

This repo is a shared workspace for the human, Codex, and Claude Code. Git is
the audit and source-of-truth layer. Shared access is open by default; the only
gate is on irreversible actions. Optimize for continuity, auditability, and
reversibility — not for blocking.

## On entry
- Read the shared instructions, current state, active tasks, handoffs addressed
  to you, recent logs, and Git status.
- Identify the task ID, current branch, changed files, and any uncommitted work
  before acting.
- Check who holds the baton. If it isn't you and no handoff is addressed to you,
  don't modify active-task files — leave a note/question and stop.
- Preserve user and other-agent work.

## During work
- You are `claude` or `codex`. Use the task ID in notes, commits, reviews, and
  handoffs.
- Prefer separate branches or separate review files for parallel work.
- Make small, single-purpose commits. Every commit carries trailers:
  ```
  Agent: <claude|codex>
  Task: <task-id>
  ```
- Record concise rationale, assumptions, evidence, risks, and next steps. Do
  not store hidden chain-of-thought — record conclusions and reasons, not raw
  internal deliberation.
- Attach a confidence (0–1) to summaries, reviews, and handoffs.
- Treat summaries as pointers, not proof — verify against source files when
  accuracy matters.
- Preserve disagreement. If you disagree with the other system, do not silently
  overwrite or flatten to consensus. Record both positions and why; let the
  human resolve.

## Irreversible-action gate (the only gate)
- Do not overwrite, reset, delete, force-push, rewrite shared history, merge, or
  take any outward-facing/irreversible action without explicit permission.
- Everything short of that is open — read, branch, draft, log, and hand off
  freely.

## On exit / handoff
- Leave the workspace resumable. Update current state, task status, and a
  handoff note.
- The handoff note is addressed to the other agent and sets the baton holder.
  Include:
  - changed paths
  - Git branch and head
  - commands/tests run and their result
  - unresolved risks
  - recommended next action
- If no code was changed, say so explicitly.
- Commit everything.

## Domain riders
- **Coding:** as above; tests are the verification of record.
- **Music:** keep text in Git (prompts, parameters, seeds, arrangement and
  listening notes, provenance — which model/params produced which take). Keep
  audio out of Git (or in LFS); the log holds pointers + metadata, not bytes.
- **Legal:** flag every citation `verified:true|false` with its source. Keep
  drafts separate from anything filed or sent. The irreversible-action gate
  applies hardest here — pause for human confirmation before anything leaves
  draft state.

## Files
- `.shared/log.jsonl` — append-only event bus; the source of truth for what
  happened. Event types: `handoff`, `decision`, `disagreement`, `summary`,
  `output`, `state_change`, `question`.
- `.shared/state.md` — current snapshot (rebuildable from the log).
- `.shared/handoff/inbox.<agent>.jsonl` — per-agent mailboxes (avoids merge
  conflicts from concurrent appends).
- `.shared/decisions/` — ADR-style markdown for significant decisions and
  preserved disagreements.

## Cross-surface orchestration (Code ↔ Cowork ↔ Codex)

The three surfaces do not share a live runtime. The topology is forced:

```
Code  ←→ [git repo / .shared bus] ←→  Cowork  ←→ [Desktop Commander] ←→ Codex (local)
```

- **Code** (cloud) — orchestrator. Holds the plan/state/audit. Reads results
  from `.shared/handoff/inbox.code.jsonl`, decides the next task, writes it to
  `.shared/handoff/inbox.cowork.jsonl`, commits, and pushes.
- **Cowork** (cloud + Desktop Commander) — executor/drafter and local arm.
  Drives **Codex** locally. Reads `inbox.cowork.jsonl`, does the work, and at
  finalization performs the **finalization push** (below).
- **Codex** (local) — verify/mine, invoked by Cowork. Code reaches Codex only
  transitively, through Cowork.

### Finalization push (the doorbell)
Every Cowork/Codex task MUST end by making Code aware. As the last step, the
local executor:

1. Writes a result/handoff entry to `.shared/handoff/inbox.code.jsonl`:
   `{ts, actor, task, status, did, flags_count, next_recommended, refs}`.
2. Refreshes `.shared/state.md` (active task, holder, open items).
3. `git add -A` (full task output + ledger), commits with trailers
   (`Agent: cowork` / `Task: <id>`), and **pushes**.

The push is the signal. Code is then woken by a git event, by the human, or by
polling; it pulls, reads `inbox.code.jsonl`, and issues the next task.

### Push everything (current mode)
Operator decision: push the **full** output — drafts, review notes, everything —
so Code always has complete context. No sanitization step. (Revisit only if the
operator reinstates a confidentiality boundary.)
