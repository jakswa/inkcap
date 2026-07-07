# Security & correctness issues

Findings from five adversarial reviews (injection, auth/sessions, runner/concurrency,
MCP/approval, general security) run against the repo on 2026-07-06. Resolved issues
move to `resolved/`. Remaining root cause: **the durable runner still has
recovery/transactional gaps**, even though the non-terminal-run uniqueness invariant
is now enforced in Postgres.

## Priority order

Fix in this sequence:

1. [06 — Add runner leases/heartbeat recovery](06-runner-active-run-invariant-in-process.md) (High)
2. [07 — Transactional runner state transitions](07-runner-nontransactional-writes.md) (High)

## Index

### Resolved
- [02 — Global unowned provider/MCP catalog (broken access control)](resolved/02-global-unowned-catalog.md) — accounts + ownership scoping + registration gate (2026-07-06); the cross-tenant halves of 03/04/05 died with it

### High
- [03 — Provider/MCP credential exfiltration via base_url swap](03-credential-exfiltration.md) — cross-tenant vector closed by 02; base_url-change credential invalidation still open
- [04 — Approval bypass via global auto_approve](04-approval-bypass-auto-approve.md) — cross-tenant vector closed by 02; prompt-injection surface remains
- [05 — Tool approval not bound to execution endpoint (TOCTOU)](05-approval-toctou.md) — single-tenant TOCTOU + name-collision routing still open
- [06 — Runner recovery lacks ownership leases/heartbeats](06-runner-active-run-invariant-in-process.md)
- [07 — Non-transactional multi-row writes leave zombie streaming messages](07-runner-nontransactional-writes.md)

### Medium
- [09 — Non-revocable stateless sessions carry stale identity](09-nonrevocable-sessions.md)
- [13 — Non-idempotent tool execution (at-least-once, no journaling)](13-tool-execution-idempotency.md)
- [14 — Driverless running rows on finishRun failure](14-driverless-running-rows.md)
- [15 — curr_node lost-update races between routes and startRun](15-curr-node-race.md)

### Low
- [17 — Low-priority hardening bundle](17-low-priority-hardening.md)
- [18 — Split-origin support accepts the insecure session cookie everywhere](18-split-origin-session-cookie-downgrade.md)

## Verified clean (no action needed)

SQL injection, XSS (sanitize-html + CSP), CSRF, command injection, open-redirect,
SSE/header injection, session cryptography (AES-256-GCM AEAD), session-secret
production validation, login brute-force throttling, conversation/message/chat/branch
IDOR, migration runner (advisory lock in transaction), run-event seq gaplessness,
path traversal, asset path traversal, provider/MCP production SSRF guards, auth timing
(constant-time dummy hash), waiting-approval stranding, delta-flush token loss, and
the former 50 MB global body limit.
