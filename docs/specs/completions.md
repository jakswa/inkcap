# Chat Completions Protocol — spec mined from llama-ui

Source: `llama-ui` (fork of llama.cpp's web chat UI), primarily
`src/lib/services/chat.service.ts` (~1490 lines) plus the type files it imports
(`src/lib/types/api.d.ts`, `src/lib/types/chat.d.ts`, `src/lib/types/settings.d.ts`),
its enums (`src/lib/enums/chat.enums.ts`, `reasoning-effort.enums.ts`,
`server.enums.ts`), constants (`src/lib/constants/api-endpoints.ts`,
`control-actions.ts`, `sse.ts`, `reasoning-effort-tokens.ts`), and the two
stores that build request options and consume the stream
(`src/lib/stores/chat.svelte.ts`, `src/lib/stores/server.svelte.ts`,
`src/lib/stores/models.svelte.ts`). This document is self-contained; you do
not need to open the fork.

This is talking to **llama-server** (llama.cpp's built-in HTTP server), not a
generic OpenAI backend. It targets a server that may run in one of two roles,
detected from `/props`:

- **MODEL mode** (`role: "model"`) — one model loaded, single instance.
- **ROUTER mode** (`role: "router"`) — the server manages multiple model
  instances; most requests then need an explicit `model` field and there's a
  `/models/load` `/models/unload` control plane. (This ROUTER stuff is
  llama-ui/llama-server specific — flag but probably out of scope for a
  first spail pass; noted here so the abstraction doesn't paint itself into
  a corner.)

All endpoints are relative (`./v1/chat/completions`, `./props`, etc.) —
the fork calls fetch with paths relative to the app's mount base, not an
absolute host. There is no separate "base URL" setting; the SPA is served
by the same llama-server it talks to.

---

## 1. Request shape: `POST ./v1/chat/completions`

### 1.1 TypeScript shape of the outgoing body

```ts
interface ApiChatCompletionRequest {
  messages: Array<{
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string | ApiChatMessageContentPart[];
    reasoning_content?: string;
    tool_calls?: ApiChatCompletionToolCall[];
    tool_call_id?: string;
  }>;
  stream?: boolean;
  model?: string;
  return_progress?: boolean;
  sse_ping_interval?: number;
  tools?: ApiChatCompletionTool[];

  // reasoning
  reasoning_format?: 'none' | 'auto';
  chat_template_kwargs?: { enable_thinking?: boolean; [k: string]: unknown };
  thinking_budget_tokens?: number;
  reasoning_control?: boolean; // always true, see below

  // sampling / generation (all optional; omitted keys mean "use server default")
  temperature?: number;
  max_tokens?: number;
  dynatemp_range?: number;
  dynatemp_exponent?: number;
  top_k?: number;
  top_p?: number;
  min_p?: number;
  xtc_probability?: number;
  xtc_threshold?: number;
  typ_p?: number;
  repeat_last_n?: number;
  repeat_penalty?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  dry_multiplier?: number;
  dry_base?: number;
  dry_allowed_length?: number;
  dry_penalty_last_n?: number;
  samplers?: string[];
  backend_sampling?: boolean;
  timings_per_token?: boolean;

  // vLLM-compat continuation
  add_generation_prompt?: boolean;
  continue_final_message?: boolean;

  // anything else the user pasted into the "custom parameters" textbox gets
  // Object.assign'd directly onto the top-level request body (see §1.5)
  [k: string]: unknown;
}

interface ApiChatMessageContentPart {
  type: 'text' | 'image_url' | 'input_audio' | 'input_video';
  text?: string;
  image_url?: { url: string };            // data: URL or http(s) URL
  input_audio?: { data: string; format: 'wav' | 'mp3' };  // base64, no data: prefix
  input_video?: { data: string; format: 'mp4' | 'ogg' | 'auto' }; // base64
}
```

`ApiChatCompletionToolCall` / `...ToolCallDelta`:

```ts
interface ApiChatCompletionToolCallDelta {
  index?: number;
  id?: string;
  type?: string;               // 'function'
  function?: { name?: string; arguments?: string };
}
interface ApiChatCompletionToolCall extends ApiChatCompletionToolCallDelta {
  function?: { name?: string; arguments?: string };
}
```

### 1.2 Message array construction

Source messages come from two shapes: plain `ApiChatMessageData` (already
API-ready) or a `DatabaseMessage` (has `id`/`convId`/`timestamp`), detected by
duck-typing (`'id' in msg && 'convId' in msg && 'timestamp' in msg`). DB
messages go through `convertDbMessageToApiChatMessageData`.

**System prompt**: There is no special-cased "system prompt" field on the
request. The system prompt is just a normal message with
`role: 'system'` that lives in the conversation's message tree as the first
node (created once, at first send, from the user's configured
`systemMessage` setting — see `chat.svelte.ts` `sendMessage()`:
`DatabaseService.createSystemMessage(convId, systemPrompt, rootId)`). It then
flows through the same message-array mapping as every other message. The one
system-specific rule: **empty system messages are filtered out** before
building the request —

```ts
.filter((msg) => {
  if (msg.role === MessageRole.SYSTEM) {
    const content = typeof msg.content === 'string' ? msg.content : '';
    return content.trim().length > 0;
  }
  return true;
});
```

(Note: `SettingsChatServiceOptions.systemMessage` exists as a field on the
options type and is populated by `getApiOptions()`, but `ChatService.sendMessage`
never destructures/reads a `systemMessage` option — passing it there is a
no-op. The only real mechanism is the DB-message-in-the-array path above.
Don't port the dead option field; port the "system message is just a message"
model.)

**Multimodal / attachment parts** (`convertDbMessageToApiChatMessageData`,
`chat.service.ts:1158-1349`): a DB message's `extra[]` attachments become
`ApiChatMessageContentPart[]` appended in this fixed order, and if any parts
exist the message's plain `content` string becomes one more `text` part
appended after images/audio (see order below), i.e. text-from-extras first,
then the message's own inline text, then video/PDF-derived parts:

1. Text-file attachments (`extra.type === 'TEXT'`) → one `text` part each,
   formatted via `formatAttachmentText('File', name, content)` which produces:
   `"\n\n--- File: <name> ---\n<content>"` (see §1.3 for the exact helper).
2. Legacy `context` attachments (old UI paste format) → same `text` part
   formatting, label `'File'`.
3. Image attachments (`type === 'IMAGE'`) → `image_url` parts. Each image is
   passed through `capImageDataURLSize(base64Url, maxImageResolution)`
   first (resizes per the `MAX_IMAGE_RESOLUTION` setting and bakes in JPEG
   EXIF orientation); untouched images pass through unchanged.
4. Audio attachments (`type === 'AUDIO'`) → `input_audio` parts. Format is
   sniffed from MIME type: `wav`/`wave`/`x-wav`/`x-wave`/`vnd.wave`/`x-pn-wav`
   (case-insensitive, trimmed) → `'wav'`; anything else → `'mp3'`.
5. **The message's own `content` string** (if non-empty) is appended as a
   final `text` part with the raw text (no label wrapping).
6. Video attachments (`type === 'VIDEO'`) → `input_video` parts; format is
   `'mp4'` if the stored MIME type includes `'mp4'`, `'ogg'` if it includes
   `'ogg'`, else `'auto'`.
7. PDF attachments (`type === 'PDF'`): if `processedAsImages` and an
   `images[]` array is present, each page becomes an `image_url` part
   (already-rendered page images); otherwise a single `text` part via
   `formatAttachmentText('PDF File', name, content)`.
8. MCP prompt / MCP resource attachments → `text` parts via
   `formatAttachmentText('MCP Prompt'|'MCP Resource', name, content, serverName)`
   (server name goes in the `extra` 4th arg, rendered as `"name (serverName)"`).

If **none** of an attachment array exists (`!message.extra || length===0`),
`content` stays a plain string (not wrapped in an array) — the array form is
only used when there's at least one attachment.

**Vision-model filtering**: after normalization, if `options.model` is set
and `modelsStore.modelSupportsVision(options.model)` is false, every
`image_url` part is stripped from every message's content array (with a
console.info per drop). If stripping leaves exactly one `text` part, the
message's `content` array is collapsed back down to a plain string.

**Reasoning content on messages**: if the message has `reasoning_content`
(assistant messages with prior thinking) it is copied onto the mapped
message **unless** `excludeReasoningFromContext` is set, in which case it's
omitted (used so reasoning doesn't bloat context on subsequent turns, and
so the pre-encode cache-warming request matches what the next real turn will
send — see §1.6).

**Tool messages**: a DB message with `role === 'tool'` and a `toolCallId`
maps straight to `{ role: 'tool', content, tool_call_id: toolCallId }` — no
attachment processing.

**Tool calls on assistant messages**: `message.toolCalls` is a JSON string in
the DB; it's `JSON.parse`d back into `ApiChatCompletionToolCall[]` and, if
non-empty, set on `result.tool_calls`.

### 1.3 `formatAttachmentText` helper (exact behavior)

```ts
function formatAttachmentText(label: string, name: string, content: string, extra?: string): string {
  const header = extra ? `${name} (${extra})` : name;
  return `\n\n--- ${label}: ${header} ---\n${content}`;
}
```

Sample output for a text file named `notes.txt`:
```
\n\n--- File: notes.txt ---\nline one\nline two
```

### 1.4 Generation parameters: every one the UI can set, and its default

The UI's per-setting registry (`settings-registry.ts`, SAMPLING and
PENALTIES sections) defaults **every numeric sampler/penalty knob to
`undefined`** — meaning: by default the UI sends **none** of these keys and
the server's own compiled-in defaults govern. Two exceptions have concrete
UI defaults:

| Option key | UI default | Notes |
|---|---|---|
| `samplers` | `''` (empty string) | split on `;` into a string array before being placed on the request (`someString.split(';').filter(s => s.trim())`); array input is passed through as-is |
| `backend_sampling` | `false` | boolean, always sent |
| `timings_per_token` | not set in registry, but `getApiOptions()` hardcodes `true` for interactive chat | drives per-token `timings`/`prompt_progress` payloads in the SSE stream |

All of the following are `undefined` by default (omitted from the request
unless the user has explicitly typed a value into Settings → Sampling /
Penalties): `temperature`, `dynatemp_range`, `dynatemp_exponent`, `top_k`,
`top_p`, `min_p`, `xtc_probability`, `xtc_threshold`, `typ_p`, `max_tokens`,
`repeat_last_n`, `repeat_penalty`, `presence_penalty`, `frequency_penalty`,
`dry_multiplier`, `dry_base`, `dry_allowed_length`, `dry_penalty_last_n`.

Every one of these is added to the request body only via an
`if (x !== undefined) requestBody.x = x` guard in `chat.service.ts` — i.e.
the wire contract is "absent key = let the server pick", not "0 = let the
server pick" (one exception: **`max_tokens`**, see below).

**`max_tokens` special case**: when the option is explicitly provided but is
`null` or `0`, the UI sends `-1` (llama-server's "infinite" sentinel) instead
of `0`:

```ts
if (max_tokens !== undefined) {
  requestBody.max_tokens = max_tokens !== null && max_tokens !== 0 ? max_tokens : -1;
}
```

**Reasoning-related fields** (always present regardless of settings):

- `reasoning_format`: `'none'` if `disableReasoningParsing` option is set,
  else `'auto'` (always sent, one of these two literal strings).
- `chat_template_kwargs.enable_thinking`: boolean, always set to whatever
  `enableThinking` resolves to (spread onto any existing
  `chat_template_kwargs` the caller supplied).
- `thinking_budget_tokens`: only set if `enableThinking && reasoningEffort`
  produce a budget `>= 0` (see table below); otherwise omitted entirely
  (internal sentinel value for "no budget" is `-1`, which is *not* sent —
  only non-negative budgets are put on the wire).
- `reasoning_control`: **always `true`**, unconditionally. Comment in source:
  "arms the budget sampler so reasoning can be ended at runtime via the
  control endpoint" (see §3, `stopReasoning`/`POST .../completions/control`).

Reasoning effort → token budget map (`REASONING_EFFORT_TOKENS`):

```ts
{ low: 512, medium: 2048, high: 8192, max: -1 /* unlimited */ }
```

**Continuation (vLLM-compat "continue" feature)**: if
`continueFinalMessage` option is true:
```ts
requestBody.continue_final_message = true;
requestBody.add_generation_prompt = false;
```
Otherwise both fields are omitted.

**Streaming control fields** (always present when `stream` is requested):
```ts
requestBody.stream = stream;                       // boolean, from options.stream
requestBody.return_progress = stream ? true : undefined;   // enables prompt_progress chunks
requestBody.sse_ping_interval = stream ? 1 : undefined;    // seconds; keeps proxies from timing out an idle SSE connection
```

**`model`**: set on the request only if `options.model` is truthy (required
in ROUTER mode; optional/ignored in MODEL mode).

**`tools`**: set only if a non-empty array is provided, else omitted
(not sent as `[]`).

### 1.5 The "custom" escape hatch

The Settings UI has a free-form JSON textarea (`customJson`, passed to
`sendMessage` as `options.custom`, which may be a JSON **string** or an
already-parsed object). It is merged directly onto the finished request body
with `Object.assign`, so it can override *anything* above, including fields
this document doesn't otherwise mention:

```ts
if (custom) {
  const customParams = typeof custom === 'string' ? JSON.parse(custom) : custom;
  Object.assign(requestBody, customParams);
}
```
Parse failures are swallowed (`console.warn`, request proceeds without the
custom params). This is how `generateTitle()` (title-generation helper) sends
`custom: { chat_template_kwargs: { enable_thinking: false } }` to force
thinking off for a one-shot title-generation call, without adding a bespoke
option.

### 1.6 Full sample request body (streaming, with a system prompt, image, and reasoning enabled)

```json
{
  "messages": [
    { "role": "system", "content": "You are a terse, helpful assistant." },
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "\n\n--- File: notes.txt ---\nremember to buy milk" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0KGgoAAAANS..." } },
        { "type": "text", "text": "What's in this screenshot?" }
      ]
    }
  ],
  "stream": true,
  "return_progress": true,
  "sse_ping_interval": 1,
  "model": "ggml-org/Qwen2.5-Omni-7B-GGUF:latest",
  "reasoning_format": "auto",
  "chat_template_kwargs": { "enable_thinking": true },
  "thinking_budget_tokens": 2048,
  "reasoning_control": true,
  "temperature": 0.7,
  "backend_sampling": false,
  "timings_per_token": true
}
```

A minimal non-streaming request (defaults only, MODEL mode, no attachments):

```json
{
  "messages": [
    { "role": "user", "content": "hello" }
  ],
  "stream": false,
  "reasoning_format": "auto",
  "chat_template_kwargs": { "enable_thinking": false },
  "reasoning_control": true,
  "backend_sampling": false
}
```

### 1.7 Request headers

```
Content-Type: application/json
Authorization: Bearer <apiKey>       // only if an API key is configured in Settings
X-Conversation-Id: <convId>          // streaming requests only, and only if a conversationId
                                      // was passed to sendMessage(); see §5. If an explicit
                                      // model is selected, this becomes "<convId>::<model>"
```
`getAuthHeaders()` returns `{}` (no `Authorization` key at all) when no API
key is configured — it does not send an empty Bearer token.

---

## 2. Response shapes

### 2.1 Non-streaming (`stream: false`)

```ts
interface ApiChatCompletionResponse {
  model?: string;
  choices: Array<{
    model?: string;               // non-standard, sometimes present per-choice
    metadata?: { model?: string };// non-standard, seen in some llama-server builds
    message: {
      content: string;
      reasoning_content?: string;
      model?: string;
      tool_calls?: ApiChatCompletionToolCall[];
    };
    finish_reason?: string | null;
  }>;
}
```

Handling (`handleNonStreamResponse`):
1. `response.text()` first (not `.json()` directly) — if the body is blank/
   whitespace-only, throws `Error('No response received from server. Please try again.')`.
2. `JSON.parse` the text.
3. Extracts model name via `extractModelName` (see §2.4).
4. `content = data.choices[0]?.message?.content || ''`.
5. `reasoning_content = data.choices[0]?.message?.reasoning_content`.
6. `tool_calls` are merged through the same `mergeToolCallDeltas` used for
   streaming (with an empty starting array, so it's really just a
   normalization pass), then JSON-stringified for the callback.
7. If both `content` is blank/whitespace-only **and** there were no tool
   calls, throws the same "No response received" error (guards against a
   200 with an empty message).
8. `onComplete(content, reasoningContent, undefined /* no timings for non-stream */, serializedToolCalls)`.

Sample non-streaming response body:
```json
{
  "model": "ggml-org/Qwen2.5-Omni-7B-GGUF:latest",
  "choices": [
    {
      "message": {
        "content": "The screenshot shows a terminal window.",
        "reasoning_content": "The user attached an image...",
        "tool_calls": null
      },
      "finish_reason": "stop"
    }
  ]
}
```

### 2.2 Streaming (`stream: true`) — SSE wire format

Each line of the stream is either:
- `data: {...json...}` — a chunk.
- `data: [DONE]` — sentinel, ends the stream (sets `streamFinished = true`
  and the reader loop exits after processing remaining buffered lines).
- Anything not starting with the literal `data:` prefix is ignored by the
  parser (so llama-server's periodic `sse_ping_interval` keep-alive comment
  lines, e.g. SSE `: ping` comments, pass through invisibly).

Constants (`src/lib/constants/sse.ts`):
```ts
SSE_LINE_SEPARATOR = '\n'
SSE_DATA_PREFIX   = 'data:'
SSE_DONE_MARKER   = '[DONE]'
```
Parsing splits the accumulated decoded text on `\n`, keeps the last
(possibly-partial) fragment in a buffer for the next read, and processes
each complete line. Lines are `line.slice('data:'.length).trim()`ed before
`JSON.parse`.

Chunk shape:
```ts
interface ApiChatCompletionStreamChunk {
  id?: string;
  object?: string;
  model?: string;
  choices: Array<{
    model?: string;
    metadata?: { model?: string };
    delta: {
      content?: string;
      reasoning_content?: string;
      model?: string;
      tool_calls?: ApiChatCompletionToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  timings?: {
    prompt_n?: number;
    prompt_ms?: number;
    predicted_n?: number;
    predicted_ms?: number;
    cache_n?: number;
  };
  prompt_progress?: { cache: number; processed: number; time_ms: number; total: number };
}
```

Per-chunk handling, in order, for `choices[0]`:
1. `content = choice.delta.content` → if present: finalize any open
   tool-call batch (see tool-call merge note below), append to aggregated
   content, fire `onChunk(content)`.
2. `reasoning_content = choice.delta.reasoning_content` → if present: same
   finalize-batch step, append to aggregated reasoning, fire
   `onReasoningChunk(reasoningContent)`.
3. `tool_calls = choice.delta.tool_calls` → merged into the running
   aggregate via `mergeToolCallDeltas` (see §2.3), then the *entire merged
   array so far* is JSON-stringified and passed to `onToolCallChunk` every
   time (not just the delta — each callback invocation carries the full
   accumulated tool-call state).
4. `parsed.id` → first non-empty value seen is passed to `onCompletionId`
   once (`idEmitted` latch, only fires on the very first chunk that carries
   an id).
5. Model name (see §2.4) → first non-empty value fires `onModel` once
   (`modelEmitted` latch).
6. `parsed.timings` / `parsed.prompt_progress` → fed to `onTimings`
   whenever either is present (prompt_progress chunks can arrive with no
   `timings` at all, e.g. during prompt processing before generation starts).

At `[DONE]`: fires
`onComplete(aggregatedContent, fullReasoningContent || undefined, lastTimings, finalToolCalls)`
where `finalToolCalls` is `JSON.stringify(aggregatedToolCalls)` if any tool
calls were seen, else `undefined`.

`finish_reason` values are read off the type (`string | null`) but
**chat.service.ts never branches on the value** — it's typed but unused in
the fork's stream parser. (Standard OpenAI values you should expect from
llama-server: `"stop"`, `"length"`, `"tool_calls"`. Do not assume the fork
validates or requires any particular one — spail's parser should read it but
shouldn't hard-fail on an unrecognized value.)

Sample streaming chunk sequence:
```
data: {"id":"chatcmpl-abc123","model":"qwen2.5-7b","choices":[{"delta":{"content":""},"finish_reason":null}]}

data: {"choices":[{"delta":{"content":"The"}}],"timings":{"prompt_n":42,"prompt_ms":120.5,"cache_n":0}}

data: {"choices":[{"delta":{"content":" screenshot"}}]}

data: {"choices":[{"delta":{},"finish_reason":"stop"}],"timings":{"prompt_n":42,"prompt_ms":120.5,"predicted_n":18,"predicted_ms":410.2,"cache_n":0}}

data: [DONE]
```

Tool-call streaming sample (index-based delta merge, function name then
incremental arguments):
```
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\":"}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"NYC\"}"}}]}}]}}

data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]
```

### 2.3 Tool-call delta merge algorithm (`mergeToolCallDeltas`)

Exact behavior (both streaming per-chunk and the single-shot normalization
of a non-streaming response's `tool_calls` run through this):

```ts
function mergeToolCallDeltas(existing, deltas, indexOffset = 0) {
  const result = existing.map(call => ({ ...call, function: call.function ? {...call.function} : undefined }));
  for (const delta of deltas) {
    const index = (typeof delta.index === 'number' && delta.index >= 0)
      ? delta.index + indexOffset
      : result.length;               // no index -> append
    while (result.length <= index) result.push({ function: undefined });
    const target = result[index];
    if (delta.id) target.id = delta.id;
    if (delta.type) target.type = delta.type;
    if (delta.function) {
      const fn = target.function ? { ...target.function } : {};
      if (delta.function.name) fn.name = delta.function.name;
      if (delta.function.arguments) fn.arguments = (fn.arguments ?? '') + delta.function.arguments;
      target.function = fn;
    }
  }
  return result;
}
```
Key point: `arguments` is **concatenated** (streaming JSON string built up
token-by-token), everything else is **overwritten** on match.

`indexOffset`/"tool call batch" mechanic: content and tool-call deltas can
interleave in one stream when the model reasons, calls a tool, reasons again,
calls another tool, etc. Every time content/reasoning text arrives after a
run of tool-call deltas, the fork "finalizes" the open batch
(`toolCallIndexOffset = aggregatedToolCalls.length`), so the *next* run of
tool-call deltas starts indexing from a fresh offset instead of colliding
with (index 0, index 1, ...) of the previous batch. If you don't need
multi-round tool calls in one stream turn yet, you can skip this and just
merge by index — but be aware naive index-only merging breaks if the model
emits two sequential single-tool-call turns in one SSE connection (both
would say `index: 0`).

### 2.4 Model-name extraction (`extractModelName`)

Priority order, first non-empty (trimmed) string wins:
1. `data.model` (root level).
2. `data.choices[0].delta.model` (streaming — first chunk only, since after
   that `modelEmitted` is already true).
3. `data.choices[0].message.model` (non-streaming final response).

No other locations are checked (explicitly, "avoid guessing from
non-standard locations (metadata, etc.)" — despite `metadata.model` being a
field in the type, it's intentionally never read). In MODEL mode there's a
known llama-server quirk the fork works around: "In single model mode,
llama-server returns a default/incorrect model name in the response" —
downstream code overrides it with the name known from `serverStore`/model
selection rather than trusting this extraction blindly. Worth replicating:
don't treat the model name in the completions response as gospel in
single-model mode.

### 2.5 Timings / usage extraction

There is **no OpenAI-style `usage` object** consumed anywhere in this file.
Instead, llama-server's own `timings` object (present on both streaming
chunks and, presumably, non-streaming responses, though the non-streaming
path here never reads it) carries:
```ts
{ prompt_n?, prompt_ms?, predicted_n?, predicted_ms?, cache_n? }
```
`prompt_n`/`predicted_n` = token counts, `*_ms` = wall time, `cache_n` =
tokens served from KV cache reuse. Tokens/sec is computed downstream (in
`chat.svelte.ts`) as `predicted_n / predicted_ms * 1000`; not part of the
wire payload.

`prompt_progress` (separate from `timings`, only present when the request
set `return_progress: true`) is a live progress-bar signal during long
prompt processing:
```ts
{ cache: number; processed: number; time_ms: number; total: number }
```
`processed` and `total` both include the `cache` portion; UI computes percent
as `(processed - cache) / (total - cache) * 100`.

---

## 3. Realtime control endpoint: `POST ./v1/chat/completions/control`

llama-server extra, not OpenAI-compatible. Used today for exactly one verb:
ending a reasoning block mid-generation ("stop thinking, start answering").

Request:
```json
{ "id": "<completion id from the streamed chunk's top-level \"id\">", "action": "reasoning_end", "model": "optional-model-name" }
```
`CONTROL_ACTION.END_REASONING = 'reasoning_end'` is the only defined action
today. `model` is included only when targeting a specific model (router
mode forwarding); omitted in single-model mode.

Response: any 2xx with JSON body `{ "success": true }` (or any truthy check)
counts as success; anything else (`!res.ok || data?.success !== true`) is
logged and treated as failure — no exception thrown, just returns `false`.
This requires `reasoning_control: true` to have been set on the original
completion request (see §1.4) — that's the whole reason that field is always
forced true: it "arms" the completion so this control call has something to
act on. Matching is by completion `id`, not by slot index, specifically to
avoid a TOCTOU race where a finished completion's slot gets reused by a
different request.

---

## 4. `/props` — llama-server capability/config discovery

`GET ./props?autoload=false` (MODEL mode) or `GET ./props?model=<id>&autoload=false`
(ROUTER mode, per-model). `autoload=false` is sent by default to prevent the
mere act of querying props from triggering a model load; the fork's
`PropsService.fetch(autoload=false)` / `fetchForModel(modelId, autoload=false)`
only omit that param if the caller explicitly opts into autoload=true.
Auth-only headers (no `Content-Type`) via `authOnly: true`.

Full response shape actually read by the fork:

```ts
interface ApiLlamaCppServerProps {
  default_generation_settings: {
    id: number;
    id_task: number;
    n_ctx: number;                 // <-- THE context-size field the UI relies on everywhere
    speculative: boolean;
    is_processing: boolean;
    params: {
      // this is effectively the full sampler/penalty default state, mirrors
      // every generation param in §1.4 plus llama.cpp internals:
      n_predict, seed, temperature, dynatemp_range, dynatemp_exponent,
      top_k, top_p, min_p, top_n_sigma, xtc_probability, xtc_threshold, typ_p,
      repeat_last_n, repeat_penalty, presence_penalty, frequency_penalty,
      dry_multiplier, dry_base, dry_allowed_length, dry_penalty_last_n,
      dry_sequence_breakers: string[],
      mirostat, mirostat_tau, mirostat_eta,
      stop: string[], max_tokens, n_keep, n_discard, ignore_eos,
      stream, logit_bias: Array<[number, number]>, n_probs, min_keep,
      grammar, grammar_lazy, grammar_triggers: string[], preserved_tokens: number[],
      chat_format, reasoning_format, reasoning_in_content, generation_prompt,
      samplers: string[], backend_sampling,
      'speculative.n_max', 'speculative.n_min', 'speculative.p_min',
      timings_per_token, post_sampling_probs,
      lora: Array<{ name: string; scale: number }>
    };
    prompt: string;
    next_token: { has_next_token, has_new_line, n_remain, n_decoded, stopping_word };
  };
  total_slots: number;
  model_path: string;
  role: 'model' | 'router';        // drives MODEL vs ROUTER detection
  modalities: { vision: boolean; audio: boolean; video: boolean };
  chat_template: string;           // used for reasoning/thinking-support heuristics, not sent back
  bos_token: string;
  eos_token: string;
  build_info: string;
  webui_settings?: Record<string, string|number|boolean>;  // deprecated
  ui_settings?: Record<string, string|number|boolean>;
  cors_proxy_enabled?: boolean;
}
```

Fields the fork actually consumes downstream:
- **`role`** → `ServerRole.MODEL` vs `ServerRole.ROUTER` (`detectRole`,
  strict equality check against `'router'`, anything else is treated as
  `'model'`).
- **`default_generation_settings.n_ctx`** → exposed as `serverStore.contextSize`
  (MODEL mode) / `modelsStore.getModelContextSize(modelId)` (ROUTER mode, via
  the per-model props fetch) — used to compute "context used / context total"
  progress bars and (implicitly) to help the user reason about the
  context-overflow error (§6).
- **`modalities.{vision,audio,video}`** → gates whether image/audio/video
  attachment UI and the vision-filtering step in §1.2 are applied. Missing
  fields default to `false` (`vision: modalities.vision ?? false`, etc.).
- **`model_path`** → basename extracted (`split(/(\\|\/)/).pop()`) as a
  display name fallback when nothing better is available.
- **`chat_template`** → heuristic string-matching (`detectThinkingSupport`,
  not detailed here — a regex/substring scan of the Jinja template text) to
  guess whether the model's chat template supports a "thinking" block at all,
  independent of the `reasoning_format` request field.
- **`ui_settings` / `webui_settings`** (`webui_settings` deprecated, prefer
  `ui_settings`) → server-pushed default UI config (theme, etc.); outside
  this doc's scope but note the dual/deprecated-alias pattern if spail wants
  to expose analogous server-pushed config.

In ROUTER mode, the bare `/props` response has **no per-model modalities**
— you must hit `/props?model=<id>` for each model you care about; this is
cached client-side per model id (`modelPropsCache`).

---

## 5. `/slots` and the resumable-stream extras

### 5.1 `GET ./slots` (requires `--slots` server flag)

Used only for `areAllSlotsIdle(model?, signal?)`:
```ts
const url = model ? `./slots?model=${encodeURIComponent(model)}` : './slots';
const slots: { is_processing: boolean }[] = await (await fetch(url, { signal })).json();
return slots.every(s => !s.is_processing);
```
Best-effort: any fetch failure, non-OK response, or missing `--slots` flag
→ treated as **idle** (`true`), not as an error. Used purely to gate a
"pre-encode" cache-warming request (fire a `stream:false, n_predict:0` replay
of the full conversation right after a turn completes, to warm KV cache for
the next turn — only if no slot is currently busy). The full `ApiSlotData`
shape (mirrors `default_generation_settings` plus a slot `id`/`id_task`) is
typed but not used by this idle-check; only `is_processing` is read.

### 5.2 `/v1/models` (`GET`)

Standard-shaped OpenAI list endpoint, but llama-server's payload carries
extra fields beyond the OpenAI spec:
```ts
interface ApiModelListResponse {
  object: string;
  data: ApiModelDataEntry[];   // id, object, owned_by, created, in_cache, path, status, aliases?, tags?, meta?
  models?: ApiModelDetails[];  // parallel array, index-aligned with data[], richer metadata (name, description, capabilities, parameters, details.{family,quantization_level,...})
}
```
Same endpoint path is used for both MODEL and ROUTER mode
(`ModelsService.list()` / `.listRouter()` both call `apiFetch(API_MODELS.LIST)`
= `/v1/models`); the response shape doesn't change, only how many entries
come back and whether `status.value` varies across `unloaded|loading|loaded|
sleeping|failed`. `ApiModelDataEntry.status.args` (loaded models only) holds
the CLI args the instance was started with.

ROUTER-only control endpoints, non-OpenAI:
- `POST /models/load` `{ model, extra_args?: string[] }` → `{ success, error? }`.
  Returns success **before** load completes; caller must poll `/v1/models`
  status.
- `POST /models/unload` `{ model }` → `{ success, error? }`. Same
  fire-then-poll pattern.
- `GET /models/sse` — Server-Sent Events feed of load/unload progress,
  events typed as `status_change | model_status | status_update |
  models_reload | model_remove | download_progress`, payload
  `{ status, progress？: { stages: string[], current: string, value: number }, exit_code? }`.
  Out of scope detail for a first completions-protocol pass but flagged in
  case spail's provider abstraction needs a "model lifecycle" hook.

### 5.3 Resumable streaming (llama-server + llama-ui protocol extension — NOT OpenAI-compatible at all)

This is the biggest llama-server-specific extra in the whole file and is
worth stealing deliberately if spail wants "reload the page mid-stream and
keep watching tokens arrive" behavior. Three endpoints, all under
`./v1/stream*`:

- **`POST ./v1/streams/lookup`** — body `{ "conversation_ids": ["<uuid>", ...] }`,
  response `ApiStreamSession[]`:
  ```ts
  interface ApiStreamSession {
    conversation_id: string;
    is_done: boolean;
    total_bytes: number;
    started_at: number;   // epoch ms
    completed_at: number; // epoch ms, 0/undefined if not done
  }
  ```
  The server only returns sessions for conv ids the caller explicitly asked
  about (no enumeration of foreign sessions). `selectActiveStream(sessions)`
  picks the *running* (`!is_done`) session with the latest `started_at`,
  ignoring any finished sessions (their content is assumed already persisted
  client-side, and their buffers may not match the DB if there's a
  "continue" in play — see the file's own comment at
  `chat.service.ts:519-528`).

- **`GET ./v1/stream/<id>?from=<byteOffset>`** — replays the SSE byte stream
  for a live or recently-completed session starting at an absolute byte
  offset into the server-side buffer. `<id>` is the "stream identity":
  bare `conversationId`, or `conversationId::modelName` when an explicit
  model was selected at POST time (so per-model sessions on the same
  conversation, e.g. in ROUTER mode, don't collide).
  Status codes: `200` success (body is the same SSE format as §2.2, replayed
  from the requested offset), `404` no session exists for that id, `400` the
  requested offset is below the point the server has already dropped from
  its buffer (bounded replay window).

- **`DELETE ./v1/stream/<id>`** — cancels/cleans up server-side session
  state (`cancelServerStream`), auth headers only, best-effort (errors just
  `console.warn`).

**How the client opts in**: any *streaming* `sendMessage` call that also
passes a `conversationId` sends `X-Conversation-Id: <streamIdentity>` on the
original POST — this single header is the server-side signal to start
buffering the SSE output into a replayable session at all. Without a
`conversationId`, no header is sent and (presumably) no server-side replay
buffer is kept.

**Client-side resume bookkeeping** (`localStorage`, key prefix
`STREAM_RESUME_LOCALSTORAGE_KEY_PREFIX + conversationId`): as bytes arrive,
the client tracks the absolute server-side byte offset of the last fully
parsed line (not counting a still-buffering partial line) and persists
`{ bytesReceived, updatedAt, model }` after every batch of parsed lines.
On an unexpected read failure/premature stream end (`reader.read()` throws,
or `done` with no `[DONE]` seen), the client:
1. Sets connection state to `RESUMING`.
2. Calls `GET ./v1/stream/<id>?from=<bytesParsed>` to reconnect.
3. If that returns anything other than HTTP 200, gives up (`LOST` state,
   fires `onError`).
4. If it returns 200 but the resumed reader yields **zero** bytes before
   ending again, gives up rather than retrying forever (`madeProgress` latch
   — every resume attempt must produce at least one byte or the client stops
   retrying; since the session has a bounded buffer size this bounds total
   retries by construction).
5. On success, swaps in the new reader and keeps parsing exactly like the
   original connection, continuing to accumulate into the same
   `aggregatedContent`/`aggregatedToolCalls`/etc.

There's also a **visibility-triggered reconnect**: if the tab was
backgrounded and comes back to visible with no bytes received in the last
`STREAM_VISIBILITY_KICK_MS` (3000ms) while the stream is still active, the
client force-cancels its own reader to trigger the same resume path (working
around mobile/OS socket death that doesn't always surface as a read error).

This is a substantial feature to consider whether to port at all for a v1 of
spail — it implies server-side session buffering keyed by conversation id
(+ optional model suffix), a byte-offset replay API, and a lookup-by-conv-id
endpoint. If spail's server owns the whole pipeline (not proxying to an
upstream llama-server), you may be able to get equivalent resilience more
simply (e.g., server holds the full generation in memory/DB and the client
just re-fetches the message row on reconnect) — call this out explicitly as
a design decision rather than assuming byte-offset SSE replay is required.

---

## 6. Error handling

### 6.1 HTTP-level errors from `POST ./v1/chat/completions` (`parseErrorResponse`)

```ts
interface ApiErrorResponse {
  error:
    | { code: number; message: string; type: 'exceed_context_size_error'; n_prompt_tokens: number; n_ctx: number }
    | { code: number; message: string; type?: string };
}
```

Algorithm:
1. `response.text()`, then `JSON.parse`.
2. `message = errorData.error?.message || 'Unknown server error'`.
3. `error.name = response.status === 400 ? 'ServerError' : 'HttpError'`
   (this is the **only** status-code-based branch — everything else is
   `'HttpError'` regardless of 401/403/404/500/etc.).
4. **Context-overflow detection**: if the parsed error object has *both*
   `n_prompt_tokens` and `n_ctx` keys present (`'n_prompt_tokens' in
   errorData.error && 'n_ctx' in errorData.error` — duck-typed, does **not**
   check `type === 'exceed_context_size_error'`), attaches
   `error.contextInfo = { n_prompt_tokens, n_ctx }` to the thrown Error
   object. Downstream (`chat.svelte.ts`) reads this off the caught error to
   populate a dedicated "context exceeded" dialog showing prompt-tokens vs
   max-context to the user.
5. If the body isn't valid JSON at all (parse throws), falls back to
   `Error('Server error (<status>): <statusText>')`, `name = 'HttpError'`,
   no `contextInfo`.

Sample context-overflow error body:
```json
{
  "error": {
    "code": 400,
    "message": "the request exceeds the available context size, try increasing it",
    "type": "exceed_context_size_error",
    "n_prompt_tokens": 8192,
    "n_ctx": 4096
  }
}
```

### 6.2 No retry-on-context-overflow, no automatic resume-on-error

Grep of the whole fork turns up **no code that automatically retries or
shrinks the request** after a context-overflow error — it's purely
surfaced to the user via a dialog (`DialogChatError.svelte`) with the two
numbers so *they* can start a new conversation, trim history, or raise
`--ctx-size`. If spail wants smarter behavior (auto-summarize/drop oldest
messages and retry), that's new ground, not a lift from this fork.

The only "retry" behavior in the whole file is the SSE resume-on-drop
described in §5.3, which is a *transport-level* reconnect (same
already-issued generation), not a request-level retry after a rejected
request.

### 6.3 Non-streaming empty-body / empty-content handling

Both a blank HTTP body and a 200 with `content` empty-and-no-tool-calls are
treated as user-facing errors ("No response received from server. Please
try again.") rather than being passed through as a valid empty response —
worth replicating so a degenerate 200 doesn't silently render nothing.

### 6.4 Network-level error normalization (`sendMessage`'s outer catch)

Wraps whatever `fetch`/downstream throws into friendlier `Error`s (name +
message) before calling `onError`/rethrowing:
- `TypeError` whose message includes `'fetch'` → `NetworkError`,
  "Unable to connect to server - please check if the server is running".
- Message includes `'ECONNREFUSED'` → `NetworkError`,
  "Connection refused - server may be offline".
- Message includes `'ETIMEDOUT'` → `TimeoutError`,
  "Request timed out - the server took too long to respond".
- `AbortError` (via `isAbortError`) is special-cased to silently return
  (not treated as a failure at all — this is the normal "user clicked stop"
  path).
- Anything else passes through unchanged (or gets wrapped in
  `Error('Unknown error occurred while sending message')` if it wasn't even
  an `Error` instance).

---

## 7. `kind: llama-server` vs generic OpenAI-compatible endpoint — provider-abstraction checklist

Use this as the "if (kind === 'llama-server') { ...extra stuff... }"
checklist when designing spail's provider interface.

**Present in OpenAI-compatible chat completions generically (works against
any provider)**:
- `messages[].{role,content,tool_calls,tool_call_id}` with `content` as
  string or multimodal parts array (`text`, `image_url`).
- `stream`, `model`, `tools`, `temperature`, `max_tokens`, `top_p`.
- SSE `data: {...}` / `data: [DONE]` framing, `choices[0].delta.content`,
  `finish_reason`.
- `Authorization: Bearer <key>` header.

**llama-server-only extras used by this fork** (absent/undefined behavior on
a generic OpenAI endpoint — a provider abstraction should gate all of these
behind a capability flag, not assume they exist):
1. Extended sampler/penalty knobs: `top_k`, `min_p`, `dynatemp_range`,
   `dynatemp_exponent`, `xtc_probability`, `xtc_threshold`, `typ_p`,
   `repeat_last_n`, `repeat_penalty`, `presence_penalty` (technically
   OpenAI-standard but llama.cpp's semantics/defaults differ),
   `frequency_penalty` (ditto), `dry_multiplier`, `dry_base`,
   `dry_allowed_length`, `dry_penalty_last_n`, `samplers` (array of sampler
   names controlling chain order), `backend_sampling`.
2. `reasoning_format` (`'none'|'auto'`), `reasoning_content` on
   messages/deltas, `chat_template_kwargs.enable_thinking`,
   `thinking_budget_tokens`, `reasoning_control` + the entire
   `POST .../completions/control` `reasoning_end` verb.
3. `return_progress` + `prompt_progress` chunks (percent-through-prompt
   progress bar support) and `timings_per_token` + the `timings` object on
   chunks (llama.cpp-specific perf telemetry; no OpenAI `usage` object is
   used at all by this fork).
4. `sse_ping_interval` (keepalive tuning for the SSE connection).
5. `continue_final_message` / `add_generation_prompt` (vLLM-compat
   continuation flags — llama-server supports these but they're not part of
   the core OpenAI spec).
6. `input_video` content-part type (not an OpenAI content type at all).
7. `X-Conversation-Id` header + the whole `/v1/stream*` resumable-session
   protocol (§5.3) — entirely bespoke to this fork/llama-server pairing.
8. `/props` (single global capability/config/context-size endpoint — no
   OpenAI equivalent), `/slots` (processing-state introspection, requires
   `--slots` flag), `/models/load`, `/models/unload`, `/models/sse`
   (router/multi-model lifecycle — `/v1/models` itself is
   OpenAI-shaped-ish but the `data[].{in_cache,path,status,aliases,tags}`
   and parallel `models[]` metadata array are llama-server additions).
9. The `model` mismatch workaround (§2.4) — generic OpenAI providers are
   assumed to report their model name correctly; llama-server in
   single-model mode is known not to, per the fork's own comment.
10. `custom` JSON passthrough merged onto the top-level request body (a
    fork-level escape hatch, not a server behavior per se, but worth noting
    as a design pattern: don't hard-code every param, leave a raw
    passthrough for options the abstraction hasn't modeled yet).

---

## 8. Gaps / verify empirically

- **`finish_reason` values actually emitted by llama-server** are never
  branched on in this fork — you'll need to hit a real llama-server (or read
  its C++ source) to enumerate the exact set (`stop`, `length`, `tool_calls`
  are the OpenAI-standard trio; llama-server may emit others, e.g. around
  grammar-triggered stops).
- **Non-streaming response `timings`/`usage`**: `handleNonStreamResponse`
  never reads a `timings` field even though the streaming path does — is it
  actually absent on non-streaming responses, or just not consumed here?
  Verify against a live server whether `POST .../completions` with
  `stream:false` still returns a `timings` object in the body (spail may
  want to capture it even if this fork didn't bother).
- **`reasoning_control` / `.../completions/control` interaction with
  non-streaming requests**: the control endpoint targets a completion by
  `id`, which is only surfaced via streaming chunks in this fork
  (`onCompletionId`). Unclear whether/how you'd get a completion id to target
  for a non-streaming request, or whether `reasoning_end` is meaningful there
  at all.
- **Exact SSE ping line format**: the parser tolerates any line not
  prefixed `data:`, but the literal wire format of llama-server's
  `sse_ping_interval`-driven keepalive (e.g. `: ping` vs a named event vs
  something else) isn't captured anywhere in this codebase — confirm against
  a live server if spail's SSE parser needs to explicitly recognize/skip it
  rather than relying on the generic "ignore non-data lines" behavior.
- **`prompt_progress.total`/`.cache` semantics at the boundary** (first
  chunk when `cache === total`, i.e. fully cached prompt) — the UI's percent
  formula divides by `(total - cache)`, which is a divide-by-zero if the
  entire prompt was cached; not guarded in the source. Verify what
  llama-server actually sends in that case (maybe it omits `prompt_progress`
  entirely when nothing needs processing — untested here).
- **Whether `/props` without `autoload=false` actually triggers a model
  load in ROUTER mode**, and what the response looks like mid-load
  (the fork treats this as a real behavior worth guarding against by default,
  but the mid-load response shape isn't documented in the types).
- **`ApiContextSizeError.type` field**: the fork's own overflow-detection
  logic explicitly does *not* check `type === 'exceed_context_size_error'`,
  only the presence of `n_prompt_tokens`/`n_ctx` keys — meaning the `type`
  field may be aspirational/not always set by the server, or the fork
  authors just chose duck-typing for robustness. Test both a context-overflow
  error and a couple of other 400s against a live server to see whether
  `type` is reliably present and what other error `type` values exist (only
  `exceed_context_size_error` appears in the type file — there's presumably
  a larger enum server-side for grammar errors, invalid params, etc., that
  this fork simply doesn't special-case).
- **Resumable-stream buffer bounds**: "the session has a bounded size" is
  asserted in a comment but the actual byte/time bound (and what a `400`
  "offset below dropped prefix" response body looks like) is not visible in
  this fork — needs checking against the llama-server implementation directly
  if spail wants to reimplement byte-accurate resume.
- **ROUTER-mode specifics** (`/models/load`, `/models/unload`, `/models/sse`
  event payloads, multi-instance port allocation) are documented here only
  at the shape level found in the type files — nobody in this fork exercises
  the full lifecycle end-to-end in a single code path I could point to, so
  treat the ROUTER section as lower-confidence than the MODEL-mode
  completions protocol.
