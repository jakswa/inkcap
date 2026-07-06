# 05 — Tool approval not bound to execution endpoint (TOCTOU / confused deputy)

**Severity:** High

## Problem

The approval card the user reviews shows only `tool_name` + `arguments`
(`src/routes/conversations.ts:118-123`, `pending-approval.eta:7-8`). At resume,
execution **re-derives** the server set and routing table from *current* mutable config
rather than what existed at park time:

- `resumeParkedRun` — `src/services/runner.ts:771-853`
- `buildToolContext` → `listEnabledMcpServersForConversation` → `gatherTools`
- `callTool` routes purely by tool **name** against the freshly built `toolIndex`
  (`src/services/mcp-client.ts:197-217`, `executeToolBatch` at `runner.ts:446-465`)

Nothing binds the approved call to the server/URL that existed when the user clicked
approve. Combined with the globally-writable catalog ([02](resolved/02-global-unowned-catalog.md),
[04](04-approval-bypass-auto-approve.md)), an attacker can change a server's `url`/
`headers` between park and approve, so the victim's approved arguments are sent to an
attacker-controlled endpoint the victim never reviewed.

Even single-tenant: `gatherTools` resolves tool-name collisions as "last server wins"
(`mcp-client.ts:183`), so the displayed tool may not be the one executed.

## Fix

- Persist the resolved server id (and ideally a config hash) on the `tool_approvals`
  row at park time.
- Route the approved execution to **that** server; reject or re-prompt if the server
  config changed between park and resume.

## Related

- [02 — Global unowned catalog](resolved/02-global-unowned-catalog.md)
- [04 — Approval bypass via auto_approve](04-approval-bypass-auto-approve.md)
