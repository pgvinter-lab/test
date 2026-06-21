# Orchestrator playbook — "The Bridge" (agent 3)

This is the decision procedure a human + Claude Code run **in the local session
called "The Bridge."** The Bridge is the orchestrator (Code, "agent 3"). The
intelligence lives here, in this playbook — **the scripts contain no LLM calls.**
The scripts are actuators; the judgment is yours.

Read `PROTOCOL.md` and `agents/event_schema.md` first. This file assumes both.

## Topology (and how it evolved for The Bridge)

```
        ┌─────────────── The Bridge (Code / orchestrator, LOCAL) ───────────────┐
        │                                                                        │
  git push/pull                                                        codex exec (local)
        │                                                                        │
        ▼                                                                        ▼
   Cowork (cloud + Desktop Commander) ──drives──▶ Codex (local verify/mine)
```

PROTOCOL.md says "Code reaches Codex only transitively, through Cowork" — that holds
for **cloud** Code. The Bridge runs **locally**, so it has a *direct* local arm to
Codex (`dispatch_to_codex.sh`) in addition to the git path to Cowork
(`dispatch_to_cowork.sh`). Cowork can still drive Codex on its own; both Codex paths
land results in the one merged stream.

Identities: the orchestrator signs as **`code`** (commit trailer `Agent: code`).
Producers in the event stream are **`cowork`** and **`codex`** only.

## Inputs and outputs

- **Watch:** `.shared/events/orchestrator_inbox.jsonl` — the single merged event
  stream (7-key events; see `event_schema.md`). Tail it by byte offset.
- **Act:** `dispatch_to_cowork.sh` (git path) and `dispatch_to_codex.sh` (local path).
- **Record:** `.shared/log.jsonl` (append-only event bus; types `handoff`,
  `decision`, `disagreement`, `summary`, `output`, `state_change`, `question`),
  `.shared/state.md` (rebuildable snapshot), `.shared/decisions/` (ADRs + preserved
  disagreements).

## The loop (bounded)

```
bridge_up.sh                      # launch watchers + show the stream
for each NEW line in orchestrator_inbox.jsonl (by offset):
    1. PARSE + VALIDATE   exactly 7 keys; source∈{cowork,codex}; kind∈{result,progress,needs_input,error}
    2. DEDUPE             skip if (source,task,kind,ts,summary) or line-hash already handled  (at-least-once stream)
    3. CLASSIFY           by kind, then by content of summary/refs
    4. DECIDE             apply the decision table → choose: dispatch_codex | dispatch_cowork | STOP | PAUSE(human)
    5. GATE CHECK         if the action is irreversible/outward → PAUSE for explicit human ok (do not auto-run)
    6. DISPATCH           run the chosen script (humans in v1 confirm before you run it)
    7. LOG                append a `decision` (and the dispatch logs its own `handoff`/`output`)
    8. BOOKKEEP           round += 1 for this task; update the material-issues set; check stop conditions
```

### Per-task bookkeeping

Keep a tiny in-session ledger per `task`:
- `round` — increments each time you dispatch for that task.
- `materials` — the set of **material issues** seen so far (a *material* issue =
  a substantive correctness / citation / scope / safety problem, **not** style or
  formatting).
- `last_action` — what you dispatched last (to detect ping-pong).

## Decision table

| event (`source` / `kind`)        | classify as            | default next action (v1)                                                                                 |
|----------------------------------|------------------------|---------------------------------------------------------------------------------------------------------|
| `cowork` / `result`              | a draft/deliverable    | route to **Codex** for independent verify/mine → `dispatch_to_codex.sh` (parallel-check, PROTOCOL req 4) |
| `codex` / `result` — new issues  | verification w/ findings | send the findings back to **Cowork** as a revision → `dispatch_to_cowork.sh --kind revise`               |
| `codex` / `result` — no new issues | convergence signal     | **STOP** → write a `summary`, hand to human. (no new material issues = converged)                       |
| `cowork` or `codex` / `needs_input` | blocked on input     | if it needs the *other agent*, dispatch there; if it needs the *human/a decision* → **PAUSE**, surface it |
| `cowork` or `codex` / `error`    | failure                | inspect; **retry once** (re-dispatch, `round+1`) within bounds; after the retry budget → **PAUSE** human |
| any / `progress`                 | informational          | **log only**, no dispatch (optionally nudge if it indicates a stall)                                     |

"New issues" = the latest Codex result contains a material issue **not already in**
this task's `materials` set. If everything it raises is already known → no new issues
→ converged.

## Stop conditions (any one halts the task)

1. **Converged** — a verification round adds **no new material issues**.
2. **Bounded rounds** — `round` reaches `MAX_ROUNDS` (default **6** per task). Never
   loop unbounded; on the cap, STOP and hand to human with the open items.
3. **Needs a human decision** — surfaced `needs_input`, or any judgment call.
4. **Irreversible action required** — see the gate; PAUSE for explicit ok.
5. **Explicit human stop.**

On any stop: append a `summary` to `log.jsonl`, refresh `state.md`, and tell the
human what converged, what's open, and the recommended next step.

## Preserve disagreement (do not flatten)

If Codex and Cowork disagree, **do not pick a winner silently and do not average them
to a false consensus.** Record both positions and the reason for each in
`.shared/decisions/<task>-<topic>.md`, append a `disagreement` to `log.jsonl`, and
surface it to the human to resolve. Carrying an unresolved disagreement forward is
correct; erasing one is not.

## The irreversible-action gate (the only hard gate)

The orchestrator may freely: read, pull, branch, draft, log, dispatch a task entry
(commit+push of a NEW inbox line is the sanctioned mechanism), and run local Codex
verify/mine.

It must **PAUSE for explicit human ok** before anything that:
- **writes/overwrites/deletes** a tracked deliverable, or moves something out of draft;
- **sends / posts / pays / e-signs / submits / files** anything outward-facing;
- **force-pushes, resets, rewrites history, or merges** shared branches;
- lets Codex apply a change matching any of the above (don't auto-approve it).

When in doubt, it's gated. Pausing is cheap; an irreversible mistake is not.

## v1 vs. later

**v1 (now):** human-in-The-Bridge. The orchestrator classifies, proposes the next
task, and *the human confirms* before each dispatch. Convergence/stop are enforced
mechanically; the substantive call stays human.

**Later (a deliberate flip, not now):** headless autonomy — the same table, run
without per-step human confirmation, still bounded and still gated on irreversible
actions. Do not enable this until the operator explicitly flips it.

## Worked example (one cycle)

```
event: {"source":"cowork","kind":"result","task":"t-…-motion","summary":"Draft motion v1 ready",
        "refs":["outputs/cowork/.../motion.md"],"next_hint":"verify citations"}
classify → cowork/result (a draft)
decide   → independent verification by Codex
dispatch → echo "Verify every citation in outputs/.../motion.md against CourtListener;
            list any unresolved or mis-cited authority." | \
           bash agents/dispatch_to_codex.sh --task t-…-motion
log      → decision: "route cowork draft to codex for cite-check (round 1)"
next     → wait for the codex/result event; if it lists a NEW unresolved cite →
           dispatch_to_cowork.sh --kind revise; if none → STOP + summary (converged)
```

## Quick reference

```sh
bash agents/bridge_up.sh                                   # start of session
# dispatch to Cowork (git path):
bash agents/dispatch_to_cowork.sh --task <id> --kind revise --instruction "…" --refs a,b
# dispatch to Codex (local path):
echo "<prompt>" | bash agents/dispatch_to_codex.sh --task <id>
# preview without side effects:
… --dry-run
```
