# THE PLAN — inkcap

> **Completed 2026-07-06.** All milestones (M0–M7) landed, one commit each,
> plus post-plan work (Codex provider, accounts). Kept as the design record;
> live state is `docs/STATUS.md`, future work is `docs/roadmap/`.

A server-driven LLM chat app. Boring SSR everywhere it can be boring; JavaScript
spent only where the chat actually streams; the **server owns the conversation**
— close the laptop mid-generation, open your phone 30 minutes later, and the
chat reached a sensible stopping point without you.

Built on the bun-hono-ssr starter (Hono routes, Eta templates, HTML forms,
`Bun.SQL` + bun-sqlgen typed queries, raw SQL migrations, cookie sessions,
Tailwind). See README.md for starter conventions — they are house rules here.

## Why this exists

llama.cpp's web UI (forked as reference at `~/sandbox/llama-ui`, checkpoint
`76fa64c`) is the best chat UI around, but it has two structural problems we
can't cheaply patch out:

1. **Single-provider**: welded to one same-origin llama-server. We want a
   registry of providers (llama-server, OpenAI-compatible endpoints, etc.)
   configured like MCP servers, selectable per conversation.
2. **Client-owned everything**: the browser runs the completion loop, executes
   tool calls, and stores chats in IndexedDB. Close every tab and the chat is
   dead; switch devices and history isn't there.

Fixing #2 inverts the data flow that its 25k lines of SPA components assume,
so instead: fresh rewrite, and the fork becomes an **organ donor and living
spec** (UX behaviors, provider quirks, export format, message-tree design).

## Principles

- **Boring CRUD is boring.** Conversation list, provider management, settings,
  auth: SSR Eta templates and plain HTML forms. No client JS.
- **JS is a budget, spent on the chat view only.** One small hand-rolled
  island: subscribe to SSE, append tokens, submit the composer without a full
  reload. No framework, no bundler ceremony beyond what the starter has.
- **The server is the agent runtime.** A chat "run" is a durable server-side
  job. Browsers are spectators that can attach, detach, and reattach.
- **Server-rendered fragments over client templating.** The server renders
  message HTML (Eta partials, markdown converted server-side); the client
  inserts it. The stream protocol carries HTML and small JSON control events,
  not app state.
- **Provider keys never reach the browser.** Stored server-side; the server
  makes all upstream calls.
- **Schema is the expensive decision — make it right early.** Message tree
  (branching) in the schema from day one, even though v1 renders linear.
- **Commit only at milestones** (working end-to-end slices), per house rule.

## Architecture

```
browser ──(HTML forms / SSE)──> Hono app ──┬── PostgreSQL (conversations, messages, runs, providers)
                                           ├── chat runner (in-process durable loop)
                                           └── upstream providers (llama-server :8001, OpenAI-compat, ...)
```

One bun process (web server + chat runner) plus the local PostgreSQL already
running on this machine. The app process is a stateful singleton by design
(personal-scale); "restart the server" must always be safe (see Runner §
recovery). PGlite was considered and dropped: its on-disk persistence is real
(`new PGlite('<data-dir>')`), but it's single-connection WASM without a wire
protocol, so keeping `Bun.SQL` + bun-sqlgen + the test harness would have
required a `pglite-socket` bridge — complexity with no payoff when a real
Postgres is already running locally.

### The chat runner (the actual hard part)

A `runs` row is the unit of durable work. The runner is an in-process loop
(not a queue system) that:

- **Streams from the provider** and persists progress: append token deltas to
  the active message row on a debounce (~250–500ms or N tokens), so a crash
  loses seconds, not the message.
- **Continues without clients.** SSE subscribers are fan-out only; zero
  subscribers changes nothing.
- **Reaches stopping points.** A run ends when: the assistant message finishes
  with no tool calls; a tool/turn budget is exhausted; a tool call requires
  approval (run parks in `waiting_approval`); the provider errors terminally;
  or the user cancels.
- **Recovers on boot.** Startup scans for `running` runs, marks the
  interrupted step, and either resumes (if provider supports it) or finalizes
  the partial message with an "interrupted" marker and parks the run in
  `error` — never silently lose or duplicate work.
- **Replays for late joiners.** Every SSE event has a per-run sequence number;
  clients reconnect with `Last-Event-ID` and get replay-from-cursor, then live
  tail. Full-state fallback: reload the page (SSR renders current DB truth).

### Providers

A `providers` table, managed with boring SSR forms — the same mental model as
the fork's MCP-server registry (`{name, url, api_key, enabled}` + per-
conversation choice):

- `base_url`, `api_key`, `kind` (`openai-compat` | `llama-server`), `enabled`,
  `default_model`.
- `kind=llama-server` unlocks the useful extras the fork taught us
  (`/props` for context size, `/slots`, model info); `openai-compat` is the
  floor: `/v1/models` + `/v1/chat/completions` streaming.
- Conversation stores `provider_id` + `model`; changeable between turns.
- "Test connection" button on the provider form (server-side check, SSR
  result).
- Jake's llama-server: `http://localhost:8001`, key in `LLAMA_API_KEY` — first
  seeded provider.

### Data model (v1)

```
users            (from starter — keep auth; phone access = internet exposure someday)
providers        id, name, kind, base_url, api_key, default_model, enabled, timestamps
conversations    id, user_id, title, provider_id, model, curr_node (message id), pinned,
                 forked_from_conversation_id, timestamps
messages         id, conversation_id, parent_id, role ('system'|'user'|'assistant'|'tool'),
                 content, reasoning_content, model, status ('complete'|'streaming'|'interrupted'),
                 tool_calls jsonb, timings jsonb, created_at
                 -- tree: parent_id + conversations.curr_node picks the active leaf path;
                 -- children derived by query (index on parent_id), not stored arrays
runs             id, conversation_id, status ('running'|'waiting_approval'|'done'|'cancelled'|'error'),
                 leaf_message_id, turn_count, budget jsonb, error, seq (event cursor), timestamps
attachments      id, message_id, kind, name, mime, bytes (bytea), created_at
                 -- separate table (NOT inline base64 in messages, the fork's mistake);
                 -- served by URL, sized-capped; v1 supports text/image
```

Adaptation from the fork's Dexie schema: same tree concept, but `children[]`
arrays become a `parent_id` index (Postgres can enforce integrity; client-
maintained arrays were a local-first workaround).

### The chat view (the one rich island)

- SSR page renders the full active-path transcript from DB (works with JS
  disabled — you just don't see live tokens).
- `<script>` island (vanilla, no build step): opens
  `GET /conversations/:id/events` (SSE), handles events:
  `message-start`, `delta` (rendered-HTML chunk or raw text + server-rendered
  finalize), `message-final` (server-rendered partial replaces the streaming
  node), `run-status`. Composer form posts normally; island intercepts to
  avoid reload when JS is on.
- Markdown rendered **server-side** (pick small: `marked` or `markdown-it` +
  `highlight.js` on the server; sanitize output). Streaming display shows
  plain text during the stream and swaps in rendered HTML at `message-final`
  — dodges the mutating-mid-parse mess for v1. KaTeX/Mermaid: later, server-
  side where possible.

## Milestones (each = one commit)

- **M0 — Starter runs as inkcap.** Create `inkcap` + `inkcap_test` databases on
  the local Postgres, configure `.env.local`/`.env.test`, rename app bits,
  `db:migrate` + `db:types` + `bun test` green, auth works. Nothing inkcap-
  specific yet.
- **M1 — Providers.** Schema + SSR CRUD + connection test + seed from env.
  Milestone proof: provider list page shows llama-server on :8001 as healthy.
- **M2 — Walking-skeleton chat.** Conversations/messages schema, conversation
  list + new-conversation (SSR), send a message via plain form POST, runner
  executes one non-streaming completion, redirect shows the reply. Ugly, no
  JS, end-to-end through the real provider.
- **M3 — The durable runner.** Streaming, token persistence, SSE with replay,
  boot recovery, cancel button, stopping-point rules. Milestone proof (the
  reveal test): start a long generation, `kill` the browser, reopen from
  another device, transcript is complete or still streaming live.
- **M4 — Chat view becomes good.** Server-side markdown + highlighting,
  message-final swap, composer island, mobile-usable layout.
- **M5 — Import from llama-ui.** Parse the fork's JSONL/zip export
  (`{conv, messages}` shape, tree-aware) into Postgres. Jake's history
  migrates.
- **M6 — Tools/MCP server-side.** MCP client in the runner, approval flow
  (`waiting_approval` + approve/deny forms — approvals are boring CRUD!).
- **M7 — Branching UI.** Edit/regenerate creating siblings, path switcher.
  Schema already supports it; this is pure view work.

## Non-goals (v1)

PWA/offline (server-driven by design), themes, Storybook, i18n, multi-user
sharing, per-keystroke sync, attachments beyond text/images, prompt caching
cleverness. The fork keeps living at `~/sandbox/llama-ui` for anything we
miss.

## Open decisions

- ~~**D1 — pglite wiring.**~~ **Resolved 2026-07-06: no pglite.** A local
  PostgreSQL is already running on :5432 — `Bun.SQL`, bun-sqlgen, migrations,
  and tests stay exactly as the starter ships them, pointed at `inkcap` /
  `inkcap_test` databases.
- ~~**D2 — SSE token persistence cadence.**~~ **Resolved 2026-07-06 (M3):
  flush pending deltas every 300ms OR every 24 deltas, whichever first
  (`src/services/runner.ts`). 300ms bounds the crash-loss window; 24 tokens
  caps write amplification on fast providers. Observed against the mock
  provider: a `kill -9` mid-stream lost only the final ~300ms of tokens.**
- ~~**D3 — Markdown pipeline.**~~ **Resolved 2026-07-06: `marked` (GFM out of the box) + `highlight.js` (sync API) + `sanitize-html` (runs last, allowlist), behind `renderMarkdown()` in `src/utils/markdown.ts`.**
- ~~**D4 — Attachment storage.**~~ **Resolved 2026-07-06: bytea in Postgres — the importer decodes attachments straight into the existing `attachments` table; no new migration.**

## Reference material (the organ donor)

`~/sandbox/llama-ui` (checkpoint `76fa64c`), notable organs:

- `src/lib/types/database.d.ts` — message tree + attachment shapes.
- `src/lib/stores/conversations.svelte.ts` — JSONL/zip export format
  (`serializeSessionToJsonl`, `parseImportFile`) → M5 importer spec.
- `src/lib/services/chat.service.ts` — completion request shape, llama-server
  extras (`/props`, `/slots`, stream resume), error-body parsing
  (`n_prompt_tokens`/`n_ctx` context-overflow detection).
- `src/lib/stores/mcp.svelte.ts` + `src/lib/types/mcp.d.ts` — MCP registry
  UX and per-conversation override semantics → M6.
- General UX answer key: how edit/regenerate/branch/stop should *feel*.

## Known risks (accepted with eyes open)

1. The runner is an agent runtime — it's the real project; don't half-ass
   recovery/cancellation (M3 is the make-or-break milestone).
2. Streaming markdown is the fiddly 10% — v1 dodges via finalize-swap.
3. Single stateful process — safe-restart is a feature requirement, not ops
   trivia.
4. No offline, ever, by design.
5. Rewrites die of parity-chasing — the fork stays runnable so nobody is
   tempted to rush parity; inkcap only has to win at durability + providers.

## Backlog

Post-v1 items surfaced during final integration live in `docs/roadmap/`. One
historical note stays here:

- **Milestone commit order is scrambled on master.** Linear history reads
  M0 → Wave1 → M1 → M2 → M5 → M3 → M4 → M6 → M7 (the M5 importer landed early
  and bundled the D3 markdown pipeline, an M4 concern). Each milestone is still
  exactly one commit; reordering would mean rewriting published history — not
  worth it. Recorded so nobody is confused by the log.

## Appendix: what landed (commit map)

| Milestone | Commit | What |
|---|---|---|
| M0 | `222069c` | Starter runs as inkcap (inkcap / inkcap_test databases, renamed) |
| Wave 1 | `18477a0` | v1 schema (messages.parent_id tree + conversations.curr_node from day one) + harvested specs from the llama-ui organ donor |
| M1 | `906d8a0` | Providers registry: SSR CRUD, connection test, keys never leave the server |
| M2 | `3bc4cf0` | Walking-skeleton chat: conversations/messages, plain-form send |
| M5 | `15c88a5` | llama-ui importer (JSONL/zip, attachments, branch trees, idempotent) + server-side markdown pipeline |
| M3 | `4e5aa04` | The durable runner: detached streaming, debounced persistence (300ms/24 deltas), run_events replay w/ Last-Event-ID, boot recovery, cancel, stall watchdog |
| M4 | `de59d80` | Chat view: server-rendered markdown + highlight, finalize-swap, composer island, mobile layout |
| M6 | `9780c06` | MCP tools: registry, tool loop, approval flow (waiting_approval park + SSR approve/deny + resume) |
| M7 | `9a58453` | Branching UI: edit-user + regenerate, ‹ i/n › sibling switcher, subtree delete, fork active path — all plain HTML forms, JS optional |
| Post-M7 | `e2cd1d6` | openai-codex provider: ChatGPT-subscription OAuth (PKCE + loopback :1455), token refresh, Responses-API translation |
| Post-M8 | `ef24020` | Accounts + ownership scoping + registration gate (issue 02) |

## Appendix: M3 reveal-test evidence (against a real llama-server)

- 600-word-story prompt: POST returned 302 in 12ms; the client made **zero**
  requests afterward. T+32s: DB held 2,310 bytes mid-stream; T+47s: reply
  complete at 4,143 bytes (722 words) with no client ever connected.
- Fresh reconnect: page SSR 200 with the full story; fresh SSE replayed the
  whole run from seq 1 (126 events, done).
- `kill -9` mid-generation froze 1,860 persisted bytes; restart logged
  "recovered 1 interrupted run(s)", appended "[interrupted by restart]",
  parked the run as error — zero bytes lost.
