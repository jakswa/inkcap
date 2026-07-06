# 07 — Non-transactional multi-row writes leave zombie streaming messages

**Severity:** High

## Problem

Multi-row state transitions are done as separate commits with no enclosing transaction,
so a failure — or even a single failed insert, no crash required — in the middle leaves
an inconsistent state that recovery can never seal.

### startRun (`src/services/runner.ts:693-709`)
`createMessage(streaming)` → `setConversationCurrNode` → `createRun` are three separate
commits. If `createRun` (or `gatherTools`/`emitEvent`) throws, `curr_node` points at a
permanent `status='streaming'` assistant message with **no run row**.
`recoverInterruptedRuns` scans only `runs` (`runs.ts:123`), so nothing ever finalizes it:
eternal spinner, and the next user turn parents onto a phantom streaming leaf. The error
path at `runner.ts:734-737` deletes the Map entry and rethrows but does **not** clean up
the message/curr_node it already committed.

### executeToolBatch (`src/services/runner.ts:505-519`)
`createMessage(streaming)` → `setConversationCurrNode` → `setRunLeafMessage`. A crash
between the last two leaves `run.leaf_message_id` pointing at the previous *sealed*
message; boot recovery checks `message.status === 'streaming'` (`runner.ts:888`), sees
`complete`, skips finalization, and parks only the run — the new streaming message is
orphaned forever.

## Fix

- Wrap each sequence in a single transaction (`sql.begin`).
- Make recovery additionally sweep `messages WHERE status='streaming'` older than a
  threshold, keyed by conversation, instead of trusting `leaf_message_id`.
