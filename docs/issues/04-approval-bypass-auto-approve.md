# 04 — Approval bypass via global auto_approve

**Severity:** Low (defense-in-depth after account scoping)

**Partial resolution:** issue 02 made MCP servers account-owned, so unrelated users
can no longer change another account's approval policy. The remaining concern is the
risk inherent in an account member explicitly granting unattended tool access.

## Problem

`auto_approve` is a boolean on the global `mcp_servers` row, set by any user via a plain
checkbox on the create/edit form (`src/routes/mcp-servers.ts:32`). When every server
owning a tool-call batch is `auto_approve`, `driveRun` skips `parkForApproval` entirely
and executes model-chosen tool calls with model-chosen arguments, in a loop up to
`DEFAULT_MAX_TURNS` (10), with **no human review**:

- `isAutoApproved` — `src/services/runner.ts:410` (`server?.auto_approve === true`)
- inline execution / bypass — `src/services/runner.ts:611-627`

Before account scoping, any user could create or alter a shared server and enable
`auto_approve`. That cross-tenant bypass is resolved. An account member can still grant
unattended access to a malicious or compromised server, so invocation limits and clear
trust boundaries remain useful defense in depth.

Prompt-injection surface compounds this: tool `description`/`inputSchema`
(`mcp-client.ts:110-118`) and tool **result text** (`extractResultText`, `:123-134`) are
injected verbatim into the LLM context (`runner.ts:465-490`), so a malicious MCP server
can steer the model into calling its own tools.

## Fix

- Scope servers per user/org ([02](resolved/02-global-unowned-catalog.md)).
- Make `auto_approve` a per-user / per-conversation trust decision by the tool's actual
  owner, not a globally-writable flag. Consider forcing approval for any server not
  owned by the conversation's user.
- Cap/track total tool invocations per run independently of turn count.
- Clearly delimit and mark tool output as untrusted in the prompt.
