// The openai-codex provider kind: chat⇄Responses translation, SSE stream
// conversion, OAuth token refresh/rotation, and the loopback connect flow —
// all against stub servers (no real OpenAI traffic).

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
function codexBackendStub(options: { rejectTokens?: Set<string> } = {}) {
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
        const wantsToolCall = hasTools && !hasToolResult

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

// Stub of auth.openai.com's token endpoint: code exchange + rotating refresh.
function issuerStub() {
  const tokenRequests: Array<Record<string, string>> = []
  let refreshCount = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const requestUrl = new URL(req.url)
      if (requestUrl.pathname === '/oauth/token' && req.method === 'POST') {
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
  return { server, tokenRequests, issuer: `http://localhost:${server.port}` }
}

async function createCodexProvider(baseUrl: string, accessToken: string, accountId?: string) {
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
    process.env['CODEX_AUTH_ISSUER'] = issuer.issuer
    try {
      const provider = await createCodexProvider(backend.baseUrl, fakeAccessToken(-60 * 1000))
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
      delete process.env['CODEX_AUTH_ISSUER']
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
    process.env['CODEX_AUTH_ISSUER'] = issuer.issuer
    try {
      const provider = await createCodexProvider(backend.baseUrl, badToken)
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
      delete process.env['CODEX_AUTH_ISSUER']
      issuer.server.stop(true)
      backend.server.stop(true)
    }
  })
})

describe('codex connect flow', () => {
  test('sign-in redirects to the issuer; the loopback callback creates the provider', async () => {
    const { headers } = await authHeadersFor()
    const issuer = issuerStub()
    const backend = codexBackendStub()
    process.env['CODEX_AUTH_ISSUER'] = issuer.issuer
    process.env['CODEX_BASE_URL'] = backend.baseUrl
    const name = `codex-connect-${randomUUIDv7()}`
    try {
      const start = await app.request(url('/providers/codex/connect'), {
        method: 'POST',
        headers,
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

      // Simulate the browser returning from auth.openai.com to the loopback.
      const callback = await fetch(`${CALLBACK_FETCH_URL}?code=test-code&state=${encodeURIComponent(state)}`, {
        redirect: 'manual',
      })
      expect(callback.status).toBe(302)
      expect(callback.headers.get('location')).toBe(`${origin}/providers`)

      // Code exchange carried PKCE, and the provider row exists with
      // discovered models filtered to supported+visible slugs.
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
      // Tokens never render.
      expect(listBody).not.toContain('refresh-token-0')
    } finally {
      delete process.env['CODEX_AUTH_ISSUER']
      delete process.env['CODEX_BASE_URL']
      issuer.server.stop(true)
      backend.server.stop(true)
      resetCodexLoginStateForTests()
    }
  })

  test('a callback with an unknown state fails without creating anything', async () => {
    const issuer = issuerStub()
    process.env['CODEX_AUTH_ISSUER'] = issuer.issuer
    try {
      const start = await app.request(url('/providers/codex/connect'), {
        method: 'POST',
        headers: (await authHeadersFor()).headers,
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
      delete process.env['CODEX_AUTH_ISSUER']
      issuer.server.stop(true)
      resetCodexLoginStateForTests()
    }
  })

  test('a full run through the durable runner streams and finalizes', async () => {
    const backend = codexBackendStub()
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
