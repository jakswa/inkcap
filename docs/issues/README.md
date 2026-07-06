# Security & correctness issues

Findings from five adversarial reviews (injection, auth/sessions, runner/concurrency,
MCP/approval, general security) run against the repo on 2026-07-06. Multiple independent
reviewers converged on the top items.

## Main Remaining Root Causes

1. **Providers and MCP servers are a global, unowned catalog** — no `user_id`, no admin
   role, routes gate only on "is authenticated." With open registration this is a
   multi-tenant app where any user can read/edit/delete every other user's catalog rows.
2. **The durable runner still has recovery/transactional gaps** even though the
   non-terminal-run uniqueness invariant is now enforced in Postgres.

## Priority order

Fix in this sequence:

1. [02 — Ownership-scope the provider/MCP catalog](02-global-unowned-catalog.md) (High) — collapses 03, 04, 05
2. [06 — Add runner leases/heartbeat recovery](06-runner-active-run-invariant-in-process.md) (High)
3. [07 — Transactional runner state transitions](07-runner-nontransactional-writes.md) (High)

## Index

### High
- [02 — Global unowned provider/MCP catalog (broken access control)](02-global-unowned-catalog.md)
- [03 — Provider/MCP credential exfiltration via base_url swap](03-credential-exfiltration.md)
- [04 — Approval bypass via global auto_approve](04-approval-bypass-auto-approve.md)
- [05 — Tool approval not bound to execution endpoint (TOCTOU)](05-approval-toctou.md)
- [06 — Runner recovery lacks ownership leases/heartbeats](06-runner-active-run-invariant-in-process.md)
- [07 — Non-transactional multi-row writes leave zombie streaming messages](07-runner-nontransactional-writes.md)

### Medium
- [09 — Non-revocable stateless sessions carry stale identity](09-nonrevocable-sessions.md)
- [13 — Non-idempotent tool execution (at-least-once, no journaling)](13-tool-execution-idempotency.md)
- [14 — Driverless running rows on finishRun failure](14-driverless-running-rows.md)
- [15 — curr_node lost-update races between routes and startRun](15-curr-node-race.md)

### Low
- [17 — Low-priority hardening bundle](17-low-priority-hardening.md)

## Verified clean (no action needed)

SQL injection, XSS (sanitize-html + CSP), CSRF, command injection, open-redirect,
SSE/header injection, session cryptography (AES-256-GCM AEAD), session-secret
production validation, login brute-force throttling, conversation/message/chat/branch
IDOR, migration runner (advisory lock in transaction), run-event seq gaplessness,
path traversal, asset path traversal, provider/MCP production SSRF guards, auth timing
(constant-time dummy hash), waiting-approval stranding, delta-flush token loss, and
the former 50 MB global body limit.
