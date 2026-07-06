# spail — status (2026-07-06)

Server-driven chat rewrite of llama-ui. All planned milestones (M0–M7) plus
two post-plan slices are on master, one commit each — the commit map and M3
reveal-test evidence live in `docs/completed/THE_PLAN.md`. Verification:
`bun run db:types` stable (55 typed queries), `bun run typecheck` clean,
`bun test` 119/119, `bun run build` produces the production bundle.

Day-to-day setup and commands: README.md. Future work: `docs/roadmap/`.
Security/correctness hardening: `docs/issues/`.

## Post-M7: openai-codex provider (ChatGPT subscription OAuth)

Provider kind speaking the Codex CLI's protocol: PKCE OAuth against
auth.openai.com with a loopback callback bound on `localhost:1455` only
during sign-in, tokens in `providers.oauth_credentials` (migration 011) with
mutex-serialized rotation-safe refresh, and a Responses-API translation layer
(`src/services/codex-auth.ts` + `codex-client.ts`, dispatched by kind from
`provider-client.ts`). Spec + caveats: `docs/specs/openai-codex.md`; tested
by `tests/integration/codex.test.ts` (stub issuer/backend, no real OpenAI
traffic). Known gaps tracked in `docs/roadmap/README.md`.

## Post-M8: accounts, ownership scoping, registration gate

Providers and MCP servers stopped being a global catalog: `accounts` +
`account_memberships` (migration 012; personal account id = user id, created
atomically with registration), `account_id NOT NULL` on both tables, every
route fetching through a membership join so a foreign id 404s, and the
runner scoping MCP servers via the conversation owner. Registration is gated
by `REGISTRATION` (default closed in production; `create-user` task
bootstraps). Details + legacy-data handling:
`docs/issues/resolved/02-global-unowned-catalog.md`. Sharing later is
additive — insert a membership row; the scoped queries already grant access.
