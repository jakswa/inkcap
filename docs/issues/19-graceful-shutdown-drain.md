# 19 — No graceful shutdown: SIGTERM drops in-flight tokens

**Severity:** High (user-visible data loss on every deploy)
**Found:** ops-readiness audit, 2026-07-07

## Problem

`src/index.ts` installs no `SIGTERM`/`SIGINT` handler. The Dockerfile CMD is
exec-form (`Dockerfile:28`), so `bun` is PID 1 and receives the signal
directly — and exits immediately with default handling. The only `process.on`
in `src/` is the dev-only supervisor (`src/dev.ts:20-28`), which does not run
in production.

On `docker stop` (rolling deploy, host reboot, `kill`):

- The in-flight provider stream is killed mid-generation.
- The `DeltaFlusher` buffer (`src/services/runner.ts` — `FLUSH_MS=300`,
  `FLUSH_TOKENS=24`) has a `close()` method, but **nothing invokes it on
  shutdown**, so up to ~300 ms / 24 tokens of already-received deltas that
  live only in memory are permanently lost. The user sees a message that
  stops short of what the provider actually sent.
- The `runs` row stays `running` until the *next* boot's
  `recoverInterruptedRuns()` (`src/index.ts:11`) finalizes it as interrupted.
- SSE connections drop uncleanly.

This is distinct from the "delta-flush token loss" item on the README's
verified-clean list, which covers in-stream ordering, not shutdown flushing.
Issues 06/07/14 cover recovery and transactionality, not draining a live
process.

## Fix

Add a `SIGTERM`/`SIGINT` handler that:

1. Stops accepting new runs (and stops the HTTP `server`).
2. Aborts each active run handle.
3. Awaits each flusher's `close()` so buffered deltas are persisted, then
   `finishRun(handle, 'interrupted')`.
4. Exits. Docker's default 10 s grace window is ample for a debounce flush.

Boot recovery already seals anything a hard kill leaves behind, so this is
purely about not losing the last debounce window on an *orderly* stop.
