import { Hono } from 'hono'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  createConversation,
  deleteConversation,
  getConversationById,
  listConversationsForUser,
  setConversationCurrNode,
} from '../db/queries/conversations'
import { getProviderById, listProviders } from '../db/queries/providers'
import { createMessage, getActivePath } from '../db/queries/messages'
import {
  getLatestRunForConversation,
  getRunningRunForConversation,
} from '../db/queries/runs'
import {
  cancelRun,
  getActiveRunHandle,
  isTerminalRunStatus,
  replayRunEvents,
  startRun,
  subscribeToRun,
  type RunEventRecord,
} from '../services/runner'
import { readString } from '../utils/validation'
import { toRenderable } from '../utils/message-view'
import { relativeTime } from '../utils/relative-time'

export const conversationRoutes = new Hono()

const maxTitleLength = 200
const maxModelLength = 200

// Rows returned by getActivePath are typed all-nullable (recursive CTE), so we
// narrow to the shape the transcript needs.
type PathMessage = {
  id: string | null
  role: string | null
  content: string | null
  reasoning_content: string | null
  model: string | null
  status: string | null
  created_at: Date | null
}

function requireUser(c: Context) {
  return c.var.user
}

// Load a conversation the current user owns, or null. Ownership is enforced so
// one user cannot read or post into another's conversation.
async function loadOwnedConversation(userId: string, id: string) {
  const conversation = await getConversationById(id)
  if (!conversation || conversation.user_id !== userId) return null
  return conversation
}

async function renderShow(
  c: Context,
  conversation: NonNullable<Awaited<ReturnType<typeof getConversationById>>>,
  options: { error?: string; draft?: string } = {},
) {
  const [provider, activeRun, sidebar] = await Promise.all([
    conversation.provider_id
      ? getProviderById(conversation.provider_id)
      : Promise.resolve(null),
    getRunningRunForConversation(conversation.id),
    listConversationsForUser(conversation.user_id),
  ])

  const path = conversation.curr_node
    ? ((await getActivePath(conversation.curr_node)) as PathMessage[])
    : []

  c.header('Cache-Control', 'private, no-store')
  return c.var.render('conversations/show', {
    title: conversation.title || 'untitled',
    conversation,
    provider,
    // Settled messages carry rendered-markdown HTML; the streaming leaf keeps
    // plain text for the island's live tail (contentHtml === null).
    messages: path.map((message) => toRenderable(message)),
    sidebar: sidebar.map((row) => ({
      id: row.id,
      title: row.title,
      updatedLabel: relativeTime(row.updated_at),
      current: row.id === conversation.id,
    })),
    activeRun: activeRun ?? null,
    error: options.error ?? null,
    draft: options.draft ?? '',
  })
}

// GET /conversations — list + new-conversation form.
conversationRoutes.get('/conversations', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')

  const [conversations, providers] = await Promise.all([
    listConversationsForUser(user.id),
    listProviders(),
  ])
  const enabledProviders = providers.filter((p) => p.enabled)
  const providerNames = Object.fromEntries(providers.map((p) => [p.id, p.name]))

  c.header('Cache-Control', 'private, no-store')
  return c.var.render('conversations/list', {
    title: 'Conversations',
    conversations: conversations.map((row) => ({
      ...row,
      updatedLabel: relativeTime(row.updated_at),
    })),
    providerNames,
    providers: enabledProviders,
    errors: [],
    values: {},
  })
})

// POST /conversations — create a conversation and redirect to it.
conversationRoutes.post('/conversations', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')

  const form = await c.req.formData()
  const providerId = readString(form, 'providerId').trim()
  const title = readString(form, 'title').trim()
  const model = readString(form, 'model').trim()
  const systemPrompt = readString(form, 'systemPrompt')

  const providers = await listProviders()
  const enabledProviders = providers.filter((p) => p.enabled)

  const errors: string[] = []
  const provider = enabledProviders.find((p) => p.id === providerId) ?? null
  if (!provider) errors.push('Choose an enabled provider')
  if (title.length > maxTitleLength) {
    errors.push(`Title must be ${maxTitleLength} characters or fewer`)
  }
  if (model.length > maxModelLength) {
    errors.push(`Model must be ${maxModelLength} characters or fewer`)
  }

  if (errors.length > 0 || !provider) {
    c.header('Cache-Control', 'private, no-store')
    return c.var.render('conversations/list', {
      title: 'Conversations',
      conversations: (await listConversationsForUser(user.id)).map((row) => ({
        ...row,
        updatedLabel: relativeTime(row.updated_at),
      })),
      providerNames: Object.fromEntries(providers.map((p) => [p.id, p.name])),
      providers: enabledProviders,
      errors,
      values: { title, model, systemPrompt, providerId },
    })
  }

  const conversation = await createConversation({
    userId: user.id,
    title: title || null,
    providerId: provider.id,
    model: model || provider.default_model || null,
  })

  // A configured system prompt lives in the tree as the root message and
  // becomes curr_node, so the first user turn hangs off it (spec §1.2).
  if (systemPrompt.trim().length > 0) {
    const systemMessage = await createMessage({
      conversationId: conversation.id,
      role: 'system',
      content: systemPrompt,
    })
    await setConversationCurrNode({ id: conversation.id, currNode: systemMessage.id })
  }

  return c.redirect(`/conversations/${conversation.id}`)
})

// POST /conversations/:id/delete — remove a conversation the user owns.
// Messages/runs/run-events cascade. Redirects back to the list.
conversationRoutes.post('/conversations/:id/delete', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')

  await deleteConversation({ id: c.req.param('id'), userId: user.id })
  return c.redirect('/conversations')
})

// GET /conversations/:id — SSR transcript of the active path + composer.
conversationRoutes.get('/conversations/:id', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')

  const conversation = await loadOwnedConversation(user.id, c.req.param('id'))
  if (!conversation) return c.notFound()

  return renderShow(c, conversation)
})

// POST /conversations/:id/messages — save the user turn, start a durable run,
// and redirect immediately. The runner streams the reply server-side; the
// conversation page shows whatever the DB holds (plus SSE live tail).
conversationRoutes.post('/conversations/:id/messages', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')

  const conversation = await loadOwnedConversation(user.id, c.req.param('id'))
  if (!conversation) return c.notFound()

  const form = await c.req.formData()
  const content = readString(form, 'content').trim()

  if (content.length === 0) {
    return renderShow(c, conversation, { error: 'Type a message before sending.' })
  }

  // One run at a time per conversation; nothing is saved while one streams.
  if (getActiveRunHandle(conversation.id)) {
    return renderShow(c, conversation, {
      draft: content,
      error: 'A reply is already streaming. Wait for it to finish or stop it first.',
    })
  }

  // Pre-flight: the provider must exist and be enabled. provider_id is ON
  // DELETE SET NULL, so a deleted provider surfaces as a friendly prompt to
  // pick another rather than a crash. Nothing is saved when we can't send.
  const provider = conversation.provider_id
    ? await getProviderById(conversation.provider_id)
    : null
  if (!provider) {
    return renderShow(c, conversation, {
      draft: content,
      error: 'This conversation has no provider. Assign one before sending.',
    })
  }
  if (!provider.enabled) {
    return renderShow(c, conversation, {
      draft: content,
      error: `Provider "${provider.name}" is disabled. Enable it before sending.`,
    })
  }

  // Save the user message and advance curr_node so the turn is durable even if
  // the reply fails. parent is the current leaf (system/root message or null).
  const userMessage = await createMessage({
    conversationId: conversation.id,
    parentId: conversation.curr_node,
    role: 'user',
    content,
  })
  await setConversationCurrNode({ id: conversation.id, currNode: userMessage.id })

  try {
    await startRun(conversation.id)
  } catch (error) {
    // The user message is saved and on the active path; only the reply
    // failed to start. Surface the error so the user can retry.
    const refreshed = await getConversationById(conversation.id)
    return renderShow(c, refreshed ?? conversation, {
      error: `Reply failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  return c.redirect(`/conversations/${conversation.id}`)
})

// POST /conversations/:id/cancel — stop the active run, keep the partial.
conversationRoutes.post('/conversations/:id/cancel', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')

  const conversation = await loadOwnedConversation(user.id, c.req.param('id'))
  if (!conversation) return c.notFound()

  await cancelRun(conversation.id)
  return c.redirect(`/conversations/${conversation.id}`)
})

// GET /conversations/:id/events — SSE: replay the run's events after
// Last-Event-ID (or all of them), then live-tail until the run is terminal.
// The subscription starts before the replay query so no event can slip
// between them; `send` dedupes by seq. `id:` is the per-run seq, so a
// reconnecting EventSource resumes exactly where it left off.
conversationRoutes.get('/conversations/:id/events', async (c) => {
  const user = requireUser(c)
  if (!user) return c.text('Unauthorized', 401)

  const conversation = await loadOwnedConversation(user.id, c.req.param('id'))
  if (!conversation) return c.notFound()

  const active = getActiveRunHandle(conversation.id)
  const run = active
    ? { id: active.runId, status: 'running' }
    : await getLatestRunForConversation(conversation.id)
  if (!run) return c.notFound()
  const runId = run.id

  const rawCursor = c.req.header('Last-Event-ID') ?? c.req.query('after') ?? ''
  const parsedCursor = Number.parseInt(rawCursor, 10)
  const cursor = Number.isFinite(parsedCursor) && parsedCursor > 0 ? parsedCursor : 0

  return streamSSE(c, async (stream) => {
    let lastSentSeq = cursor
    let writeChain: Promise<unknown> = Promise.resolve()
    let finish: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })

    const isTerminalEvent = (event: RunEventRecord) =>
      event.type === 'run-status' &&
      isTerminalRunStatus(String((event.payload as { status?: string })?.status ?? ''))

    const send = (event: RunEventRecord) => {
      if (event.seq <= lastSentSeq) return
      lastSentSeq = event.seq
      writeChain = writeChain
        .then(() =>
          stream.writeSSE({
            id: String(event.seq),
            event: event.type,
            data: JSON.stringify(event.payload),
          }),
        )
        .then(() => {
          if (isTerminalEvent(event)) finish()
        })
        .catch(() => finish())
    }

    let replaying = true
    const buffered: RunEventRecord[] = []
    const unsubscribe = subscribeToRun(runId, (event) => {
      if (replaying) buffered.push(event)
      else send(event)
    })
    stream.onAbort(() => finish())

    try {
      for (const event of await replayRunEvents(runId, cursor)) send(event)
      for (const event of buffered) send(event)
      replaying = false

      // Terminal already? The replay ended with the terminal run-status (or
      // the cursor was past it) — close instead of tailing forever.
      if (!getActiveRunHandle(conversation.id)) {
        const current = await getLatestRunForConversation(conversation.id)
        if (!current || current.id !== runId || isTerminalRunStatus(current.status)) {
          finish()
        }
      }

      await finished
      await writeChain
    } finally {
      unsubscribe()
    }
  })
})
