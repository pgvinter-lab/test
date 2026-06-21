# Normalized orchestrator event schema

The two watcher daemons (`watch_cowork.py`, `watch_codex.py`) are **sensors**, not
agents. They detect when Cowork or Codex produces output and emit one *normalized*
event per signal into a single merged stream that Code (the orchestrator) reads:

```
.shared/events/orchestrator_inbox.jsonl   # append-only, one JSON object per line
```

## Event shape

Every line in `orchestrator_inbox.jsonl` is exactly these seven keys:

```json
{
  "ts":        "2026-06-21T17:10:00Z",          // ISO-8601 UTC; source ts if present, else emit time
  "source":    "cowork",                         // "cowork" | "codex" — which surface produced it
  "task":      "t-20260621-demo",                // task id (best-effort; "unknown" if undeterminable)
  "kind":      "result",                         // "result" | "progress" | "needs_input" | "error"
  "summary":   "Drafted section 2; 0 unresolved cites.",
  "refs":      ["outputs/cowork/t-20260621-demo/section2.md"],  // list of paths the event points at
  "next_hint": "Code: review section 2 and assign section 3."   // recommended next action (may be "")
}
```

`source` is closed to `cowork | codex`. `kind` is closed to
`result | progress | needs_input | error`.

## Where each field comes from

### From `inbox.code.jsonl` entries (both watchers)

The protocol's finalization-push entry is
`{ts, actor, task, status, did, flags_count, next_recommended, refs}`. Mapping:

| event field | inbox entry field(s) (first non-empty wins)        |
|-------------|----------------------------------------------------|
| `ts`        | `ts` → emit time                                   |
| `source`    | `actor`                                             |
| `task`      | `task` → `taskId` → `"unknown"`                     |
| `kind`      | `status` mapped via the table below → `"progress"` |
| `summary`   | `did` → `summary` → `msg` → `""`                    |
| `refs`      | `refs` (coerced to a list) → `[]`                  |
| `next_hint` | `next_recommended` → `next_hint` → `next` → `""`    |

`watch_cowork` keeps only entries with `actor == "cowork"`; `watch_codex` keeps only
`actor == "codex"`. They never both emit the same line.

### `status` → `kind` mapping

```
result   ← result, done, complete, completed, output, ok, finalized
progress ← progress, working, in_progress, wip, update, started
needs_input ← needs_input, needs-input, blocked, question, waiting, needs_human_review
error    ← error, failed, failure, fail
```

Unknown / missing status defaults to **`progress`** (a conservative "something happened,
disposition unclear" — never silently claims a result).

### From Codex artifacts (`watch_codex` only, `.shared/review/*`)

A new or changed file under `.shared/review/` becomes an event:

| event field | value                                                            |
|-------------|------------------------------------------------------------------|
| `ts`        | file mtime (UTC)                                                 |
| `source`    | `"codex"`                                                        |
| `task`      | a `t-YYYYMMDD-...` token found in the filename, else the stem    |
| `kind`      | `needs_input` if name contains `needs_human_review`/`needs_input`/`question`; `error` if `error`/`fail`; `progress` if `progress`/`wip`; else `result` |
| `summary`   | `"Codex artifact updated: review/<name>"`                       |
| `refs`      | `["review/<name>"]`                                              |
| `next_hint` | `""`                                                             |

Files whose name starts with `_` (e.g. `_codex_review_prompt.txt`) or `.` are treated
as scratch/inputs and ignored.

## Idempotency (cursors — never re-emit)

Each watcher persists a cursor next to the event stream; deleting a cursor replays from
scratch, which is the only way to get duplicates.

- `.shared/events/.cowork_cursor` — `{"sha": "<last remote tip>", "seen": ["<sha1 of each emitted inbox line>", ...]}`.
  The `sha` short-circuits cycles where the branch tip hasn't moved; the `seen` hash set
  guarantees that a *moved* tip whose inbox merely grew never re-emits already-seen lines.
- `.shared/events/.codex_cursor` — `{"files": {"review/<name>": "<mtime>:<size>", ...}, "entries": ["<sha1 of each emitted codex inbox line>", ...]}`.
  A review file re-emits only when its `mtime:size` signature changes.

## Read topology (why the two watchers read differently)

```
Code ←→ [git repo / .shared bus] ←→ Cowork ←→ [Desktop Commander] ←→ Codex (local)
```

- **`watch_cowork`** polls `git fetch` (default every 30s) and reads `inbox.code.jsonl`
  from the **git ref** `origin/<branch>` — Cowork's results reach this machine only as
  pushed commits, so the commit *is* the doorbell.
- **`watch_codex`** polls the **working tree** by mtime (default every 5s) — Codex writes
  to local disk and never goes through git, so there is nothing to fetch.

## Runtime files (all under `.shared/events/`, gitignored)

| file                       | written by         | purpose                              |
|----------------------------|--------------------|--------------------------------------|
| `orchestrator_inbox.jsonl` | both watchers      | the one merged event stream          |
| `.cowork_cursor`           | `watch_cowork.py`  | dedup state for the Cowork sensor     |
| `.codex_cursor`            | `watch_codex.py`   | dedup state for the Codex sensor      |
| `watch_cowork.log`         | `watch_cowork.py`  | per-cycle activity log               |
| `watch_codex.log`          | `watch_codex.py`   | per-cycle activity log               |
| `.inbox.lock`              | both watchers      | append lock so the merged stream never interleaves |
| `watchers.pid`             | `start_watchers.*` | PIDs for `stop_watchers.*`           |

These are **per-clone runtime state**, not shared artifacts — `.gitignore` excludes
`.shared/events/`. The scripts under `agents/` are the only shared part; each clone
regenerates its own event stream and cursors.

## Running

```sh
# Git Bash
bash agents/start_watchers.sh      # launches both, detached; writes watchers.pid; prints a banner
bash agents/stop_watchers.sh       # kills by PID

# PowerShell
powershell -ExecutionPolicy Bypass -File agents/start_watchers.ps1
powershell -ExecutionPolicy Bypass -File agents/stop_watchers.ps1
```

Single-pass (for testing / cron): `python agents/watch_cowork.py --once`,
`python agents/watch_codex.py --once`.

### Environment overrides

| var               | default                | used by | meaning                                            |
|-------------------|------------------------|---------|----------------------------------------------------|
| `SHARED_DIR`      | `<repo>/.shared`       | both    | base dir for `events/`, `review/`, `handoff/`      |
| `POLL_INTERVAL`   | `30` / `5`             | both    | seconds between cycles (cowork / codex)            |
| `SHARED_REMOTE`   | `origin`               | cowork  | git remote to fetch                                |
| `SHARED_BRANCH`   | current branch         | cowork  | branch to fetch/read                               |
| `COWORK_WATCH_REF`| `<remote>/<branch>`    | cowork  | ref to read the inbox from; `WORKTREE` = local file |
| `COWORK_NO_FETCH` | unset                  | cowork  | set truthy to skip `git fetch` (offline/testing)   |
