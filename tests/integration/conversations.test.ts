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

// A minimal OpenAI-compatible stub that returns one fixed non-streaming reply.
const stubReply = 'Hello from the stub assistant.'
let lastRequestBody: unknown = null
const stub = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/v1/chat/completions') {
      lastRequestBody = await req.json()
      return Response.json({
        model: 'stub-model',
        choices: [{ message: { content: stubReply }, finish_reason: 'stop' }],
      })
    }
    return new Response('not found', { status: 404 })
  },
})
const stubBaseUrl = `http://localhost:${stub.port}`

afterAll(() => {
  stub.stop(true)
})

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
  test('send delivers a reply, advances curr_node, and renders the transcript', async () => {
    const user = await makeUser()
    const cookie = sessionFor(user)
    const provider = await createProvider({
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

    const conversation = await getConversationById(conversationId)
    expect(conversation?.curr_node).not.toBeNull()

    const path = await getActivePath(conversation!.curr_node!)
    // system prompt + user turn + assistant reply
    expect(path.map((m) => m.role)).toEqual(['system', 'user', 'assistant'])
    expect(path[1]?.content).toBe('What is up?')
    expect(path[2]?.content).toBe(stubReply)
    expect(path[2]?.model).toBe('stub-model')
    // curr_node points at the assistant reply (the leaf).
    expect(conversation?.curr_node).toBe(path[2]?.id ?? null)

    // Request the stub received carried the mapped active-path messages.
    expect((lastRequestBody as { stream?: boolean }).stream).toBe(false)
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

  test('provider HTTP failure saves the user message and surfaces the error', async () => {
    const user = await makeUser()
    const cookie = sessionFor(user)
    // Point at a dead port so the fetch fails.
    const provider = await createProvider({
      name: `dead-${randomUUIDv7()}`,
      kind: 'openai-compat',
      baseUrl: 'http://127.0.0.1:1',
      defaultModel: 'stub-model',
      enabled: true,
    })

    const conversationId = await createConversationViaForm(cookie, provider.id)

    const send = await app.request(url(`/conversations/${conversationId}/messages`), {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin },
      body: form({ content: 'are you there?' }),
    })
    expect(send.status).toBe(200)
    const html = await send.text()
    expect(html).toContain('Reply failed')
    // The user message was saved and is on the active path.
    expect(html).toContain('are you there?')

    const conversation = await getConversationById(conversationId)
    expect(conversation?.curr_node).not.toBeNull()
    const path = await getActivePath(conversation!.curr_node!)
    expect(path.map((m) => m.role)).toEqual(['user'])
  })

  test('another user cannot view or post into the conversation', async () => {
    const owner = await makeUser()
    const ownerCookie = sessionFor(owner)
    const provider = await createProvider({
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
