# 14 — Driverless running rows on finishRun failure

**Severity:** Medium

## Problem

If `finishRun` throws (a DB blip during finalization, `src/services/runner.ts:640-642`),
the error is logged, `activeRuns` is cleared, and the run stays `running` in the DB with
nobody driving it. The SSE endpoint (`src/routes/conversations.ts:711-716`) sees
`status='running'`, never calls `finish()`, and tails forever. Meanwhile `startRun`
(which never consults the DB) can create a second concurrent-looking `running` row. It
self-heals only at the next boot.

## Fix

- Retry finalization with backoff.
- Make the SSE terminal check also treat "no active handle + no recent event" as dead.
- The lease/heartbeat column from [06](06-runner-active-run-invariant-in-process.md)
  lets recovery reclaim these without a full restart.
