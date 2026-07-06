import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUIDv7 } from 'bun'

const { app } = await import('../../src/app')
const { createUser } = await import('../../src/db/queries/users')
const { createProvider } = await import('../../src/db/queries/providers')
const { createConversation, getConversationById, setConversationCurrNode } =
  await import('../../src/db/queries/conversations')
const { createMessage, getActivePath, getMessageById } = await import(
  '../../src/db/queries/messages'
)
const { createRun, getLatestRunForConversation, getRunById } = await import(
  '../../src/db/queries/runs'
)
const { createMcpServer, setConversationMcpOverride } = await import(
  '../../src/db/queries/mcp-servers'
)
const { createToolApproval, listApprovalsForRun } = await import(
  '../../src/db/queries/tool-approvals'
)
const {
  recoverInterruptedRuns,
  replayRunEvents,
  resumeParkedRun,
  startRun,
} = await import('../../src/services/runner')
const { startMockProvider, mockContent } = await import(
  '../../src/tasks/mock-provider'
)
const { startStubMcpServer } = await import('../helpers/mcp-stub')
const { encryptSession } = await import('../../src/utils/private-session')

const origin = 'http://localhost:3000'
const mock = startMockProvider()
const mockBaseUrl = `http://localhost:${mock.port}`

afterAll(() => {
  mock.stop(true)
})

async function makeUser() {
  const suffix = randomUUIDv7()
  return createUser({
    name: 'MCP Test User',
    email: `mcp-${suffix}@example.com`,
    emailNormalized: `mcp-${suffix}@example.com`,
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

// A conversation wired to the mock provider (in `modeSegment`) plus one MCP
// server (its own stub) enabled for the conversation.
async function setupToolConversation(
  modeSegment: string,
  options: { autoApprove?: boolean } = {},
) {
  const user = await makeUser()
  const provider = await makeProvider(user.id, modeSegment)
  const stub = startStubMcpServer()
  const conversation = await createConversation({
    userId: user.id,
    providerId: provider.id,
    model: 'mock-model',
  })
  const server = await createMcpServer({
    accountId: user.id,
    name: `stub-${randomUUIDv7()}`,
    url: stub.url,
    autoApprove: options.autoApprove ?? false,
    requestTimeoutMs: 5000,
    enabled: true,
  })
  await setConversationMcpOverride({
    conversationId: conversation.id,
    mcpServerId: server.id,
    enabled: true,
  })
  const userMessage = await createMessage({
    conversationId: conversation.id,
    role: 'user',
    content: 'call the tool',
  })
  await setConversationCurrNode({ id: conversation.id, currNode: userMessage.id })

  return { user, provider, stub, conversation, server }
}

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 10_000,
  stepMs = 20,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await Bun.sleep(stepMs)
  }
}

const runReaches = (conversationId: string, status: string) => async () => {
  const run = await getLatestRunForConversation(conversationId)
  return run && run.status === status ? run : null
}

// The linear active path (root-first) as {role, content} for assertions.
async function activePath(conversationId: string) {
  const conversation = await getConversationById(conversationId)
  if (!conversation?.curr_node) return []
  const rows = (await getActivePath(conversation.curr_node)) as Array<{
    role: string | null
    content: string | null
    status: string | null
    tool_calls: unknown
    tool_call_id: string | null
  }>
  return rows
}

describe('M6 MCP tool loop', () => {
  test('approve path: park → approve → execute tool → final answer', async () => {
    const { conversation, stub } = await setupToolConversation('tools,tokens=5')
    try {
      await startRun(conversation.id, { stallTimeoutMs: 3000 })

      // The tool-call turn seals and the run parks awaiting approval.
      const parked = await waitFor(runReaches(conversation.id, 'waiting_approval'))
      const approvals = await listApprovalsForRun(parked.id)
      expect(approvals).toHaveLength(1)
      expect(approvals[0]?.tool_name).toBe('echo')
      expect(approvals[0]?.decision).toBe('pending')

      // The sealed assistant message carries the tool_calls.
      const path1 = await activePath(conversation.id)
      const sealed = path1.at(-1)
      expect(sealed?.role).toBe('assistant')
      expect(sealed?.status).toBe('complete')
      expect(Array.isArray(sealed?.tool_calls)).toBe(true)

      // A run-status waiting_approval event was emitted for the island.
      const events = await replayRunEvents(parked.id, 0)
      expect(
        events.some(
          (e) =>
            e.type === 'run-status' &&
            (e.payload as { status?: string }).status === 'waiting_approval',
        ),
      ).toBe(true)

      // Approve → tool executes and the loop finishes with a final answer.
      await resumeParkedRun(conversation.id, 'approve', { stallTimeoutMs: 3000 })
      await waitFor(runReaches(conversation.id, 'done'))

      expect(stub.calls).toHaveLength(1)
      expect(stub.calls[0]?.name).toBe('echo')

      const path2 = await activePath(conversation.id)
      const roles = path2.map((m) => m.role)
      expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant'])
      const toolMessage = path2[2]
      expect(toolMessage?.tool_call_id).toBe(approvals[0]?.tool_call_id)
      expect(toolMessage?.content).toContain('echo:')
      expect(path2.at(-1)?.content).toBe(mockContent(5))
      expect(path2.at(-1)?.status).toBe('complete')
    } finally {
      stub.stop()
    }
  }, 20_000)

  test('deny path: denial tool message, tool never runs, loop continues', async () => {
    const { conversation, stub } = await setupToolConversation('tools,tokens=3')
    try {
      await startRun(conversation.id, { stallTimeoutMs: 3000 })
      await waitFor(runReaches(conversation.id, 'waiting_approval'))

      await resumeParkedRun(conversation.id, 'deny', { stallTimeoutMs: 3000 })
      await waitFor(runReaches(conversation.id, 'done'))

      // The tool was never actually invoked.
      expect(stub.calls).toHaveLength(0)

      const path = await activePath(conversation.id)
      expect(path.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
      expect(path[2]?.content).toBe('Tool execution was denied by the user.')
      expect(path.at(-1)?.content).toBe(mockContent(3))
    } finally {
      stub.stop()
    }
  }, 20_000)

  test('auto-approve: no park, tool runs inline to a final answer', async () => {
    const { conversation, stub } = await setupToolConversation('tools,tokens=4', {
      autoApprove: true,
    })
    try {
      const { runId } = await startRun(conversation.id, { stallTimeoutMs: 3000 })
      const run = await waitFor(runReaches(conversation.id, 'done'))
      expect(run.id).toBe(runId)

      expect(stub.calls).toHaveLength(1)
      const path = await activePath(conversation.id)
      expect(path.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
      expect(path[2]?.content).toContain('echo:')
      expect(path.at(-1)?.content).toBe(mockContent(4))

      // Two provider turns ran (tool-call turn + final turn); it never parked.
      expect(Number(run.turn_count)).toBe(2)
    } finally {
      stub.stop()
    }
  }, 20_000)

  test('turn budget: a tool that never stops parks the run with a budget marker', async () => {
    const { conversation, stub } = await setupToolConversation('toolloop', {
      autoApprove: true,
    })
    try {
      await startRun(conversation.id, { stallTimeoutMs: 3000, maxTurns: 2 })
      const run = await waitFor(runReaches(conversation.id, 'error'))
      expect(run.error).toContain('budget')

      // Budget checked after the 2nd tool-call turn seals: only the 1st turn's
      // tool executed before the run parked.
      expect(stub.calls).toHaveLength(1)
      expect(Number(run.turn_count)).toBe(2)
    } finally {
      stub.stop()
    }
  }, 20_000)

  test('waiting_approval survives a simulated restart (recovery leaves it alone)', async () => {
    const user = await makeUser()
    const conversation = await createConversation({ userId: user.id })
    const userMessage = await createMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'call the tool',
    })
    const assistant = await createMessage({
      conversationId: conversation.id,
      parentId: userMessage.id,
      role: 'assistant',
      content: '',
      status: 'complete',
      toolCalls: [
        { id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{}' } },
      ],
    })
    await setConversationCurrNode({ id: conversation.id, currNode: assistant.id })
    const run = await createRun({
      conversationId: conversation.id,
      status: 'waiting_approval',
      leafMessageId: assistant.id,
    })
    await createToolApproval({
      runId: run.id,
      messageId: assistant.id,
      toolCallId: 'call_1',
      toolName: 'echo',
      arguments: '{}',
    })

    // Boot recovery must NOT touch a parked run: it only sweeps `running` rows.
    const recovered = await recoverInterruptedRuns({ conversationId: conversation.id })
    expect(recovered).toBe(0)

    const parked = await getRunById(run.id)
    expect(parked?.status).toBe('waiting_approval')

    const message = await getMessageById(assistant.id)
    expect(message?.status).toBe('complete')

    const approvals = await listApprovalsForRun(run.id)
    expect(approvals).toHaveLength(1)
    expect(approvals[0]?.decision).toBe('pending')
  })

  test('POST /approvals resumes a parked run through the HTTP route', async () => {
    const { user, conversation, stub } = await setupToolConversation('tools,tokens=2')
    try {
      const cookie = sessionFor(user)
      await startRun(conversation.id, { stallTimeoutMs: 3000 })
      await waitFor(runReaches(conversation.id, 'waiting_approval'))

      // The show page renders the approval card.
      const show = await app.request(`${origin}/conversations/${conversation.id}`, {
        headers: { Cookie: cookie },
      })
      const html = await show.text()
      expect(html).toContain('Waiting for approval')
      expect(html).toContain('echo')

      const body = new FormData()
      body.set('decision', 'approve')
      const res = await app.request(
        `${origin}/conversations/${conversation.id}/approvals`,
        { method: 'POST', headers: { Cookie: cookie, Origin: origin }, body },
      )
      expect(res.status).toBe(302)

      await waitFor(runReaches(conversation.id, 'done'))
      expect(stub.calls).toHaveLength(1)
    } finally {
      stub.stop()
    }
  }, 20_000)
})
