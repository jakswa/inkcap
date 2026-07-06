import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUIDv7 } from 'bun'

const { app } = await import('../../src/app')
const { createUser } = await import('../../src/db/queries/users')
const { createProvider } = await import('../../src/db/queries/providers')
const { getConversationById } = await import('../../src/db/queries/conversations')
const { getLatestRunForConversation } = await import('../../src/db/queries/runs')
const { renderMessageHtml, replayRunEvents } = await import('../../src/services/runner')
const { encryptSession } = await import('../../src/utils/private-session')

const origin = 'http://localhost:3000'
const url = (path: string) => `${origin}${path}`

function form(input: Record<string, string>) {
  const body = new FormData()
  for (const [key, value] of Object.entries(input)) body.set(key, value)
  return body
}

async function makeUser() {
  const suffix = randomUUIDv7()
  return createUser({
    name: 'Chat View User',
    email: `chatview-${suffix}@example.com`,
    emailNormalized: `chatview-${suffix}@example.com`,
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

// A stub OpenAI-compatible provider that streams a fixed *markdown* reply, so
// we can prove markdown flows all the way into the server-rendered SSE payload.
const markdownReply = '# Heading\n\n**bold** and `code` here.'
const stub = Bun.serve({
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname === '/v1/chat/completions') {
      await req.json()
      const body = [
        `data: ${JSON.stringify({ model: 'stub-model', choices: [{ delta: { content: markdownReply } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], timings: { predicted_n: 6, predicted_ms: 300 } })}\n\n`,
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

async function waitForRunSettled(conversationId: string) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const run = await getLatestRunForConversation(conversationId)
    if (run && run.status !== 'running') return run
    if (Date.now() > deadline) throw new Error('run did not settle')
    await Bun.sleep(25)
  }
}

async function startConversation(cookie: string, providerId: string) {
  const res = await app.request(url('/conversations'), {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin },
    body: form({ providerId, model: 'stub-model' }),
  })
  expect(res.status).toBe(302)
  return (res.headers.get('location') ?? '').slice('/conversations/'.length)
}

describe('message partial rendering', () => {
  test('renders markdown, collapses reasoning, and neutralizes XSS through the real pipeline', async () => {
    const html = await renderMessageHtml({
      id: 'msg-abc',
      role: 'assistant',
      content:
        '# Title\n\n**bold** and `code`\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))',
      reasoning_content: 'let me think about it',
      model: 'test-model',
      status: 'complete',
      timings: { predicted_n: 10, predicted_ms: 500, prompt_n: 5, prompt_ms: 100 },
    })

    // markdown rendered
    expect(html).toContain('data-message-id="msg-abc"')
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
    // XSS neutralized by sanitize-html before it ever reaches the template
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)</script>')
    expect(html).not.toContain('javascript:')
    // reasoning tucked into a collapsed <details>
    expect(html).toContain('<details')
    expect(html).toContain('Reasoning')
    expect(html).toContain('let me think about it')
    // subtle footer: model + prompt/generation timings
    expect(html).toContain('test-model')
    expect(html).toContain('prompt')
    expect(html).toContain('50.0 tok/s')
    expect(html).toContain('gen')
    expect(html).toContain('20.0 tok/s')
  })

  test('a streaming message stays plain text (no client-side markdown)', async () => {
    const html = await renderMessageHtml({
      id: 'msg-stream',
      role: 'assistant',
      content: '**not rendered yet**',
      reasoning_content: null,
      model: null,
      status: 'streaming',
      timings: null,
    })

    expect(html).toContain('data-status="streaming"')
    expect(html).toContain('data-content')
    // raw markdown text, NOT converted — the island appends deltas here
    expect(html).toContain('**not rendered yet**')
    expect(html).not.toContain('<strong>')
    expect(html).toContain('streaming')
  })
})

describe('message-final SSE payload', () => {
  test('carries the server-rendered markdown HTML block', async () => {
    const user = await makeUser()
    const cookie = sessionFor(user)
    const provider = await createProvider({
      accountId: user.id,
      name: `md-stub-${randomUUIDv7()}`,
      kind: 'openai-compat',
      baseUrl: stubBaseUrl,
      defaultModel: 'stub-model',
      enabled: true,
    })
    const conversationId = await startConversation(cookie, provider.id)

    const send = await app.request(url(`/conversations/${conversationId}/messages`), {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin },
      body: form({ content: 'render some markdown' }),
    })
    expect(send.status).toBe(302)

    const run = await waitForRunSettled(conversationId)
    expect(run.status).toBe('done')

    const events = await replayRunEvents(run.id, 0)
    const final = events.find((e) => e.type === 'message-final')
    expect(final).toBeTruthy()
    const finalHtml = String((final!.payload as { html?: string }).html)
    // The payload is the SAME server-rendered partial, markdown already applied.
    expect(finalHtml).toContain('data-message-id')
    expect(finalHtml).toContain('<strong>bold</strong>')
    expect(finalHtml).toContain('<code>code</code>')

    // And the SSR page renders that same rendered markdown (no active run now).
    const show = await app.request(url(`/conversations/${conversationId}`), {
      headers: { Cookie: cookie },
    })
    const showHtml = await show.text()
    expect(showHtml).toContain('<strong>bold</strong>')
    // The island is wired up on the page.
    expect(showHtml).toContain('/chat.js')
  }, 15_000)
})

describe('the chat island asset', () => {
  test('is served as JavaScript from /static', async () => {
    const res = await app.request('/assets/test/chat.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
    const body = await res.text()
    expect(body).toContain('EventSource')
    expect(body).toContain('message-final')
  })
})

describe('conversation delete', () => {
  test('owner can delete; the conversation disappears from the list', async () => {
    const user = await makeUser()
    const cookie = sessionFor(user)
    const provider = await createProvider({
      accountId: user.id,
      name: `del-stub-${randomUUIDv7()}`,
      kind: 'openai-compat',
      baseUrl: stubBaseUrl,
      enabled: true,
    })
    const conversationId = await startConversation(cookie, provider.id)

    const del = await app.request(url(`/conversations/${conversationId}/delete`), {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin },
      body: form({}),
    })
    expect(del.status).toBe(302)
    expect(del.headers.get('location')).toBe('/conversations')
    expect(await getConversationById(conversationId)).toBeUndefined()
  })

  test('a non-owner cannot delete the conversation', async () => {
    const owner = await makeUser()
    const ownerCookie = sessionFor(owner)
    const provider = await createProvider({
      accountId: owner.id,
      name: `del-owned-${randomUUIDv7()}`,
      kind: 'openai-compat',
      baseUrl: stubBaseUrl,
      enabled: true,
    })
    const conversationId = await startConversation(ownerCookie, provider.id)

    const intruder = await makeUser()
    const del = await app.request(url(`/conversations/${conversationId}/delete`), {
      method: 'POST',
      headers: { Cookie: sessionFor(intruder), Origin: origin },
      body: form({}),
    })
    expect(del.status).toBe(302)
    // Still there — the DELETE is scoped by user_id.
    expect(await getConversationById(conversationId)).not.toBeUndefined()
  })
})
