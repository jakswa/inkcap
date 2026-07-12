# Security & correctness issues

Findings from five adversarial reviews (injection, auth/sessions, runner/concurrency,
MCP/approval, general security) run against the repo on 2026-07-06, plus a sixth
security pass and an ops-readiness audit on 2026-07-07. Rechecked against the code on
2026-07-12. Resolved issues move to `resolved/`; partially resolved files describe only
the remaining risk. Two root causes dominate: **the durable runner still has
recovery/transactional gaps** (even though the non-terminal-run uniqueness invariant
is now enforced in Postgres), and **the process has no graceful lifecycle** — no
drain on shutdown, no health signal, no operator-visible run errors.

## Priority order

Fix in this sequence:

1. [19 — Graceful shutdown: drain + flush on SIGTERM](19-graceful-shutdown-drain.md) (High — loses tokens every deploy)
2. [06 — Add runner leases/heartbeat recovery](06-runner-active-run-invariant-in-process.md) (High)
3. [07 — Transactional runner state transitions](07-runner-nontransactional-writes.md) (High)
4. [20 — Operability: health endpoint, HEALTHCHECK, run-error logging](20-operability-gaps.md) (Medium)

## Index

### Resolved
- [02 — Global unowned provider/MCP catalog (broken access control)](resolved/02-global-unowned-catalog.md) — accounts + ownership scoping + registration gate (2026-07-06); the cross-tenant halves of 03/04/05 died with it
- [22a — MCP SSRF via redirect-following](22-outbound-guard-redirects-and-rebinding.md) — MCP fetches now refuse redirects (`redirect: 'manual'`), matching the provider/codex clients (2026-07-07); rebinding + dev-noop residuals still tracked in 22

### High
- [05 — Tool approval not bound to execution endpoint (TOCTOU)](05-approval-toctou.md) — account-local TOCTOU + name-collision routing still open
- [06 — Runner recovery lacks ownership leases/heartbeats](06-runner-active-run-invariant-in-process.md)
- [07 — Non-transactional multi-row writes leave zombie streaming messages](07-runner-nontransactional-writes.md)
- [19 — No graceful shutdown: SIGTERM drops in-flight tokens](19-graceful-shutdown-drain.md)

### Medium
- [03 — Stored credential survives a base_url change](03-credential-exfiltration.md) — cross-tenant attack closed by 02; destination-change invalidation remains
- [09 — Non-revocable stateless sessions carry stale identity](09-nonrevocable-sessions.md)
- [13 — Non-idempotent tool execution (at-least-once, no journaling)](13-tool-execution-idempotency.md)
- [14 — Driverless running rows on finishRun failure](14-driverless-running-rows.md)
- [15 — curr_node lost-update races between routes and startRun](15-curr-node-race.md)
- [20 — Operability gaps: no health endpoint, no HEALTHCHECK, silent run errors](20-operability-gaps.md)
- [21 — Login throttle bypass via spoofable forwarding headers](21-throttle-bypass-forwarded-headers.md)
- [22 — Outbound guard: DNS-rebinding TOCTOU + dev no-op (redirect half fixed)](22-outbound-guard-redirects-and-rebinding.md)

### Low
- [04 — Unattended MCP trust and prompt-injection hardening](04-approval-bypass-auto-approve.md) — cross-tenant bypass closed by 02
- [17 — Low-priority hardening bundle](17-low-priority-hardening.md)
- [18 — Split-origin support accepts the insecure session cookie everywhere](18-split-origin-session-cookie-downgrade.md)

## Verified clean (no action needed)

SQL injection, XSS (sanitize-html + CSP), CSRF, command injection, open-redirect,
SSE/header injection (SSE ownership enforced; `Last-Event-ID` integer-clamped),
session cryptography (AES-256-GCM AEAD), session-secret production validation,
conversation/message/chat/branch IDOR, migration runner (advisory lock in
transaction), run-event seq gaplessness, path traversal, asset path traversal,
markdown `data:`/`javascript:` scheme stripping (remote `<img>` blocked at runtime
by `default-src 'self'`), Codex OAuth state/PKCE (no cross-account binding), auth
timing (constant-time dummy hash), waiting-approval stranding, delta-flush token
loss (in-stream ordering — *not* shutdown drain, see [19](19-graceful-shutdown-drain.md)),
and the former 50 MB global body limit.

Caveated (clean only under a stated assumption): **login brute-force throttling**
holds only behind a proxy that normalizes forwarding headers — direct-reachable
deployments are bypassable ([21](21-throttle-bypass-forwarded-headers.md));
**provider/MCP production SSRF guards** block the initial host but the redirect
gap is only just closed ([22a](22-outbound-guard-redirects-and-rebinding.md)) and
DNS-rebinding remains ([22b](22-outbound-guard-redirects-and-rebinding.md)).
