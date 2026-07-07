# 18 — Split-origin session cookies: residual limits of the dual-name scheme

The split-origin deployment work (HTTPS domain behind a TLS-terminating proxy
plus plain-HTTP LAN-IP access) made the session cookie name per-request: a
secure request gets `__Host-session`, an insecure one gets `session`
(`src/utils/private-session.ts`, `src/routes/auth.ts`).

Guardrails already in place:

- In production the insecure `session` cookie is only **issued or accepted**
  when the operator has declared a plain-http trusted origin
  (`insecureSessionCookieAllowed()`); an https-only deployment keeps full
  `__Host-` semantics, and a proxy that forgets `x-forwarded-proto` degrades
  to a Secure cookie rather than an insecure one.
- `currentUser` uses the first cookie that *decrypts* (secure name first), so
  a stale/undecryptable `__Host-session` can't wedge logins into a loop.
- Issuing `__Host-session` also deletes a leftover `session` cookie.

Residual warts, inherent to serving one hostname over both schemes:

- Browsers reject Secure `Set-Cookie` (including deletions) over plain http,
  so **logout over the http side cannot clear `__Host-session`** — the https
  session survives until expiry. Same root cause: a *still-valid* old
  `__Host-session` shadows a newer http login on https requests. Only a
  server-side invalidation watermark (issue 09) truly fixes either.
- With the http opt-in active, an on-path attacker can inject a `session`
  cookie holding a valid session they own (fixation into the attacker's
  account). Sessions are AES-GCM authenticated, so forging one is not
  possible; registration is closed in production.
- `requestIsSecure` trusts `x-forwarded-proto` from any client (no
  trusted-proxy list). It only picks the cookie name, and the opt-in gate
  bounds the damage to the downgrade described above.

Related, same commit: `OUTBOUND_TRUSTED_HOSTS` exempts listed hosts from the
production SSRF guard for *every* account on the instance, not per-owner, and
trusts the name rather than what it resolves to (a repointed DNS record stays
trusted). Fine single-family; revisit (per-provider allow flag) before
multi-tenant sharing.
