---
name: work-with-codex-to
description: >-
  Orchestrate a multi-agent loop to accomplish a goal collaboratively across
  Claude Code, Codex, and (when available) the Gemini / Google family, using
  whichever backends are reachable via CLI or browser. Use when the user says
  "work with codex to <goal>" or invokes /work-with-codex-to <goal>. The skill
  clarifies and confirms intent first, then drives an iterative
  Claude<->Codex(<->Gemini) loop until the goal is verified against an explicit
  Definition of Done, syncs results into the shared system of record (Git +
  .shared/), and shuts down with a final report. Honors the Shared AI Workspace
  Protocol in PROTOCOL.md.
allowed-tools: Bash Read Write Edit AskUserQuestion WebSearch WebFetch
---

# work-with-codex-to

Drive a bounded, auditable collaboration loop between Claude Code and Codex
(plus Gemini/Google and web research when reachable) to accomplish `<goal>`,
then sync everything to the system of record and shut down.

Operating posture: **open shared access, one gate at irreversible actions.**
Optimize for continuity, auditability, and reversibility — not for blocking.
Run autonomously between the start confirmation and completion; only stop for
(a) the upfront intent confirmation, (b) a genuinely irreversible action, or
(c) a true ambiguity/blocker.

---

## Phase 0 — Preflight (capability detection + scaffolding)

1. **Print the ENVIRONMENT REPORT and decide topology.** This is also the
   self-test that tells us whether the loop can run here at all. Run the
   bundled probe (or inline the same checks):
   ```bash
   bash "$(dirname "$0")/scripts/preflight.sh" 2>/dev/null || \
   { echo "host: $(hostname)  os: $(uname -srm)  cwd: $(pwd)";
     for c in codex gemini claude gh node python3 jq; do
       printf "%-8s " "$c"; command -v "$c" || echo "(missing)"; done; }
   ```
   Show the report to the user, then interpret:
   - **`codex` present** → Codex is reachable as a peer agent (CLI). The loop
     can run for real. Proceed.
   - **`codex` missing** → this surface cannot reach Codex (you are in a cloud
     environment isolated from the laptop, e.g. the Code tab or a Cowork cloud
     VM). Do **not** silently fake it. Tell the user plainly and offer the
     three real options before continuing:
       1. Re-run from a surface that has local `codex` (e.g. Cowork if it runs
          locally, or a local terminal Claude Code).
       2. Install `codex` into this environment via a setup script and re-run.
       3. Proceed **Claude-only** (no second agent) — degraded, stated as such.
   - **`gemini` present** → available for second opinions / research; if
     missing, fall back to Claude's `WebSearch`/`WebFetch`.
   - Confirm exact non-interactive flags before first use; versions differ:
     `codex exec --help` and `gemini --help`.

2. **Bootstrap the shared system of record** (idempotent — only creates what's
   missing):
   ```bash
   mkdir -p .shared/handoff .shared/decisions
   [ -f .shared/log.jsonl ] || : > .shared/log.jsonl
   [ -f .shared/handoff/inbox.codex.jsonl ]  || : > .shared/handoff/inbox.codex.jsonl
   [ -f .shared/handoff/inbox.claude.jsonl ] || : > .shared/handoff/inbox.claude.jsonl
   [ -f .shared/state.md ] || printf '# Current State\n\nholder: claude\nactive_task: (none)\n' > .shared/state.md
   ```
   If `PROTOCOL.md` is absent, read it from the repo root once created; this
   skill assumes that protocol governs all handoffs.

3. **Mint a task ID:** `t-$(date +%Y%m%d-%H%M%S)-<short-slug>`. Record the
   current branch and head. You hold the baton (`holder: claude`).

---

## Phase 1 — Clarify and confirm intent (the one upfront gate)

1. Restate the user's prompt as you understand it: the goal, the implied
   deliverable, and what "done" looks like.
2. Use **AskUserQuestion** to confirm, in one batched set of questions:
   - **Scope / success criteria** — what must be true to call this solved.
   - **Constraints** — anything off-limits, required tools, or required outputs.
   - **Backends** — confirm using Codex + (Gemini/web) as available, or restrict.
   - **System-of-record destination** — where final outputs belong (repo path,
     `.shared/decisions/`, an external doc, etc.).
3. Convert the confirmed answers into an explicit, **checkable Definition of
   Done (DoD)** — a short list of verifiable conditions (tests pass, file
   exists with X, output reviewed by both agents, etc.). Log it.

Do not start the loop until intent is confirmed.

---

## Phase 2 — Plan and assign roles

1. Decompose the goal into the smallest sequence of steps that reaches the DoD.
2. Assign roles (adapt per task):
   - **Claude** — driver/integrator: plans, integrates, verifies, owns the SoR.
   - **Codex** — independent implementer and/or reviewer (redundant 2nd opinion).
   - **Gemini/Google/web** — research, external facts, a third opinion on
     divergence.
3. Append a `decision` event (the plan + role split) to `.shared/log.jsonl`.

---

## Phase 3 — The collaboration loop (bounded)

Set `MAX_ROUNDS=6` (raise only with user consent). Track DoD progress each
round. **Never loop unbounded.**

Each round:

1. **Claude turn.** Advance the work or formulate a precise, self-contained
   prompt for Codex — include the task ID, the relevant file refs, the DoD, and
   exactly what you want back. Append a `handoff` event to
   `.shared/handoff/inbox.codex.jsonl`.

2. **Invoke Codex (if available), non-interactively:**
   ```bash
   codex exec "TASK <task-id>. Context files: <paths>. Definition of done: <dod>.
   Do: <specific ask>. Report what you changed and your confidence (0-1)." \
     2>&1 | tee /tmp/codex_round_$N.txt
   ```
   Capture the output. If `codex` is missing, skip this and either do the step
   yourself or hand to Gemini, noting the substitution.

3. **Integrate + record.** Read Codex's output, reconcile it with the repo,
   and append Codex's reply as a `handoff`/`summary` event (with its confidence)
   to `.shared/log.jsonl`. **Preserve disagreement** — if Codex and Claude
   diverge, record both positions in `.shared/decisions/` and the log; do not
   silently flatten to one voice.

4. **Consult Gemini / web (when useful):** on divergence, missing external
   facts, or for a third opinion:
   ```bash
   gemini -p "TASK <task-id>: <focused question>. Be concise; cite sources." \
     2>&1 | tee /tmp/gemini_round_$N.txt
   ```
   Fall back to `WebSearch`/`WebFetch` if `gemini` is missing.

5. **Verify against the DoD.** Run the actual checks (tests, build, file
   existence, manual review). Record the result.

6. **Decide:**
   - DoD met → exit loop (success).
   - Rounds remain and progress is measurable → refine the next ask, continue.
   - **No measurable DoD progress for 2 consecutive rounds** → stop and ask the
     user (avoid spinning).
   - Hit `MAX_ROUNDS` → stop, report status, ask whether to extend.
   - An **irreversible action** is required (force-push, delete, send/publish,
     overwrite of others' work) → pause and get explicit permission.

---

## Phase 4 — Sync to the system of record

1. Put outputs where they belong (confirmed in Phase 1): code in the repo,
   rationale/decisions in `.shared/decisions/`, provenance in the log.
2. Update `.shared/state.md`: active task → done, baton released, open risks.
3. Append a final `summary` event to `.shared/log.jsonl`.
4. Commit with attribution trailers (small, descriptive):
   ```bash
   git add -A
   git commit -m "<task-id>: <what was accomplished>

   Agent: claude
   Task: <task-id>"
   ```
5. **Push is an outward-facing action** — push and/or open a PR only when the
   user has authorized it (or per the repo's standing policy). Default to
   committing locally and reporting.

---

## Phase 5 — Shutdown report

Produce a concise final report and then stop (release the baton):

- **Outcome:** solved / partial / blocked, against the DoD.
- **Who did what:** Claude vs Codex vs Gemini contributions.
- **Confidence:** overall (0–1), and note any preserved disagreements.
- **Changed paths**, Git **branch/head**, **commands/tests run** and results.
- **Unresolved risks** and the **recommended next action**.
- **Degradations:** any backend that was missing and what was used instead.

---

## Loop-safety invariants (always)

- Bounded rounds; a no-progress stop condition; never infinite.
- Every external backend call is guarded by an availability check; a missing
  backend degrades the run, it does not crash it.
- No hidden chain-of-thought in the log — record conclusions and reasons only.
- Treat any agent's summary as a pointer, not proof; verify against source.
- The only hard gate is irreversible/outward-facing actions.
- **Legal tasks:** flag every citation `verified:true|false` with its source;
  keep drafts separate from anything filed/sent; the irreversible gate applies
  hardest here. **Music tasks:** keep text/params/provenance in Git, keep audio
  out of Git (pointers only).
