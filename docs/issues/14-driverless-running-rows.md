# 14 — Driverless running rows on finishRun failure

**Severity:** Medium

## Problem

If `finishRun` throws (a DB blip during finalization, `src/services/runner.ts`
`driveRun` fallback path), the error is logged, `activeRuns` is cleared in the
`finally`, and the run stays `running` in the DB with nobody driving it. The SSE
endpoint (`src/routes/conversations.ts`) sees `status='running'`, never calls
`finish()`, and tails forever.

Two claims from the original writeup no longer hold and are corrected here:

- *"`startRun` never consults the DB and can create a second `running` row"* —
  no longer true. `startRun` now checks `getBlockingRunForConversation`, and the
  partial unique index (`008_runs_active_unique.sql`) forbids a second active
  row. The failure mode is now a **blocked** conversation, not a duplicate run.
- *"self-heals only at the next boot"* — incomplete. `cancelRun` now sweeps an
  orphaned blocking row via `parkOrphanedRun`, so a user pressing Stop reclaims
  the slot without a restart. What still requires a boot (or the lease from
  [06](06-runner-active-run-invariant-in-process.md)) is an *unattended*
  reclaim — nobody presses Stop, and the SSE tail hangs until then.

## Fix

- Retry finalization with backoff.
- Make the SSE terminal check also treat "no active handle + no recent event" as dead.
- The lease/heartbeat column from [06](06-runner-active-run-invariant-in-process.md)
  lets recovery reclaim these without a full restart.
