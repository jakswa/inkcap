# 15 — curr_node lost-update races between routes and startRun

**Severity:** Medium

## Problem

Every branching route guards with `getActiveRunHandle` early (e.g.
`src/routes/conversations.ts:383,447,495,526`) then performs multiple awaits before
writing `curr_node`. The check-then-act window allows interleaving:

1. Tab A passes the edit guard.
2. Tab B's `POST /messages` reserves the run and moves `curr_node`.
3. Tab A's `setConversationCurrNode` (`:420`) clobbers it.
4. A's `startRun` throws ("already streaming") but the damage is committed — the
   in-flight run now streams into a message that's off the active path, and
   `executeToolBatch` later yanks `curr_node` back (`runner.ts:515`), losing A's edit.

## Fix

- The DB unique index from [06](06-runner-active-run-invariant-in-process.md) prevents
  the concurrent run.
- Use conditional writes:
  `UPDATE conversations SET curr_node=... WHERE curr_node = <expected>`, or a
  transaction that re-checks for an active run before committing.
