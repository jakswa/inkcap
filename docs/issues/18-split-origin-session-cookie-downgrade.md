# 18 — Split-origin support accepts the insecure session cookie everywhere

The split-origin deployment work (HTTPS domain behind a TLS-terminating proxy
plus plain-HTTP LAN-IP access) made the session cookie name per-request: a
secure request gets `__Host-session`, an insecure one gets `session`
(`src/utils/private-session.ts`, `src/routes/auth.ts`). `currentUser` accepts
either name, preferring `__Host-session` when both are present.

Consequences, deliberate but worth remembering:

- The `__Host-` prefix guarantees are now advisory: an HTTPS-only production
  deployment still *accepts* a plain `session` cookie. Sessions are AES-GCM
  encrypted + authenticated, so an attacker cannot mint one, but an active
  network attacker who can answer plain-HTTP requests for the domain can
  inject a `session` cookie carrying a *valid session they own* — logging the
  victim into the attacker's account (session fixation, needs a MITM position
  and an account on the instance; registration is closed in production).
- `requestIsSecure` trusts `x-forwarded-proto` from any client, with no
  trusted-proxy list. It only picks the cookie name, so the worst a spoof
  achieves is a cookie the browser refuses or a downgrade to the name above.

If inkcap ever grows past the home-lab threat model, gate acceptance of the
insecure cookie behind explicit split-origin config (e.g. only when
`CSRF_TRUSTED_ORIGINS` names an http origin) and add a trusted-proxy setting.
Related: `OUTBOUND_TRUSTED_HOSTS` (same commit) exempts listed hosts from the
production SSRF guard for *every* account on the instance, not per-owner —
fine single-family, revisit before multi-tenant sharing.
