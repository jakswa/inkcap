# 02 — Global unowned provider/MCP catalog (broken access control)

**Severity:** High
**Reachable by:** any authenticated user

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
