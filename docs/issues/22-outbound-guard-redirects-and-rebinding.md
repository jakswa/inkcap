# 22 — Outbound SSRF guard: redirect-following (fixed) + residual rebinding/dev gaps

**Severity:** Medium
**Found:** security review round 6, 2026-07-07

`assertSafeOutboundUrl` (`src/utils/outbound-url.ts`) vets a URL's host at
call time. Three ways that check gets bypassed after it passes:

## 22a — MCP fetches followed HTTP redirects — FIXED (this change)

The MCP transport (`src/services/mcp-client.ts`) handed the validated URL to
`StreamableHTTPClientTransport` with no custom `fetch`, so the SDK's fetch
followed redirects by default. A user who can add an MCP server could point it
at a public host that answers `302 Location: http://169.254.169.254/…` (cloud
metadata) or `http://127.0.0.1:PORT/…`, and the server's fetch would follow
into the blocked range — bypassing the guard entirely (confirmed blind SSRF /
internal port probe; full exfil back to the model depends on the redirect
target speaking JSON-RPC/SSE).

The provider and codex clients already passed `redirect: 'manual'`
(`provider-client.ts`, `codex-client.ts`); the MCP path was the one gap.

**Fixed:** `withClient` now supplies a `fetch` wrapper that forces
`redirect: 'manual'`, matching the sibling clients. Regression test:
`tests/mcp-client.test.ts` ("does not follow redirects"), which uses a 307 to
a reachable stub to prove the guard — not merely an unreachable target — is
what stops the connection.

## 22b — Guard is TOCTOU (DNS rebinding) — OPEN

`outbound-url.ts` resolves the hostname and checks the returned addresses, but
the subsequent `fetch` (provider / codex / MCP) re-resolves independently. A
user-controlled domain with a short TTL that answers a public IP during
validation and `127.0.0.1` / `169.254.169.254` at fetch time slips through.
`redirect: 'manual'` does not help — the initial resolution is what's poisoned.
Production-only and requires attacker-controlled DNS, hence lower priority.

**Fix:** resolve once, verify, and connect to the pinned IP (or move to an
allowlist-only egress).

Checked and already safe: decimal/hex/short IPv4 (`http://2130706433/`,
`http://0x7f000001/`, `http://127.1/`) all normalize via `new URL()` and are
caught; bracketed IPv6 literals fail `lookup()`. Only live DNS rebinding
remains.

## 22c — Guard is a no-op outside production — OPEN (by design, needs a warning)

`outbound-url.ts` returns early when `NODE_ENV !== 'production'` (intentional,
so a local llama-server on a private IP works). A self-hosted operator who runs
the image without `NODE_ENV=production` silently gets **zero** SSRF protection
on all provider/MCP/codex fetches.

**Fix:** emit a one-time startup warning when the guard is disabled, and note
it in the deployment docs.

## Related

- `OUTBOUND_TRUSTED_HOSTS` is an instance-global, name-based exemption
  ([18](18-split-origin-session-cookie-downgrade.md)).
