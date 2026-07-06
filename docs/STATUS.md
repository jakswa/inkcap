# spail — status (2026-07-06)

Server-driven chat rewrite of llama-ui. All planned milestones are on master,
one commit each. Final QA: `bun run db:types` stable (55 typed queries),
`bun run typecheck` clean, `bun test` 119/119, `bun run build` produces the
production bundle.

## What got built

| Milestone | Commit | What |
|---|---|---|
| M0 | `222069c` | Starter runs as spail (spail / spail_test databases, renamed) |
| Wave 1 | `18477a0` | v1 schema (messages.parent_id tree + conversations.curr_node from day one) + harvested specs from the llama-ui organ donor |
| M1 | `906d8a0` | Providers registry: SSR CRUD, connection test, keys never leave the server |
| M2 | `3bc4cf0` | Walking-skeleton chat: conversations/messages, plain-form send |
| M5 | `15c88a5` | llama-ui importer (JSONL/zip, attachments, branch trees, idempotent) + server-side markdown pipeline |
| M3 | `4e5aa04` | The durable runner: detached streaming, debounced persistence (300ms/24 deltas), run_events replay w/ Last-Event-ID, boot recovery, cancel, stall watchdog |
| M4 | `de59d80` | Chat view: server-rendered markdown + highlight, finalize-swap, composer island, mobile layout |
| M6 | `9780c06` | MCP tools: registry, tool loop, approval flow (waiting_approval park + SSR approve/deny + resume) |
| M7 | this commit | Branching UI: edit-user (branch or in-place) + regenerate, ‹ i/n › sibling switcher, subtree delete, fork active path — all plain HTML forms, JS optional |

Yes, M5 landed before M3/M4 in the log — each milestone is still exactly one
commit, the order is just scrambled (noted in THE_PLAN backlog).

### Post-M7: openai-codex provider (ChatGPT subscription OAuth)

New provider kind speaking the Codex CLI's protocol: PKCE OAuth against
auth.openai.com with a loopback callback the server binds on `localhost:1455`
only during sign-in, tokens in `providers.oauth_credentials` (migration 011)
with mutex-serialized rotation-safe refresh, and a Responses-API translation
layer (`src/services/codex-auth.ts` + `codex-client.ts`, dispatched from
`provider-client.ts` by kind). Spec + caveats: `docs/specs/openai-codex.md`.
Covered by `tests/integration/codex.test.ts` (stub issuer/backend, no real
OpenAI traffic). Known gaps: the `OpenAI-Beta` header is deliberately not
sent (HTTP-path value unverified), usage-window (`/wham/usage`) surfacing is
not built, 429s surface as run errors with the upstream message, and the
loopback flow needs the browser on the server's machine (or an SSH tunnel of
1455) — no device-code fallback yet.

## How to run it

```sh
bun install
bun run db:migrate                 # .env.development -> spail database
bun src/tasks/seed-provider.ts     # creates/updates the "llama-server" provider
                                   # from DEV_LLAMA_SERVER / DEV_LLAMA_KEY
bun run dev                        # http://localhost:3000
```

Register an account in the UI, then import your llama-ui history:

```sh
bun src/tasks/import-llama-ui.ts <export.jsonl-or-.zip> --user jakswa@gmail.com
```

The importer is idempotent — re-running the same file skips already-imported
conversations. It handles zips, attachments (images/audio/pdf/text), branch
trees, and dangling parents; it skips-and-warns on malformed lines instead of
dying.

Everyday verification: `bun run db:types && bun run typecheck && bun test`
(tests use `.env.test` -> spail_test). `bun run build` does all of that plus
the production bundle.

## Reveal-test evidence (M3, against your real llama-server)

- 600-word-story prompt: POST returned 302 in 12ms; the client made **zero**
  requests afterward. T+32s: DB held 2,310 bytes mid-stream; T+47s: reply
  complete at 4,143 bytes (722 words) with no client ever connected.
- Fresh reconnect: page SSR 200 with the full story; fresh SSE replayed the
  whole run from seq 1 (126 events, done).
- `kill -9` mid-generation froze 1,860 persisted bytes; restart logged
  "recovered 1 interrupted run(s)", appended "[interrupted by restart]",
  parked the run as error — zero bytes lost.

## Known gaps / backlog

See "## Backlog" in `docs/THE_PLAN.md`. Highlights:

- Edit-user has no "Save (keep responses)" button yet — saving always
  regenerates. Manual *assistant* edit also not implemented (regenerate is).
- The ‹ i/n › sibling switcher is SSR-only: after a live finalize-swap it
  appears on next page load, not instantly.
- Forking mid-stream copies the streaming leaf as-is; fork doesn't copy
  attachments.
- Runner "resume stream" is the finalize-as-interrupted fallback only.

## Needs your eyeballs

- Branching UX feel (M7): edit/regenerate/switch/delete/fork are all plain
  forms — try them against the real llama-server and see if anything feels
  clunky compared to llama-ui.
- MCP approval flow (M6): approve/deny is SSR forms; check the park/resume
  feel on a real tool-using conversation.
- Run a real import of your llama-ui export and eyeball a few branched
  conversations end-to-end.
