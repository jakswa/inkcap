# 17 — Low-priority hardening bundle

Lower-severity items worth folding in opportunistically. None are directly exploitable
today.

## 17a — run_events grows unboundedly between restarts

Cleanup runs only at boot (`src/index.ts:13`, `runner.ts:938`). A long-lived server
accumulates ~1 row per flush (up to ~3/sec/run) forever, and stranded non-terminal runs
are never eligible. Add a periodic cleanup timer
that also handles stale non-terminal runs.

## 17b — No total run timeout or output cap

The watchdog (`src/services/provider-client.ts:281`) only catches *silence*. A provider
trickling one token per 100s pins the conversation slot indefinitely and grows
`messages.content` without bound. User inputs are now capped, but provider output
still is not. Worse, `content = content || delta`
(`messages.ts:60-67`) rewrites the whole row each flush — O(n²) write amplification on
very long outputs. Add a max wall-clock and max content length, both parking as `error`.

## 17c — Cancel not honored during a tool batch

`handle.abort` is wired only into `streamChat` (`runner.ts:327`); `callTool` takes no
`AbortSignal`, so cancel waits out the tool call (bounded only by the per-server
`request_timeout_ms`) and the batch keeps inserting tool messages after the user pressed
stop. Cosmetic sibling: `cancelRun` on a just-finished run returns `true`
(`runner.ts:860-863`) even though nothing was cancelled.

## 17d — SSE write chain has no backpressure

`src/routes/conversations.ts:682-694`: a slow client's `writeChain` buffers every
rendered event in memory for the connection's lifetime. Minor at current scale.

## 17e — Batch approve/deny is all-or-nothing

`decideRunApprovals` (`tool-approvals.ts:56`) decides every pending row to one decision;
a user can't approve one tool and deny another in a multi-call turn. Defense-in-depth
gap, not a direct hole.

## 17f — Importer decompression-bomb risk

`src/utils/llama-ui-import.ts` / `src/tasks/import-llama-ui.ts` is CLI-only (no HTTP
route reaches it), so not remotely reachable. A malicious zip could still be a
decompression-bomb DoS against the operator running the import. Low priority given it's
operator-invoked.

## 17g — Concurrent tests mutate shared process.env

`bunfig.toml` sets `concurrentTestGlob = "*"`, and several integration tests
set/delete process-global env vars mid-test (`CODEX_AUTH_ISSUER`,
`CODEX_BASE_URL`, `PUBLIC_ORIGIN`) with cleanup in `finally`. A concurrently
running test that reads the same var during that window (codex `returnTo`
assertions, CSRF origin checks) can flake. Hasn't been observed in practice —
the windows are microseconds — but the pattern scales badly; a shared
env-mutation lock in `tests/helpers` (or per-request config injection) would
retire it.

## 17h — Unbounded MCP tool-result size

`extractResultText` (`src/services/mcp-client.ts`) joins all text parts (or
`JSON.stringify`s the whole content array) with no length cap, and the runner
stores the result verbatim as a tool message. A malicious or buggy MCP server
can return a multi-megabyte result that is buffered in memory and written to
`messages.content`. Distinct from 17b, which caps *provider* output but
explicitly not tool-result content. Add a byte cap with truncation.

## 17i — Codex loopback listener leaks after an abandoned login

`sweepExpiredLogins()` (`src/services/codex-auth.ts`) deletes expired pending
logins but never calls `stopLoopbackIfIdle()` — that stop is only reached from
`completeCodexLoginCallback`'s `finally`. If a user starts a Codex sign-in and
never returns (browser closed), the pending entry is swept on the next
`startCodexLogin`, but the `Bun.serve` on `127.0.0.1:1455` stays bound
indefinitely with zero pending logins. Bounded to loopback, so low impact.
Call `stopLoopbackIfIdle()` after sweeping.

## 17j — Account enumeration on registration

`POST /register` returns `'Email is already registered'` for an existing
address (`src/routes/auth.ts`), versus the deliberately generic login error —
so registration discloses account membership. `REGISTRATION` defaults to
`closed` in production, which contains this to `open` deployments. Use a
generic message (or a verification-email flow) where open registration is on.
