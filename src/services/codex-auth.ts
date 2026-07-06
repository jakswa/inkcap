// ChatGPT-subscription OAuth for the `openai-codex` provider kind.
//
// This is the Codex CLI's own login flow, reproduced server-side: OAuth 2.0
// authorization-code + PKCE against auth.openai.com using the CLI's public
// client id, with the registered loopback redirect http://localhost:1455/
// auth/callback. inkcap binds that port only while a login is pending; the
// loopback handler validates state, exchanges the code, and hands the token
// bundle to a completion callback registered by the initiating route.
//
// Tokens are JWTs stored on the provider row (oauth_credentials jsonb) in the
// ~/.codex/auth.json `tokens` shape. Two operational rules from the spec:
//   1. Refresh tokens ROTATE — the DB row is the single canonical store and
//      every refresh writes the rotated bundle back before returning.
//   2. Refreshes are serialized per provider behind an in-process lock, so
//      concurrent runs can never race two refreshes into a
//      `refresh_token_reused` 401.
//
// The upstream (chatgpt.com/backend-api/codex) is undocumented and may change
// without notice; this is personal-use tooling for the operator's own
// subscription.

import { createHash, randomBytes } from 'node:crypto'
import {
  getProviderById,
  updateProviderOauthCredentials,
  type CodexOauthCredentials,
} from '../db/queries/providers'

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OAUTH_SCOPE = 'openid profile email offline_access'

// The base_url a freshly connected provider gets. Env-overridable so tests
// (and captive QA setups) can point at a stub backend.
export function codexDefaultBaseUrl() {
  return process.env['CODEX_BASE_URL'] ?? 'https://chatgpt.com/backend-api/codex'
}

// How long before the access token's `exp` we refresh proactively. Generous
// enough that a long streaming run started just before expiry still finishes
// under the old token's validity.
const REFRESH_LEEWAY_MS = 5 * 60 * 1000

// A pending browser login is abandoned after this long.
const LOGIN_TTL_MS = 10 * 60 * 1000

// Issuer/port are constants of the registered OAuth client; the env overrides
// exist so tests (and captive QA setups) can point at a stub.
function issuer() {
  return process.env['CODEX_AUTH_ISSUER'] ?? 'https://auth.openai.com'
}

function callbackPort() {
  const raw = process.env['CODEX_OAUTH_PORT']
  const port = Number(raw)
  return raw && Number.isInteger(port) && port > 0 ? port : 1455
}

function redirectUri() {
  return `http://localhost:${callbackPort()}/auth/callback`
}

function base64url(buffer: Buffer) {
  return buffer.toString('base64url')
}

export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// exp claim in ms, or null when the token isn't a decodable JWT.
export function jwtExpiryMs(token: string): number | null {
  const claims = decodeJwtClaims(token)
  const exp = claims?.['exp']
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null
}

// The `chatgpt-account-id` request header comes from the id_token's (or
// access_token's) https://api.openai.com/auth claim block, preferring
// chatgpt_account_id with the OpenCode-style organization/project fallbacks.
export function extractAccountId(tokens: {
  id_token?: string | null
  access_token?: string | null
}): string | null {
  for (const token of [tokens.id_token, tokens.access_token]) {
    if (!token) continue
    const claims = decodeJwtClaims(token)
    const auth = claims?.['https://api.openai.com/auth']
    if (!auth || typeof auth !== 'object') continue
    const block = auth as Record<string, unknown>
    for (const key of ['chatgpt_account_id', 'organization_id', 'project_id']) {
      const value = block[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
  }
  return null
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  error?: string
  error_description?: string
}

async function postTokenEndpoint(body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(`${issuer()}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let data: TokenResponse = {}
  try {
    data = JSON.parse(text) as TokenResponse
  } catch {
    // Non-JSON error body — fall through to the status check below.
  }
  if (!response.ok || !data.access_token) {
    const detail = data.error_description || data.error || `HTTP ${response.status}`
    throw new Error(`ChatGPT token endpoint rejected the request: ${detail}`)
  }
  return data
}

function credentialsFromTokenResponse(
  data: TokenResponse,
  previous?: CodexOauthCredentials | null,
): CodexOauthCredentials {
  const idToken = data.id_token ?? previous?.id_token ?? null
  return {
    id_token: idToken,
    access_token: data.access_token!,
    // Rotation: a refresh response may omit refresh_token; keep the old one.
    refresh_token: data.refresh_token ?? previous?.refresh_token ?? '',
    account_id:
      extractAccountId({ id_token: idToken, access_token: data.access_token }) ??
      previous?.account_id ??
      null,
    last_refresh: new Date().toISOString(),
  }
}

// --- Pending logins + loopback callback server ---

interface PendingLogin {
  state: string
  verifier: string
  createdAt: number
  // Where to send the browser when something goes wrong (the app's /providers).
  returnTo: string
  // Registered by the initiating route: persists the bundle (create provider
  // or update credentials) and returns the URL to redirect the browser to.
  complete: (credentials: CodexOauthCredentials) => Promise<string>
}

const pendingLogins = new Map<string, PendingLogin>()
let loopbackServer: ReturnType<typeof Bun.serve> | null = null

function sweepExpiredLogins() {
  const now = Date.now()
  for (const [state, pending] of pendingLogins) {
    if (now - pending.createdAt > LOGIN_TTL_MS) pendingLogins.delete(state)
  }
}

// Graceful stop: this runs from the callback handler's own request, so a
// forced close would reset the socket before the redirect reaches the
// browser. In-flight requests finish; no new connections are accepted.
function stopLoopbackIfIdle(options: { force?: boolean } = {}) {
  if (pendingLogins.size === 0 && loopbackServer) {
    loopbackServer.stop(options.force ?? false)
    loopbackServer = null
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function callbackErrorPage(message: string, returnTo: string | null) {
  const back = returnTo
    ? `<p><a href="${escapeHtml(returnTo)}">Back to inkcap</a></p>`
    : ''
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ChatGPT sign-in failed</title></head><body><h1>ChatGPT sign-in failed</h1><p>${escapeHtml(message)}</p>${back}</body></html>`,
    { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )
}

async function handleLoopbackCallback(url: URL): Promise<Response> {
  const state = url.searchParams.get('state') ?? ''
  const pending = pendingLogins.get(state)
  if (!pending || Date.now() - pending.createdAt > LOGIN_TTL_MS) {
    return callbackErrorPage('This sign-in link expired or was already used. Start again from the Providers page.', pending?.returnTo ?? null)
  }
  pendingLogins.delete(state)

  const oauthError = url.searchParams.get('error')
  if (oauthError) {
    const description = url.searchParams.get('error_description')
    return callbackErrorPage(description || oauthError, pending.returnTo)
  }
  const code = url.searchParams.get('code')
  if (!code) {
    return callbackErrorPage('The callback did not include an authorization code.', pending.returnTo)
  }

  try {
    const tokens = await postTokenEndpoint(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(),
        client_id: CODEX_CLIENT_ID,
        code_verifier: pending.verifier,
      }),
    )
    const redirectTo = await pending.complete(credentialsFromTokenResponse(tokens))
    return new Response(null, { status: 302, headers: { Location: redirectTo } })
  } catch (error) {
    return callbackErrorPage(
      error instanceof Error ? error.message : String(error),
      pending.returnTo,
    )
  } finally {
    sweepExpiredLogins()
    stopLoopbackIfIdle()
  }
}

function ensureLoopbackServer() {
  if (loopbackServer) return
  loopbackServer = Bun.serve({
    port: callbackPort(),
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === 'GET' && url.pathname === '/auth/callback') {
        return handleLoopbackCallback(url)
      }
      return new Response('not found', { status: 404 })
    },
  })
}

// Begin a browser login. Binds the loopback callback port (fails loudly when
// something else holds it), registers the pending login, and returns the
// auth.openai.com authorize URL to redirect the user's browser to.
export function startCodexLogin(options: {
  returnTo: string
  complete: (credentials: CodexOauthCredentials) => Promise<string>
}): { authorizeUrl: string } {
  sweepExpiredLogins()
  try {
    ensureLoopbackServer()
  } catch (error) {
    throw new Error(
      `Could not bind the OAuth callback port ${callbackPort()} (is the Codex CLI or another login mid-flight?): ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const state = base64url(randomBytes(24))

  pendingLogins.set(state, {
    state,
    verifier,
    createdAt: Date.now(),
    returnTo: options.returnTo,
    complete: options.complete,
  })

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_CLIENT_ID,
    redirect_uri: redirectUri(),
    scope: OAUTH_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    // OpenAI-specific: yields the Codex-style consent and an id_token that
    // embeds the chatgpt_account_id claim block.
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs',
  })
  return { authorizeUrl: `${issuer()}/oauth/authorize?${params.toString()}` }
}

// --- Access-token retrieval with proactive refresh ---

export interface CodexAccess {
  accessToken: string
  accountId: string | null
}

// Per-provider refresh serialization (see module header, rule 2).
const refreshLocks = new Map<string, Promise<CodexOauthCredentials>>()

async function refreshCredentials(
  providerId: string,
  staleAccessToken: string,
): Promise<CodexOauthCredentials> {
  const existing = refreshLocks.get(providerId)
  if (existing) return existing

  const task = (async () => {
    // Re-read inside the lock: a concurrent caller may have refreshed and
    // rotated the token while we were queued. Only skip the refresh when the
    // stored token is no longer the one the caller deemed stale/rejected.
    const provider = await getProviderById(providerId)
    const credentials = provider?.oauth_credentials as CodexOauthCredentials | null | undefined
    if (!credentials?.refresh_token) {
      throw new Error('This ChatGPT provider has no stored login. Re-authenticate it from the Providers page.')
    }
    if (credentials.access_token !== staleAccessToken) {
      const expiry = jwtExpiryMs(credentials.access_token)
      if (expiry !== null && expiry - Date.now() > REFRESH_LEEWAY_MS) {
        return credentials
      }
    }

    let tokens: TokenResponse
    try {
      tokens = await postTokenEndpoint(
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: credentials.refresh_token,
          client_id: CODEX_CLIENT_ID,
        }),
      )
    } catch (error) {
      throw new Error(
        `ChatGPT token refresh failed — re-authenticate this provider from the Providers page. (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }
    const rotated = credentialsFromTokenResponse(tokens, credentials)
    await updateProviderOauthCredentials({ id: providerId, oauthCredentials: rotated })
    return rotated
  })()

  refreshLocks.set(providerId, task)
  try {
    return await task
  } finally {
    refreshLocks.delete(providerId)
  }
}

// Fresh access token + account id for a codex provider row, refreshing (and
// persisting the rotation) when the stored token is expired or nearly so.
// `forceRefresh` implements the reactive refresh-and-retry after an upstream
// 401 even when the token looked valid locally.
export async function getCodexAccess(
  providerId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<CodexAccess> {
  const provider = await getProviderById(providerId)
  const credentials = provider?.oauth_credentials as CodexOauthCredentials | null | undefined
  if (!credentials?.access_token) {
    throw new Error('This ChatGPT provider has no stored login. Re-authenticate it from the Providers page.')
  }

  const expiry = jwtExpiryMs(credentials.access_token)
  const stale = expiry === null || expiry - Date.now() <= REFRESH_LEEWAY_MS
  if (!options.forceRefresh && !stale) {
    return { accessToken: credentials.access_token, accountId: credentials.account_id }
  }

  const refreshed = await refreshCredentials(providerId, credentials.access_token)
  return { accessToken: refreshed.access_token, accountId: refreshed.account_id }
}

// Test hook: tear down the loopback listener between test files.
export function resetCodexLoginStateForTests() {
  pendingLogins.clear()
  stopLoopbackIfIdle({ force: true })
}
