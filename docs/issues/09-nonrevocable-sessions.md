# 09 — Non-revocable stateless sessions carry stale identity

**Severity:** Medium (documented limitation, but real the moment mutable accounts exist)

## Problem

`currentUser` trusts the cookie's `user` object verbatim and never re-fetches from the
DB (`src/middleware/current-user.ts:19-28`). `issuedAt` is stored in the session but
never compared against any watermark — `decryptSession` only checks expiry
(`src/utils/private-session.ts:24-27,56-61`). Sessions live 30 days. Logout clears only
the current browser's cookie (`src/routes/auth.ts:140-146`).

Consequences:
- A deleted or renamed user keeps a fully valid session until expiry.
- There is no "log out everywhere."
- A leaked cookie is valid for the full 30 days with no way to revoke it.

This is acknowledged in CLAUDE.md, but it becomes an exposure the moment you add
password change, account deletion, or forced logout.

## Fix

- Re-fetch the user on sensitive routes.
- Add a per-user `sessions_valid_after` watermark; compare `issuedAt` against it and
  reject stale sessions.
- Bump the watermark on password change / deletion / forced logout.
