# Conversation export/import format (from llama-ui)

Source of truth: `llama-ui` fork of llama.cpp's web chat UI, checkpoint used
for this spec's research:

- `src/lib/stores/conversations.svelte.ts` — `serializeSessionToJsonl`,
  `parseSessionsJsonl`, `parseImportFile`, `downloadConversationFile`,
  `downloadConversationsArchive`, `generateConversationFilename`
- `src/lib/types/database.d.ts` — `DatabaseConversation`, `DatabaseMessage`,
  `DatabaseMessageExtra*`, `ExportedConversation`
- `src/lib/utils/branching.ts` — `filterByLeafNodeId`, `findLeafNode`,
  `findDescendantMessages`, `getMessageSiblings`
- `src/lib/services/database.service.ts` — how messages/conversations are
  actually created and persisted (root message, `createMessageBranch`,
  `forkConversation`, `importConversations`)
- `src/lib/stores/chat.svelte.ts` — where `reasoningContent`, `toolCalls`,
  `timings`, `model`, `completionId`, `toolCallId` get populated on messages
- `src/lib/utils/convert-files-to-extra.ts` — exact base64 encoding per
  attachment type
- `src/lib/components/app/settings/SettingsChat/SettingsChatImportExportTab.svelte`
  — the actual call sites that decide *which* messages get exported

This is written for an implementer who will never open the fork. All field
names, types, and code excerpts below are transcribed verbatim from the
source (paths/line context given so you can tell what's paraphrase vs quote).

---

## 1. The core data shapes

### 1.1 `DatabaseConversation`

```ts
export interface DatabaseConversation {
	currNode: string | null;
	id: string;
	lastModified: number;
	name: string;
	mcpServerOverrides?: McpServerOverride[];
	thinkingEnabled?: boolean;
	reasoningEffort?: ReasoningEffort; // 'low' | 'medium' | 'high' | 'max'
	forkedFromConversationId?: string;
	pinned?: boolean;
}
```

Field notes:

- `id` — a `crypto.randomUUID()` string (see §1.4). Not a URL-safe short ID,
  a full UUID v4 (with a `Math.random()`-based fallback if
  `crypto.randomUUID` is unavailable, which produces a much shorter,
  non-UUID-shaped string — see Gaps).
- `currNode` — the message ID of the tip of the currently-active branch (NOT
  the root). **Typed as `string | null` but `DatabaseService.createConversation`
  actually initializes it to `''` (empty string), never `null`, in practice.**
  Treat `''`, `null`, and "points at a message ID not present in this export"
  as equivalent to "no current node — fall back to latest by timestamp" (this
  fallback behavior is implemented in `filterByLeafNodeId`, see §2.2).
- `lastModified` — `Date.now()` (epoch millis), bumped by
  `DatabaseService.updateConversation` on every conversation-level write.
- `name` — user/auto-generated title. Not guaranteed non-empty in older data.
- `mcpServerOverrides` — optional array of `{ serverId: string; enabled: boolean }`.
- `thinkingEnabled` — optional bool, per-conversation override of the global
  "thinking" toggle.
- `reasoningEffort` — optional, one of the `ReasoningEffort` enum values
  (`'low' | 'medium' | 'high' | 'max'`).
- `forkedFromConversationId` — set only on conversations created via
  "Fork conversation" (see §1.4.1); absent on ordinary conversations. This is
  a **conversation-level** parent pointer, unrelated to message tree
  parent/children.
- `pinned` — optional bool, sidebar pin state.

### 1.2 `DatabaseMessage`

```ts
export interface DatabaseMessage {
	id: string;
	convId: string;
	type: ChatMessageType;      // in practice: 'root' | 'system' | 'text'
	timestamp: number;
	role: ChatRole;              // 'user' | 'assistant' | 'system' | 'tool'
	content: string;
	parent: string | null;
	/** @deprecated - left for backward compatibility */
	thinking?: string;
	/** Reasoning content produced by the model (separate from visible content) */
	reasoningContent?: string;
	/** Serialized JSON array of tool calls made by assistant messages */
	toolCalls?: string;
	/** Chat completion id streamed by the server, used to target realtime control (e.g. end reasoning) */
	completionId?: string;
	/** Tool call ID for tool result messages (role: 'tool') */
	toolCallId?: string;
	children: string[];
	extra?: DatabaseMessageExtra[];
	timings?: ChatMessageTimings;
	model?: string;
}
```

`ChatMessageType` and `ChatRole` are declared as imported types but **do not
actually exist as exported type aliases anywhere in the fork's source** (dead
type references that apparently don't fail the build — see Gaps). Ignore the
nominal types and go by the literal string values actually assigned at
runtime:

- `type`: `'root'` (the synthetic tree root, see §2.1), `MessageRole.SYSTEM`
  i.e. `'system'` (the system-prompt message created via
  `DatabaseService.createSystemMessage`), or `MessageType.TEXT` i.e. `'text'`
  (every ordinary user/assistant/tool message created via
  `DatabaseService.createMessageBranch`). `MessageType.THINK` (`'think'`)
  exists in the enum but is never assigned to `.type` anywhere in the
  codebase searched — reasoning lives in the separate `reasoningContent`
  field instead, not as a distinct message type.
- `role`: one of `MessageRole` — `USER = 'user'`, `ASSISTANT = 'assistant'`,
  `SYSTEM = 'system'`, `TOOL = 'tool'`.
- `content`: plain string. For assistant messages this is the final
  rendered text (reasoning/thinking is NOT embedded here — see
  `reasoningContent`).
- `parent`: the message-tree parent's `id`, or `null` only for the root
  message.
- `thinking`: deprecated legacy field, may appear in old exports; do not
  write it for new data. If present on import, prefer `reasoningContent`.
- `reasoningContent`: current field for model reasoning/thinking traces,
  populated from `onAssistantTurnComplete`'s `reasoningContent` argument
  (`reasoningContent: reasoningContent || undefined` — so it's `undefined`,
  never an empty string, when there's no reasoning).
- `toolCalls`: **stored in the IndexedDB / in a parsed `DatabaseMessage`
  object as a JSON-stringified array** of `ApiChatCompletionToolCall`:
  ```ts
  export interface ApiChatCompletionToolCallFunctionDelta {
  	name?: string;
  	arguments?: string;
  }
  export interface ApiChatCompletionToolCallDelta {
  	index?: number;
  	id?: string;
  	type?: string;
  	function?: ApiChatCompletionToolCallFunctionDelta;
  }
  export interface ApiChatCompletionToolCall extends ApiChatCompletionToolCallDelta {
  	function?: ApiChatCompletionToolCallFunctionDelta & { arguments?: string };
  }
  ```
  Set via `toolCalls: toolCalls ? JSON.stringify(toolCalls) : ''` in
  `chat.svelte.ts`. Empty-but-present is the string `''`, not `undefined`.
  **On JSONL export this field is un-stringified back into a real JSON
  array** — see §3.
- `completionId`: the upstream chat-completion id string (e.g. an OpenAI-style
  `chatcmpl-...` id), recorded once per assistant turn the first time the
  server streams one.
- `toolCallId`: only set on `role: 'tool'` messages, the tool_call id the
  result corresponds to (paired with an entry in the parent assistant
  message's `toolCalls` array).
- `children`: array of message IDs, **append-only, in creation order**
  (`children: [...parentMessage.children, newMessage.id]`). The **last**
  element is "the most recently created branch" and is what tree-walking
  helpers treat as the active/default child when following a path down (see
  §2.2 `findLeafNode`).
- `extra`: array of attachments, see §4.
- `timings`: optional, `ChatMessageTimings`:
  ```ts
  export interface ChatMessageTimings {
  	cache_n?: number;
  	predicted_ms?: number;
  	predicted_n?: number;
  	prompt_ms?: number;
  	prompt_n?: number;
  	agentic?: ChatMessageAgenticTimings; // tool-loop/turn stats, optional
  }
  ```
- `model`: the model id string used to generate this specific message
  (assistant messages only in practice); `null` is used as a placeholder
  value when creating a message before the model is known
  (`model: null` in several `createMessageBranch` call sites), then patched
  in later via `DatabaseService.updateMessage(id, { model: resolvedModel })`.

### 1.3 `ExportedConversation` (the JSONL-per-message payload shape)

```ts
export type ExportedConversation = {
	conv: DatabaseConversation;
	messages: DatabaseMessage[];
};

export type ExportedConversations = ExportedConversation | ExportedConversation[];
```

This is the in-memory shape that both the `.jsonl` serializer and the legacy
`.json` importer operate on.

### 1.4 IDs and the root message

IDs (conversation and message) are generated by:

```ts
// src/lib/utils/uuid.ts
export function uuid(): string {
	return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).substring(2);
}
```

i.e. normally a standard RFC-4122 v4 UUID string (e.g.
`"3fa1c2e4-9b7a-4c1d-8e2f-1a2b3c4d5e6f"`), with a non-UUID-shaped fallback
(`Math.random().toString(36)`, ~11 base-36 chars) only in environments
lacking `crypto.randomUUID`. Don't assume UUID-v4 shape is guaranteed;
treat message/conversation IDs as opaque strings.

Every conversation has exactly one synthetic **root message**, created by
`DatabaseService.createRootMessage`:

```ts
static async createRootMessage(convId: string): Promise<string> {
	const rootMessage: DatabaseMessage = {
		id: uuid(),
		convId,
		type: 'root',
		timestamp: Date.now(),
		role: MessageRole.SYSTEM,
		content: '',
		parent: null,
		toolCalls: '',
		children: []
	};
	await db[IDXDB_TABLES.messages].add(rootMessage);
	return rootMessage.id;
}
```

The root message is never shown in the UI and its `content` is always `''`.
It exists purely so every real message has a non-null `parent` to chain from,
and so branching logic has a single well-defined tree root. `role: SYSTEM` on
the root is incidental (it's never rendered) — don't confuse it with the
actual system-prompt message (`type: 'system'`), which is created separately
as the root's child.

#### 1.4.1 Conversation-level forking (not message-tree forking)

`DatabaseService.forkConversation(sourceConvId, atMessageId, options)` clones
the path from root to `atMessageId` (via `filterByLeafNodeId(..., true)`,
i.e. **including** the root) into a brand-new conversation with **all new
message IDs** (a fresh `idMap`), sets `forkedFromConversationId` on the new
conversation to the source conversation's `id`, and points the new
conversation's `currNode` at the cloned tip message. `options.includeAttachments`
gates whether `extra` is copied (`msg.extra` vs `undefined`) — attachments can
be deliberately dropped on fork. This is a distinct feature from message-tree
branching (§2) and is not part of the JSONL export format itself, but you'll
see `forkedFromConversationId` on exported `conv` records for forked chats.

---

## 2. Message tree semantics

### 2.1 Shape

Every non-root message has exactly one `parent` (a message ID). Every
message additionally carries its own `children: string[]` (redundant with
`parent` but stored explicitly and kept in sync on every mutation — nothing
computes children from a `parent` scan at write time; `createMessageBranch`
pushes onto the parent's stored array). A conversation's messages form a
tree rooted at the single `type: 'root'` message:

```
root (type: 'root', content: '', parent: null)
 └─ system prompt (type: 'system', role: 'system')   [optional, 0 or 1]
     └─ user msg 1
         ├─ assistant reply A   ← original
         └─ assistant reply B   ← edited/regenerated sibling, created later
             └─ ...continues from B if B is the active branch
```

(Diagram adapted from the comment header in `src/lib/utils/branching.ts`.)

Branch points arise from two user actions, both of which **never mutate an
existing message with responses** — they always add a new sibling instead:

- **Editing a user (or system) message that already has children**
  (`editMessageWithBranching`): creates a brand new message with the same
  `parent` as the one being edited (i.e. a sibling), then generates a new
  assistant response under it. If the edited message has **no** children yet,
  it's updated in place instead (no new branch) — branching only happens
  once there's downstream content to preserve.
- **Regenerating an assistant message** (`regenerateMessageWithBranching`):
  creates a new assistant message as a sibling of the one being regenerated
  (same `parent` — the user message), then streams a fresh completion into
  it. (There is also a non-branching `regenerateMessage` that instead
  deletes the old assistant message and everything after it and appends
  fresh — used by a different code path; only the "WithBranching" variant
  produces siblings.)

In both branching cases the new sibling's `parent` is set explicitly to the
shared parent id (passed as the second argument to
`DatabaseService.createMessageBranch`), and `createMessageBranch` itself
appends the new message's id onto that parent's `children` array:

```ts
// database.service.ts, createMessageBranch (abridged)
const newMessage: DatabaseMessage = {
	...message,
	id: uuid(),
	parent: parentId,
	toolCalls: message.toolCalls ?? '',
	children: []
};
await db[IDXDB_TABLES.messages].add(newMessage);
if (parentId !== null) {
	const parentMessage = await db[IDXDB_TABLES.messages].get(parentId);
	await db[IDXDB_TABLES.messages].update(parentId, {
		children: [...parentMessage.children, newMessage.id]
	});
}
await this.updateConversation(message.convId, { currNode: newMessage.id });
```

Note the last line: **creating any new message branch immediately moves
`currNode` to that new message.** `currNode` always tracks "the last message
the user was looking at / just created," not necessarily a leaf — but see
§2.2, active-path resolution always walks to the actual leaf from there.

### 2.2 Active-path resolution (`currNode` → visible messages)

The "active path" shown in the chat UI is computed, never stored as its own
list. Two helper functions in `src/lib/utils/branching.ts` do this:

```ts
export function filterByLeafNodeId(
	messages: readonly DatabaseMessage[],
	leafNodeId: string,
	includeRoot: boolean = false
): readonly DatabaseMessage[] {
	const result: DatabaseMessage[] = [];
	const nodeMap = new Map<string, DatabaseMessage>();
	for (const msg of messages) nodeMap.set(msg.id, msg);

	// Find the starting node (leaf node or latest if not found)
	let startNode: DatabaseMessage | undefined = nodeMap.get(leafNodeId);
	if (!startNode) {
		let latestTime = -1;
		for (const msg of messages) {
			if (msg.timestamp > latestTime) { startNode = msg; latestTime = msg.timestamp; }
		}
	}

	// Traverse from leaf to root, collecting messages
	let currentNode: DatabaseMessage | undefined = startNode;
	while (currentNode) {
		if (currentNode.type !== 'root' || includeRoot) result.push(currentNode);
		if (currentNode.parent === null) break;
		currentNode = nodeMap.get(currentNode.parent);
	}

	// Sort: system messages first, then by timestamp
	result.sort((a, b) => {
		if (a.role === MessageRole.SYSTEM && b.role !== MessageRole.SYSTEM) return -1;
		if (a.role !== MessageRole.SYSTEM && b.role === MessageRole.SYSTEM) return 1;
		return a.timestamp - b.timestamp;
	});
	return result;
}
```

```ts
function findLeafNodeInMap(nodeMap, messageId): string {
	let currentNode = nodeMap.get(messageId);
	while (currentNode && currentNode.children.length > 0) {
		const lastChildId = currentNode.children[currentNode.children.length - 1];
		currentNode = nodeMap.get(lastChildId);
	}
	return currentNode?.id ?? messageId;
}
export function findLeafNode(messages, messageId): string {
	const nodeMap = new Map(messages.map((msg) => [msg.id, msg] as const));
	return findLeafNodeInMap(nodeMap, messageId);
}
```

To reconstruct "what the user was actually looking at" from an export:

1. Take `conv.currNode`. If it's falsy/empty or doesn't resolve to a message
   in this export, fall back to the message with the **max `timestamp`**
   across the whole set (this is `filterByLeafNodeId`'s own fallback, and is
   what an importer should replicate for robustness).
2. `currNode` is not guaranteed to be a leaf — walk it *down* to a leaf first
   via `findLeafNode` semantics (follow `children[children.length - 1]`
   repeatedly) if you want "the tip of the branch currently selected,"
   **or** walk it *up* via `parent` links directly (which is what
   `filterByLeafNodeId` actually does — it does not call `findLeafNode`
   first). In the stock app the two usually agree because `currNode` is set
   to a freshly-created message's own id (which has no children yet, so it's
   already a leaf) — see the `updateCurrentNode` calls throughout
   `chat.svelte.ts` and `createMessageBranch`'s automatic
   `currNode` update. Only `navigateToSibling` explicitly walks a possibly
   non-leaf sibling id down to a leaf before setting `currNode`. **An
   importer reconstructing "the active path" should walk `currNode` up via
   `parent` (not down)** — that's what production code (`loadConversation`,
   `refreshActiveMessages`) actually does.
3. Walk from that leaf up through `.parent` links to the root, collecting
   every message whose `type !== 'root'`.
4. Sort the collected messages: all `role === 'system'` messages first
   (stable amongst themselves), then everything else ascending by
   `timestamp`. This means a system-prompt message with a *later* timestamp
   than the messages after it (e.g. edited after the fact) will still sort
   to the top of the visible transcript.

This active-path list is exactly what a user sees in the chat pane and is
the only thing multi-branch UI navigation (`navigateToSibling`,
`getMessageSiblings`) cares about; sibling branches that are not on the
active path are still present in storage (and in most export flows, see
§2.3) but simply aren't part of "the conversation" as currently viewed.

### 2.3 How branches appear in the exported flat message list — IMPORTANT

**The exported `messages` array is not the active path** in the common case.
It depends on which call site produced the export:

- **Bulk/Settings export** (`SettingsChatImportExportTab.svelte`
  `handleExportConfirm`, the primary export UI — "Export conversations"
  dialog): always calls
  `conversationsStore.getConversationMessages(conv.id)` →
  `DatabaseService.getConversationMessages(convId)` →
  ```ts
  static async getConversationMessages(convId: string): Promise<DatabaseMessage[]> {
  	return await db[IDXDB_TABLES.messages].where('convId').equals(convId).sortBy('timestamp');
  }
  ```
  i.e. **every message row for the conversation** — root message included,
  every branch/sibling included — sorted **purely by `timestamp` ascending**
  (no tree-order, no system-first pass; that sort only happens in
  `filterByLeafNodeId`, which this path does not call). Branches interleave
  chronologically: if branch A was created, then branch B was created later
  off the same parent, then more messages were appended to A afterward, the
  flat list order will *not* look like a clean depth-first walk — it's
  purely "in the order these rows were created/last touched."
  (Dexie's `sortBy('timestamp')` sorts by each row's own `timestamp` field —
  note this is the message's own timestamp, which for an edited-in-place
  message, per `editMessageWithBranching`'s no-children path, gets bumped to
  `Date.now()` on edit, potentially reordering it relative to siblings.)

- **Single-conversation sidebar download** (`downloadConversation(convId)`):
  if the requested conversation happens to be the currently active one in
  the store, it exports `this.activeMessages` — i.e. **only the current
  active path, root excluded, sorted via `filterByLeafNodeId`'s system-first
  rule** (see §2.2). If the requested conversation is *not* the active one,
  it falls through to the same `DatabaseService.getConversationMessages`
  call as the bulk path above — i.e. **everything, root included.**
  This inconsistency (active-path-only vs. full-tree export depending on
  which conversation happens to be open in the tab) is a real quirk of the
  fork, not a spec choice — see Gaps.

**Practical implication for spail's importer:** always assume the `messages`
array in a JSONL/zip export may contain the full tree (root message, dead
branches, multiple assistant siblings under one user message) and reconstruct
active/inactive branches yourself from `parent`/`children`/`conv.currNode`
per §2.2, rather than assuming array order or array membership implies "this
is the visible conversation." Do not assume the root message is present
either — build your importer to tolerate both a present and an absent
`type: 'root'` row (synthesize one if every message's `parent` chain doesn't
bottom out at `null` within the export... actually every real message's
ultimate ancestor **is** the root row when present; if the root row is
*absent* from the export, the topmost message(s) will have `parent: null`
directly).

### 2.4 Ordering guarantees, summarized

- No guarantee that array order equals tree/traversal order.
- No guarantee that the root message is included (depends on export call
  site — included whenever `getConversationMessages` was used, excluded when
  `activeMessages`/`filterByLeafNodeId` was used).
- The only ordering signal that *is* reliable across the whole file is each
  message's own `timestamp` field, and even that can be **bumped later than
  its logical tree position** by in-place edits (§2.3 note on
  `editMessageWithBranching`'s no-branch path).
- `children` arrays are reliably in creation order (append-only), so they're
  the more trustworthy source of "which sibling came first" than comparing
  timestamps across different messages when in doubt.

---

## 3. The JSONL line format

### 3.1 Serialization

```ts
serializeSessionToJsonl(data: ExportedConversation): string {
	const { conv, messages } = data;

	const sessionLine = JSON.stringify({ type: 'session', harness: 'llama.app', ...conv });
	const messageLines = messages.map((message: DatabaseMessage) => {
		// `toolCalls` is stored as a JSON string; drop it when empty, otherwise parse it.
		const { toolCalls, ...rest } = message;
		const normalized = toolCalls ? { ...rest, toolCalls: JSON.parse(toolCalls) } : rest;
		return JSON.stringify({ type: 'message', message: normalized });
	});

	return [sessionLine, ...messageLines].join('\n');
}
```

So a `.jsonl` export is:

- **Line 1**: a **session header**, shape
  `{ type: 'session', harness: 'llama.app', ...<all DatabaseConversation fields> }`.
  Note `type` and `harness` are siblings of the spread conversation fields —
  a real conversation could theoretically have fields named `type` or
  `harness`, but `DatabaseConversation` doesn't define any, so no collision
  in practice.
- **Lines 2..N**: one **message record** per line, shape
  `{ type: 'message', message: <DatabaseMessage with toolCalls as a real JSON array (or field omitted entirely if it was falsy)> }`.
  Crucially: `toolCalls` is **omitted from the object** (not present as
  `null`/`undefined`) when the source message's `toolCalls` string was falsy
  (`''`, `undefined`). When present, it's a parsed array, not a string —
  **this is the opposite encoding from the IndexedDB/runtime representation**
  (§1.2), which stores it double-encoded as a JSON string.
- Lines are joined with plain `'\n'` (no trailing newline after the last
  line, and no line-ending normalization — if any field contains embedded
  newlines they're safely escaped by `JSON.stringify`, so this is still valid
  JSONL).
- **Multiple sessions can be concatenated in one `.jsonl` file** by just
  repeating the (session line, message lines...) group — the parser (§3.2)
  starts a new session on every `type: 'session'` line it sees. The single
  export path (`downloadConversationFile`) only ever writes one session per
  file, but `parseSessionsJsonl` supports many, and this is the mechanism the
  `.zip` variant's *contents* rely on being idempotent to call once per
  archive entry.

### 3.2 Parsing

```ts
parseSessionsJsonl(text: string): ExportedConversation[] {
	const sessions: ExportedConversation[] = [];
	let current: ExportedConversation | null = null;

	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		const record = JSON.parse(trimmed);

		if (record.type === 'session') {
			const conv = { ...record };
			delete conv.type;
			delete conv.harness;
			current = { conv: conv as DatabaseConversation, messages: [] };
			sessions.push(current);
		} else if (record.type === 'message') {
			if (!current) throw new Error('Invalid JSONL: message record before any session record');
			const message = record.message as DatabaseMessage;
			if (message.toolCalls !== undefined && typeof message.toolCalls !== 'string') {
				message.toolCalls = JSON.stringify(message.toolCalls);
			}
			current.messages.push(message);
		}
		// Ignore unknown record types for forward compatibility.
	}
	return sessions;
}
```

Notes for an importer:

- Blank lines are skipped.
- A `message` line before any `session` line is a hard parse error (thrown).
- Unknown `type` values are silently ignored (forward-compat escape hatch —
  spail should do the same rather than erroring, to stay compatible with
  future fields the fork might add).
- On parse, `toolCalls` is round-tripped back to a JSON **string** to match
  the runtime/IndexedDB `DatabaseMessage.toolCalls: string | undefined` shape
  — i.e. `parseSessionsJsonl`'s output objects have `toolCalls` as a string
  again, matching §1.2, NOT the array shape that appeared on the wire in
  §3.1. **spail's importer should decide its own canonical in-memory/DB shape
  independently** — the fork round-trips through a string only because
  IndexedDB requires it; a SQL `jsonb` column can just store the array
  directly. What matters for fidelity is: on the wire (in the `.jsonl`
  bytes), `toolCalls` is a plain JSON array when present, absent when there
  were no tool calls.
- `harness: 'llama.app'` is a static marker, not meaningfully variable;
  don't rely on its exact string for version detection — treat it as
  informational only.

### 3.3 Content-Type / file extension constants used

```ts
FileExtensionText.JSONL = '.jsonl'
FileExtensionText.ZIP   = '.zip'
FileExtensionText.JSON  = '.json'   // legacy only
MimeTypeText.JSONL      = 'application/jsonl'
MimeTypeApplication.ZIP = 'application/zip'
```

---

## 4. Attachments (`extra`) — exact encoding

`DatabaseMessage.extra?: DatabaseMessageExtra[]`, a discriminated union on
`type` (an `AttachmentType` enum value):

```ts
export enum AttachmentType {
	AUDIO = 'AUDIO',
	IMAGE = 'IMAGE',
	VIDEO = 'VIDEO',
	MCP_PROMPT = 'MCP_PROMPT',
	MCP_RESOURCE = 'MCP_RESOURCE',
	PDF = 'PDF',
	TEXT = 'TEXT',
	LEGACY_CONTEXT = 'context' // legacy, pre-dates this fork's TEXT type
}

export interface DatabaseMessageExtraImageFile {
	type: AttachmentType.IMAGE;
	name: string;
	size?: number;
	base64Url: string;      // FULL data: URL, e.g. "data:image/png;base64,iVBORw0K..."
}

export interface DatabaseMessageExtraAudioFile {
	type: AttachmentType.AUDIO;
	name: string;
	size?: number;
	base64Data: string;     // RAW base64 payload, NO "data:...;base64," prefix
	mimeType: string;
}

export interface DatabaseMessageExtraVideoFile {
	type: AttachmentType.VIDEO;
	name: string;
	size?: number;
	base64Data: string;     // RAW base64 payload, NO prefix
	mimeType: string;
}

export interface DatabaseMessageExtraPdfFile {
	type: AttachmentType.PDF;
	base64Data: string;     // RAW base64 payload of the original PDF, NO prefix
	name: string;
	size?: number;
	content: string;        // extracted text (or a placeholder like "PDF file with N pages")
	images?: string[];      // present only if processedAsImages; each a full data: URL (PNG)
	processedAsImages: boolean;
}

export interface DatabaseMessageExtraTextFile {
	type: AttachmentType.TEXT;
	name: string;
	size?: number;
	content: string;        // plain text content, verbatim
}

export interface DatabaseMessageExtraMcpPrompt {
	type: AttachmentType.MCP_PROMPT;
	name: string;
	size?: number;
	serverName: string;
	promptName: string;
	content: string;
	arguments?: Record<string, string>;
}

export interface DatabaseMessageExtraMcpResource {
	type: AttachmentType.MCP_RESOURCE;
	name: string;
	size?: number;
	uri: string;
	serverName: string;
	content: string;
	mimeType?: string;
}

/** @deprecated legacy pasted-content format from the old (pre-fork) UI */
export interface DatabaseMessageExtraLegacyContext {
	type: AttachmentType.LEGACY_CONTEXT;   // 'context'
	name: string;
	size?: number;
	content: string;
}
```

**Encoding rule (the important bit for an importer that must decode into a
separate attachments table):**

- `IMAGE` extras store the **entire `data:` URL** as `base64Url` — the mime
  type is embedded in that URL string (e.g. `data:image/png;base64,...`), not
  provided as a separate field. To get raw bytes: strip everything up to and
  including the first `,`, then base64-decode. To get the mime type: parse
  the `data:<mime>;base64,` prefix.
- `AUDIO`, `VIDEO`, and `PDF` extras store `base64Data` as the **raw base64
  payload only** (no `data:` prefix) — mime type is given separately as
  `mimeType` (for audio/video) or is implicitly `application/pdf` (for PDF,
  not stored as a field at all — the type discriminant `PDF` implies it).
  This asymmetry (`base64Url` full-data-URL for images vs. `base64Data`
  raw-base64 for everything else) is confirmed directly in the file-reading
  code:
  ```ts
  // src/lib/utils/convert-files-to-extra.ts
  function readFileAsBase64(file: File): Promise<string> {
  	return new Promise((resolve, reject) => {
  		const reader = new FileReader();
  		reader.onload = () => {
  			// Extract base64 data without the data URL prefix
  			const dataUrl = reader.result as string;
  			const base64 = dataUrl.split(',')[1];
  			resolve(base64);
  		};
  		reader.onerror = () => reject(reader.error);
  		reader.readAsDataURL(file);
  	});
  }
  ```
  (used for audio/video/PDF), vs. images which keep `file.preview` — itself
  a `FileReader.readAsDataURL` result — as-is, full `data:` URL and all.
- `PDF.images`, when present (i.e. `processedAsImages: true`), is an array of
  full `data:image/png;base64,...` URLs (one per rendered page) — same full
  data-URL convention as `IMAGE.base64Url`.
- `TEXT`, `MCP_PROMPT`, `MCP_RESOURCE`, `LEGACY_CONTEXT` extras carry their
  payload as plain UTF-8 `content` strings — no base64 involved.
- `size` is the original file size in bytes where known (optional
  everywhere) — it is **not** validated against the actual decoded payload
  length anywhere in the reviewed code, so don't trust it as authoritative;
  recompute from decoded bytes if you need an accurate value.

**Mapping to a normalized attachments table** (for spail): for each
`extra[i]` on a message, decode into `(mime_type, name, size, bytes | text)`:

| `type`            | bytes source                                            | mime_type source                          | text source |
|-------------------|----------------------------------------------------------|--------------------------------------------|-------------|
| `IMAGE`           | base64-decode after 1st `,` in `base64Url`               | parse `data:<mime>;base64,` prefix          | —           |
| `AUDIO`           | base64-decode `base64Data` directly                       | `mimeType` field                            | —           |
| `VIDEO`           | base64-decode `base64Data` directly                       | `mimeType` field                            | —           |
| `PDF`             | base64-decode `base64Data` directly (original PDF bytes)  | `application/pdf` (implicit)                | `content` (extracted text, store alongside) |
| `TEXT`            | — (no binary)                                             | e.g. `text/plain` (not stored, implicit)    | `content`   |
| `MCP_PROMPT`      | — (no binary)                                             | n/a                                          | `content` + `serverName`/`promptName`/`arguments` |
| `MCP_RESOURCE`    | — (no binary)                                             | `mimeType` (optional field)                  | `content` + `uri`/`serverName` |
| `LEGACY_CONTEXT`  | — (no binary, legacy)                                     | n/a                                          | `content`   |

---

## 5. The `.zip` variant

### 5.1 Writing (`downloadConversationsArchive`)

```ts
downloadConversationsArchive(data: ExportedConversation[]): void {
	const usedNames = new SvelteSet<string>();
	const files: Record<string, Uint8Array> = {};

	for (const session of data) {
		const baseName = this.generateConversationFilename(session.conv, session.messages);
		let entryName = baseName;
		let suffix = 1;
		while (usedNames.has(entryName)) {
			entryName = baseName.replace(new RegExp(`${FileExtensionText.JSONL}$`), `_${suffix++}${FileExtensionText.JSONL}`);
		}
		usedNames.add(entryName);
		files[entryName] = strToU8(this.serializeSessionToJsonl(session));
	}

	const archiveName = `${new Date().toISOString().split(ISO_DATE_TIME_SEPARATOR)[0]}_conversations${FileExtensionText.ZIP}`;
	const zipped = zipSync(files);
	const blob = new Blob([zipped], { type: MimeTypeApplication.ZIP });
	this.triggerDownload(blob, archiveName);
}
```

- One `.jsonl` file **per conversation** inside the zip (each file is exactly
  the single-session format from §3.1 — a zip is just a bundle of
  independent single-session JSONL files, not one big multi-session file).
- Zip is built with `fflate`'s `zipSync` (no compression-level tuning shown,
  default). Entries are flat (no subdirectories) at the zip root.
- Archive filename: `<YYYY-MM-DD>_conversations.zip` (just the date portion
  of `new Date().toISOString()`, split on `'T'`, index 0).
- Entry filenames use `generateConversationFilename` (§5.3) and get a
  `_1`, `_2`, ... suffix inserted before `.jsonl` on collision (checked
  against a `Set` of names already used **within this archive**).

### 5.2 Reading (`parseImportFile`)

```ts
async parseImportFile(file: File): Promise<ExportedConversation[]> {
	const name = file.name.toLowerCase();

	if (name.endsWith(FileExtensionText.ZIP)) {
		const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
		const sessions: ExportedConversation[] = [];
		for (const [entryName, bytes] of Object.entries(entries)) {
			if (!entryName.toLowerCase().endsWith(FileExtensionText.JSONL)) continue;
			sessions.push(...this.parseSessionsJsonl(strFromU8(bytes)));
		}
		return sessions;
	}

	const text = await file.text();
	if (name.endsWith(FileExtensionText.JSONL)) {
		return this.parseSessionsJsonl(text);
	}

	// Legacy JSON format: an array of conversations or a single conversation object.
	const parsed = JSON.parse(text);
	if (Array.isArray(parsed)) return parsed;
	if (parsed && typeof parsed === 'object' && 'conv' in parsed && 'messages' in parsed) return [parsed];
	throw new Error('Invalid file format: expected array of conversations or single conversation object');
}
```

- **Format is dispatched purely on the *file name's* extension**, lower-cased
  (`file.name.toLowerCase()`), not by sniffing magic bytes or content. `.zip`
  → unzip and treat every entry ending in `.jsonl` (case-insensitive) as a
  session file, ignoring any other entries (e.g. a stray `README.txt` inside
  the zip is silently skipped). `.jsonl` → parse directly as one file's worth
  of sessions. Anything else → attempt legacy `.json` parsing (a raw
  `JSON.parse` of the whole file, expecting either a top-level array of
  `ExportedConversation` or a single `{ conv, messages }` object) and throw
  if it's neither shape.
- No validation of the `conv` or `message` object shapes beyond what
  `JSON.parse` itself guarantees (no schema/zod validation in this code
  path) — a malformed but syntactically-valid JSON line will pass through to
  the DB import step and fail (or corrupt) there instead. spail's importer
  should validate shapes explicitly rather than relying on this being safe.
- No dedup/merge across multiple `.jsonl` files inside one `.zip` beyond
  whatever `DatabaseService.importConversations` does at import time
  (skip-if-conversation-id-already-exists — see below).

### 5.3 Filename generation (used for both single-file and per-entry zip names)

```ts
generateConversationFilename(conversation: { id?: string; name?: string }, msgs?: DatabaseMessage[]): string {
	const conversationName = (conversation.name ?? '').trim().toLowerCase();
	const sanitizedName = conversationName
		.replace(/[^a-z0-9]/gi, '_')
		.replace(/_+/g, '_')
		.substring(0, 20);              // EXPORT_CONV_NAME_SUFFIX_MAX_LENGTH

	const referenceDate = msgs?.length ? new Date(Math.max(...msgs.map((m) => m.timestamp))) : new Date();
	const iso = referenceDate.toISOString().slice(0, 19);   // ISO_TIMESTAMP_SLICE_LENGTH, drops the .sssZ
	const formattedDate = iso.replace('T', '_').replaceAll(':', '-');
	const trimmedConvId = conversation.id?.slice(0, 8) ?? '';  // EXPORT_CONV_ID_TRIM_LENGTH
	return `${formattedDate}_conv_${trimmedConvId}_${sanitizedName}.jsonl`;
}
```

Example: conversation `id: "3fa1c2e4-9b7a-4c1d-8e2f-1a2b3c4d5e6f"`, name
`"Rust ownership Q&A"`, newest message timestamp `2026-07-06T15:30:05.123Z`
→ filename `2026-07-06_15-30-05_conv_3fa1c2e4_rust_ownership_q_a.jsonl`.

### 5.4 Import into storage (`DatabaseService.importConversations`)

```ts
static async importConversations(data): Promise<{ imported: number; skipped: number }> {
	let importedCount = 0, skippedCount = 0;
	return await db.transaction('rw', [...], async () => {
		for (const item of data) {
			const { conv, messages } = item;
			const existing = await db[IDXDB_TABLES.conversations].get(conv.id);
			if (existing) { skippedCount++; continue; }   // dedup purely on conv.id
			await db[IDXDB_TABLES.conversations].add(conv);
			for (const msg of messages) await db[IDXDB_TABLES.messages].put(msg);
			importedCount++;
		}
		return { imported: importedCount, skipped: skippedCount };
	});
}
```

- Dedup key is **`conv.id` only** — if a conversation with that exact UUID
  already exists locally, the *entire* conversation (all its messages) is
  skipped; there's no per-message merge/upsert-by-id across an existing and
  incoming conversation with the same id.
- Messages are `put` (upsert by `id`), not `add` — so if you re-import the
  same `.jsonl` after already-imported messages exist for a *new* (not
  deduped) conversation id, later messages would overwrite earlier ones by
  id; in practice this only matters if you construct adversarial import data
  since the conversation-level dedup normally short-circuits first.
- No FK/consistency validation — a message whose `parent` isn't in the
  imported set for that conversation is stored as-is (dangling parent
  pointer); the tree-walking helpers (§2.2) tolerate this by starting at
  `currNode` and simply stopping when `nodeMap.get(parent)` returns
  `undefined`.

---

## 6. Hand-assembled realistic sample (importer test fixture)

Scenario: a conversation with a system prompt, one user turn, an assistant
reply that includes `reasoningContent`, then the user regenerates the
assistant reply (branching) producing a second assistant sibling which
becomes the active tip. This is a **single-conversation `.jsonl` export**
(the `downloadConversationFile` path), and — per §2.3 — because the export
call always goes through `getConversationMessages` in the bulk/export-dialog
path (the realistic, common path), it will include the **root message** and
**both assistant siblings** (not just the active one).

IDs are shortened UUID-like strings for readability; timestamps are epoch
millis increasing left-to-right through the scenario.

```jsonl
{"type":"session","harness":"llama.app","currNode":"msg-a4","id":"9f13a7d0-2b41-4c9e-8f77-1d6b6a2e5c10","lastModified":1751809805123,"name":"Rust ownership Q&A","thinkingEnabled":true,"reasoningEffort":"medium"}
{"type":"message","message":{"id":"msg-root","convId":"9f13a7d0-2b41-4c9e-8f77-1d6b6a2e5c10","type":"root","timestamp":1751809800000,"role":"system","content":"","parent":null,"children":["msg-sys"]}}
{"type":"message","message":{"id":"msg-sys","convId":"9f13a7d0-2b41-4c9e-8f77-1d6b6a2e5c10","type":"system","timestamp":1751809800100,"role":"system","content":"You are a concise Rust tutor. Prefer short code examples.","parent":"msg-root","children":["msg-u1"]}}
{"type":"message","message":{"id":"msg-u1","convId":"9f13a7d0-2b41-4c9e-8f77-1d6b6a2e5c10","type":"text","timestamp":1751809801000,"role":"user","content":"Why can't I return a reference to a local variable in Rust?","parent":"msg-sys","children":["msg-a1","msg-a4"]}}
{"type":"message","message":{"id":"msg-a1","convId":"9f13a7d0-2b41-4c9e-8f77-1d6b6a2e5c10","type":"text","timestamp":1751809803500,"role":"assistant","content":"Because the local variable is dropped at the end of the function, so the reference would dangle. Rust's borrow checker rejects this at compile time.","parent":"msg-u1","children":[],"reasoningContent":"The user is asking about lifetimes and dangling references. Keep it short: local var dropped -> reference would outlive its referent -> compiler error E0515.","completionId":"chatcmpl-8f2c1a90","model":"qwen2.5-coder-32b-instruct","timings":{"cache_n":12,"predicted_n":41,"predicted_ms":812.3,"prompt_n":58,"prompt_ms":140.6}}}
{"type":"message","message":{"id":"msg-a4","convId":"9f13a7d0-2b41-4c9e-8f77-1d6b6a2e5c10","type":"text","timestamp":1751809805123,"role":"assistant","content":"The local variable lives on the stack frame of the function; once the function returns, that frame is gone. A `&T` pointing into it would be a dangling reference, so the borrow checker (via lifetime elision) refuses to compile it — you'd see error E0515: \"cannot return value referencing local variable\".","parent":"msg-u1","children":[],"reasoningContent":"Regenerate: be more specific, cite the actual error code E0515 and mention lifetime elision explicitly this time.","completionId":"chatcmpl-8f2c22b1","model":"qwen2.5-coder-32b-instruct","timings":{"cache_n":58,"predicted_n":63,"predicted_ms":1190.4,"prompt_n":58,"prompt_ms":25.1}}}
```

Field-by-field notes on this fixture:

- Session line's `currNode` is `"msg-a4"` — the regenerated (second)
  assistant reply, matching "regenerate creates a new sibling and moves
  `currNode` to it" (§2.1).
- `msg-root`: `type: "root"`, `content: ""`, `parent: null`. Included here
  because this fixture models the common bulk-export path (§2.3). An
  importer must not render this message; it exists only to anchor the tree.
- `msg-sys`: the system prompt, `type: "system"`, child of the root, single
  child pointing at the first user message.
- `msg-u1`: the user turn. Its `children` array has **two** entries,
  `["msg-a1", "msg-a4"]`, in creation order — `msg-a1` is the original
  reply, `msg-a4` is the regenerated one created afterward. This is the
  branch point.
- `msg-a1` and `msg-a4` are **siblings** (same `parent: "msg-u1"`), each with
  its own `reasoningContent`, `completionId`, `model`, and `timings` —
  independent generations, not a diff/patch of each other.
- Neither assistant message has a `toolCalls` field at all (omitted, per
  §3.1's "drop it when empty" rule) — there were no tool calls in this
  scenario.
- No `extra` field appears on any message (no attachments in this scenario).
  A message with an image attachment would instead include e.g.:
  ```json
  "extra":[{"type":"IMAGE","name":"diagram.png","size":48213,"base64Url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."}]
  ```
- To reconstruct "what the user currently sees" from this fixture: resolve
  `currNode` = `"msg-a4"`, walk `.parent` up (`msg-a4` → `msg-u1` → `msg-sys`
  → `msg-root`, stop — `parent === null`), drop the root, sort
  system-first-then-by-timestamp → visible transcript is
  `[msg-sys, msg-u1, msg-a4]`. `msg-a1` exists in storage/in the export but
  is **not** part of the active transcript.

A **zip** containing this same conversation plus one more would be a
`<date>_conversations.zip` with two entries, e.g.:

```
2026-07-06_conversations.zip
├── 2026-07-06_15-30-05_conv_9f13a7d0_rust_ownership_q_a.jsonl
└── 2026-07-06_09-12-40_conv_5c2b9e11_docker_compose_help.jsonl
```

— each entry byte-for-byte the same single-session JSONL format as the
example above (own `type:'session'` header line, own message lines), no
manifest file, no shared/root-level metadata.

---

## 7. Gaps / verify empirically

- **`ChatMessageType`/`ChatRole` don't resolve to any exported type alias
  anywhere in the searched source** (`database.d.ts` imports them from
  `$lib/types/chat`, which doesn't define them; `app.d.ts` re-imports/re-
  exports the same non-existent names). Either this is dead/broken typing
  that `skipLibCheck`-style tooling tolerates, or there's a generated/
  build-time file not present in this checkout that defines them. Doesn't
  affect the runtime JSON shape (confirmed from actual `role`/`type`
  assignment call sites), but worth a sanity check against the fork's build
  output if available.
- **`currNode` typed `string | null` but initialized to `''`.** Confirm
  spail's importer treats `''` the same as `null`/missing when deciding
  whether to fall back to "latest message by timestamp."
- **Export call-site inconsistency (§2.3):** whether the exported `messages`
  array is the full tree (with root) or just the active path (without root)
  depends on whether the conversation being exported happens to be the
  currently-active one in that browser tab at export time. This looks like
  an accidental inconsistency in the fork rather than an intentional
  contract. Verify against a live build of llama-ui (export the same
  conversation both while it's the active tab and while it isn't) rather
  than trusting this derivation from source alone, and decide whether spail
  should normalize to "always full tree" (recommended, since it's a strict
  superset and importer already must handle full-tree per §2.3).
- **Sort/leaf-resolution direction mismatch:** `filterByLeafNodeId` walks
  `currNode` *up* via `.parent`, while `findLeafNode`/`navigateToSibling`
  walk *down* via last `children`. They agree in the common case (freshly
  created messages have no children yet) but could diverge if `currNode`
  ever points at a non-leaf message with real content already produced from
  it (e.g. after some not-yet-found code path sets `currNode` to a message
  that already has a child). Worth a live-app experiment: manually set
  `currNode` to a mid-tree message (e.g. via devtools) and see whether the
  loaded chat view walks up (from that node) or down (to its leaf).
- **`toolCalls` empty-vs-absent semantics on decode:** `parseSessionsJsonl`
  only re-stringifies `toolCalls` when `!== undefined`. A JSONL file
  hand-crafted with `"toolCalls": null` would fail the `typeof !== 'string'`
  check and get passed through as `null` rather than becoming `''` — probably
  harmless but not explicitly handled; decide how strict spail's parser
  should be about this vs. the fork's leniency.
- **No schema validation anywhere in the import path** (confirmed by
  reading, not inferred) — spail's importer is free to be much stricter;
  there is no compatibility reason to replicate the fork's total absence of
  validation, only its wire *shapes*.
- **Legacy `.json` format fields** — this spec did not deep-dive the
  `MigrationService` legacy-format migration code (out of scope per the
  task's file list), only the pass-through shape check in `parseImportFile`
  (`Array.isArray` or `'conv' in parsed && 'messages' in parsed`). If spail
  needs to import very old exports (pre-JSONL), read
  `src/lib/services/migration.service.ts` in the fork separately before
  building that path.
- **Attachment `size` field is unverified/optional** — not cross-checked
  against decoded payload length anywhere in the reviewed code. Don't trust
  it for storage accounting; recompute from decoded bytes.
- **UUID fallback shape** (`Math.random().toString(36).substring(2)`) means
  IDs are not *guaranteed* to be RFC-4122 UUIDs in all environments/exports,
  only "usually." If spail's schema wants to enforce a UUID column type for
  imported conversation/message IDs, this fallback path could produce
  non-conforming values — decide whether to coerce/regenerate IDs on import
  instead of trusting the source IDs verbatim (also sidesteps any
  cross-export ID collisions).
