# 21 — Login throttle bypass via spoofable forwarding headers

**Severity:** Medium
**Found:** security review round 6, 2026-07-07
**Reachable by:** any unauthenticated client that can reach the server directly

## Problem

The login rate limiter keys on `login:${clientKey}:${email}`
(`src/routes/auth.ts:161`), and `clientKey` derives the client IP purely from
request headers with no trusted-proxy allowlist (`src/routes/auth.ts:210-217`):

```js
function clientKey(c: Context) {
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-real-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  )
}
```

In any deployment reachable directly (a LAN IP — explicitly supported via
`CSRF_TRUSTED_ORIGINS`, or a proxy that doesn't strip these headers) an
attacker sets a fresh `X-Forwarded-For` per request and gets a brand-new
bucket every time, defeating the 10-attempts / 15-min cap entirely. The
in-memory `authAttempts` map (`auth.ts:30`) also grows one entry per distinct
spoofed value — a secondary unbounded-memory angle.

The README lists login brute-force throttling as verified clean; that holds
only behind a proxy that normalizes these headers. Direct-reachable
deployments — which the split-origin work explicitly enables — do not get it.

## Fix

- Derive the client IP from a configured trusted-proxy hop count (or the raw
  socket peer address when no proxy is declared), rather than trusting the
  first spoofable header.
- Bound the `authAttempts` map (size cap / periodic sweep) independent of the
  keying fix.

## Related

- `requestIsSecure` trusts `x-forwarded-proto` from any client with no
  trusted-proxy list ([18](18-split-origin-session-cookie-downgrade.md)) —
  same root cause (unauthenticated forwarding headers taken at face value).
