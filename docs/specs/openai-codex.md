# OpenAI Codex (ChatGPT subscription OAuth) provider

The `openai-codex` provider kind drives a chat off the operator's own ChatGPT
subscription by reproducing the Codex CLI's reverse-engineered auth + wire
protocol. Everything here is **undocumented upstream and may change without
notice** — the constants below match the Codex CLI and the community reference
implementations (llm-openai-via-codex, Zed, OpenCode, Hermes) as of mid-2026.
Personal, single-user tooling only; no account pooling.

Implementation: `src/services/codex-auth.ts` (OAuth + refresh),
`src/services/codex-client.ts` (Responses translation), dispatched from
`provider-client.ts` on `kind === 'openai-codex'`.

## OAuth (authorization code + PKCE)

- Issuer: `https://auth.openai.com` (`CODEX_AUTH_ISSUER` overrides for tests)
- Client id: `app_EMoamEEZ73f0CkXaXp7hrann` (the Codex CLI's public client)
- Redirect: `http://localhost:1455/auth/callback` — fixed by the client
  registration. inkcap tries to bind 127.0.0.1:1455 only while a login is
  pending (`CODEX_OAUTH_PORT` overrides for tests). If the browser is on a
  different machine from the server, the redirect lands on the browser's own
  localhost; copy that failed callback URL and paste it into inkcap's
  `/providers/codex/callback` form. The server can still exchange the code
  because it owns the pending PKCE verifier and uses the registered localhost
  redirect URI at the token endpoint.
- Scope: `openid profile email offline_access`
- Extra authorize params: `id_token_add_organizations=true`,
  `codex_cli_simplified_flow=true`, `originator=codex_cli_rs`
- Token endpoint: `POST /oauth/token` (form-encoded). Code exchange returns
  `access_token` + `refresh_token` + `id_token`, all JWTs. Expiry comes from
  the access token's `exp` claim (no expires_in on disk).
- `chatgpt-account-id` header value: id_token claim
  `"https://api.openai.com/auth".chatgpt_account_id` (fallbacks:
  organization_id, project_id).
- **Refresh tokens rotate.** `grant_type=refresh_token` returns a new one;
  reusing an old one is a terminal 401 (`refresh_token_reused`). The provider
  row (`providers.oauth_credentials` jsonb, auth.json `tokens` shape) is the
  single canonical store; refreshes are per-provider mutex-serialized and
  written back atomically. Proactive refresh inside a 5-minute leeway of
  `exp`; one reactive refresh-and-retry on an upstream 401.

## Wire protocol

- Endpoint: `POST https://chatgpt.com/backend-api/codex/responses`
  (**Responses API**, not chat completions; not api.openai.com). Base URL
  stored per provider; `CODEX_BASE_URL` sets the default for new connects.
- Identity headers (all load-bearing): `Authorization: Bearer <jwt>`,
  `chatgpt-account-id`, `originator: codex_cli_rs` (server-side whitelist,
  wrong value → 403), `User-Agent: codex_cli_rs/…`. Plus
  `Accept: text/event-stream` and a `session_id` UUID header. We deliberately
  do not send `OpenAI-Beta` — its HTTP-path value is unverified.
- Body quirks: `store: false` (stateless — full history replays as `input[]`
  each turn), **non-empty `instructions`** (else 400 "Instructions are
  required"; we always prefix a Codex-style preamble and append the user's
  system prompt), `include: ["reasoning.encrypted_content"]`. Reasoning knob:
  `reasoning: { effort, summary: "auto" }` (inkcap's `max` maps to `high`).
- Tools: Responses flat shape (`{type:'function', name, description,
  parameters}`); history items `function_call` / `function_call_output`.
- SSE events consumed: `response.output_text.delta` (content),
  `response.reasoning_summary_text.delta` / `response.reasoning_text.delta`
  (thinking), `response.output_item.added|done` +
  `response.function_call_arguments.delta` (tool calls),
  `response.created` (model), `response.completed` (finish),
  `response.failed` / `error` (throw).
- Metrics: not normalized into message `timings` yet. The backend may include
  usage token counts on terminal response objects, but it does not currently
  provide llama-server-style prompt/generation durations; avoid inventing
  custom wall-clock tok/s until there is a stable upstream timing signal.
- Known stream pitfalls handled: status events echo the full instructions and
  can arrive as truncated JSON (parse tolerantly, skip), and the terminal
  `response.output` array can be empty — the message is always reconstructed
  from deltas.
- Models: `GET /models?client_version=1.0.0`, keep
  `supported_in_api && visibility == "list"`; static fallback
  `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`. Re-run discovery from the provider
  edit page ("Test and save") when the backend rejects a model.
- Usage limits are rolling 5-hour/weekly windows per plan; a 429 surfaces as
  a run error telling the user to wait for the window to reset.
