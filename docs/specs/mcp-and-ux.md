# MCP Registry + Chat UX Answer Key

Source: `llama-ui` (fork of llama.cpp web chat UI, Svelte SPA), strip-mined read-only.
This document is self-contained — do not open the fork. Field names, code excerpts and
sample payloads below are exact quotes/derivations from the source, current as of this
audit (2026-07-06).

Primary files referenced (all paths relative to the llama-ui repo, for provenance only —
you will never open them):

- `src/lib/types/mcp.d.ts` — MCP type definitions
- `src/lib/stores/mcp.svelte.ts` — MCP "Host" store (connections, tool routing, health checks)
- `src/lib/stores/agentic.svelte.ts` — the agentic tool-calling loop (this is the M6 runner spec)
- `src/lib/types/agentic.d.ts` — agentic message/flow types
- `src/lib/types/database.d.ts` — `DatabaseMessage`, `DatabaseConversation`, `McpServerOverride`
- `src/lib/stores/conversations.svelte.ts` — per-conversation MCP overrides, sibling navigation, fork
- `src/lib/stores/chat.svelte.ts` — edit/regenerate/continue/delete/stop implementations
- `src/lib/utils/branching.ts` — conversation-tree utilities (siblings, leaf resolution, descendants)
- `src/lib/services/database.service.ts` — IndexedDB delete semantics
- `src/lib/enums/tools.enums.ts` — `ToolSource`, `ToolPermissionDecision`
- `src/lib/stores/permissions.svelte.ts` — "always allow" tool permission persistence
- `src/lib/components/.../ChatMessageActionCardPermissionRequest.svelte` — approval UI
- `src/lib/components/.../ChatMessage.svelte`, `ChatMessages.svelte` — UI wiring for all message actions

---

## Part A — MCP Registry

### A.1 Full shape of a registry entry

```ts
// src/lib/types/mcp.d.ts
export interface MCPServerDisplayInfo {
  id: string;
  name?: string;
  url: string;
}

export type MCPServerSettingsEntry = MCPServerDisplayInfo & {
  enabled: boolean;                 // see A.4 — this is NOT "usable in this chat"
  requestTimeoutSeconds: number;
  headers?: string;                 // JSON-encoded string, e.g. '{"Authorization":"Bearer sk-..."}'
  iconUrl?: string;
  useProxy?: boolean;                // route requests through server's CORS proxy
};
```

So the full field list, with types, is:

| field | type | notes |
|---|---|---|
| `id` | `string` | stable id; either user-supplied or auto-generated `${MCP_SERVER_ID_PREFIX}-${index+1}` where `MCP_SERVER_ID_PREFIX = 'LlamaUI-MCP-Server'` (see `#generateServerId`) |
| `name` | `string \| undefined` | optional display name; falls back to URL in the UI |
| `url` | `string` | the MCP server endpoint |
| `enabled` | `boolean` | "registered/visible in Settings" flag — see A.4, this is a trap |
| `requestTimeoutSeconds` | `number` | default `300` (5 min) — see `DEFAULT_MCP_CONFIG.requestTimeoutSeconds` |
| `headers` | `string \| undefined` | **JSON-encoded object as a string**, e.g. custom auth headers; parsed with `JSON.parse` at connect time, swallowed with a `console.warn` on parse failure |
| `iconUrl` | `string \| undefined` | not used for actual icon resolution at runtime (see A.3, icons come from the live MCP handshake) |
| `useProxy` | `boolean \| undefined` | if true, requests are proxied through the backing llama-server's CORS proxy (`isProxyAvailable` gates this on `serverStore.props?.cors_proxy_enabled`) |

Storage: the entire array is JSON-stringified into one settings key,
`SETTINGS_KEYS.MCP_SERVERS` (part of the generic app-settings blob, not its own table).
`addServer`/`updateServer`/`removeServer` all read the full array, mutate it, and
`JSON.stringify` it back into that single key — there is no per-server row.

Sample stored value (what you'd find in the settings blob under `mcpServers`):

```json
[
  {
    "id": "LlamaUI-MCP-Server-1",
    "name": "Exa Search",
    "url": "https://mcp.exa.ai/mcp",
    "enabled": true,
    "requestTimeoutSeconds": 300,
    "headers": "{\"Authorization\":\"Bearer sk-exa-xxxx\"}",
    "useProxy": false
  },
  {
    "id": "local-fs",
    "name": "Filesystem",
    "url": "http://localhost:9001/mcp",
    "enabled": true,
    "requestTimeoutSeconds": 60,
    "useProxy": true
  }
]
```

There is also a related but distinct type for onboarding-only entries:

```ts
export interface RecommendedMCPServer extends MCPServerDisplayInfo {
  description: string;
  enabled: boolean;
  requestTimeoutSeconds: number;
}
```
These are pre-canned servers (ids tracked in `RECOMMENDED_MCP_SERVER_IDS`) shown in a
recommendations dialog; a user "opts in" to one via a per-chat override (see A.4), and
`optedInRecommendationIds` is the source of truth for "has the user accepted this
recommendation anywhere."

### A.2 Connection config derived from a registry entry

`#buildServerConfig(entry)` turns a `MCPServerSettingsEntry` into the actual transport
config used to connect:

```ts
export type MCPServerConfig = {
  transport?: MCPTransportType;      // detected from URL (e.g. http vs sse vs ws) via detectMcpTransportFromUrl
  url: string;
  protocols?: string | string[];
  headers?: Record<string, string>;  // parsed from entry.headers JSON string
  credentials?: RequestCredentials;
  handshakeTimeoutMs?: number;       // DEFAULT_MCP_CONFIG.connectionTimeoutMs = 10_000
  requestTimeoutMs?: number;         // entry.requestTimeoutSeconds * 1000
  capabilities?: ClientCapabilities;
  useProxy?: boolean;
};
```

Multiple servers combine into:

```ts
export type MCPClientConfig = {
  servers: Record<string, MCPServerConfig>;  // keyed by server id
  protocolVersion?: string;                   // DEFAULT_MCP_CONFIG.protocolVersion
  capabilities?: ClientCapabilities;           // DEFAULT_MCP_CONFIG.capabilities = { tools: { listChanged: true } }
  clientInfo?: Implementation;                 // { name: MCP_CLIENT_NAME, version: ... }
  requestTimeoutMs?: number;
};
```

### A.3 Lifecycle: connect → list tools → call

1. **Build config.** `ensureInitialized(perChatOverrides?)` builds an `MCPClientConfig`
   from the settings-stored array, filtered to only the servers enabled *for this
   conversation* (see A.4). It computes a signature (`JSON.stringify(mcpConfig)`) and
   short-circuits if already connected with the same signature (avoids reconnect churn
   on every render).
2. **Connect.** For every server entry, `MCPService.connect(name, serverConfig,
   clientInfo, capabilities, onPhaseChange, listChangedHandlers)` performs the
   transport handshake. Connections run via `Promise.allSettled` — one server failing
   does not block the others. Each successful connection becomes an `MCPConnection`:
   ```ts
   export interface MCPConnection {
     client: Client;
     transport: Transport;
     tools: Tool[];
     serverName: string;
     transportType: MCPTransportType;
     serverInfo?: MCPServerInfo;           // { name, version, title?, description?, websiteUrl?, icons? }
     serverCapabilities?: ServerCapabilities;
     clientCapabilities?: ClientCapabilities;
     protocolVersion?: string;
     instructions?: string;                 // server-provided system-prompt-like instructions
     connectionTimeMs: number;
     requestTimeoutMs: number;
   }
   ```
3. **List tools.** `connection.tools` is populated at connect time from the MCP
   `tools/list` call (inside `MCPService.connect`, not shown separately here — treat it
   as part of connect). A `toolsIndex: Map<toolName, serverName>` is built across ALL
   connected servers so a tool name can be routed back to its owning server. **Tool
   name collisions across servers are resolved "last write wins"** with a
   `console.warn` — no namespacing/prefixing of tool names is done.
4. **listChanged handling.** If a server later emits a `tools/listChanged`
   notification, `handleToolsListChanged` clears that server's old tool-index entries
   and rebuilds them, again logging (not erroring) on name collisions.
5. **Call a tool.** `executeTool(toolCall, signal)` looks up owning server by name,
   parses `toolCall.function.arguments` (string or object — string is `JSON.parse`d,
   must decode to a plain object or it throws), and calls
   `MCPService.callTool(connection, { name, arguments }, signal)`. On a "session
   expired" error (HTTP 404 per MCP spec 2025-11-25 — client must discard the session
   id and reinitialize) it transparently reconnects once and retries the same call.
6. **Auto-reconnect.** If the phase callback reports `DISCONNECTED` outside of an
   explicit tool-call retry (e.g. a WebSocket drop), `autoReconnect(serverName)` runs an
   indefinite exponential-backoff reconnect loop: initial delay `1000ms`, multiplier
   `2`, cap `30000ms`, each attempt itself timing out after `15000ms`
   (`MCP_RECONNECT_*` constants). A re-entrancy guard (`reconnectingServers` Set) plus a
   deferred-retry flag (`needsReconnect`) prevents duplicate concurrent reconnect loops.
7. **Reference counting, not per-message teardown.** `acquireConnection()` /
   `releaseConnection(shutdownIfUnused=false)` bracket each agentic flow run.
   Connections are **kept alive by default** across turns/messages/flows (MCP spec
   encourages long-lived sessions) — `shutdown()` is only called explicitly, or when a
   different signature makes the current connection set stale.
8. **Health checks are a separate, UI-only connection path** (`runHealthCheck`), used
   by the settings page to preview a server (tools, capabilities, instructions) without
   committing to using it. If `promoteToActive` is passed and the server is enabled, a
   successful health-check connection is promoted into the live `connections` map
   instead of being torn down — this avoids a redundant reconnect the moment the user
   actually sends a message.

### A.4 Per-conversation override semantics (this is the part to get exactly right)

There are **two independent enabled flags** and it is easy to conflate them:

1. **`MCPServerSettingsEntry.enabled`** (global, in the settings blob) — despite the
   name, this does **not** gate whether the server's tools are sent to the LLM. It only
   gates whether the server shows up as *selectable* in UI surfaces:
   ```ts
   hasAvailableServers(): boolean {
     return parseMcpServerSettings(config().mcpServers).some((s) => s.enabled && s.url.trim());
   }
   get visibleMcpServers(): MCPServerSettingsEntry[] {
     const optedIn = this.optedInRecommendationIds;
     return this.getServersSorted().filter(
       (server) => server.enabled && (!RECOMMENDED_MCP_SERVER_IDS.has(server.id) || optedIn.has(server.id))
     );
   }
   ```

2. **Per-conversation override** — the only thing that actually determines whether a
   server's tools are connected/exposed to the model **for a given conversation**:
   ```ts
   // src/lib/types/database.d.ts
   export interface McpServerOverride {
     serverId: string;
     enabled: boolean;
   }
   export interface DatabaseConversation {
     ...
     mcpServerOverrides?: McpServerOverride[];
     ...
   }
   ```
   The gate function, verbatim:
   ```ts
   #checkServerEnabled(server: MCPServerSettingsEntry, perChatOverrides?: McpServerOverride[]): boolean {
     const override = perChatOverrides?.find((o) => o.serverId === server.id);
     return override?.enabled ?? false;
   }
   ```
   **Note the default: `?? false`.** If a conversation has no override entry for a
   server at all, that server is *disabled* for that conversation — global `enabled:
   true` in settings is irrelevant. A server must be explicitly turned on per
   conversation (or via the defaults mechanism below) to ever be connected/used in that
   conversation. `#buildMcpClientConfig` calls `#checkServerEnabled` and skips any
   server that fails it — global `enabled` is never consulted at that point.

3. **Storage of the override list:**
   - Existing conversation → `DatabaseConversation.mcpServerOverrides` (persisted row),
     mutated via `conversationsStore.setMcpServerOverride(serverId, enabled |
     undefined)`. Passing `undefined` *removes* the override entry (reverts to
     "disabled by default" for that server in that conversation), it is not the same as
     `enabled: false` staying in the array (though behaviorally identical today, since
     `?? false` treats both as off).
   - **New conversation not yet created** → `conversationsStore.pendingMcpServerOverrides`,
     a `$state` array seeded from a *separate settings key*,
     `SETTINGS_KEYS.MCP_DEFAULT_SERVER_OVERRIDES` (a "sticky defaults for new chats"
     concept, saved via `saveMcpDefaults()` every time a pending override changes).
     When the first message of a new conversation is sent, this pending array becomes
     that conversation's persisted `mcpServerOverrides`
     (`conversationsStore` line ~293-303 — copies `pendingMcpServerOverrides` onto the
     newly created conversation, then clears the pending array).
   - Toggling API: `toggleMcpServerForChat(serverId)` flips the current effective
     enabled bit; `removeMcpServerOverride(serverId)` clears it back to "no override →
     disabled".

4. **How the override list reaches the runner.** In `chatStore`'s send path:
   ```ts
   const perChatOverrides = conversationsStore.activeConversation?.mcpServerOverrides;
   const agenticResult = await agenticStore.runAgenticFlow({
     conversationId: convId,
     messages: allMessages,
     options: { ...this.getApiOptions(), ...(effectiveModel ? { model: effectiveModel } : {}) },
     callbacks: streamCallbacks,
     signal: abortController.signal,
     perChatOverrides
   });
   ```
   Inside `runAgenticFlow`, `perChatOverrides` flows to
   `mcpStore.hasEnabledServers(perChatOverrides)` and
   `mcpStore.ensureInitialized(perChatOverrides)`, which is what actually filters the
   connect set per A.4.2 above.

5. **Important consequence for spail's design:** the "enabled" checkbox in a
   per-conversation MCP picker is really the *only* switch that matters at
   request-time. The global settings list is closer to a *catalog* (what servers exist,
   with connection details) than a live-enablement toggle. Spail's server-side
   equivalent should probably keep this same two-layer split: a global server catalog
   + a per-conversation (or per-request) allow-list, defaulting to nothing enabled.

### A.5 Tool-call approval UX

Permission decisions are a 4-way enum:
```ts
// src/lib/enums/tools.enums.ts
export enum ToolPermissionDecision {
  ALWAYS = 'always',
  ALWAYS_SERVER = 'always_server',
  ONCE = 'once',
  DENY = 'deny'
}
```

Approval card copy/actions (from `ChatMessageActionCardPermissionRequest.svelte`):
- **"Allow once"** → `ONCE`
- dropdown → **"Always allow `<toolName>` tool"** → `ALWAYS`
- dropdown → **"Always allow all tools from `<serverLabel>`"** (or "Approve all tools
  from MCP Tools" if no server label, e.g. builtin/custom tools) → `ALWAYS_SERVER`
- **"Deny"** → `DENY`

Message shown: `Allow use of **{toolName}** from **{serverLabel}**?` (server clause
omitted for non-MCP tool sources).

Persistence and resolution logic (`agenticStore.requestPermission`):
```ts
private async requestPermission(conversationId, toolName, serverLabel, signal): Promise<ToolPermissionDecision> {
  const permissionKey = toolsStore.getPermissionKey(toolName);
  if (permissionKey && permissionsStore.hasTool(permissionKey)) {
    return ToolPermissionDecision.ONCE;   // already "always allowed" earlier -> auto-approve silently
  }
  this._pendingPermissions.set(conversationId, { toolName, serverLabel });
  return new Promise<ToolPermissionDecision>((resolve) => {
    ...
    this._permissionResolvers.set(conversationId, (decision) => {
      this._pendingPermissions.set(conversationId, null);
      if (decision === ToolPermissionDecision.ALWAYS && permissionKey) {
        permissionsStore.allowTool(permissionKey);
      } else if (decision === ToolPermissionDecision.ALWAYS_SERVER) {
        const serverToolKeys = toolsStore.allTools
          .filter((t) => t.serverName ? t.serverName === serverLabel
                                       : toolsStore.getToolServerLabel(t.definition.function.name) === serverLabel)
          .map((t) => toolsStore.getPermissionKey(t.definition.function.name)!)
          .filter((k): k is string => k !== null);
        permissionsStore.allowTools(serverToolKeys);
      }
      resolve(decision);
    });
    signal?.addEventListener('abort', () => { /* resolves DENY if the flow is cancelled mid-prompt */ }, { once: true });
  });
}
```
Key behavior points:
- **`ONCE` and `ALWAYS`/`ALWAYS_SERVER` are NOT equivalent** — only `ALWAYS`/
  `ALWAYS_SERVER` persist anything. `ONCE` approves just this single call and will
  prompt again next time.
- "Always allow" persistence is entirely client-local: `permissionsStore` keeps a
  `Set<string>` of tool "permission keys" (the tool's identity key, from
  `toolsStore.getPermissionKey(toolName)`) serialized to `localStorage` under
  `ALWAYS_ALLOWED_TOOLS_LOCALSTORAGE_KEY`. It is **not per-conversation** and **not
  synced to the DB** — it is a single flat allow-list for the whole browser profile.
  On future calls, `requestPermission` checks this set FIRST and silently returns
  `ONCE` (auto-approved) without ever surfacing the UI card.
- `DENY` does not throw — it produces a synthetic tool result: the string
  `'Tool execution was denied by the user.'` fed back to the model as if it were the
  tool's output (`toolSuccess = false`). The model sees a normal tool-result message
  and can react/apologize/try something else; the loop is not aborted.
- If the abort signal fires while a permission prompt is outstanding (chat is
  stopped), the pending promise resolves `DENY` too.
- Per-turn UI also exposes `pendingPermissionRequest(conversationId): { toolName,
  serverLabel } | null` for the exact rendering the message list should show while
  paused, and a "streamingToolCall" preview (`{ name, arguments }` partial JSON as it
  streams) shown before the call is even dispatched.
- There is also a **turn-limit approval gate**, structurally identical in shape: once
  `turn >= maxTurns` (default 100, `DEFAULT_AGENTIC_CONFIG.maxTurns`), the loop calls
  `requestContinue(conversationId, signal)` which blocks on a "keep going?" yes/no from
  the user (`agenticPendingContinueRequest` / `agenticResolveContinue`). Declining ends
  the flow; accepting resets the turn counter to 0 and continues.

---

## Part B — Tool-call flow (the M6 runner-loop spec)

### B.1 Wire shapes

Per-turn assistant/tool messages sent back to the LLM as the running conversation
(`AgenticMessage`, `src/lib/types/agentic.d.ts`):
```ts
export type AgenticToolCallPayload = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };   // arguments is a JSON string, NOT an object
};

export type AgenticMessage =
  | { role: 'system' | 'user'; content: string | ApiChatMessageContentPart[] }
  | { role: 'assistant';
      content?: string | ApiChatMessageContentPart[];
      reasoning_content?: string;
      tool_calls?: AgenticToolCallPayload[] }
  | { role: 'tool'; tool_call_id: string; content: string | ApiChatMessageContentPart[] };
```

Persisted shape (`DatabaseMessage`, one row per turn/tool-result — see B.4):
```ts
export interface DatabaseMessage {
  id: string;
  convId: string;
  type: ChatMessageType;
  timestamp: number;
  role: ChatRole;              // 'system' | 'user' | 'assistant' | 'tool'
  content: string;
  parent: string | null;
  reasoningContent?: string;
  toolCalls?: string;           // JSON-serialized array of tool calls, empty string '' if none
  completionId?: string;        // server-streamed chat-completion id, for realtime control
  toolCallId?: string;           // ONLY set on role:'tool' rows — links back to the call it answers
  children: string[];
  extra?: DatabaseMessageExtra[];
  timings?: ChatMessageTimings;
  model?: string;
}
```

The linkage is exactly OpenAI-style: an assistant message's `tool_calls[i].id` must
equal the `tool_call_id` on the subsequent `role: 'tool'` message that answers it. Each
tool call gets its own separate `role: 'tool'` DB row (not batched into one message),
created **in the same order the calls were issued**, immediately after execution.

### B.2 Sample request/response for one agentic turn

Request sent to the completions endpoint (via `ChatService.sendMessage`, which is a
thin streaming wrapper — not reproduced here since it's just HTTP/SSE plumbing):
```json
{
  "model": "qwen2.5-72b-instruct",
  "stream": true,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "web_search",
        "description": "Search the web for a query",
        "parameters": {
          "type": "object",
          "properties": { "query": { "type": "string" } },
          "required": ["query"]
        }
      }
    }
  ],
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "What's the weather in Tokyo right now?" }
  ]
}
```

Model's streamed reply resolves into (turn 1, no visible content, one tool call):
```json
{
  "role": "assistant",
  "content": "",
  "tool_calls": [
    { "id": "call_abc123", "type": "function", "function": { "name": "web_search", "arguments": "{\"query\":\"Tokyo weather now\"}" } }
  ]
}
```

Tool execution result is fed back as (note role `tool`, and `tool_call_id` matching):
```json
{ "role": "tool", "tool_call_id": "call_abc123", "content": "Tokyo: 21°C, partly cloudy, humidity 58%." }
```

Turn 2 request re-sends the FULL running message list (system + user + assistant-with-
tool_calls + tool-result) plus `tools` again, and the model now produces a final
assistant message with no `tool_calls` — that ends the loop for this send.

### B.3 The loop itself, condensed to its control flow (from `executeAgenticLoop`)

```
sessionMessages = toAgenticMessages(initialMessages)   // DB/API messages -> AgenticMessage[]
turn = 0
loop:
  if turn >= maxTurns:
    shouldContinue = await requestContinue(...)          // user-facing "keep going?" gate
    if !shouldContinue or aborted: flush + return
    turn = 0                                             // limit resets, loop keeps running
  if turn > 0: createAssistantMessage()                  // new DB row for this turn
  stream chat completion with `tools` attached
    accumulate turnContent, turnReasoningContent, turnToolCalls (parsed incrementally from deltas)
  if aborted mid-stream: persist partial turnContent as final content, flush, return
  if a "steering message" was queued by the user during this turn: persist turn, flush, return
       (caller re-sends the queued message as a NORMAL new user message — NOT injected
        mid-loop; the agentic flow always exits cleanly first)
  if turnToolCalls.length == 0:
    persist assistant turn (final answer) -> onAssistantTurnComplete(content, reasoning, timings, undefined)
    flush, return                                        // <- normal end of a run
  normalize tool calls (ensure id/type/function.name/arguments all present, synth id `tool_${i}` if missing)
  persist assistant turn WITH tool_calls -> onAssistantTurnComplete(content, reasoning, timings, calls)
  append that assistant message to sessionMessages
  for each toolCall in order:
    if aborted: flush, return
    if steering message queued: mark THIS and all REMAINING calls in the batch as
        `'Tool execution was interrupted by a new user message.'` tool-result rows, break
    resolve toolSource (builtin / frontend-sandbox / mcp) via toolsStore.getToolSource
    permission = await requestPermission(...)             // may block on user UI
    if DENY: result = 'Tool execution was denied by the user.', success=false
    else: dispatch to the right executor:
        BUILTIN  -> ToolsService.executeTool(name, args, signal)
        FRONTEND -> SandboxService.executeTool(name, args, signal)   // sandboxed client-side tool
        else/MCP -> mcpStore.executeTool({id, function:{name,arguments}}, signal)
    extract any base64 data-URI image payloads out of the raw tool text result into
        DatabaseMessageExtra attachments (images become extra vision content parts,
        NOT left inline as huge base64 blobs in `content`)
    createToolResultMessage(toolCallId, cleanedResult, attachments) -> DB row, role 'tool'
    append { role:'tool', tool_call_id, content: cleanedResult (or content-parts incl. image_url if
        the model supports vision) } to sessionMessages
  turn++
  goto loop head (this re-issues a completion call with the now-longer sessionMessages)
```

Everything (`onAssistantTurnComplete`, `createToolResultMessage`,
`createAssistantMessage`) is a **callback injected by the caller** (`chatStore`), which
is what actually persists rows via `DatabaseService` and mirrors them into the reactive
`activeMessages` array. The agentic store itself has zero direct DB dependency — it's a
pure orchestration loop parameterized entirely by callbacks. This is the cleanest
mapping onto a server-side runner: swap the callbacks for direct DB writes / SSE emits,
keep the same state machine.

### B.4 Where a turn falls back to non-agentic streaming

`runAgenticFlow` returns `{ handled: false }` (and the caller falls through to a plain,
non-tool `ChatService.sendMessage` call) whenever:
- `agenticConfig.enabled` is false — computed as `hasTools && DEFAULT_AGENTIC_CONFIG.enabled`,
  where `hasTools = mcpStore.hasEnabledServers(perChatOverrides) || toolsStore.builtinTools.length > 0
  || toolsStore.customTools.length > 0`. In practice: **if there are zero enabled
  tools of any kind for this conversation, the request never gets a `tools` array at
  all** — not even an empty one.
- `toolsStore.getEnabledToolsForLLM()` (union of MCP + builtin + custom tool
  definitions, filtered to whatever is actually enabled) is empty.

This means "agentic" isn't a mode toggle so much as an emergent behavior: it only
activates when there is something to call.

---

## Part C — UX Answer key

Conventions used below:
- "Tree" = the `DatabaseMessage.parent`/`children[]` linked structure per conversation.
  There's always a synthetic `root` node (`type: 'root', parent: null`) as the tree
  root; the first real message's `parent` is that root id.
- "Current path" = `filterByLeafNodeId(allMessages, conversation.currNode, includeRoot)`
  — walks from `currNode` up to root via `.parent`, then re-sorts ascending by
  timestamp (system messages forced first). This is exactly what's rendered as
  `activeMessages`.
- "Leaf" = a message with `children.length === 0`.
- `findLeafNode(messages, id)` walks DOWN from `id`, always following the **last**
  element of `children[]` at each level (i.e. the most-recently-created branch), until
  it hits a childless node. This is the "which sub-branch does this jump land on"
  answer used everywhere below.

### C.1 Edit a user message

Two distinct user-facing actions exist; they are NOT the same button:

**(a) "Save" (branching edit) — `chatStore.editMessageWithBranching(messageId, newContent, newExtras?)`**
- Wired from `ChatMessages.svelte`'s `editWithBranching` action, called on the primary
  Save when editing a `role: 'user'` (or `role: 'system'`) message.
- Tree mutation:
  - If the message currently has **no children** (nothing was ever generated in
    response, e.g. user edits before the assistant reply lands, or edits the very last
    message in the branch) → **update in place**: same message id, `content` and
    `timestamp` overwritten via `DatabaseService.updateMessage`. No new node. No
    sibling created.
  - If the message **has children** (there is at least one existing response
    downstream) → **create a brand-new sibling message** (same `parent`, new id) via
    `DatabaseService.createMessageBranch(..., parentId)`, and set
    `conversation.currNode` to that new message's id. The original message and its
    whole subtree are preserved untouched as an alternate sibling branch, reachable via
    sibling navigation (C.3).
- Display: `refreshActiveMessages()` re-derives the path from the (possibly new)
  `currNode`. If a new sibling was made, the previously-visible assistant replies
  disappear from view (they're still in the DB, just off the newly-active path) and are
  replaced by nothing yet — because:
- If the edited message's role is `user`, this ALWAYS triggers a brand-new response
  generation afterward: `await this.generateResponseForMessage(messageIdForResponse)`.
  So "edit user message" == "branch (or replace) + immediately regenerate the
  assistant's reply to it." If role is `system`, no regeneration is triggered (a system
  prompt edit doesn't get "replied to").
- Title regeneration: if the edited message is the conversation's first user message,
  the conversation title is regenerated from the new content (with a confirmation
  dialog if the user has manually renamed the conversation — see
  `updateConversationTitleWithConfirmation`, not detailed further here).

**(b) "Save (keep responses)" — `chatStore.editUserMessagePreserveResponses(messageId, newContent, newExtras?)`**
- Wired from `ChatMessages.svelte`'s `editUserMessagePreserveResponses`, only offered
  for `role: 'user'` messages, via a distinct `handleSaveEditOnly` UI path.
- Tree mutation: **always in place** — same message id, content/extra overwritten.
  **No branching, no deletion, no regeneration request.** The existing children
  (assistant replies) are left exactly as they were, now logically "answering" the
  edited text even though they were generated against the old text.
- Display: content updates in place; nothing downstream changes.
- Use this when the user wants to correct a typo/detail without discarding the
  existing conversation continuation.

### C.2 Edit an assistant message

`chatStore.editAssistantMessage(messageId, newContent, shouldBranch: boolean)` — wired
from `editWithReplacement`. `shouldBranch` is a **user-visible toggle in the edit UI**
(`shouldBranchAfterEdit`, a checkbox-like state defaulting to `false`, read at Save
time).
- `shouldBranch = false` (default): **update in place** — same message id and position
  in the tree, `content` overwritten via `DatabaseService.updateMessage` +
  `conversationsStore.updateMessageAtIndex`. No LLM call is made — this is a pure
  manual text edit of what the assistant "said."
- `shouldBranch = true`: **create a new sibling assistant message** under the same
  `parent`, seeded with `newContent` (and the original's `toolCalls`/`model` copied
  over), then set `currNode` to the new message. The prior assistant response becomes
  an alternate sibling, still reachable. **No LLM call here either** — branching an
  assistant edit is still just a manual content substitution, not a regenerate. (If the
  user wants a fresh LLM-authored answer, that is what "Regenerate" — C.4 — is for.)
- Neither path deletes descendant messages. If the original assistant message had
  children (e.g. a follow-up user message under it) and `shouldBranch=false`, those
  children remain, now hanging off the edited content. If `shouldBranch=true`, the new
  sibling starts with an empty `children: []` — i.e. any subsequent conversation under
  the OLD response is only reachable by navigating back to that old sibling.

### C.3 Switching between siblings (branch navigation)

`conversationsStore.navigateToSibling(siblingId)`:
- Input `siblingId` need not itself be a leaf — it's typically one of the ids returned
  by `getMessageSiblings(...).siblingIds`, which are **already resolved to each
  sibling's leaf** (`ChatMessageSiblingInfo.siblingIds` stores leaf ids, per
  `buildSiblingInfoMap`/`getMessageSiblings` in `branching.ts`):
  ```ts
  const siblingLeafIds = siblingIds.map((id) => findLeafNodeInMap(nodeMap, id));
  ```
- Regardless, `navigateToSibling` re-resolves `findLeafNode(allMessages, siblingId)`
  itself before use, so **the path below the switch point is always the deepest/most-
  recently-extended path under that sibling** (follow last-child repeatedly) — NOT
  necessarily the sibling message itself if it has any descendants, and NOT "the
  shortest path" or "the first-created path."
- Mutation: `conversation.currNode` is set to that resolved leaf id (persisted via
  `DatabaseService.updateCurrentNode` + local state mirror), then
  `refreshActiveMessages()` re-derives the full displayed path from root to that leaf.
- Side effect: if switching changes what the conversation's first user message is (only
  possible if you're navigating a branch that forked all the way back near the root)
  and the new first message has non-empty content differing from the old one, the
  conversation title is regenerated from it.
- UI sibling metadata surfaced per message (`ChatMessageSiblingInfo`):
  ```ts
  { message, siblingIds: string[], currentIndex: number, totalSiblings: number }
  ```
  used to render "‹ 2 / 3 ›" style controls.

### C.4 Regenerate an assistant message

Only one path is actually wired to the UI: **`regenerateMessageWithBranching(messageId,
modelOverride?)`** (the older non-branching `regenerateMessage` exists in the store but
has no caller in any component — see Gaps).
- Tree mutation: looks up the target assistant message's `parent`, creates a **new
  sibling assistant message** under that same parent (empty content, to be streamed
  into), sets `currNode` to the new message, refreshes the active path. The original
  assistant response (and anything that had been built on top of it) is preserved as an
  alternate sibling, exactly like C.1(a)'s branching case.
- The conversation path used as LLM context is `filterByLeafNodeId(allMessages,
  parentMessage.id, false)` — i.e. everything up to and including the parent, but NOT
  including the old assistant response being regenerated.
- `modelOverride`, if given (e.g. user picks a different model from a dropdown next to
  the message), overrides the model for just this regeneration; otherwise it reuses
  `msg.model` (the model that produced the original response) if set, else falls back
  to whatever the send path would otherwise pick.
- Display: the new empty assistant message streams in place of the old one (same
  visual slot, new id), old one is reachable via sibling nav.

### C.5 Continue (assistant message)

`continueAssistantMessage(messageId)` first classifies intent via
`classifyContinueIntent(activeMessages, idx)` into one of three behaviors (the classify
function itself lives in a utils module not read in this pass — treat the three
outcomes below as the contract, verify the exact classification predicates
empirically if spail needs to replicate them):
1. **`RERUN_TURN`** → delegates straight to `regenerateMessageWithBranching(messageId)`
   (C.4) — used when the target assistant message has `tool_calls` with **no**
   trailing tool-result messages yet (can't safely resume mid tool-call sequence with a
   token-level continuation).
2. **`NEXT_TURN`** → `continueAsNextAgenticTurn(anchorIndex)`: opens a **fresh new
   assistant message** as a new branch off the last tool-result message
   (`DatabaseService.createMessageBranch(..., anchorMessage.id)`), sets `currNode`
   there, and streams a brand-new agentic turn (goes through `streamChatCompletion`
   again, which can re-enter the agentic loop). Used when the assistant's tool_calls
   are already fully paired with tool results — the "continuation" is really "let the
   model take its next turn," not literal text continuation.
3. **Default / token-level continue** → uses the server's `continue_final_message: true`
   completion flag (vLLM/llama.cpp compat) to literally keep generating from
   the message's exact current byte content, **in place, same message id** (no
   branching, no new node). Implementation detail worth preserving for spail: it
   captures `originalContent`/`originalReasoning` before streaming, and every chunk is
   appended and written as `originalContent + appendedContent` — so a stop mid
   continuation still yields a coherent (original + partial-appended) result, persisted
   via the same abort path as fresh generation (see C.6).

### C.6 Stop / cancel mid-stream

`chatStore.stopGeneration()` → `stopGenerationForChat(convId)`:
```ts
async stopGenerationForChat(convId: string): Promise<void> {
  await this.savePartialResponseIfNeeded(convId);
  this.setStreamingActive(false);
  const streamStateForStop = this.chatStreamingStates.get(convId);
  const modelForStop = streamStateForStop?.model;
  void ChatService.cancelServerStream(convId, modelForStop);  // tells the SERVER to actually stop generating
  this.abortRequest(convId);                                   // aborts the client-side fetch/stream
  this.setChatLoading(convId, false);
  this.clearChatStreaming(convId);
  this.setProcessingState(convId, null);
  this.clearPendingMessage(convId);
}
```
Key points:
- **The partial content IS kept.** `savePartialResponseIfNeeded` writes whatever
  content/reasoning had streamed so far into the last assistant `DatabaseMessage` row
  (`DatabaseService.updateMessage(lastMessage.id, { content: partialContent,
  reasoningContent?, timings? })`) BEFORE tearing down streaming state. If literally
  nothing had streamed yet (empty content and empty reasoning), nothing is written —
  the message row is left as whatever it already was (typically empty string).
- It's not just a client-side abort: `ChatService.cancelServerStream(convId,
  modelForStop)` explicitly tells the backend to stop producing tokens server-side —
  otherwise a detached generation would keep running to EOS/`max_tokens` even after the
  client drops its HTTP connection. **Spail's server-driven design needs an equivalent
  explicit stop RPC**, not just closing the SSE connection, since the model call is
  presumably decoupled from the client connection lifecycle.
- Mid-agentic-loop stop: `signal.aborted` is checked at multiple points in
  `executeAgenticLoop` (before each turn, before/after each tool call, right after the
  LLM stream). Whatever turn content had accumulated when the abort is noticed is
  persisted via `onAssistantTurnComplete(turnContent, ..., toolCalls: undefined)` before
  the flow returns — so a stop mid tool-calling still keeps the partial assistant text
  of the CURRENT turn, but does not execute any further not-yet-started tool calls, and
  does NOT synthesize placeholder tool-result rows for calls that hadn't started yet
  (contrast with the *steering message* interruption path in B.3, which DOES synthesize
  `'Tool execution was interrupted by a new user message.'` rows for skipped calls —
  stop/abort does not do this).
- `isAbortError(error)` is the universal check used everywhere (both `chat.svelte.ts`
  and `agentic.svelte.ts`) to distinguish "user cancelled" from "real error" — a real
  error still keeps whatever partial content existed AND additionally surfaces an error
  dialog (`showErrorDialog`), whereas cancellation is silent.
- If a message had been queued to auto-send-next ("Send immediately" while a pending
  steering/queued message existed), stopping resumes that queued send instead of just
  going idle (`consumePendingMessage` → `sendMessage(pending.content, pending.extras)`).

### C.7 Delete

`chatStore.deleteMessage(messageId)`:
- Tree mutation: always a **cascading delete** — `DatabaseService.deleteMessageCascading`
  computes `findDescendantMessages(allMessages, messageId)` (BFS over `children[]`) and
  bulk-deletes `[messageId, ...descendants]`, additionally removing `messageId` from its
  parent's `children[]` array. This applies uniformly regardless of role — deleting a
  system message this way (via the trash icon on a system message bubble) cascades its
  descendants too, same as any other message. (Contrast with C.8's special-cased
  "clear system prompt" flow, which explicitly reparents children instead of deleting
  them — that is a DIFFERENT code path, only reachable by emptying the system-message
  textarea, not by the generic delete action. See Gaps — worth confirming empirically
  which UI affordance maps to which path.)
- Before deleting, if the deleted message is on the **current path**
  (`filterByLeafNodeId(allMessages, currNode, false)`), the view must move off it:
  - If siblings remain (other messages sharing the same `parent`, excluding the
    deleted one): navigate to **the sibling with the latest `timestamp`**, resolved to
    ITS leaf via `findLeafNode`.
  - Else (deleted message was an only child): navigate to the **parent's** leaf
    (`findLeafNode(allMessages, messageToDelete.parent)`) — i.e. collapse up to
    whatever the parent's current deepest branch is (which, since the deleted subtree
    is now gone, is well-defined).
  - If the deleted message was NOT on the current path (a dangling alternate branch),
    `currNode` is untouched.
- `getDeletionInfo(messageId)` is a **preview-only** helper (used to populate a
  confirmation dialog: "this will delete N messages, M user / K assistant") — for
  non-system messages it counts `[messageId, ...descendants]`; for system messages it
  reports `totalCount: 1` (implying "only the system message itself is at risk," i.e.
  the preview assumes the reparent-on-clear behavior). **This preview count does NOT
  match what the generic cascading delete actually does for a system message with
  descendants** — flagged as a gap below, verify which is authoritative before spail
  copies either.
- Display: `refreshActiveMessages()` re-derives the active path after the delete and
  any `currNode` change above.

### C.8 Emptying/clearing a system prompt (distinct from delete)

Not the generic delete button — this fires when a user clears the system-message
textarea to empty and saves (`handleSaveEdit` special-cases
`message.role === MessageRole.SYSTEM` and empty trimmed content) →
`chatStore.removeSystemPromptPlaceholder(messageId)`:
- If the system message is the ONLY other message in the conversation (`allMessages.length
  === 2`: root + this system message, and it has no children) → **deletes the whole
  conversation** and the caller navigates to the app's start route.
- Otherwise: **reparents** every one of the system message's children onto the true
  root node (`DatabaseService.updateMessage(childId, { parent: rootMessage.id })`),
  splices the system message out of root's `children[]` while splicing in its former
  children, deletes the (now childless) system-message row via the **non-cascading**
  `DatabaseService.deleteMessage` (which only detaches from its parent and deletes
  itself — not the cascading variant), and removes it from the in-memory
  `activeMessages` array directly.
- Net effect: the rest of the conversation is preserved, just with no system message
  at the front.

### C.9 Fork a conversation

`conversationsStore.forkConversation(messageId, { name, includeAttachments })`:
- Creates a **brand-new conversation** whose message tree is a copy of the path from
  root through `messageId` (server/DB-side `DatabaseService.forkConversation` handles
  the actual copy — not detailed further here since it's a straightforward tree copy,
  optionally including attachments per the flag).
- Navigates the app to the new conversation (`goto(RouterService.chat(newConv.id))`)
  and shows a success toast. The original conversation is untouched.
- This is the one action here that does NOT mutate the current conversation's tree at
  all — it's a full copy-and-branch-out-of-band operation.

---

## Gaps / verify empirically

1. **Dead code ambiguity — `chatStore.updateMessage` and `chatStore.regenerateMessage`
   (the older, non-`*WithBranching` variants) have no callers anywhere in
   `src/lib/components`.** They appear to be superseded by
   `editMessageWithBranching`/`editUserMessagePreserveResponses` and
   `regenerateMessageWithBranching` respectively, but weren't deleted. Do not treat
   their "delete-and-replace-in-place" behavior as current UX — verify against a live
   build (or git blame) that they're truly unreachable before using them as a spec
   source; if spail wants a "destructive regenerate that prunes forward history," that
   behavior does still exist in this dead code and could be resurrected deliberately,
   but confirm that's an intentional product decision and not an accidental relic.
2. **System-message delete: two divergent code paths, unclear which is
   product-intended for the generic trash-can action.** `getDeletionInfo` previews a
   system-message delete as `totalCount: 1` (implying children are preserved/
   reparented), but the actual generic `chatStore.deleteMessage` → cascading delete
   path deletes a system message's entire descendant subtree, with no reparenting.
   Only the separate "clear the system prompt textarea to empty" flow
   (`removeSystemPromptPlaceholder`) does the reparent-preserving behavior. Confirm
   empirically (run the fork's UI) whether the trash-can icon is actually disabled/
   hidden for system messages, or whether this is a live inconsistency, before
   deciding which behavior spail's delete endpoint should implement for a system
   message.
3. **`classifyContinueIntent`'s exact predicates were not read in this pass** (the
   function lives outside the files this audit covered). The three-way behavior
   (`RERUN_TURN` / `NEXT_TURN` / token-level continue) is documented from its call
   sites and comments, but the precise rule for "tool_calls present with no trailing
   tool results" vs "tool_calls already paired with results" vs "plain text message"
   should be re-derived from `classifyContinueIntent`'s source directly if M6/M7
   acceptance criteria need to replicate it exactly.
4. **Tool name collision policy ("last connected server wins") is a real product
   decision, not an oversight** — but only a `console.warn` marks it. If spail wants
   deterministic multi-server tool routing, decide up front whether to keep
   last-wins, adopt first-wins, or namespace tool names per server (e.g.
   `serverId::toolName`) — the fork does not disambiguate for the model at all, so a
   model calling `search` when two servers both expose `search` will always reach
   whichever connected last.
5. **`ALWAYS`/`ALWAYS_SERVER` tool permission persistence is global-per-browser-profile,
   not per-conversation and not server-synced.** Confirm this is the desired model for
   spail (a server-driven, presumably multi-device app) — a naive port would need a
   per-user (not per-browser) persisted allow-list instead of `localStorage`.
6. **Steering-message interruption vs stop/abort produce different tool-result
   placeholders for in-flight/queued tool calls** (steering synthesizes "interrupted by
   a new user message" tool-result rows for each skipped call; abort/stop does not
   synthesize anything for calls that hadn't started). Confirm both behaviors are
   wanted, since an LLM resuming after a stop will see a tool_calls array with NO
   matching tool-result rows at all for any calls that didn't get to run — verify how
   (or whether) spail's runner needs to backfill synthetic tool-result rows in that
   case to keep the message list well-formed for a subsequent completion request (some
   APIs require every `tool_calls[i].id` to have a matching tool message before the
   next turn).
7. **Health-check "promote to active connection" vs. the enable/override lifecycle**:
   confirm empirically whether a promoted-but-not-yet-agentic-flow connection can go
   stale/orphaned if the user disables the server for that conversation before ever
   sending a message (i.e. does `releaseConnection`/`shutdown` definitely get called in
   that path, or can a promoted health-check connection leak).
8. **Icon resolution (`getServerFavicon`/`#getMcpIconUrl`) and the `iconUrl` field on
   `MCPServerSettingsEntry` appear disconnected** — the stored `iconUrl` field is never
   read in the icon-resolution code path shown; icons come from the live MCP
   `serverInfo.icons` handshake or a favicon.ico/png guess against the root domain.
   Confirm whether `iconUrl` is legacy/unused before porting it into spail's schema.
