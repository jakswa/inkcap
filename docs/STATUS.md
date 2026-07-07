# inkcap — status (2026-07-07)

Server-driven chat rewrite of llama-ui. All planned milestones (M0–M8) plus
the post-plan slices below are on master — the commit map and M3 reveal-test
evidence live in `docs/completed/THE_PLAN.md`. Verification:
`bun run db:types` stable (59 typed queries), `bun run typecheck` clean,
`bun test` 146/146, `bun run build` produces the production bundle.

Day-to-day setup and commands: README.md. Future work: `docs/roadmap/`.
Security/correctness hardening: `docs/issues/` (last swept 2026-07-07 — a sixth
security pass + an ops-readiness audit; see issues 19–22 and 17h–17j).

## Post-M7: openai-codex provider (ChatGPT subscription OAuth)

Provider kind speaking the Codex CLI's protocol: PKCE OAuth against
auth.openai.com with a loopback callback bound on `localhost:1455` only
during sign-in, tokens in `providers.oauth_credentials` (migration 011) with
mutex-serialized rotation-safe refresh, and a Responses-API translation layer
(`src/services/codex-auth.ts` + `codex-client.ts`, dispatched by kind from
`provider-client.ts`). Spec + caveats: `docs/specs/openai-codex.md`; tested
by `tests/integration/codex.test.ts` (stub issuer/backend, no real OpenAI
traffic). Known gaps tracked in `docs/roadmap/README.md`.

## Post-M8: accounts, ownership scoping, registration gate

Providers and MCP servers stopped being a global catalog: `accounts` +
`account_memberships` (migration 012; personal account id = user id, created
atomically with registration), `account_id NOT NULL` on both tables, every
route fetching through a membership join so a foreign id 404s, and the
runner scoping MCP servers via the conversation owner. Registration is gated
by `REGISTRATION` (default closed in production; `create-user` task
bootstraps). Details + legacy-data handling:
`docs/issues/resolved/02-global-unowned-catalog.md`. Sharing later is
additive — insert a membership row; the scoped queries already grant access.

## Post-accounts: split-origin home deployments

Serving one instance over both an HTTPS proxy origin and a plain-HTTP LAN IP:
`PUBLIC_ORIGIN` (OAuth/CSRF canonical origin), `CSRF_TRUSTED_ORIGINS` (extra
form-submit origins), `OUTBOUND_TRUSTED_HOSTS` (SSRF-guard exemptions), and a
per-request session cookie name (`__Host-session` on secure requests, `session`
on opted-in insecure ones). Residual warts are catalogued in
`docs/issues/18-split-origin-session-cookie-downgrade.md`; the forwarding-header
trust it introduces also underlies issue 21.

## Docs-audit slice (2026-07-07)

Catalog-only pass plus two on-the-spot fixes: the `ci.yml` push trigger
(`main` → `master`, so direct pushes are actually tested) and the MCP SSRF
redirect-following hole (issue 22a). New/updated issues: 19–22, 17h–17j, and a
corrected issue 14. New roadmap entries: conversation export, attachment
upload/serve over HTTP, and prompts-&-defaults.
