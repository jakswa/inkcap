// ChatGPT-subscription OAuth for the `openai-codex` provider kind.
//
// This reproduces the Codex CLI's ChatGPT sign-in paths server-side. The
// default is the device-code flow: inkcap shows a one-time code, the user enters
// it at auth.openai.com/codex/device, then inkcap polls for an authorization
// code and exchanges it for tokens. The legacy authorization-code + PKCE
// loopback flow remains as a fallback; it uses the CLI client's fixed
// http://localhost:1455/auth/callback redirect and binds that port only while a
// login is pending.
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

const DEVICE_USER_CODE_PATH = '/api/accounts/deviceauth/usercode'
const DEVICE_TOKEN_PATH = '/api/accounts/deviceauth/token'
const DEVICE_VERIFICATION_PATH = '/codex/device'
const DEVICE_REDIRECT_PATH = '/deviceauth/callback'
const DEVICE_LOGIN_TTL_MS = 15 * 60 * 1000
const DEVICE_SLOW_DOWN_INCREMENT_MS = 5 * 1000

// Issuer/port are constants of the registered OAuth client; the env overrides
// exist so tests (and captive QA setups) can point at a stub.
function issuer() {
  return process.env['CODEX_AUTH_ISSUER'] ?? 'https://auth.openai.com'
}

function issuerFromCredentials(credentials: CodexOauthCredentials) {
  return credentials.auth_issuer ?? issuer()
}

function callbackPort() {
  const raw = process.env['CODEX_OAUTH_PORT']
  const port = Number(raw)
  return raw && Number.isInteger(port) && port > 0 ? port : 1455
}

const CALLBACK_PATH = '/auth/callback'

function redirectUri() {
  return `http://localhost:${callbackPort()}${CALLBACK_PATH}`
}

class CodexCallbackError extends Error {
  constructor(
    message: string,
    readonly returnTo: string | null,
  ) {
    super(message)
  }
}

// Validates a hand-pasted callback URL against the same port/path the
// registered redirect_uri uses — accepting other ports would quietly diverge
// from what the token endpoint will be told.
function parseCallbackUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('Paste the full localhost callback URL from your browser address bar.')
  }

  const localhost = new Set(['localhost', '127.0.0.1', '[::1]'])
  const port = Number(url.port || 80)
  if (
    url.protocol !== 'http:' ||
    !localhost.has(url.hostname) ||
    port !== callbackPort() ||
    url.pathname !== CALLBACK_PATH
  ) {
    throw new Error('That does not look like the Codex localhost callback URL.')
  }
  return url
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

async function postTokenEndpoint(body: URLSearchParams, authIssuer = issuer()): Promise<TokenResponse> {
  const response = await fetch(`${authIssuer}/oauth/token`, {
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
  authIssuer = previous?.auth_issuer ?? issuer(),
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
    auth_issuer: authIssuer,
  }
}

// --- Pending logins + loopback callback server ---

interface PendingLogin {
  state: string
  verifier: string
  authIssuer: string
  createdAt: number
  // Where to send the browser when something goes wrong (the app's /providers).
  returnTo: string
  // Registered by the initiating route: persists the bundle (create provider
  // or update credentials) and returns the URL to redirect the browser to.
  complete: (credentials: CodexOauthCredentials) => Promise<string>
}

const pendingLogins = new Map<string, PendingLogin>()
let loopbackServer: ReturnType<typeof Bun.serve> | null = null

interface PendingDeviceLogin {
  id: string
  ownerUserId: string
  authIssuer: string
  deviceAuthId: string
  userCode: string
  verificationUri: string
  intervalMs: number
  nextPollAt: number
  createdAt: number
  expiresAt: number
  returnTo: string
  complete: (credentials: CodexOauthCredentials) => Promise<string>
  // Set while an upstream poll (and possibly the token exchange + complete())
  // is running, so a double-submit joins the same attempt instead of racing a
  // second exchange into duplicate providers or a code-reuse failure.
  inFlight?: Promise<CodexDevicePollResult>
}

export interface CodexDeviceLoginView {
  id: string
  userCode: string
  verificationUri: string
  intervalSeconds: number
  expiresAt: string
  returnTo: string
}

export type CodexDevicePollResult =
  | { status: 'pending'; login: CodexDeviceLoginView; message?: string }
  | { status: 'complete'; redirectTo: string }
  | { status: 'expired'; returnTo: string }
  | { status: 'failed'; returnTo: string; message: string }

const pendingDeviceLogins = new Map<string, PendingDeviceLogin>()

function deviceLoginView(login: PendingDeviceLogin): CodexDeviceLoginView {
  return {
    id: login.id,
    userCode: login.userCode,
    verificationUri: login.verificationUri,
    intervalSeconds: Math.max(1, Math.ceil(login.intervalMs / 1000)),
    expiresAt: new Date(login.expiresAt).toISOString(),
    returnTo: login.returnTo,
  }
}

function sweepExpiredLogins() {
  const now = Date.now()
  for (const [state, pending] of pendingLogins) {
    if (now - pending.createdAt > LOGIN_TTL_MS) pendingLogins.delete(state)
  }
  for (const [id, pending] of pendingDeviceLogins) {
    if (now > pending.expiresAt) pendingDeviceLogins.delete(id)
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

// Shared completion for both callback deliveries (loopback GET, pasted URL).
// Every failure surfaces as a CodexCallbackError carrying the returnTo of the
// pending login when one was found.
async function completeCodexLoginCallback(url: URL): Promise<string> {
  try {
    const state = url.searchParams.get('state') ?? ''
    const pending = pendingLogins.get(state)
    if (!pending || Date.now() - pending.createdAt > LOGIN_TTL_MS) {
      throw new CodexCallbackError('This sign-in link expired or was already used. Start again from the Providers page.', pending?.returnTo ?? null)
    }
    pendingLogins.delete(state)

    const oauthError = url.searchParams.get('error')
    if (oauthError) {
      const description = url.searchParams.get('error_description')
      throw new CodexCallbackError(description || oauthError, pending.returnTo)
    }
    const code = url.searchParams.get('code')
    if (!code) {
      throw new CodexCallbackError('The callback did not include an authorization code.', pending.returnTo)
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
        pending.authIssuer,
      )
      return await pending.complete(credentialsFromTokenResponse(tokens, undefined, pending.authIssuer))
    } catch (error) {
      throw new CodexCallbackError(error instanceof Error ? error.message : String(error), pending.returnTo)
    }
  } finally {
    sweepExpiredLogins()
    stopLoopbackIfIdle()
  }
}

export async function completeCodexLoginFromCallbackUrl(callbackUrl: string): Promise<string> {
  return completeCodexLoginCallback(parseCallbackUrl(callbackUrl))
}

async function handleLoopbackCallback(url: URL): Promise<Response> {
  try {
    const redirectTo = await completeCodexLoginCallback(url)
    return new Response(null, { status: 302, headers: { Location: redirectTo } })
  } catch (error) {
    const returnTo = error instanceof CodexCallbackError ? error.returnTo : null
    return callbackErrorPage(error instanceof Error ? error.message : String(error), returnTo)
  }
}

function ensureLoopbackServer() {
  if (loopbackServer) return
  loopbackServer = Bun.serve({
    port: callbackPort(),
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === 'GET' && url.pathname === CALLBACK_PATH) {
        return handleLoopbackCallback(url)
      }
      return new Response('not found', { status: 404 })
    },
  })
}

// Begin a browser login. Tries to bind the loopback callback port for local
// browsers, registers the pending login either way, and returns the
// auth.openai.com authorize URL to redirect the user's browser to. Deployed
// servers can finish by accepting a pasted localhost callback URL.
export function startCodexLoopbackLogin(options: {
  returnTo: string
  authIssuer?: string
  complete: (credentials: CodexOauthCredentials) => Promise<string>
}): { authorizeUrl: string } {
  sweepExpiredLogins()
  try {
    ensureLoopbackServer()
  } catch (error) {
    console.warn(
      `Could not bind the OAuth callback port ${callbackPort()}; continuing with manual callback paste fallback: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const state = base64url(randomBytes(24))
  const authIssuer = options.authIssuer ?? issuer()

  pendingLogins.set(state, {
    state,
    verifier,
    authIssuer,
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
  return { authorizeUrl: `${authIssuer}/oauth/authorize?${params.toString()}` }
}

interface DeviceUserCodeResponse {
  device_auth_id?: string
  user_code?: string
  interval?: number | string
}

interface DeviceTokenResponse {
  authorization_code?: string
  code_verifier?: string
  error?: unknown
}

function deviceVerificationUri(authIssuer: string) {
  return `${authIssuer}${DEVICE_VERIFICATION_PATH}`
}

function deviceRedirectUri(authIssuer: string) {
  return `${authIssuer}${DEVICE_REDIRECT_PATH}`
}

async function postDeviceUserCode(authIssuer: string): Promise<{ deviceAuthId: string; userCode: string; intervalMs: number }> {
  const response = await fetch(`${authIssuer}${DEVICE_USER_CODE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  if (!response.ok) {
    const hint = response.status === 404
      ? 'Device-code login may be disabled for this ChatGPT account/workspace. Enable "Allow device code login" or use the legacy localhost fallback.'
      : text || `HTTP ${response.status}`
    throw new Error(`ChatGPT device-code request failed: ${hint}`)
  }

  let data: DeviceUserCodeResponse
  try {
    data = JSON.parse(text) as DeviceUserCodeResponse
  } catch {
    throw new Error('ChatGPT device-code request returned invalid JSON')
  }
  const interval = typeof data.interval === 'string' ? Number(data.interval.trim()) : data.interval
  if (!data.device_auth_id || !data.user_code || typeof interval !== 'number' || !Number.isFinite(interval) || interval < 0) {
    throw new Error(`ChatGPT device-code request returned invalid fields: ${text}`)
  }
  return {
    deviceAuthId: data.device_auth_id,
    userCode: data.user_code,
    intervalMs: Math.max(1000, Math.floor(interval * 1000)),
  }
}

export async function startCodexDeviceLogin(options: {
  ownerUserId: string
  returnTo: string
  authIssuer?: string
  complete: (credentials: CodexOauthCredentials) => Promise<string>
}): Promise<CodexDeviceLoginView> {
  sweepExpiredLogins()
  const authIssuer = options.authIssuer ?? issuer()
  const device = await postDeviceUserCode(authIssuer)
  const id = base64url(randomBytes(24))
  const now = Date.now()
  const login: PendingDeviceLogin = {
    id,
    ownerUserId: options.ownerUserId,
    authIssuer,
    deviceAuthId: device.deviceAuthId,
    userCode: device.userCode,
    verificationUri: deviceVerificationUri(authIssuer),
    intervalMs: device.intervalMs,
    nextPollAt: now,
    createdAt: now,
    expiresAt: now + DEVICE_LOGIN_TTL_MS,
    returnTo: options.returnTo,
    complete: options.complete,
  }
  pendingDeviceLogins.set(id, login)
  return deviceLoginView(login)
}

function deviceErrorCode(data: DeviceTokenResponse): string | null {
  const error = data.error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const code = (error as Record<string, unknown>)['code']
    if (typeof code === 'string') return code
  }
  return null
}

// Passive lookup for rendering the device page (GET): no upstream call, no
// nextPollAt bump — safe against refreshes, prefetches, and restored tabs.
export function getCodexDeviceLogin(
  id: string,
  ownerUserId: string,
): { status: 'pending'; login: CodexDeviceLoginView } | { status: 'expired' } | { status: 'missing' } {
  const login = pendingDeviceLogins.get(id)
  sweepExpiredLogins()
  if (!login || login.ownerUserId !== ownerUserId) return { status: 'missing' }
  if (Date.now() > login.expiresAt) {
    pendingDeviceLogins.delete(id)
    return { status: 'expired' }
  }
  return { status: 'pending', login: deviceLoginView(login) }
}

export async function pollCodexDeviceLogin(id: string, ownerUserId: string): Promise<CodexDevicePollResult> {
  // Grab the entry before sweeping so a just-expired login reports 'expired'
  // instead of vanishing into the generic 'already used' failure.
  const login = pendingDeviceLogins.get(id)
  sweepExpiredLogins()
  if (!login || login.ownerUserId !== ownerUserId) {
    return { status: 'failed', returnTo: '/providers', message: 'This ChatGPT sign-in expired or was already used. Start again from Providers.' }
  }
  if (Date.now() > login.expiresAt) {
    pendingDeviceLogins.delete(id)
    return { status: 'expired', returnTo: login.returnTo }
  }
  if (login.inFlight) return login.inFlight
  if (Date.now() < login.nextPollAt) {
    return { status: 'pending', login: deviceLoginView(login) }
  }

  const task = pollDeviceLoginUpstream(login).finally(() => {
    login.inFlight = undefined
  })
  login.inFlight = task
  return task
}

async function pollDeviceLoginUpstream(login: PendingDeviceLogin): Promise<CodexDevicePollResult> {
  login.nextPollAt = Date.now() + login.intervalMs
  let response: Response
  let text: string
  try {
    response = await fetch(`${login.authIssuer}${DEVICE_TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_auth_id: login.deviceAuthId, user_code: login.userCode }),
      signal: AbortSignal.timeout(30_000),
    })
    text = await response.text()
  } catch (error) {
    // Transient network failure: keep the login (and the entered code) alive
    // so the user can simply try again.
    return {
      status: 'pending',
      login: deviceLoginView(login),
      message: `Could not reach OpenAI (${error instanceof Error ? error.message : String(error)}). Try again in a moment.`,
    }
  }

  let data: DeviceTokenResponse = {}
  if (text) {
    try {
      data = JSON.parse(text) as DeviceTokenResponse
    } catch {
      // Non-JSON error body — fall through to status handling below.
    }
  }

  if (response.ok) {
    if (!data.authorization_code || !data.code_verifier) {
      pendingDeviceLogins.delete(login.id)
      return { status: 'failed', returnTo: login.returnTo, message: `ChatGPT device-code response was missing fields: ${text}` }
    }
    try {
      const tokens = await postTokenEndpoint(
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: data.authorization_code,
          redirect_uri: deviceRedirectUri(login.authIssuer),
          client_id: CODEX_CLIENT_ID,
          code_verifier: data.code_verifier,
        }),
        login.authIssuer,
      )
      const redirectTo = await login.complete(credentialsFromTokenResponse(tokens, undefined, login.authIssuer))
      pendingDeviceLogins.delete(login.id)
      return { status: 'complete', redirectTo }
    } catch (error) {
      pendingDeviceLogins.delete(login.id)
      return { status: 'failed', returnTo: login.returnTo, message: error instanceof Error ? error.message : String(error) }
    }
  }

  // Trust the body's error code over the HTTP status: OpenAI signals both
  // "still pending" and terminal denials through 403s, so a bare status check
  // would leave a denied user staring at the waiting page until the TTL.
  const errorCode = deviceErrorCode(data)
  const pendingCode = errorCode === 'deviceauth_authorization_pending' || errorCode === 'authorization_pending'
  if (pendingCode || (errorCode === null && (response.status === 403 || response.status === 404))) {
    return { status: 'pending', login: deviceLoginView(login), message: 'Waiting for you to finish sign-in at OpenAI…' }
  }
  if (errorCode === 'slow_down') {
    login.intervalMs += DEVICE_SLOW_DOWN_INCREMENT_MS
    login.nextPollAt = Date.now() + login.intervalMs
    return { status: 'pending', login: deviceLoginView(login), message: 'OpenAI asked inkcap to slow down polling; still waiting.' }
  }

  pendingDeviceLogins.delete(login.id)
  return {
    status: 'failed',
    returnTo: login.returnTo,
    message: errorCode === 'access_denied'
      ? 'The sign-in request was denied at OpenAI. Start again from Providers, or use the legacy localhost fallback.'
      : `ChatGPT device-code login failed (${response.status}): ${errorCode ?? (text || response.statusText)}`,
  }
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
        issuerFromCredentials(credentials),
      )
    } catch (error) {
      throw new Error(
        `ChatGPT token refresh failed — re-authenticate this provider from the Providers page. (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }
    const rotated = credentialsFromTokenResponse(tokens, credentials, issuerFromCredentials(credentials))
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
  pendingDeviceLogins.clear()
  stopLoopbackIfIdle({ force: true })
}
