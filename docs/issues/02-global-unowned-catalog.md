# 02 — Global unowned provider/MCP catalog (broken access control)

**Severity:** High
**Reachable by:** any authenticated user
**Status:** RESOLVED (migration `012_accounts.sql`, 2026-07-06)

## Resolution

- `accounts` + `account_memberships` tables; every user gets a personal
  account (id = user id) created atomically with registration.
- `providers.account_id` / `mcp_servers.account_id` (NOT NULL); every route
  fetches through a membership join (`getProviderForUser`,
  `getMcpServerForUser`, `list*ForUser`), so a foreign id 404s. The runner's
  `listEnabledMcpServersForConversation` joins memberships via the
  conversation owner, so a stray override row cannot expose a foreign server.
- Legacy data: the migration also detaches `conversations.provider_id` where
  the conversation owner's accounts can't see the provider (the backfill gives
  pre-012 rows to the earliest user), and the send/regenerate preflights fetch
  the provider scoped by the conversation owner — a legacy conversation cannot
  keep spending a foreign provider.
- Registration is gated by `REGISTRATION` env (default closed in production);
  `src/tasks/create-user.ts` bootstraps closed deployments.
- MCP edit form no longer echoes stored header values; blank keeps them, an
  explicit checkbox clears them (mirrors the provider API-key pattern).
- Regression coverage: cross-account 404 sweeps in
  `tests/integration/providers.test.ts` / `mcp-servers.test.ts`,
  runner-guard and header-masking tests, `registration-gate.test.ts`.

Original finding follows.

## Problem

`providers` and `mcp_servers` are global tables with **no `user_id`** and there is **no
admin role** anywhere (grep confirms no role/is_admin column). Schema:
`src/db/migrations/002_providers.sql`, `007_mcp_servers.sql`. Every handler in
`src/routes/providers.ts` and `src/routes/mcp-servers.ts` gates only on
`if (!c.var.user)` — authentication, never authorization.

Because registration is open, this is a multi-tenant app in which any registered user
can list, create, edit, delete, enable/disable, and test **every** provider and MCP
server in the deployment — including rows another user created.

## Impact

- **Cross-tenant DoS:** `POST /providers/:id/delete` or `/disable` breaks every
  conversation that uses that provider.
- **Catalog poisoning:** create or edit an MCP server the whole app can enable.
- **Root cause / amplifier for:**
  - [03 — Credential exfiltration](03-credential-exfiltration.md)
  - [04 — Approval bypass via auto_approve](04-approval-bypass-auto-approve.md)
  - [05 — Approval TOCTOU](05-approval-toctou.md)

Note the inconsistency: `GET /mcp-servers/:id/edit` renders stored auth **headers**
(e.g. `{"Authorization":"Bearer sk-…"}`) as plaintext into a `<textarea>`
(`mcp-servers/edit-content.eta:29`), while `providers` deliberately masks its secret.
So any logged-in user can read another tenant's MCP auth secrets directly.

## Fix

- Add `user_id` (or an org/team scope) to `providers` and `mcp_servers`.
- Scope **every** query with `WHERE user_id = $current`.
- If the catalog is meant to be shared, gate create/edit/delete/enable behind a real
  admin role.
- Never render stored MCP header values back to the client — mirror the provider
  mask + "leave blank to keep" pattern.
