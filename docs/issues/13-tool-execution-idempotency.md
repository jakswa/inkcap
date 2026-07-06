# 13 — Non-idempotent tool execution (at-least-once, no journaling)

**Severity:** Medium

## Problem

Tool execution has no journaling and no idempotency key, so side effects can be lost or
duplicated.

- **Lost side effect:** `callTool` (`src/services/runner.ts:464-472`) commits nothing
  before executing. A crash between `callTool` and `createMessage(tool)` means the side
  effect happened but no record exists; recovery parks the run as `error` with no trace
  the tool ran.
- **Duplicate execution:** in `resumeParkedRun` (`runner.ts:811-821`), a crash after
  `decideRunApprovals` but before `setRunStatus('running')` leaves a `waiting_approval`
  run whose approvals are all decided — `listPendingApprovalsForRun` is empty so the UI
  shows no buttons (`routes/conversations.ts:114-116`), yet the run still gates on
  approval: stuck. A hand-crafted re-POST (or a second process) re-enters
  `resumeParkedRun`, `decideRunApprovals` no-ops, `listApprovalsForRun` returns the
  decided rows, and `executeToolBatch` **re-executes the tools**. No idempotency key is
  sent to MCP servers.

## Fix

- Per-approval `executing`/`executed` state, written before/after each `callTool`.
- Skip already-executed rows on resume.
- Pass `tool_call_id` to MCP servers as an idempotency hint.
