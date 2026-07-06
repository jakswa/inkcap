# 04 — Approval bypass via global auto_approve

**Severity:** High
**Reachable by:** any authenticated user (chains off [02](resolved/02-global-unowned-catalog.md))

## Problem

`auto_approve` is a boolean on the global `mcp_servers` row, set by any user via a plain
checkbox on the create/edit form (`src/routes/mcp-servers.ts:32`). When every server
owning a tool-call batch is `auto_approve`, `driveRun` skips `parkForApproval` entirely
and executes model-chosen tool calls with model-chosen arguments, in a loop up to
`DEFAULT_MAX_TURNS` (10), with **no human review**:

- `isAutoApproved` — `src/services/runner.ts:410` (`server?.auto_approve === true`)
- inline execution / bypass — `src/services/runner.ts:611-627`

Because the catalog is global and unowned ([02](resolved/02-global-unowned-catalog.md)), any user
can create — or flip on an existing shared server that others have enabled — an
`auto_approve: true` server. If that server points to an attacker-controlled public
endpoint, its tool calls then run server-side with no gate.

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
