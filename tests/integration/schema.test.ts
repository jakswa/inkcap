import { describe, expect, test } from 'bun:test'
import { randomUUIDv7 } from 'bun'

const { sql } = await import('../../src/db/client')
const { createUser } = await import('../../src/db/queries/users')
const { createProvider, getProviderById, listProvidersForUser, setProviderEnabled } =
  await import('../../src/db/queries/providers')
const {
  createConversation,
  getConversationById,
  listConversationsForUser,
  setConversationCurrNode,
} = await import('../../src/db/queries/conversations')
const { createMessage, getActivePath, listMessageChildren } = await import(
  '../../src/db/queries/messages'
)
const { createRun, getRunById, setRunStatus, incrementRunSeq, listRunningRuns } =
  await import('../../src/db/queries/runs')

// Bun.SQL query objects don't behave as plain promises under expect().rejects,
// so assert rejection with an explicit try/catch helper.
async function assertRejects(run: () => Promise<unknown>) {
  let threw = false
  try {
    await run()
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
}

async function makeUser() {
  const suffix = randomUUIDv7()
  return createUser({
    name: 'Schema Test User',
    email: `schema-${suffix}@example.com`,
    emailNormalized: `schema-${suffix}@example.com`,
    passwordHash: 'x',
  })
}

async function makeProvider(accountId: string) {
  return createProvider({
    accountId,
    name: `provider-${randomUUIDv7()}`,
    kind: 'llama-server',
    baseUrl: 'http://localhost:8001',
    apiKey: null,
    defaultModel: 'test-model',
  })
}

describe('providers', () => {
  test('create, get, list, and toggle enabled', async () => {
    const owner = await makeUser()
    const created = await makeProvider(owner.id)
    expect(created.enabled).toBe(true)
    expect(created.kind).toBe('llama-server')

    const fetched = await getProviderById(created.id)
    expect(fetched?.base_url).toBe('http://localhost:8001')

    const all = await listProvidersForUser(owner.id)
    expect(all.some((p) => p.id === created.id)).toBe(true)

    const toggled = await setProviderEnabled({ id: created.id, enabled: false })
    expect(toggled?.enabled).toBe(false)
  })

  test('rejects an unknown kind', async () => {
    await assertRejects(
      () => sql`
        INSERT INTO providers (id, name, kind, base_url)
        VALUES (${randomUUIDv7()}, 'bad', 'not-a-kind', 'http://x')
      `,
    )
  })
})

describe('conversations', () => {
  test('create, list-for-user, and default fields', async () => {
    const user = await makeUser()
    const provider = await makeProvider(user.id)

    const convo = await createConversation({
      userId: user.id,
      title: 'Hello',
      providerId: provider.id,
      model: 'test-model',
    })

    expect(convo.pinned).toBe(false)
    expect(convo.curr_node).toBeNull()

    const fetched = await getConversationById(convo.id)
    expect(fetched?.title).toBe('Hello')

    const list = await listConversationsForUser(user.id)
    expect(list.map((c) => c.id)).toContain(convo.id)
    // Other users' conversations must not leak in.
    expect(list.every((c) => c.user_id === user.id)).toBe(true)
  })

  test('deleting a provider keeps the conversation (SET NULL)', async () => {
    const user = await makeUser()
    const provider = await makeProvider(user.id)
    const convo = await createConversation({
      userId: user.id,
      providerId: provider.id,
    })

    await sql`DELETE FROM providers WHERE id = ${provider.id}`

    const fetched = await getConversationById(convo.id)
    expect(fetched).toBeDefined()
    expect(fetched?.provider_id).toBeNull()
  })
})

describe('messages tree', () => {
  // Build: root -> (branchA, branchB); branchA -> leafA
  async function buildTree(userId: string) {
    const convo = await createConversation({ userId })
    const root = await createMessage({
      conversationId: convo.id,
      role: 'user',
      content: 'root',
    })
    const branchA = await createMessage({
      conversationId: convo.id,
      parentId: root.id,
      role: 'assistant',
      content: 'branchA',
    })
    const branchB = await createMessage({
      conversationId: convo.id,
      parentId: root.id,
      role: 'assistant',
      content: 'branchB',
    })
    const leafA = await createMessage({
      conversationId: convo.id,
      parentId: branchA.id,
      role: 'user',
      content: 'leafA',
    })
    return { convo, root, branchA, branchB, leafA }
  }

  test('children are derived from parent_id', async () => {
    const user = await makeUser()
    const { root, branchA, branchB } = await buildTree(user.id)

    const children = await listMessageChildren(root.id)
    const ids = children.map((c) => c.id)
    expect(ids).toContain(branchA.id)
    expect(ids).toContain(branchB.id)
    expect(ids).toHaveLength(2)
  })

  test('active-path CTE returns the linear path root->leaf for a curr_node', async () => {
    const user = await makeUser()
    const { convo, root, branchA, branchB, leafA } = await buildTree(user.id)

    await setConversationCurrNode({ id: convo.id, currNode: leafA.id })
    const refreshed = await getConversationById(convo.id)
    expect(refreshed?.curr_node).toBe(leafA.id)

    const path = await getActivePath(leafA.id)
    // root-first order, only the active branch (A), never branch B.
    expect(path.map((m) => m.content)).toEqual(['root', 'branchA', 'leafA'])
    expect(path.map((m) => m.id)).toEqual([root.id, branchA.id, leafA.id])
    expect(path.map((m) => m.id)).not.toContain(branchB.id)
  })

  test('rejects an unknown role', async () => {
    const user = await makeUser()
    const convo = await createConversation({ userId: user.id })
    await assertRejects(
      () => sql`
        INSERT INTO messages (id, conversation_id, role, content)
        VALUES (${randomUUIDv7()}, ${convo.id}, 'wizard', 'hi')
      `,
    )
  })
})

describe('runs', () => {
  test('status transitions and error text', async () => {
    const user = await makeUser()
    const convo = await createConversation({ userId: user.id })
    const run = await createRun({ conversationId: convo.id, budget: { turns: 5 } })
    expect(run.status).toBe('running')
    expect(run.seq).toBe('0')

    const waiting = await setRunStatus({ id: run.id, status: 'waiting_approval' })
    expect(waiting?.status).toBe('waiting_approval')

    const errored = await setRunStatus({
      id: run.id,
      status: 'error',
      error: 'boom',
    })
    expect(errored?.status).toBe('error')
    expect(errored?.error).toBe('boom')

    const fetched = await getRunById(run.id)
    expect(fetched?.status).toBe('error')
  })

  test('increment seq bumps the cursor', async () => {
    const user = await makeUser()
    const convo = await createConversation({ userId: user.id })
    const run = await createRun({ conversationId: convo.id })

    const first = await incrementRunSeq(run.id)
    const second = await incrementRunSeq(run.id)
    expect(Number(first?.seq)).toBe(1)
    expect(Number(second?.seq)).toBe(2)
  })

  test('only one non-terminal run is allowed per conversation', async () => {
    const user = await makeUser()
    const convo = await createConversation({ userId: user.id })
    const running = await createRun({ conversationId: convo.id })
    await assertRejects(() => createRun({ conversationId: convo.id }))
    await assertRejects(() =>
      createRun({ conversationId: convo.id, status: 'waiting_approval' }),
    )

    await setRunStatus({ id: running.id, status: 'done' })
    const waiting = await createRun({
      conversationId: convo.id,
      status: 'waiting_approval',
    })
    await assertRejects(() => createRun({ conversationId: convo.id }))
    await setRunStatus({ id: waiting.id, status: 'cancelled' })
  })

  test('running partial index query only returns running runs', async () => {
    const user = await makeUser()
    const convo = await createConversation({ userId: user.id })
    const running = await createRun({ conversationId: convo.id })
    await setRunStatus({ id: running.id, status: 'done' })
    const done = await createRun({ conversationId: convo.id })
    await setRunStatus({ id: done.id, status: 'done' })
    const nextRunning = await createRun({ conversationId: convo.id })

    const runningList = await listRunningRuns()
    const ids = runningList.map((r) => r.id)
    expect(ids).toContain(nextRunning.id)
    expect(ids).not.toContain(running.id)
    expect(ids).not.toContain(done.id)
    expect(runningList.every((r) => r.status === 'running')).toBe(true)
  })

  test('deleting a conversation cascades messages and runs', async () => {
    const user = await makeUser()
    const convo = await createConversation({ userId: user.id })
    const msg = await createMessage({
      conversationId: convo.id,
      role: 'user',
      content: 'x',
    })
    const run = await createRun({ conversationId: convo.id, leafMessageId: msg.id })

    await sql`DELETE FROM conversations WHERE id = ${convo.id}`

    const [msgLeft] = await sql`SELECT 1 FROM messages WHERE id = ${msg.id}`
    const [runLeft] = await sql`SELECT 1 FROM runs WHERE id = ${run.id}`
    expect(msgLeft).toBeUndefined()
    expect(runLeft).toBeUndefined()
  })
})

describe('attachments', () => {
  test('store and read bytea, cascade on message delete', async () => {
    const user = await makeUser()
    const convo = await createConversation({ userId: user.id })
    const msg = await createMessage({
      conversationId: convo.id,
      role: 'user',
      content: 'has attachment',
    })

    const id = randomUUIDv7()
    const payload = Buffer.from('hello bytes')
    await sql`
      INSERT INTO attachments (id, message_id, kind, name, mime, bytes)
      VALUES (${id}, ${msg.id}, 'text', 'note.txt', 'text/plain', ${payload})
    `

    const [row] = await sql`SELECT kind, bytes FROM attachments WHERE id = ${id}`
    expect(row?.kind).toBe('text')
    expect(Buffer.from(row!.bytes).toString()).toBe('hello bytes')

    await sql`DELETE FROM messages WHERE id = ${msg.id}`
    const [left] = await sql`SELECT 1 FROM attachments WHERE id = ${id}`
    expect(left).toBeUndefined()
  })
})
