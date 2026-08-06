# Current State — end of session (resume here)

holder: code (cloud)  |  status: paused for the night

## DONE & safe on origin (pgvinter-lab/test @ ~600a48b)
- Hardened orchestration system: work-with-codex-to skill, PROTOCOL/AGENTS/CLAUDE,
  agents/ (watchers, dispatch_to_*, orchestrator_playbook, bridge_up, validate_event),
  finalize_task.py.
- Fixes landed: F1 (NO-GO blocker), F4, F7, F8, F10, F11, F12, F16, F17, plus the
  Windows launcher batch (F13/F14/F15/F23) and identity reconciliation + F27.
- Two deploy-readiness reviews + unified fix list (.shared/review/).

## Decisions locked
- bridge MCP = canonical cross-LLM sync (file-watchers = fallback only).
- lab/test = the cloud REPLICA target of the desktop system.
- Backup scope = take everything (system + case text); secrets + bulk media excluded.
  Destination branch: integrated-claude-desktop-codex-system-v1 (in pgvinter-lab/test,
  the only repo Code can currently reach; add_repo for a standalone repo unavailable).
- STARTUP.md (desktop bootup) FOUND; its 3-step structure is the model for the
  replica's onboarding — reconcile onto the bridge-MCP approach.

## FAILED tonight (not lost — just didn't transfer)
- Cowork desktop->origin full-system backup never pushed the branch. Desktop intact.
  Cause TBD: likely the broken local pgvinter-lab-test clone (unresolved merge:
  UU AGENTS.md, UU dispatch_to_codex.sh, stray 'auto: unblock rebase' stash) and/or
  gather complexity. Needs a fresh clone, not the broken one.

## OPEN for next session
1. Fix the broken local lab/test clone (blocks local runs incl. the --sandbox test).
2. Re-attempt the one-shot backup from a FRESH clone -> branch above.
3. Then: pull it, build the cloud replica (bridge MCP wired into .mcp.json, cloud-portable).
4. Backlog: F9 (stale-lock owner-stamp), Windows launcher verification on the box.

## How to resume
Read PROTOCOL.md, this file, and .shared/review/unified_fix_list.md.
