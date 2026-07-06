import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUIDv7 } from 'bun'

const { app } = await import('../../src/app')
const { sql } = await import('../../src/db/client')
const { createUser } = await import('../../src/db/queries/users')
const { createProvider } = await import('../../src/db/queries/providers')
const {
  createConversation,
  getConversationById,
  setConversationCurrNode,
} = await import('../../src/db/queries/conversations')
const { createMessage, getActivePath, getMessageById, listSiblings } =
  await import('../../src/db/queries/messages')
const { getLatestRunForConversation } = await import('../../src/db/queries/runs')
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
    name: 'Branch Test User',
    email: `branch-${suffix}@example.com`,
    emailNormalized: `branch-${suffix}@example.com`,
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

// Fast stub: streams one fixed reply and finishes, so a run reaches `done`.
const stubReply = 'Fixed stub reply.'
const stub = Bun.serve({
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname === '/v1/chat/completions') {
      await req.json()
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

// Hanging stub: emits one delta then holds the stream open, so a run stays
// `running` (active-run handle present) long enough to test the branch guard.
const hangingStub = Bun.serve({
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname === '/v1/chat/completions') {
      await req.json()
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ model: 'stub-model', choices: [{ delta: { content: 'thinking…' } }] })}\n\n`,
            ),
          )
          // Never close — the run remains active until cancelled/stalled.
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    return new Response('not found', { status: 404 })
  },
})
const hangingBaseUrl = `http://localhost:${hangingStub.port}`

afterAll(() => {
  stub.stop(true)
  hangingStub.stop(true)
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

async function waitForRunSettled(conversationId: string) {
  return waitFor(async () => {
    const run = await getLatestRunForConversation(conversationId)
    return run && run.status !== 'running' ? run : null
  })
}

async function makeProvider(baseUrl = stubBaseUrl) {
  return createProvider({
    name: `branch-stub-${randomUUIDv7()}`,
    kind: 'openai-compat',
    baseUrl,
    defaultModel: 'stub-model',
    enabled: true,
  })
}

// Build a conversation owned by a fresh user, returning everything a test needs.
async function setup(baseUrl = stubBaseUrl) {
  const user = await makeUser()
  const cookie = sessionFor(user)
  const provider = await makeProvider(baseUrl)
  const conversation = await createConversation({
    userId: user.id,
    title: 'branch',
    providerId: provider.id,
    model: 'stub-model',
  })
  return { user, cookie, provider, conversationId: conversation.id }
}

// Insert a message directly (tree scaffolding for switch/delete tests). A short
// sleep guarantees strictly increasing created_at so sibling / last-child
// ordering is deterministic.
async function addMessage(
  conversationId: string,
  parentId: string | null,
  role: 'system' | 'user' | 'assistant' | 'tool',
  content: string,
) {
  const message = await createMessage({ conversationId, parentId, role, content })
  await Bun.sleep(3)
  return message
}

function post(path: string, cookie: string, body: Record<string, string> = {}) {
  return app.request(url(path), {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin },
    body: form(body),
  })
}

describe('branching UI (M7)', () => {
  test('editing a user message with responses forks a new sibling and regenerates', async () => {
    const { cookie, conversationId } = await setup()

    // Seed the first turn through the real send path so the user message has an
    // assistant reply downstream (the "has children" branch of the edit rule).
    const send = await post(`/conversations/${conversationId}/messages`, cookie, {
      content: 'original question',
    })
    expect(send.status).toBe(302)
    await waitForRunSettled(conversationId)

    const before = await getConversationById(conversationId)
    const beforePath = await getActivePath(before!.curr_node!)
    expect(beforePath.map((m) => m.role)).toEqual(['user', 'assistant'])
    const originalUser = beforePath[0]!
    const originalAssistant = beforePath[1]!

    // Edit the user message → new sibling (old branch preserved) + fresh run.
    const edit = await post(
      `/conversations/${conversationId}/messages/${originalUser.id}/edit`,
      cookie,
      { content: 'edited question' },
    )
    expect(edit.status).toBe(302)
    await waitForRunSettled(conversationId)

    // curr_node moved to a NEW user message (different id, edited content).
    const after = await getConversationById(conversationId)
    const afterPath = await getActivePath(after!.curr_node!)
    expect(afterPath.map((m) => m.role)).toEqual(['user', 'assistant'])
    const newUser = afterPath[0]!
    expect(newUser.id).not.toBe(originalUser.id)
    expect(newUser.content).toBe('edited question')
    expect(newUser.parent_id).toBe(originalUser.parent_id)

    // The user message now has two sibling branches; the original survives.
    const siblings = await listSiblings({
      conversationId,
      parentId: originalUser.parent_id,
    })
    expect(siblings.length).toBe(2)
    expect(siblings.map((s) => s.id).sort()).toEqual(
      [originalUser.id!, newUser.id!].sort(),
    )
    // Original assistant reply is untouched, off the active path.
    const stillThere = await getMessageById(originalAssistant.id!)
    expect(stillThere?.content).toBe(stubReply)
  })

  test('editing a user message with no responses updates it in place (no new sibling)', async () => {
    const { conversationId, cookie } = await setup()
    // A lone user message (no run yet → no children).
    const userMsg = await addMessage(conversationId, null, 'user', 'draft text')
    await setConversationCurrNode({ id: conversationId, currNode: userMsg.id })

    const edit = await post(
      `/conversations/${conversationId}/messages/${userMsg.id}/edit`,
      cookie,
      { content: 'corrected text' },
    )
    expect(edit.status).toBe(302)
    await waitForRunSettled(conversationId)

    // Same message id, content overwritten (edited in place, no sibling made).
    const same = await getMessageById(userMsg.id)
    expect(same?.id).toBe(userMsg.id)
    expect(same?.content).toBe('corrected text')
    const siblings = await listSiblings({ conversationId, parentId: null })
    expect(siblings.length).toBe(1)
  })

  test('regenerating an assistant message opens a new sibling assistant slot', async () => {
    const { conversationId, cookie } = await setup()
    const send = await post(`/conversations/${conversationId}/messages`, cookie, {
      content: 'hi',
    })
    expect(send.status).toBe(302)
    await waitForRunSettled(conversationId)

    const before = await getConversationById(conversationId)
    const beforePath = await getActivePath(before!.curr_node!)
    const userMsg = beforePath[0]!
    const firstAssistant = beforePath[1]!

    const regen = await post(
      `/conversations/${conversationId}/messages/${firstAssistant.id}/regenerate`,
      cookie,
    )
    expect(regen.status).toBe(302)
    await waitForRunSettled(conversationId)

    const after = await getConversationById(conversationId)
    const afterPath = await getActivePath(after!.curr_node!)
    expect(afterPath.map((m) => m.role)).toEqual(['user', 'assistant'])
    const newAssistant = afterPath[1]!
    // Same parent user turn, different assistant id — a sibling reply.
    expect(newAssistant.id).not.toBe(firstAssistant.id)
    expect(newAssistant.parent_id).toBe(userMsg.id)

    const assistantSiblings = await listSiblings({
      conversationId,
      parentId: userMsg.id,
    })
    expect(assistantSiblings.length).toBe(2)
    // The original reply is preserved off-path.
    expect(await getMessageById(firstAssistant.id!)).not.toBeNull()
  })

  test('switching to a sibling lands on its deepest most-recent descendant', async () => {
    const { conversationId, cookie } = await setup()
    // user1 ─┬─ asstA            (active)
    //        └─ asstB ─┬─ user2a
    //                  └─ user2b ── asst3   (newest branch under asstB)
    const user1 = await addMessage(conversationId, null, 'user', 'q1')
    const asstA = await addMessage(conversationId, user1.id, 'assistant', 'A')
    const asstB = await addMessage(conversationId, user1.id, 'assistant', 'B')
    await addMessage(conversationId, asstB.id, 'user', 'follow-a')
    const user2b = await addMessage(conversationId, asstB.id, 'user', 'follow-b')
    const asst3 = await addMessage(conversationId, user2b.id, 'assistant', 'deep')
    await setConversationCurrNode({ id: conversationId, currNode: asstA.id })

    const res = await post(`/conversations/${conversationId}/switch`, cookie, {
      target: asstB.id,
    })
    expect(res.status).toBe(302)

    // findLeafByLastChild(asstB): asstB → user2b (newest) → asst3 (leaf).
    const after = await getConversationById(conversationId)
    expect(after?.curr_node).toBe(asst3.id)
  })

  test('deleting a message removes its subtree and moves off it to a sibling leaf', async () => {
    const { conversationId, cookie } = await setup()
    // user1 ─┬─ asstA ── user2 ── asst2   (active path, to be deleted)
    //        └─ asstB ── user2b ── asst2b (newest sibling → reposition target)
    const user1 = await addMessage(conversationId, null, 'user', 'q')
    const asstA = await addMessage(conversationId, user1.id, 'assistant', 'A')
    const user2 = await addMessage(conversationId, asstA.id, 'user', 'more')
    const asst2 = await addMessage(conversationId, user2.id, 'assistant', 'A2')
    const asstB = await addMessage(conversationId, user1.id, 'assistant', 'B')
    const user2b = await addMessage(conversationId, asstB.id, 'user', 'more-b')
    const asst2b = await addMessage(conversationId, user2b.id, 'assistant', 'B2')
    await setConversationCurrNode({ id: conversationId, currNode: asst2.id })

    const res = await post(
      `/conversations/${conversationId}/messages/${asstA.id}/delete`,
      cookie,
    )
    expect(res.status).toBe(302)

    // The whole asstA subtree is gone.
    expect(await getMessageById(asstA.id)).toBeUndefined()
    expect(await getMessageById(user2.id)).toBeUndefined()
    expect(await getMessageById(asst2.id)).toBeUndefined()
    // Repositioned to the newest remaining sibling's deepest leaf.
    const after = await getConversationById(conversationId)
    expect(after?.curr_node).toBe(asst2b.id)
    // Untouched branch survives.
    expect(await getMessageById(asstB.id)).not.toBeUndefined()
  })

  test('deleting an only child collapses curr_node to the parent leaf', async () => {
    const { conversationId, cookie } = await setup()
    const user1 = await addMessage(conversationId, null, 'user', 'q')
    const asst1 = await addMessage(conversationId, user1.id, 'assistant', 'a1')
    const user2 = await addMessage(conversationId, asst1.id, 'user', 'q2')
    const asst2 = await addMessage(conversationId, user2.id, 'assistant', 'a2')
    await setConversationCurrNode({ id: conversationId, currNode: asst2.id })

    const res = await post(
      `/conversations/${conversationId}/messages/${user2.id}/delete`,
      cookie,
    )
    expect(res.status).toBe(302)

    expect(await getMessageById(user2.id)).toBeUndefined()
    expect(await getMessageById(asst2.id)).toBeUndefined()
    // asst1 has no children now → it becomes the active leaf.
    const after = await getConversationById(conversationId)
    expect(after?.curr_node).toBe(asst1.id)
  })

  test('deleting a message off the active path leaves curr_node untouched', async () => {
    const { conversationId, cookie } = await setup()
    const user1 = await addMessage(conversationId, null, 'user', 'q')
    const asstA = await addMessage(conversationId, user1.id, 'assistant', 'A')
    const asstB = await addMessage(conversationId, user1.id, 'assistant', 'B')
    await setConversationCurrNode({ id: conversationId, currNode: asstA.id })

    const res = await post(
      `/conversations/${conversationId}/messages/${asstB.id}/delete`,
      cookie,
    )
    expect(res.status).toBe(302)

    const after = await getConversationById(conversationId)
    expect(after?.curr_node).toBe(asstA.id) // unchanged
    expect(await getMessageById(asstB.id)).toBeUndefined()
  })

  test('fork copies exactly the active path into a new conversation', async () => {
    const { conversationId, cookie } = await setup()
    // Active path user1 → asstB, with asstA an off-path sibling that must NOT
    // be copied into the fork.
    const user1 = await addMessage(conversationId, null, 'user', 'question')
    await addMessage(conversationId, user1.id, 'assistant', 'off-path reply')
    const asstB = await addMessage(conversationId, user1.id, 'assistant', 'on-path reply')
    await setConversationCurrNode({ id: conversationId, currNode: asstB.id })

    const res = await post(`/conversations/${conversationId}/fork`, cookie)
    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    expect(location).toStartWith('/conversations/')
    const forkId = location.slice('/conversations/'.length)
    expect(forkId).not.toBe(conversationId)

    const fork = await getConversationById(forkId)
    expect(fork?.forked_from_conversation_id).toBe(conversationId)

    // The fork's active path mirrors the source active path, content-for-content.
    const forkPath = await getActivePath(fork!.curr_node!)
    expect(forkPath.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(forkPath.map((m) => m.content)).toEqual(['question', 'on-path reply'])
    // New rows, not shared with the source.
    expect(forkPath[0]!.id).not.toBe(user1.id)
    expect(forkPath[1]!.id).not.toBe(asstB.id)

    // Exactly the active path was copied — the off-path sibling was excluded.
    const [{ count }] = await sql`
      SELECT count(*)::int AS count FROM messages WHERE conversation_id = ${forkId}
    `
    expect(count).toBe(2)

    // The source conversation is untouched (still 3 messages).
    const [{ count: srcCount }] = await sql`
      SELECT count(*)::int AS count FROM messages WHERE conversation_id = ${conversationId}
    `
    expect(srcCount).toBe(3)
  })

  test('editing while a run is streaming shows a friendly error and does not branch', async () => {
    const { conversationId, cookie } = await setup(hangingBaseUrl)
    const userMsg = await addMessage(conversationId, null, 'user', 'kickoff')
    await setConversationCurrNode({ id: conversationId, currNode: userMsg.id })

    // Start a run that will stay active (hanging stub).
    const send = await post(`/conversations/${conversationId}/messages`, cookie, {
      content: 'go',
    })
    expect(send.status).toBe(302)

    // Attempt to edit while the run is active → friendly SSR error, no branch.
    const edit = await post(
      `/conversations/${conversationId}/messages/${userMsg.id}/edit`,
      cookie,
      { content: 'sneaky edit' },
    )
    expect(edit.status).toBe(200)
    const html = await edit.text()
    expect(html.toLowerCase()).toContain('streaming')

    // Clean up: stop the run.
    await post(`/conversations/${conversationId}/cancel`, cookie)
    await waitForRunSettled(conversationId)
  })
})
