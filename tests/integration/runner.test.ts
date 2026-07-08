import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUIDv7 } from 'bun'

const { app } = await import('../../src/app')
const { createUser } = await import('../../src/db/queries/users')
const { createProvider } = await import('../../src/db/queries/providers')
const { createConversation, getConversationById, setConversationCurrNode } =
  await import('../../src/db/queries/conversations')
const { createMessage, getMessageById } = await import('../../src/db/queries/messages')
const { createRun, getRunById, getLatestRunForConversation } = await import(
  '../../src/db/queries/runs'
)
const { getActiveRunHandle, recoverInterruptedRuns, replayRunEvents, startRun } =
  await import('../../src/services/runner')
const { startMockProvider, mockContent } = await import(
  '../../src/tasks/mock-provider'
)
const { encryptSession } = await import('../../src/utils/private-session')

const origin = 'http://localhost:3000'

const mock = startMockProvider()
const mockBaseUrl = `http://localhost:${mock.port}`

afterAll(() => {
  mock.stop(true)
})

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
    name: 'Runner Test User',
    email: `runner-${suffix}@example.com`,
    emailNormalized: `runner-${suffix}@example.com`,
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

// Provider whose base_url routes to the mock in a given mode, e.g.
// "drip,tokens=30,interval=10" (see src/tasks/mock-provider.ts).
async function makeProvider(accountId: string, modeSegment: string) {
  return createProvider({
    accountId,
    name: `mock-${randomUUIDv7()}`,
    kind: 'openai-compat',
    baseUrl: `${mockBaseUrl}/${modeSegment}`,
    defaultModel: 'mock-model',
    enabled: true,
  })
}

async function setupConversation(modeSegment: string) {
  const user = await makeUser()
  const cookie = sessionFor(user)
  const provider = await makeProvider(user.id, modeSegment)
  const res = await app.request(url('/conversations'), {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin },
    body: form({ providerId: provider.id, model: 'mock-model' }),
  })
  expect(res.status).toBe(302)
  const conversationId = (res.headers.get('location') ?? '').slice('/conversations/'.length)
  return { user, cookie, provider, conversationId }
}

async function send(cookie: string, conversationId: string, content = 'hello') {
  const res = await app.request(url(`/conversations/${conversationId}/messages`), {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin },
    body: form({ content }),
  })
  expect(res.status).toBe(302)
}

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 10_000,
  stepMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await Bun.sleep(stepMs)
  }
}

async function assistantMessageFor(conversationId: string) {
  const conversation = await getConversationById(conversationId)
  if (!conversation?.curr_node) return null
  const message = await getMessageById(conversation.curr_node)
  return message?.role === 'assistant' ? message : null
}

interface SseEvent {
  seq: number
  type: string
  payload: Record<string, unknown>
}

// Read SSE events from a response body until the server closes the stream (it
// does after a terminal run-status) or `until` matches.
async function readSseEvents(
  res: Response,
  until?: (event: SseEvent) => boolean,
  timeoutMs = 10_000,
): Promise<SseEvent[]> {
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const events: SseEvent[] = []
  let buffer = ''
  const deadline = Date.now() + timeoutMs

  const parseBlock = (block: string): SseEvent | null => {
    let seq = -1
    let type = ''
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) seq = Number(line.slice(3).trim())
      else if (line.startsWith('event:')) type = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (!type || seq < 0) return null
    return { seq, type, payload: JSON.parse(data) }
  }

  try {
    for (;;) {
      if (Date.now() > deadline) throw new Error('SSE read timed out')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() ?? ''
      for (const block of blocks) {
        const event = parseBlock(block)
        if (!event) continue
        events.push(event)
        if (until?.(event)) return events
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return events
}

function deltaText(events: SseEvent[]) {
  return events
    .filter((e) => e.type === 'delta')
    .map((e) => String(e.payload['content'] ?? ''))
    .join('')
}

function expectContiguous(events: SseEvent[], firstSeq: number) {
  const seqs = events.map((e) => e.seq)
  expect(seqs).toEqual(seqs.map((_, i) => firstSeq + i))
}

const terminal = (e: SseEvent) =>
  e.type === 'run-status' && e.payload['status'] !== 'running'

describe('durable runner', () => {
  test('run completes with zero SSE subscribers (DB is the spectator)', async () => {
    const { cookie, conversationId } = await setupConversation('drip,tokens=12,interval=5')
    await send(cookie, conversationId)

    const run = await waitFor(async () => {
      const r = await getLatestRunForConversation(conversationId)
      return r && r.status !== 'running' ? r : null
    })
    expect(run.status).toBe('done')
    expect(Number(run.turn_count)).toBe(1)
    expect(run.error).toBeNull()

    const message = await assistantMessageFor(conversationId)
    expect(message?.status).toBe('complete')
    expect(message?.content).toBe(mockContent(12))
    expect(message?.model).toBe('mock-model')
    expect(message?.timings).not.toBeNull()
  }, 15_000)

  test('debounced persistence lands tokens mid-stream', async () => {
    const { cookie, conversationId } = await setupConversation(
      'drip,tokens=20,interval=20,reasoning=2',
    )
    await send(cookie, conversationId)

    // Read the row mid-drip: partial content persisted while still streaming.
    const partial = await waitFor(async () => {
      const message = await assistantMessageFor(conversationId)
      return message && message.status === 'streaming' && message.content.length > 0
        ? message
        : null
    })
    expect(partial.content.length).toBeLessThan(mockContent(20).length)
    expect(mockContent(20).startsWith(partial.content)).toBe(true)

    // While streaming, the show page SSRs the partial + stop button, and
    // sending again is refused.
    const show = await app.request(url(`/conversations/${conversationId}`), {
      headers: { Cookie: cookie },
    })
    const html = await show.text()
    expect(html).toContain('Stop generating')
    expect(html).toContain('data-active')
    const resend = await app.request(url(`/conversations/${conversationId}/messages`), {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin },
      body: form({ content: 'again' }),
    })
    expect(resend.status).toBe(200)
    expect(await resend.text()).toContain('already streaming')

    const run = await waitFor(async () => {
      const r = await getLatestRunForConversation(conversationId)
      return r && r.status !== 'running' ? r : null
    })
    expect(run.status).toBe('done')
    const message = await assistantMessageFor(conversationId)
    expect(message?.content).toBe(mockContent(20))
    expect(message?.reasoning_content).toBe('r0 r1 ')
  }, 15_000)

  test('SSE replay after completion, then replay from a cursor: no gaps, no dupes', async () => {
    const { cookie, conversationId } = await setupConversation('drip,tokens=20,interval=3')
    await send(cookie, conversationId)
    await waitFor(async () => {
      const r = await getLatestRunForConversation(conversationId)
      return r && r.status === 'done' ? r : null
    })

    const full = await readSseEvents(
      await app.request(url(`/conversations/${conversationId}/events`), {
        headers: { Cookie: cookie },
      }),
    )
    expectContiguous(full, 1)
    expect(full[0]?.type).toBe('message-start')
    expect(full.at(-1)?.type).toBe('run-status')
    expect(full.at(-1)?.payload['status']).toBe('done')
    expect(full.some((e) => e.type === 'message-final')).toBe(true)
    expect(deltaText(full)).toBe(mockContent(20))
    const finalHtml = String(
      full.find((e) => e.type === 'message-final')?.payload['html'],
    )
    expect(finalHtml).toContain('data-message-id')
    expect(finalHtml).toContain('t19')

    // Late joiner with Last-Event-ID resumes exactly after the cursor.
    const cursor = full[Math.floor(full.length / 2)]!.seq
    const resumed = await readSseEvents(
      await app.request(url(`/conversations/${conversationId}/events`), {
        headers: { Cookie: cookie, 'Last-Event-ID': String(cursor) },
      }),
    )
    expect(resumed).toEqual(full.filter((e) => e.seq > cursor))
  }, 15_000)

  test('SSE live tail stitches replay + live events without gaps or dupes', async () => {
    const { cookie, conversationId } = await setupConversation('drip,tokens=20,interval=10')
    await send(cookie, conversationId)

    // Join mid-run so some events replay from the DB and the rest arrive live.
    await waitFor(async () => {
      const message = await assistantMessageFor(conversationId)
      return message && message.content.length > 0 ? message : null
    })
    const events = await readSseEvents(
      await app.request(url(`/conversations/${conversationId}/events`), {
        headers: { Cookie: cookie },
      }),
      terminal,
    )
    expectContiguous(events, 1)
    expect(events[0]?.type).toBe('message-start')
    expect(events.at(-1)?.payload['status']).toBe('done')
    expect(deltaText(events)).toBe(mockContent(20))
  }, 15_000)

  test('cancel stops the run and keeps the partial', async () => {
    const { cookie, conversationId } = await setupConversation('hang,after=5,interval=5')
    await send(cookie, conversationId)

    // The 300ms debounce flushes the 5 pre-hang tokens even though the
    // provider then goes silent forever.
    await waitFor(async () => {
      const message = await assistantMessageFor(conversationId)
      return message && message.content === mockContent(5) ? message : null
    })

    const cancel = await app.request(url(`/conversations/${conversationId}/cancel`), {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin },
    })
    expect(cancel.status).toBe(302)

    const run = await waitFor(async () => {
      const r = await getLatestRunForConversation(conversationId)
      return r && r.status !== 'running' ? r : null
    })
    expect(run.status).toBe('cancelled')

    const message = await assistantMessageFor(conversationId)
    expect(message?.status).toBe('interrupted')
    expect(message?.content).toBe(mockContent(5))
  }, 15_000)

  test('provider failure mid-stream: partial kept, message interrupted, run error', async () => {
    const { cookie, conversationId } = await setupConversation('fail,after=4,interval=5')
    await send(cookie, conversationId)

    const run = await waitFor(async () => {
      const r = await getLatestRunForConversation(conversationId)
      return r && r.status !== 'running' ? r : null
    })
    expect(run.status).toBe('error')
    expect(run.error).toContain('stream ended unexpectedly')

    const message = await assistantMessageFor(conversationId)
    expect(message?.status).toBe('interrupted')
    expect(message?.content).toBe(mockContent(4))

    // The replayable event log ends with the error status.
    const events = await replayRunEvents(run.id, 0)
    expect(events.at(-1)?.type).toBe('run-status')
    expect((events.at(-1)?.payload as { status?: string }).status).toBe('error')
  }, 15_000)

  test('provider HTTP 500: run errors with the provider message, empty partial kept', async () => {
    const { cookie, conversationId } = await setupConversation('error500')
    await send(cookie, conversationId)

    const run = await waitFor(async () => {
      const r = await getLatestRunForConversation(conversationId)
      return r && r.status !== 'running' ? r : null
    })
    expect(run.status).toBe('error')
    expect(run.error).toContain('mock provider exploded')

    const message = await assistantMessageFor(conversationId)
    expect(message?.status).toBe('interrupted')
    expect(message?.content).toBe('')
  }, 15_000)

  // Regression (QA panel, races-and-cancel #3): a provider that streams K
  // tokens and then holds the connection open forever must not pin the run in
  // `running` (blocking the conversation's active-run slot) until a restart.
  // The stall watchdog must park it as a terminal provider error on its own,
  // keeping every persisted token. Uses startRun directly so the watchdog can
  // be shortened without mutating the process-wide env (tests run concurrently
  // and other tests rely on hang mode staying silent until they cancel).
  test('provider that hangs forever: stall watchdog parks the run as error, partial kept', async () => {
    const user = await makeUser()
    const provider = await makeProvider(user.id, 'hang,after=4,interval=5')
    const conversation = await createConversation({
      userId: user.id,
      providerId: provider.id,
      model: 'mock-model',
    })
    const userMessage = await createMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'hello',
    })
    await setConversationCurrNode({ id: conversation.id, currNode: userMessage.id })

    const { runId } = await startRun(conversation.id, { stallTimeoutMs: 400 })

    const run = await waitFor(async () => {
      const r = await getLatestRunForConversation(conversation.id)
      return r && r.status !== 'running' ? r : null
    })
    expect(run.status).toBe('error')
    expect(run.error).toContain('stopped responding')

    // Every token streamed before the silence is kept; message is sealed.
    const message = await assistantMessageFor(conversation.id)
    expect(message?.status).toBe('interrupted')
    expect(message?.content).toBe(mockContent(4))

    // The replayable event log ends with the terminal status.
    const events = await replayRunEvents(runId, 0)
    expect(events.at(-1)?.type).toBe('run-status')
    expect((events.at(-1)?.payload as { status?: string }).status).toBe('error')

    // The active-run slot is released, so the conversation can send again.
    expect(getActiveRunHandle(conversation.id)).toBeNull()
  }, 15_000)

  test('boot recovery finalizes orphaned streaming runs without losing or duplicating tokens', async () => {
    const user = await makeUser()
    const conversation = await createConversation({ userId: user.id })
    const userMessage = await createMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'crashed mid-reply',
    })
    const assistant = await createMessage({
      conversationId: conversation.id,
      parentId: userMessage.id,
      role: 'assistant',
      content: 'partial tokens ',
      status: 'streaming',
    })
    await setConversationCurrNode({ id: conversation.id, currNode: assistant.id })
    const run = await createRun({
      conversationId: conversation.id,
      leafMessageId: assistant.id,
    })

    const recovered = await recoverInterruptedRuns({ conversationId: conversation.id })
    expect(recovered).toBe(1)

    const message = await getMessageById(assistant.id)
    expect(message?.status).toBe('interrupted')
    expect(message?.content).toBe('partial tokens \n\n[interrupted by restart]')

    const parked = await getRunById(run.id)
    expect(parked?.status).toBe('error')
    expect(parked?.error).toBe('interrupted by server restart')

    // Recovery emits replayable events like a live run would.
    const events = await replayRunEvents(run.id, 0)
    expect(events.map((e) => e.type)).toEqual(['message-final', 'run-status'])
    const html = String((events[0]?.payload as { html?: string }).html)
    expect(html).toContain('[interrupted by restart]')

    // Idempotent: a second sweep finds nothing running and changes nothing.
    expect(await recoverInterruptedRuns({ conversationId: conversation.id })).toBe(0)
    const again = await getMessageById(assistant.id)
    expect(again?.content).toBe('partial tokens \n\n[interrupted by restart]')
  })
})
