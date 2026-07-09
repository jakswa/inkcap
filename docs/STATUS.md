# Status (2026-07-08)

inkcap is usable: server-owned chat runs, branching messages, providers, MCP
approval parking, llama-ui import, account scoping, registration gate,
ChatGPT/Codex provider, demo seed data, Docker build, and tests are in place.

Verify before meaningful code changes:

```sh
bun run db:types
bun run typecheck
bun test
```

## Important implementation facts

- The runner is the runtime (`src/services/runner.ts`): it streams, persists,
  fans out SSE, parks for approvals, and recovers interrupted runs on boot.
- Providers and MCP servers are account-scoped. Keep membership joins on every
  route/runner lookup that touches them.
- Messages are a branch tree. `conversations.curr_node` selects the active path.
- Markdown rendering is server-side and sanitized.
- Split-origin/self-hosted deployments use `PUBLIC_ORIGIN`,
  `CSRF_TRUSTED_ORIGINS`, and `OUTBOUND_TRUSTED_HOSTS`.

## Where work is tracked

- Roadmap features and polish: `docs/roadmap/README.md`
- Security/correctness hardening: `docs/issues/README.md`
- Finished design history: `docs/completed/THE_PLAN.md`
- Codex provider details: `docs/specs/openai-codex.md`
