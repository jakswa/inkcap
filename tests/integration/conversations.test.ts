import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUIDv7 } from 'bun'

const { app } = await import('../../src/app')
const { createUser } = await import('../../src/db/queries/users')
const { createProvider } = await import('../../src/db/queries/providers')
const { getConversationById } = await import('../../src/db/queries/conversations')
const { getActivePath } = await import('../../src/db/queries/messages')
const { encryptSession } = await import('../../src/utils/private-session')

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
    name: 'Convo Test User',
    email: `convo-${suffix}@example.com`,
    emailNormalized: `convo-${suffix}@example.com`,
    passwordHash: 'x',
  })
}

function sessionFor(user: { id: string; name: string; email: string; created_at: Date }) {
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + 1)
  const cookie = encryptSession({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      created_at: user.created_at.toISOString(),
    },
    issuedAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
  })
  return `session=${cookie}`
}

// A minimal OpenAI-compatible stub that streams one fixed reply (M3 rewired
// send to the durable runner, which always requests `stream: true`).
const stubReply = 'Hello from the stub assistant.'
let lastRequestBody: unknown = null
const stub = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/v1/chat/completions') {
      lastRequestBody = await req.json()
      const body = [
        `data: ${JSON.stringify({ model: 'stub-model', choices: [{ delta: { content: stubReply } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ].join('')
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    return new Response('not found', { status: 404 })
  },
})
const stubBaseUrl = `http://localhost:${stub.port}`

afterAll(() => {
  stub.stop(true)
})

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await Bun.sleep(25)
  }
}

// Sends redirect immediately; the reply streams server-side. Wait for the
// conversation's run to reach a terminal state before asserting.
async function waitForRunSettled(conversationId: string) {
  const { getLatestRunForConversation } = await import('../../src/db/queries/runs')
  return waitFor(async () => {
    const run = await getLatestRunForConversation(conversationId)
    return run && run.status !== 'running' ? run : null
  })
}

async function createConversationViaForm(
  cookie: string,
  providerId: string,
  extra: Record<string, string> = {},
) {
  const res = await app.request(url('/conversations'), {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin },
    body: form({ providerId, model: 'stub-model', ...extra }),
  })
  expect(res.status).toBe(302)
  const location = res.headers.get('location') ?? ''
  expect(location).toStartWith('/conversations/')
  return location.slice('/conversations/'.length)
}

describe('conversations chat loop', () => {
  test('new-chat composer uses provider-backed model and reasoning controls', async () => {
    const user = await makeUser()
    const cookie = sessionFor(user)
    const model = `reasoning-${randomUUIDv7()}`
    const provider = await createProvider({
      accountId: user.id,
      name: `controls-${randomUUIDv7()}`,
      kind: 'llama-server',
      baseUrl: stubBaseUrl,
      defaultModel: model,
      models: [model],
      modelMetadata: {
        [model]: {
          capabilities: ['text', 'reasoning'],
          reasoning: true,
          contextSize: null,
          source: 'test',
        },
      },
      enabled: true,
    })

    const res = await app.request(url('/conversations'), {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin },
      body: form({ providerId: provider.id, model, title: 'x'.repeat(201) }),
    })
    expect(res.status).toBe(200)
    const html = await res.text()

    expect(html).toContain('data-model-select')
    expect(html).toContain(model)
    expect(html).toContain(provider.name)
    expect(html).toContain('data-reasoning="1"')
    expect(html).toContain('data-reasoning-control')
    expect(html).not.toContain('list="new-chat-models"')
  })

  test('new-chat model option carries provider and model together', async () => {
    const user = await makeUser()
    const cookie = sessionFor(user)
    const first = await createProvider({
      accountId: user.id,
      name: `first-${randomUUIDv7()}`,
      kind: 'openai-compat',
      baseUrl: stubBaseUrl,
      defaultModel: 'first-model',
      models: ['first-model'],
      enabled: true,
    })
    const second = await createProvider({
      accountId: user.id,
      name: `second-${randomUUIDv7()}`,
      kind: 'openai-compat',
      baseUrl: stubBaseUrl,
      defaultModel: 'second-model',
      models: ['second-model'],
      enabled: true,
    })

    const create = await app.request(url('/conversations'), {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin },
      body: form({ providerModel: `${second.id}:${encodeURIComponent('second-model')}` }),
    })
    expect(create.status).toBe(302)

    const location = create.headers.get('location') ?? ''
    const conversation = await getConversationById(location.slice('/conversations/'.length))
    expect(conversation?.provider_id).toBe(second.id)
    expect(conversation?.provider_id).not.toBe(first.id)
    expect(conversation?.model).toBe('second-model')
  })

  test('existing-chat composer can switch to another provider model', async () => {
    const user = await makeUser()
    const cookie = sessionFor(user)
    const first = await createProvider({
      accountId: user.id,
      name: `first-chat-${randomUUIDv7()}`,
      kind: 'openai-compat',
      baseUrl: stubBaseUrl,
      defaultModel: 'first-model',
      models: ['first-model'],
      enabled: true,
    })
    const second = await createProvider({
      accountId: user.id,
      name: `second-chat-${randomUUIDv7()}`,
      kind: 'openai-compat',
      baseUrl: stubBaseUrl,
      defaultModel: 'second-model',
      models: ['second-model'],
      enabled: true,
    })
    const conversationId = await createConversationViaForm(cookie, first.id, {
      model: 'first-model',
    })

    const show = await app.request(url(`/conversations/${conversationId}`), {
      headers: { Cookie: cookie },
    })
    const html = await show.text()
    expect(html).toContain('first-model')
    expect(html).toContain('second-model')
    expect(html).toContain(second.name)

    const send = await app.request(url(`/conversations/${conversationId}/messages`), {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin },
      body: form({
        content: 'switch providers',
        providerModel: `${second.id}:${encodeURIComponent('second-model')}`,
      }),
    })
    expect(send.status).toBe(302)
    await waitForRunSettled(conversationId)

    const conversation = await getConversationById(conversationId)
    expect(conversation?.provider_id).toBe(second.id)
    expect(conversation?.model).toBe('second-model')
    expect((lastRequestBody as { model?: string }).model).toBe('second-model')
  })

  test('send delivers a reply, advances curr_node, and renders the transcript', async () => {
    const user = await makeUser()
    const cookie = sessionFor(user)
    const provider = await createProvider({
      accountId: user.id,
      name: `stub-${randomUUIDv7()}`,
      kind: 'openai-compat',
      baseUrl: stubBaseUrl,
      defaultModel: 'stub-model',
      enabled: true,
    })

    const conversationId = await createConversationViaForm(cookie, provider.id, {
      systemPrompt: 'You are a terse assistant.',
    })

    const send = await app.request(url(`/conversations/${conversationId}/messages`), {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin },
      body: form({ content: 'What is up?' }),
    })
    expect(send.status).toBe(302)
    expect(send.headers.get('location')).toBe(`/conversations/${conversationId}`)

    const run = await waitForRunSettled(conversationId)
    expect(run.status).toBe('done')

    const conversation = await getConversationById(conversationId)
    expect(conversation?.curr_node).not.toBeNull()

    const path = await getActivePath(conversation!.curr_node!)
    // system prompt + user turn + assistant reply
    expect(path.map((m) => m.role)).toEqual(['system', 'user', 'assistant'])
    expect(path[1]?.content).toBe('What is up?')
    expect(path[2]?.content).toBe(stubReply)
    expect(path[2]?.model).toBe('stub-model')
    expect(path[2]?.status).toBe('complete')
    // curr_node points at the assistant reply (the leaf).
    expect(conversation?.curr_node).toBe(path[2]?.id ?? null)

    // Request the stub received carried the mapped active-path messages.
    expect((lastRequestBody as { stream?: boolean }).stream).toBe(true)
    expect((lastRequestBody as { messages?: Array<{ role: string }> }).messages?.map((m) => m.role)).toEqual([
      'system',
      'user',
    ])

    const show = await app.request(url(`/conversations/${conversationId}`), {
      headers: { Cookie: cookie },
    })
    expect(show.status).toBe(200)
    const html = await show.text()
    expect(html).toContain('What is up?')
    expect(html).toContain(stubReply)
  })

  test('sending on a disabled provider shows a friendly error and saves nothing', async () => {
    const user = await makeUser()
    const cookie = sessionFor(user)
    const provider = await createProvider({
      accountId: user.id,
      name: `disabled-${randomUUIDv7()}`,
      kind: 'openai-compat',
      baseUrl: stubBaseUrl,
      defaultModel: 'stub-model',
      enabled: true,
    })

    const conversationId = await createConversationViaForm(cookie, provider.id)

    // Disable the provider after the conversation exists.
    const { setProviderEnabled } = await import('../../src/db/queries/providers')
    await setProviderEnabled({ id: provider.id, enabled: false })

    const send = await app.request(url(`/conversations/${conversationId}/messages`), {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin },
      body: form({ content: 'hello?' }),
    })
    expect(send.status).toBe(200)
    const html = await send.text()
    expect(html).toContain('disabled')
    // The draft is preserved for the user to retry.
    expect(html).toContain('hello?')

    // Nothing was persisted: curr_node stays null (no system prompt was set).
    const conversation = await getConversationById(conversationId)
    expect(conversation?.curr_node).toBeNull()
  })

  test('provider HTTP failure keeps the user message and parks the run as error', async () => {
    const user = await makeUser()
    const cookie = sessionFor(user)
    // Point at a dead port so the provider fetch fails inside the run.
    const provider = await createProvider({
      accountId: user.id,
      name: `dead-${randomUUIDv7()}`,
      kind: 'openai-compat',
      baseUrl: 'http://127.0.0.1:1',
      defaultModel: 'stub-model',
      enabled: true,
    })

    const conversationId = await createConversationViaForm(cookie, provider.id)

    // The send itself succeeds — the failure happens in the detached run.
    const send = await app.request(url(`/conversations/${conversationId}/messages`), {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin },
      body: form({ content: 'are you there?' }),
    })
    expect(send.status).toBe(302)

    const run = await waitForRunSettled(conversationId)
    expect(run.status).toBe('error')
    expect(run.error).toContain('Unable to reach the provider')

    // The user message was saved; the empty reply is marked interrupted.
    const conversation = await getConversationById(conversationId)
    expect(conversation?.curr_node).not.toBeNull()
    const path = await getActivePath(conversation!.curr_node!)
    expect(path.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(path[0]?.content).toBe('are you there?')
    expect(path[1]?.status).toBe('interrupted')
  })

  test('another user cannot view or post into the conversation', async () => {
    const owner = await makeUser()
    const ownerCookie = sessionFor(owner)
    const provider = await createProvider({
      accountId: owner.id,
      name: `owned-${randomUUIDv7()}`,
      kind: 'openai-compat',
      baseUrl: stubBaseUrl,
      enabled: true,
    })
    const conversationId = await createConversationViaForm(ownerCookie, provider.id)

    const intruder = await makeUser()
    const intruderCookie = sessionFor(intruder)

    const view = await app.request(url(`/conversations/${conversationId}`), {
      headers: { Cookie: intruderCookie },
    })
    expect(view.status).toBe(404)

    const post = await app.request(url(`/conversations/${conversationId}/messages`), {
      method: 'POST',
      headers: { Cookie: intruderCookie, Origin: origin },
      body: form({ content: 'peeking' }),
    })
    expect(post.status).toBe(404)
  })
})
