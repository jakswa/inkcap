// The openai-codex provider kind: chat⇄Responses translation, SSE stream
// conversion, OAuth token refresh/rotation, and the device/loopback connect
// flows — all against stub servers (no real OpenAI traffic).

import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUIDv7 } from 'bun'
import type { StreamDelta } from '../../src/services/provider-client'

// The loopback callback port is fixed in production (the OAuth client is
// registered for localhost:1455); tests use a private port to stay clear of
// any real Codex CLI login. Read lazily by codex-auth, but set before any
// codex code runs.
process.env['CODEX_OAUTH_PORT'] = '14855'
const CALLBACK_URL = 'http://localhost:14855/auth/callback'
// The loopback listener binds IPv4; Bun's fetch may resolve `localhost` to
// ::1 first (browsers fall back, fetch does not), so tests dial 127.0.0.1.
const CALLBACK_FETCH_URL = 'http://127.0.0.1:14855/auth/callback'

const { app } = await import('../../src/app')
const { createProvider, getProviderById } = await import('../../src/db/queries/providers')
const { createUser } = await import('../../src/db/queries/users')
const { getConversationById } = await import('../../src/db/queries/conversations')
const { getMessageById } = await import('../../src/db/queries/messages')
const { getLatestRunForConversation } = await import('../../src/db/queries/runs')
const { encryptSession } = await import('../../src/utils/private-session')
const { streamChat } = await import('../../src/services/provider-client')
const { buildCodexRequestBody } = await import('../../src/services/codex-client')
const { resetCodexLoginStateForTests } = await import('../../src/services/codex-auth')

const origin = 'http://localhost:3000'

function url(path: string) {
  return `${origin}${path}`
}

function form(input: Record<string, string>) {
  const body = new FormData()
  for (const [key, value] of Object.entries(input)) body.set(key, value)
  return body
}

async function makeUser() {
  const suffix = randomUUIDv7()
  return createUser({
    name: 'Codex Test User',
    email: `codex-${suffix}@example.com`,
    emailNormalized: `codex-${suffix}@example.com`,
    passwordHash: 'x',
  })
}

function sessionFor(user: { id: string; name: string; email: string; created_at: Date }) {
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + 1)
  return `session=${encryptSession({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      created_at: user.created_at.toISOString(),
    },
    issuedAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
  })}`
}

// Providers are account-scoped: a test keeps one real identity across its
// requests (the connect callback inserts a provider row FK'd to the account).
async function authHeadersFor() {
  const user = await makeUser()
  return { user, headers: { Cookie: sessionFor(user), Origin: origin } }
}

function codexStubHeaders(
  headers: Record<string, string>,
  options: { issuer?: string; baseUrl?: string },
) {
  return {
    ...headers,
    ...(options.issuer ? { 'x-inkcap-test-codex-auth-issuer': options.issuer } : {}),
    ...(options.baseUrl ? { 'x-inkcap-test-codex-base-url': options.baseUrl } : {}),
  }
}

// Unsigned JWT with the claim block the account-id extraction reads. Only the
// payload is ever decoded — no signature verification happens client-side.
function fakeJwt(claims: Record<string, unknown>) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.${part('sig')}`
}

function fakeAccessToken(expiresInMs: number, accountId = 'acct-test-123') {
  return fakeJwt({
    exp: Math.floor((Date.now() + expiresInMs) / 1000),
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })
}

interface CapturedRequest {
  headers: Record<string, string>
  body: Record<string, unknown>
}

// Stub of chatgpt.com/backend-api/codex: /models listing plus /responses SSE.
// Emits a tool call when the request declares tools and no tool result has
// come back yet; otherwise streams text. Includes a deliberately truncated
// status event to prove the parser skips malformed JSON without dying.
function codexBackendStub(options: { rejectTokens?: Set<string>; callTools?: boolean } = {}) {
  const captured: CapturedRequest[] = []
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const requestUrl = new URL(req.url)
      const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
      if (!token || options.rejectTokens?.has(token)) {
        return Response.json({ detail: 'Unauthorized' }, { status: 401 })
      }
      if (req.headers.get('originator') !== 'codex_cli_rs') {
        return Response.json({ detail: 'Forbidden originator' }, { status: 403 })
      }

      if (requestUrl.pathname === '/models') {
        return Response.json({
          models: [
            { slug: 'gpt-5.5', supported_in_api: true, visibility: 'list' },
            { slug: 'gpt-5.4', supported_in_api: true, visibility: 'list' },
            { slug: 'gpt-5.2-codex', supported_in_api: false, visibility: 'list' },
            { slug: 'hidden-model', supported_in_api: true, visibility: 'hidden' },
          ],
        })
      }

      if (requestUrl.pathname === '/responses' && req.method === 'POST') {
        const body = (await req.json()) as Record<string, unknown>
        captured.push({
          headers: Object.fromEntries(req.headers.entries()),
          body,
        })
        if (body['instructions'] === '' || body['instructions'] == null) {
          return Response.json({ detail: 'Instructions are required' }, { status: 400 })
        }

        const input = Array.isArray(body['input']) ? (body['input'] as Array<{ type?: string }>) : []
        const hasTools = Array.isArray(body['tools']) && (body['tools'] as unknown[]).length > 0
        const hasToolResult = input.some((item) => item.type === 'function_call_output')
        const wantsToolCall = options.callTools !== false && hasTools && !hasToolResult

        const send = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
        let sse = ''
        sse += `event: response.created\n${send({ type: 'response.created', response: { model: 'gpt-5.5' } })}`
        // Truncated status event (the real backend does this across SSE
        // buffer boundaries on the huge instructions echo).
        sse += 'data: {"type":"response.in_progress","response":{"instructions":"You are Codex, ba\n\n'
        if (wantsToolCall) {
          sse += send({
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'function_call', call_id: 'call_stub_1', name: 'echo', arguments: '' },
          })
          sse += send({
            type: 'response.function_call_arguments.delta',
            output_index: 0,
            delta: '{"text":',
          })
          sse += send({
            type: 'response.function_call_arguments.delta',
            output_index: 0,
            delta: '"hi"}',
          })
          sse += send({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'function_call',
              call_id: 'call_stub_1',
              name: 'echo',
              arguments: '{"text":"hi"}',
            },
          })
        } else {
          sse += send({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } })
          sse += send({ type: 'response.reasoning_summary_text.delta', delta: 'thinking… ' })
          sse += send({ type: 'response.output_text.delta', delta: 'Hello ' })
          sse += send({ type: 'response.output_text.delta', delta: 'from codex!' })
          sse += send({ type: 'response.output_text.done', text: 'Hello from codex!' })
        }
        // Terminal event with an EMPTY output array — clients must
        // reconstruct the message from deltas.
        sse += send({ type: 'response.completed', response: { model: 'gpt-5.5', output: [] } })

        return new Response(sse, {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
        })
      }

      return new Response('not found', { status: 404 })
    },
  })
  return { server, captured, baseUrl: `http://localhost:${server.port}` }
}

// Stub of auth.openai.com's device auth + token endpoints: code exchange and
// rotating refresh. `deviceToken` overrides the poll response (denials,
// pending); `tokenDelayMs` slows the code exchange to widen race windows.
function issuerStub(options: {
  deviceToken?: (body: Record<string, string>) => Response | Promise<Response>
  tokenDelayMs?: number
} = {}) {
  const tokenRequests: Array<Record<string, string>> = []
  const deviceTokenRequests: Array<Record<string, string>> = []
  let refreshCount = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const requestUrl = new URL(req.url)
      if (requestUrl.pathname === '/api/accounts/deviceauth/usercode' && req.method === 'POST') {
        const body = (await req.json()) as Record<string, unknown>
        if (body['client_id'] !== 'app_EMoamEEZ73f0CkXaXp7hrann') {
          return Response.json({ error: 'bad_client' }, { status: 400 })
        }
        return Response.json({
          device_auth_id: 'device-auth-1',
          user_code: 'ABCD-EFGH',
          interval: 0,
        })
      }
      if (requestUrl.pathname === '/api/accounts/deviceauth/token' && req.method === 'POST') {
        const body = (await req.json()) as Record<string, string>
        deviceTokenRequests.push(body)
        if (options.deviceToken) return options.deviceToken(body)
        return Response.json({
          authorization_code: 'device-authorization-code',
          code_verifier: 'device-code-verifier',
        })
      }
      if (requestUrl.pathname === '/oauth/token' && req.method === 'POST') {
        if (options.tokenDelayMs) await Bun.sleep(options.tokenDelayMs)
        const params = new URLSearchParams(await req.text())
        const record = Object.fromEntries(params.entries())
        tokenRequests.push(record)
        if (record['grant_type'] === 'authorization_code') {
          return Response.json({
            access_token: fakeAccessToken(60 * 60 * 1000),
            refresh_token: 'refresh-token-0',
            id_token: fakeJwt({
              'https://api.openai.com/auth': { chatgpt_account_id: 'acct-test-123' },
            }),
          })
        }
        if (record['grant_type'] === 'refresh_token') {
          refreshCount += 1
          return Response.json({
            access_token: fakeAccessToken(60 * 60 * 1000),
            refresh_token: `refresh-token-${refreshCount}`,
          })
        }
        return Response.json({ error: 'unsupported_grant_type' }, { status: 400 })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return { server, tokenRequests, deviceTokenRequests, issuer: `http://localhost:${server.port}` }
}

async function createCodexProvider(baseUrl: string, accessToken: string, accountId?: string, authIssuer?: string) {
  return createProvider({
    accountId: accountId ?? (await makeUser()).id,
    name: `codex-${randomUUIDv7()}`,
    kind: 'openai-codex',
    baseUrl,
    defaultModel: 'gpt-5.5',
    models: ['gpt-5.5', 'gpt-5.4'],
    oauthCredentials: {
      id_token: null,
      access_token: accessToken,
      refresh_token: 'refresh-token-0',
      account_id: 'acct-test-123',
      last_refresh: new Date().toISOString(),
      ...(authIssuer ? { auth_issuer: authIssuer } : {}),
    },
    enabled: true,
  })
}

async function collect(stream: AsyncGenerator<StreamDelta, void, undefined>) {
  const deltas: StreamDelta[] = []
  for await (const delta of stream) deltas.push(delta)
  return deltas
}

function contentOf(deltas: StreamDelta[]) {
  return deltas
    .filter((d): d is Extract<StreamDelta, { kind: 'content' }> => d.kind === 'content')
    .map((d) => d.text)
    .join('')
}

afterAll(() => {
  resetCodexLoginStateForTests()
})

describe('codex request translation', () => {
  test('hoists system messages into Codex-style instructions and maps the tree', () => {
    const body = buildCodexRequestBody(
      'gpt-5.5',
      [
        { role: 'system', content: 'Answer in French.' },
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: 'Let me check.',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"a":1}' } },
          ],
        },
        { role: 'tool', content: 'echoed', tool_call_id: 'call_1' },
      ],
      {
        tools: [
          {
            type: 'function',
            function: { name: 'echo', description: 'Echo it', parameters: { type: 'object' } },
          },
        ],
        reasoningEffort: 'max',
      },
    )

    expect(body['model']).toBe('gpt-5.5')
    expect(body['store']).toBe(false)
    expect(body['stream']).toBe(true)
    expect(body['include']).toEqual(['reasoning.encrypted_content'])
    const instructions = body['instructions'] as string
    expect(instructions.startsWith('You are Codex')).toBe(true)
    expect(instructions).toContain('Answer in French.')

    expect(body['input']).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Let me check.' }],
      },
      { type: 'function_call', call_id: 'call_1', name: 'echo', arguments: '{"a":1}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'echoed' },
    ])
    expect(body['tools']).toEqual([
      {
        type: 'function',
        name: 'echo',
        description: 'Echo it',
        parameters: { type: 'object' },
        strict: false,
      },
    ])
    // 'max' clamps to the Responses API's 'high'.
    expect(body['reasoning']).toEqual({ effort: 'high', summary: 'auto' })
  })

  test('instructions are never empty even without a system message', () => {
    const body = buildCodexRequestBody('gpt-5.5', [{ role: 'user', content: 'Hi' }])
    expect((body['instructions'] as string).length).toBeGreaterThan(0)
    expect(body['reasoning']).toBeUndefined()
    expect(body['tools']).toBeUndefined()
  })
})

describe('codex streaming', () => {
  test('translates Responses SSE into content/reasoning/model/finish deltas', async () => {
    const backend = codexBackendStub()
    try {
      const provider = await createCodexProvider(backend.baseUrl, fakeAccessToken(60 * 60 * 1000))
      const deltas = await collect(
        streamChat(
          { id: provider.id, kind: provider.kind, base_url: provider.base_url, api_key: null },
          'gpt-5.5',
          [{ role: 'user', content: 'Say hi' }],
        ),
      )

      expect(contentOf(deltas)).toBe('Hello from codex!')
      expect(deltas.some((d) => d.kind === 'reasoning' && d.text.includes('thinking'))).toBe(true)
      expect(deltas.find((d) => d.kind === 'model')).toEqual({ kind: 'model', model: 'gpt-5.5' })
      expect(deltas.at(-1)).toEqual({ kind: 'finish', finishReason: 'stop' })

      // The wire request carried the whitelisted identity headers and the
      // stateless-Responses quirks.
      const request = backend.captured[0]!
      expect(request.headers['chatgpt-account-id']).toBe('acct-test-123')
      expect(request.headers['originator']).toBe('codex_cli_rs')
      expect(request.headers['session_id']).toMatch(/[0-9a-f-]{36}/)
      expect(request.headers['user-agent']).toContain('codex_cli_rs/')
      expect(request.body['store']).toBe(false)
      expect(request.body['stream']).toBe(true)
    } finally {
      backend.server.stop(true)
    }
  })

  test('translates streamed function calls into merged tool-call deltas', async () => {
    const backend = codexBackendStub()
    try {
      const provider = await createCodexProvider(backend.baseUrl, fakeAccessToken(60 * 60 * 1000))
      const deltas = await collect(
        streamChat(
          { id: provider.id, kind: provider.kind, base_url: provider.base_url, api_key: null },
          'gpt-5.5',
          [{ role: 'user', content: 'Use the tool' }],
          undefined,
          undefined,
          [{ type: 'function', function: { name: 'echo', description: '', parameters: {} } }],
        ),
      )

      const toolDeltas = deltas.filter(
        (d): d is Extract<StreamDelta, { kind: 'tool-calls' }> => d.kind === 'tool-calls',
      )
      expect(toolDeltas.length).toBeGreaterThan(0)
      expect(toolDeltas.at(-1)!.toolCalls).toEqual([
        {
          id: 'call_stub_1',
          type: 'function',
          function: { name: 'echo', arguments: '{"text":"hi"}' },
        },
      ])
      expect(deltas.at(-1)).toEqual({ kind: 'finish', finishReason: 'tool_calls' })
    } finally {
      backend.server.stop(true)
    }
  })

  test('refreshes an expired token proactively and persists the rotation', async () => {
    const issuer = issuerStub()
    const backend = codexBackendStub()
    try {
      const provider = await createCodexProvider(backend.baseUrl, fakeAccessToken(-60 * 1000), undefined, issuer.issuer)
      const deltas = await collect(
        streamChat(
          { id: provider.id, kind: provider.kind, base_url: provider.base_url, api_key: null },
          'gpt-5.5',
          [{ role: 'user', content: 'Say hi' }],
        ),
      )
      expect(contentOf(deltas)).toBe('Hello from codex!')

      const refreshed = await getProviderById(provider.id)
      const credentials = refreshed!.oauth_credentials as {
        access_token: string
        refresh_token: string
      }
      expect(credentials.refresh_token).toBe('refresh-token-1')
      expect(credentials.access_token).not.toBe(provider.oauth_credentials!.access_token)
      expect(issuer.tokenRequests[0]!['grant_type']).toBe('refresh_token')
    } finally {
      issuer.server.stop(true)
      backend.server.stop(true)
    }
  })

  test('a fresh-looking token rejected upstream triggers one reactive refresh and retry', async () => {
    const issuer = issuerStub()
    // 45 minutes: comfortably past the proactive-refresh leeway but a
    // different exp than the issuer stub mints, so the rotated token can
    // never collide with this rejected one.
    const badToken = fakeAccessToken(45 * 60 * 1000)
    const backend = codexBackendStub({ rejectTokens: new Set([badToken]) })
    try {
      const provider = await createCodexProvider(backend.baseUrl, badToken, undefined, issuer.issuer)
      const deltas = await collect(
        streamChat(
          { id: provider.id, kind: provider.kind, base_url: provider.base_url, api_key: null },
          'gpt-5.5',
          [{ role: 'user', content: 'Say hi' }],
        ),
      )
      expect(contentOf(deltas)).toBe('Hello from codex!')
      expect(issuer.tokenRequests.length).toBe(1)
    } finally {
      issuer.server.stop(true)
      backend.server.stop(true)
    }
  })
})

describe('codex connect flow', () => {
  test('device-code sign-in creates the provider without a loopback callback', async () => {
    const { headers } = await authHeadersFor()
    const issuer = issuerStub()
    const backend = codexBackendStub()
    const startHeaders = codexStubHeaders(headers, { issuer: issuer.issuer, baseUrl: backend.baseUrl })
    const name = `codex-connect-${randomUUIDv7()}`
    try {
      const start = await app.request(url('/providers/codex/connect'), {
        method: 'POST',
        headers: startHeaders,
        body: form({ name }),
      })
      // POST-redirect-GET: the code page lives at a stable GET URL.
      expect(start.status).toBe(303)
      const devicePath = start.headers.get('location')!
      expect(devicePath).toMatch(/^\/providers\/codex\/device\/[^/]+$/)

      const page = await app.request(url(devicePath), { headers })
      expect(page.status).toBe(200)
      const startBody = await page.text()
      expect(startBody).toContain('ABCD-EFGH')
      expect(startBody).toContain(`${issuer.issuer}/codex/device`)
      expect(startBody).toContain('No tunnel or localhost callback is needed')
      const pollPath = startBody.match(/action="(\/providers\/codex\/device\/[^"/]+\/poll)"/)?.[1]
      expect(pollPath).toBeTruthy()

      // Refreshing re-renders the same pending login; the GET never polls
      // upstream, so the completed authorization can't be consumed by it.
      const refreshed = await app.request(url(devicePath), { headers })
      expect(await refreshed.text()).toContain('ABCD-EFGH')
      expect(issuer.deviceTokenRequests).toEqual([])

      const finish = await app.request(url(pollPath!), {
        method: 'POST',
        headers,
        redirect: 'manual',
      })
      expect(finish.status).toBe(302)
      expect(finish.headers.get('location')).toBe(`${origin}/providers`)
      expect(issuer.deviceTokenRequests).toEqual([{ device_auth_id: 'device-auth-1', user_code: 'ABCD-EFGH' }])

      const exchange = issuer.tokenRequests.find((r) => r['grant_type'] === 'authorization_code')!
      expect(exchange['code']).toBe('device-authorization-code')
      expect(exchange['code_verifier']).toBe('device-code-verifier')
      expect(exchange['redirect_uri']).toBe(`${issuer.issuer}/deviceauth/callback`)

      const list = await app.request(url('/providers'), { headers })
      const listBody = await list.text()
      expect(listBody).toContain(name)
      expect(listBody).toContain('ChatGPT OAuth: connected')
      expect(listBody).toContain('gpt-5.5')
      expect(listBody).not.toContain('gpt-5.2-codex')
      expect(listBody).not.toContain('hidden-model')
      expect(listBody).not.toContain('refresh-token-0')
    } finally {
      issuer.server.stop(true)
      backend.server.stop(true)
    }
  })

  test('a denial at OpenAI fails fast instead of waiting out the TTL', async () => {
    const { headers } = await authHeadersFor()
    const issuer = issuerStub({
      deviceToken: () => Response.json({ error: { code: 'access_denied' } }, { status: 403 }),
    })
    const startHeaders = codexStubHeaders(headers, { issuer: issuer.issuer })
    try {
      const start = await app.request(url('/providers/codex/connect'), {
        method: 'POST',
        headers: startHeaders,
        body: form({ name: `codex-denied-${randomUUIDv7()}` }),
      })
      expect(start.status).toBe(303)
      const devicePath = start.headers.get('location')!

      const poll = await app.request(url(`${devicePath}/poll`), { method: 'POST', headers })
      expect(poll.status).toBe(400)
      expect(await poll.text()).toContain('denied at OpenAI')

      // The denied login is gone; polling again reports it as used.
      const again = await app.request(url(`${devicePath}/poll`), { method: 'POST', headers })
      expect(again.status).toBe(400)
      expect(await again.text()).toContain('expired or was already used')
    } finally {
      issuer.server.stop(true)
    }
  })

  test('a 403 with no terminal error code still counts as pending', async () => {
    const { headers } = await authHeadersFor()
    const issuer = issuerStub({
      deviceToken: () => Response.json({ error: { code: 'deviceauth_authorization_pending' } }, { status: 403 }),
    })
    const startHeaders = codexStubHeaders(headers, { issuer: issuer.issuer })
    try {
      const start = await app.request(url('/providers/codex/connect'), {
        method: 'POST',
        headers: startHeaders,
        body: form({ name: `codex-pending-${randomUUIDv7()}` }),
      })
      const devicePath = start.headers.get('location')!
      const poll = await app.request(url(`${devicePath}/poll`), { method: 'POST', headers })
      expect(poll.status).toBe(200)
      const body = await poll.text()
      expect(body).toContain('Waiting for you to finish sign-in')
      expect(body).toContain('ABCD-EFGH')
    } finally {
      issuer.server.stop(true)
    }
  })

  test('double-submitting the poll completes once and creates one provider', async () => {
    const { headers } = await authHeadersFor()
    const issuer = issuerStub({ tokenDelayMs: 250 })
    const backend = codexBackendStub()
    const startHeaders = codexStubHeaders(headers, { issuer: issuer.issuer, baseUrl: backend.baseUrl })
    const name = `codex-double-${randomUUIDv7()}`
    try {
      const start = await app.request(url('/providers/codex/connect'), {
        method: 'POST',
        headers: startHeaders,
        body: form({ name }),
      })
      const pollUrl = url(`${start.headers.get('location')!}/poll`)

      // Both submits join the same in-flight exchange and both see the result.
      const [first, second] = await Promise.all([
        app.request(pollUrl, { method: 'POST', headers, redirect: 'manual' }),
        app.request(pollUrl, { method: 'POST', headers, redirect: 'manual' }),
      ])
      for (const res of [first, second]) {
        expect(res.status).toBe(302)
        expect(res.headers.get('location')).toBe(`${origin}/providers`)
      }
      expect(issuer.deviceTokenRequests.length).toBe(1)

      const list = await app.request(url('/providers'), { headers })
      const listBody = await list.text()
      expect(listBody.split(name).length - 1).toBe(1)
    } finally {
      issuer.server.stop(true)
      backend.server.stop(true)
    }
  })

  test('a network failure while polling keeps the sign-in alive', async () => {
    const { headers } = await authHeadersFor()
    const issuer = issuerStub()
    const startHeaders = codexStubHeaders(headers, { issuer: issuer.issuer })
    try {
      const start = await app.request(url('/providers/codex/connect'), {
        method: 'POST',
        headers: startHeaders,
        body: form({ name: `codex-blip-${randomUUIDv7()}` }),
      })
      const devicePath = start.headers.get('location')!

      // The issuer becomes unreachable mid-sign-in.
      issuer.server.stop(true)
      const poll = await app.request(url(`${devicePath}/poll`), { method: 'POST', headers })
      expect(poll.status).toBe(200)
      const body = await poll.text()
      expect(body).toContain('Could not reach OpenAI')
      // The login (and the code the user already entered) survives the blip.
      expect(body).toContain('ABCD-EFGH')
    } finally {
      issuer.server.stop(true)
    }
  })

  test('legacy localhost fallback redirects to the issuer; the loopback callback creates the provider', async () => {
    const { headers } = await authHeadersFor()
    const issuer = issuerStub()
    const backend = codexBackendStub()
    const startHeaders = codexStubHeaders(headers, { issuer: issuer.issuer, baseUrl: backend.baseUrl })
    const name = `codex-connect-${randomUUIDv7()}`
    try {
      const start = await app.request(url('/providers/codex/connect/localhost'), {
        method: 'POST',
        headers: startHeaders,
        body: form({ name }),
      })
      expect(start.status).toBe(302)
      const authorizeUrl = new URL(start.headers.get('location')!)
      expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(`${issuer.issuer}/oauth/authorize`)
      expect(authorizeUrl.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
      expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(CALLBACK_URL)
      expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256')
      expect(authorizeUrl.searchParams.get('codex_cli_simplified_flow')).toBe('true')
      const state = authorizeUrl.searchParams.get('state')!
      expect(state.length).toBeGreaterThan(10)

      const callback = await fetch(`${CALLBACK_FETCH_URL}?code=test-code&state=${encodeURIComponent(state)}`, {
        redirect: 'manual',
      })
      expect(callback.status).toBe(302)
      expect(callback.headers.get('location')).toBe(`${origin}/providers`)

      const exchange = issuer.tokenRequests.find((r) => r['grant_type'] === 'authorization_code')!
      expect(exchange['code']).toBe('test-code')
      expect(exchange['code_verifier']!.length).toBeGreaterThan(20)

      const list = await app.request(url('/providers'), { headers })
      const listBody = await list.text()
      expect(listBody).toContain(name)
      expect(listBody).toContain('ChatGPT OAuth: connected')
      expect(listBody).toContain('gpt-5.5')
      expect(listBody).not.toContain('gpt-5.2-codex')
      expect(listBody).not.toContain('hidden-model')
      expect(listBody).not.toContain('refresh-token-0')
    } finally {
      issuer.server.stop(true)
      backend.server.stop(true)
    }
  })

  test('a remote browser can paste the localhost callback URL to finish sign-in', async () => {
    const { headers } = await authHeadersFor()
    const issuer = issuerStub()
    const backend = codexBackendStub()
    const startHeaders = codexStubHeaders(headers, { issuer: issuer.issuer, baseUrl: backend.baseUrl })
    const name = `codex-remote-${randomUUIDv7()}`
    try {
      const start = await app.request(url('/providers/codex/connect/localhost'), {
        method: 'POST',
        headers: startHeaders,
        body: form({ name }),
      })
      expect(start.status).toBe(302)
      const authorizeUrl = new URL(start.headers.get('location')!)
      const state = authorizeUrl.searchParams.get('state')!

      // On a deployed inkcap, auth.openai.com redirects the user's browser to
      // that browser's localhost:1455, not the inkcap server. The user can copy
      // the failed localhost URL from the address bar and paste it back into
      // inkcap, where the server still owns the PKCE verifier and pending state.
      const pasted = await app.request(url('/providers/codex/callback'), {
        method: 'POST',
        headers,
        body: form({
          callback_url: `${CALLBACK_URL}?code=remote-code&state=${encodeURIComponent(state)}`,
        }),
      })
      expect(pasted.status).toBe(302)
      expect(pasted.headers.get('location')).toBe(`${origin}/providers`)

      const exchange = issuer.tokenRequests.find((r) => r['grant_type'] === 'authorization_code')!
      expect(exchange['code']).toBe('remote-code')
      expect(exchange['redirect_uri']).toBe(CALLBACK_URL)

      const list = await app.request(url('/providers'), { headers })
      const listBody = await list.text()
      expect(listBody).toContain(name)
      expect(listBody).toContain('ChatGPT OAuth: connected')
    } finally {
      issuer.server.stop(true)
      backend.server.stop(true)
    }
  })

  test('a pasted callback URL with the wrong port is rejected', async () => {
    const { headers } = await authHeadersFor()
    // Tests run with CODEX_OAUTH_PORT=14855, so the CLI's real default port
    // is the wrong one here — the paste form must only accept the exact
    // redirect_uri the token endpoint will be told about.
    const pasted = await app.request(url('/providers/codex/callback'), {
      method: 'POST',
      headers,
      body: form({
        callback_url: 'http://localhost:1455/auth/callback?code=x&state=y',
      }),
    })
    expect(pasted.status).toBe(400)
    expect(await pasted.text()).toContain('does not look like the Codex localhost callback URL')
  })

  test('codex callback returns to the configured public origin, not a LAN/IP origin', async () => {
    const { headers } = await authHeadersFor()
    const issuer = issuerStub()
    const backend = codexBackendStub()
    try {
      const lanHeaders = codexStubHeaders(
        { ...headers, Origin: 'http://192.168.1.160', 'x-inkcap-test-public-origin': 'https://chat.home.jake.town' },
        { issuer: issuer.issuer, baseUrl: backend.baseUrl },
      )
      const start = await app.request('http://192.168.1.160/providers/codex/connect/localhost', {
        method: 'POST',
        headers: lanHeaders,
        body: form({ name: `codex-public-origin-${randomUUIDv7()}` }),
      })
      expect(start.status).toBe(302)
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!

      const pasted = await app.request('http://192.168.1.160/providers/codex/callback', {
        method: 'POST',
        headers: lanHeaders,
        body: form({
          callback_url: `${CALLBACK_URL}?code=public-origin-code&state=${encodeURIComponent(state)}`,
        }),
      })
      expect(pasted.status).toBe(302)
      expect(pasted.headers.get('location')).toBe('https://chat.home.jake.town/providers')
    } finally {
      issuer.server.stop(true)
      backend.server.stop(true)
    }
  })

  test('a callback with an unknown state fails without creating anything', async () => {
    const issuer = issuerStub()
    try {
      const { headers } = await authHeadersFor()
      const start = await app.request(url('/providers/codex/connect/localhost'), {
        method: 'POST',
        headers: codexStubHeaders(headers, { issuer: issuer.issuer }),
        body: form({ name: `codex-badstate-${randomUUIDv7()}` }),
      })
      expect(start.status).toBe(302)

      const callback = await fetch(`${CALLBACK_FETCH_URL}?code=test-code&state=wrong-state`, {
        redirect: 'manual',
      })
      expect(callback.status).toBe(400)
      expect(await callback.text()).toContain('expired or was already used')
      expect(issuer.tokenRequests.length).toBe(0)
    } finally {
      issuer.server.stop(true)
    }
  })

  test('a full run through the durable runner streams and finalizes', async () => {
    const backend = codexBackendStub({ callTools: false })
    try {
      const suffix = randomUUIDv7()
      const user = await createUser({
        name: 'Codex Runner User',
        email: `codex-runner-${suffix}@example.com`,
        emailNormalized: `codex-runner-${suffix}@example.com`,
        passwordHash: 'x',
      })
      const provider = await createCodexProvider(
        backend.baseUrl,
        fakeAccessToken(60 * 60 * 1000),
        user!.id,
      )
      const expiresAt = new Date()
      expiresAt.setDate(expiresAt.getDate() + 1)
      const cookie = `session=${encryptSession({
        user: {
          id: user!.id,
          name: user!.name,
          email: user!.email,
          created_at: user!.created_at.toISOString(),
        },
        issuedAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString(),
      })}`

      const created = await app.request(url('/conversations'), {
        method: 'POST',
        headers: { Cookie: cookie, Origin: origin },
        body: form({ providerId: provider.id, model: 'gpt-5.5' }),
      })
      expect(created.status).toBe(302)
      const conversationId = (created.headers.get('location') ?? '').slice(
        '/conversations/'.length,
      )

      const sent = await app.request(url(`/conversations/${conversationId}/messages`), {
        method: 'POST',
        headers: { Cookie: cookie, Origin: origin },
        body: form({ content: 'Say hi' }),
      })
      expect(sent.status).toBe(302)

      const run = await (async () => {
        const deadline = Date.now() + 10_000
        for (;;) {
          const r = await getLatestRunForConversation(conversationId)
          if (r && r.status !== 'running') return r
          if (Date.now() > deadline) throw new Error('run never finished')
          await Bun.sleep(25)
        }
      })()
      expect(`${run.status} ${run.error ?? ''}`.trim()).toBe('done')

      const conversation = await getConversationById(conversationId)
      const leaf = await getMessageById(conversation!.curr_node!)
      expect(leaf!.role).toBe('assistant')
      expect(leaf!.status).toBe('complete')
      expect(leaf!.content).toBe('Hello from codex!')
      expect(leaf!.model).toBe('gpt-5.5')
      expect(
        ((backend.captured[0]!.body['tools'] as Array<{ name?: string }> | undefined) ?? []).map(
          (tool) => tool.name,
        ),
      ).toContain('submit_artifact')
    } finally {
      backend.server.stop(true)
    }
  })

  test('the standard provider form refuses the openai-codex kind', async () => {
    const res = await app.request(url('/providers'), {
      method: 'POST',
      headers: (await authHeadersFor()).headers,
      body: form({
        name: `codex-form-${randomUUIDv7()}`,
        kind: 'openai-codex',
        base_url: 'https://chatgpt.com/backend-api/codex',
        api_key: '',
        default_model: '',
      }),
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Sign in with ChatGPT')
  })
})
