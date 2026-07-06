# 06 — Runner recovery lacks ownership leases/heartbeats

**Severity:** High

## Problem

The "one non-terminal run per conversation" invariant is now enforced in Postgres by
`runs_one_active_per_conversation_idx`, covering `running` and `waiting_approval` rows.
The remaining gap is recovery ownership: live process identity still exists only in the
process-local `Map` (`src/services/runner.ts` `activeRuns`).

### Scenario — recovery corrupts a live run (any rolling deploy)
A new process boots while the old one is still draining a stream.
`recoverInterruptedRuns()` (`src/index.ts:11`) sees the old process's run as
`status='running'`, cannot see the other process's `activeRuns`, and calls
`parkOrphanedRun` — splicing `[interrupted by restart]` into the middle of a message the
old process is still appending to, finalizing it `interrupted`, setting the run `error`.
The old process then keeps flushing deltas and overwrites status back to `complete`.
Result: garbage message, contradictory run states.

The kill-9 durability proof only covered the stop-the-world restart, not this overlap.

## Fixed

- Added a unique partial index on `runs(conversation_id)` where status is
  `running` or `waiting_approval`.
- `startRun` checks for blocking non-terminal rows, and `cancelRun` can cancel
  parked `waiting_approval` runs.

## Remaining Fix

- Add a process-identity / heartbeat (lease) column so recovery only sweeps runs whose
  owner is provably dead, not everything `running`.
