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
import {
  createMessage,
  deleteMessageSubtree,
  getActivePath,
  getMessageById,
  listMessageChildren,
  listSiblings,
  updateMessageContent,
} from '../db/queries/messages'
import {
  getLatestRunForConversation,
  getRunningRunForConversation,
} from '../db/queries/runs'
import {
  listMcpServersWithOverride,
  setConversationMcpOverride,
} from '../db/queries/mcp-servers'
import { listPendingApprovalsForRun } from '../db/queries/tool-approvals'
import {
  cancelRun,
  getActiveRunHandle,
  isTerminalRunStatus,
  replayRunEvents,
  resumeParkedRun,
  startRun,
  subscribeToRun,
  type RunEventRecord,
} from '../services/runner'
import { readString } from '../utils/validation'
import { toRenderable } from '../utils/message-view'
import { relativeTime } from '../utils/relative-time'
import {
  findLeafByLastChild,
  forkConversationPath,
  siblingNavFor,
} from '../services/branching'

export const conversationRoutes = new Hono()

const maxTitleLength = 200
const maxModelLength = 200

// Rows returned by getActivePath are typed all-nullable (recursive CTE), so we
// narrow to the shape the transcript needs.
type PathMessage = {
  id: string | null
  parent_id: string | null
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

// Pretty-print a tool call's JSON arguments for the approval card; fall back to
// the raw string if it isn't valid JSON.
function prettyArguments(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

async function renderShow(
  c: Context,
  conversation: NonNullable<Awaited<ReturnType<typeof getConversationById>>>,
  options: { error?: string; draft?: string } = {},
) {
  const [provider, activeRun, sidebar, latestRun] = await Promise.all([
    conversation.provider_id
      ? getProviderById(conversation.provider_id)
      : Promise.resolve(null),
    getRunningRunForConversation(conversation.id),
    listConversationsForUser(conversation.user_id),
    getLatestRunForConversation(conversation.id),
  ])

  const path = conversation.curr_node
    ? ((await getActivePath(conversation.curr_node)) as PathMessage[])
    : []

  // Pending tool approvals: the latest run is parked in waiting_approval and
  // has pending rows. Rendered as approve/deny forms (boring CRUD).
  let pendingApproval: {
    runId: string
    calls: { toolName: string; arguments: string }[]
  } | null = null
  if (latestRun && latestRun.status === 'waiting_approval') {
    const pending = await listPendingApprovalsForRun(latestRun.id)
    if (pending.length > 0) {
      pendingApproval = {
        runId: latestRun.id,
        calls: pending.map((p) => ({
          toolName: p.tool_name,
          arguments: prettyArguments(p.arguments),
        })),
      }
    }
  }

  // Attach sibling-navigation metadata (M7) to each message on the active
  // path: where a message has siblings (siblingNav.total > 1) the transcript
  // renders a "‹ i/n ›" switcher. Computed here (not in toRenderable) because
  // it needs a DB lookup the runner's message-final render doesn't do.
  const messages = await Promise.all(
    path.map(async (message) => ({
      ...toRenderable(message),
      siblingNav: message.id
        ? await siblingNavFor({
            conversationId: conversation.id,
            parentId: message.parent_id,
            messageId: message.id,
          })
        : null,
    })),
  )

  c.header('Cache-Control', 'private, no-store')
  return c.var.render('conversations/show', {
    title: conversation.title || 'untitled',
    conversation,
    provider,
    // Settled messages carry rendered-markdown HTML; the streaming leaf keeps
    // plain text for the island's live tail (contentHtml === null).
    messages,
    sidebar: sidebar.map((row) => ({
      id: row.id,
      title: row.title,
      updatedLabel: relativeTime(row.updated_at),
      current: row.id === conversation.id,
    })),
    activeRun: activeRun ?? null,
    pendingApproval,
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

// Shared preflight for branch-then-run actions (edit, regenerate): the
// provider must exist and be enabled, mirroring the send path. Returns a
// friendly error string, or null when it's safe to start a run.
async function runPreflightError(
  conversation: NonNullable<Awaited<ReturnType<typeof getConversationById>>>,
): Promise<string | null> {
  const provider = conversation.provider_id
    ? await getProviderById(conversation.provider_id)
    : null
  if (!provider) {
    return 'This conversation has no provider. Assign one before sending.'
  }
  if (!provider.enabled) {
    return `Provider "${provider.name}" is disabled. Enable it before sending.`
  }
  return null
}

// POST /conversations/:id/messages/:messageId/edit — branching edit of a user
// message (spec C.1a). If the message has no responses yet, edit it in place;
// otherwise fork a new sibling with the new text, preserving the old branch.
// Either way curr_node lands on the (edited/new) user message and a fresh run
// generates the reply.
conversationRoutes.post('/conversations/:id/messages/:messageId/edit', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')

  const conversation = await loadOwnedConversation(user.id, c.req.param('id'))
  if (!conversation) return c.notFound()

  // Guard: one run at a time. Branching mid-stream would race the runner's
  // curr_node writes, so ask the user to stop first (spec: friendly error).
  if (getActiveRunHandle(conversation.id)) {
    return renderShow(c, conversation, {
      error: 'A reply is streaming. Stop it before editing a message.',
    })
  }

  const message = await getMessageById(c.req.param('messageId'))
  if (!message || message.conversation_id !== conversation.id) return c.notFound()
  if (message.role !== 'user') {
    return renderShow(c, conversation, { error: 'Only your messages can be edited.' })
  }

  const form = await c.req.formData()
  const content = readString(form, 'content').trim()
  if (content.length === 0) {
    return renderShow(c, conversation, { error: 'Type a message before saving.' })
  }

  const preflight = await runPreflightError(conversation)
  if (preflight) return renderShow(c, conversation, { error: preflight })

  // No responses downstream → edit in place (spec: no new node). Otherwise
  // create a sibling so the old branch survives, reachable via the switcher.
  const children = await listMessageChildren(message.id)
  let targetId: string
  if (children.length === 0) {
    const updated = await updateMessageContent({ id: message.id, content })
    targetId = updated.id
  } else {
    const sibling = await createMessage({
      conversationId: conversation.id,
      parentId: message.parent_id,
      role: 'user',
      content,
    })
    targetId = sibling.id
  }
  await setConversationCurrNode({ id: conversation.id, currNode: targetId })

  try {
    await startRun(conversation.id)
  } catch (error) {
    const refreshed = await getConversationById(conversation.id)
    return renderShow(c, refreshed ?? conversation, {
      error: `Reply failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  return c.redirect(`/conversations/${conversation.id}`)
})

// POST /conversations/:id/messages/:messageId/regenerate — new sibling reply
// (spec C.4). Point curr_node at the assistant message's parent (the user turn)
// and start a run: startRun opens a fresh assistant child there, so the old
// reply is preserved as a sibling and the LLM context excludes it.
conversationRoutes.post(
  '/conversations/:id/messages/:messageId/regenerate',
  async (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect('/login')

    const conversation = await loadOwnedConversation(user.id, c.req.param('id'))
    if (!conversation) return c.notFound()

    if (getActiveRunHandle(conversation.id)) {
      return renderShow(c, conversation, {
        error: 'A reply is streaming. Stop it before regenerating.',
      })
    }

    const message = await getMessageById(c.req.param('messageId'))
    if (!message || message.conversation_id !== conversation.id) return c.notFound()
    if (message.role !== 'assistant') {
      return renderShow(c, conversation, {
        error: 'Only assistant replies can be regenerated.',
      })
    }
    if (!message.parent_id) {
      return renderShow(c, conversation, { error: 'Nothing to regenerate from.' })
    }

    const preflight = await runPreflightError(conversation)
    if (preflight) return renderShow(c, conversation, { error: preflight })

    await setConversationCurrNode({
      id: conversation.id,
      currNode: message.parent_id,
    })

    try {
      await startRun(conversation.id)
    } catch (error) {
      const refreshed = await getConversationById(conversation.id)
      return renderShow(c, refreshed ?? conversation, {
        error: `Reply failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    }

    return c.redirect(`/conversations/${conversation.id}`)
  },
)

// POST /conversations/:id/switch — sibling navigation (spec C.3). `target` is a
// sibling id; curr_node jumps to that sibling's deepest most-recent branch
// (findLeafByLastChild), so the whole path below the switch point re-derives.
conversationRoutes.post('/conversations/:id/switch', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')

  const conversation = await loadOwnedConversation(user.id, c.req.param('id'))
  if (!conversation) return c.notFound()

  if (getActiveRunHandle(conversation.id)) {
    return renderShow(c, conversation, {
      error: 'A reply is streaming. Stop it before switching branches.',
    })
  }

  const form = await c.req.formData()
  const target = readString(form, 'target').trim()
  if (target) {
    const message = await getMessageById(target)
    if (!message || message.conversation_id !== conversation.id) return c.notFound()
    const leaf = await findLeafByLastChild(target)
    await setConversationCurrNode({ id: conversation.id, currNode: leaf })
  }

  return c.redirect(`/conversations/${conversation.id}`)
})

// POST /conversations/:id/messages/:messageId/delete — prune a message and its
// whole subtree (spec C.7). If the active leaf was inside the pruned subtree
// (curr_node → NULL via ON DELETE SET NULL), reposition: prefer the newest
// remaining sibling's leaf, else collapse to the parent's leaf.
conversationRoutes.post(
  '/conversations/:id/messages/:messageId/delete',
  async (c) => {
    const user = requireUser(c)
    if (!user) return c.redirect('/login')

    const conversation = await loadOwnedConversation(user.id, c.req.param('id'))
    if (!conversation) return c.notFound()

    if (getActiveRunHandle(conversation.id)) {
      return renderShow(c, conversation, {
        error: 'A reply is streaming. Stop it before deleting a message.',
      })
    }

    const message = await getMessageById(c.req.param('messageId'))
    if (!message || message.conversation_id !== conversation.id) return c.notFound()

    const parentId = message.parent_id
    const prevCurr = conversation.curr_node
    await deleteMessageSubtree({ id: message.id, conversationId: conversation.id })

    // curr_node is now NULL only if the deleted subtree contained it — i.e. the
    // deleted message was on the active path. A dangling branch leaves it alone.
    const refreshed = await getConversationById(conversation.id)
    if (refreshed && prevCurr && refreshed.curr_node === null) {
      const siblings = await listSiblings({
        conversationId: conversation.id,
        parentId,
      })
      let newCurr: string | null = null
      if (siblings.length > 0) {
        // created_at ASC → last row is the newest remaining sibling.
        newCurr = await findLeafByLastChild(siblings[siblings.length - 1]!.id)
      } else if (parentId) {
        newCurr = await findLeafByLastChild(parentId)
      }
      await setConversationCurrNode({ id: conversation.id, currNode: newCurr })
    }

    return c.redirect(`/conversations/${conversation.id}`)
  },
)

// POST /conversations/:id/fork — copy the active path into a new conversation
// (spec C.9), stamping forked_from_conversation_id. Never mutates the source
// tree; redirects to the fresh copy.
conversationRoutes.post('/conversations/:id/fork', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')

  const conversation = await loadOwnedConversation(user.id, c.req.param('id'))
  if (!conversation) return c.notFound()

  const newId = await forkConversationPath(conversation)
  return c.redirect(`/conversations/${newId}`)
})

// POST /conversations/:id/approvals — approve or deny the pending tool call(s)
// on a run parked in waiting_approval, resuming the runner loop. Boring CRUD:
// two buttons post `decision=approve|deny`.
conversationRoutes.post('/conversations/:id/approvals', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')

  const conversation = await loadOwnedConversation(user.id, c.req.param('id'))
  if (!conversation) return c.notFound()

  const form = await c.req.formData()
  const decision = readString(form, 'decision').trim()
  if (decision !== 'approve' && decision !== 'deny') {
    return renderShow(c, conversation, { error: 'Choose approve or deny.' })
  }

  try {
    await resumeParkedRun(conversation.id, decision)
  } catch (error) {
    return renderShow(c, conversation, {
      error: `Could not resume: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  return c.redirect(`/conversations/${conversation.id}`)
})

// GET /conversations/:id/tools — per-conversation MCP server picker. Each
// enabled server exposes its tools to the model for THIS conversation only.
conversationRoutes.get('/conversations/:id/tools', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')

  const conversation = await loadOwnedConversation(user.id, c.req.param('id'))
  if (!conversation) return c.notFound()

  const servers = await listMcpServersWithOverride(conversation.id)

  c.header('Cache-Control', 'private, no-store')
  return c.var.render('conversations/tools', {
    title: 'Tools',
    conversation,
    servers,
  })
})

// POST /conversations/:id/tools — toggle one server's override for this
// conversation. `enabled=on` turns it on; absent turns it off.
conversationRoutes.post('/conversations/:id/tools', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')

  const conversation = await loadOwnedConversation(user.id, c.req.param('id'))
  if (!conversation) return c.notFound()

  const form = await c.req.formData()
  const serverId = readString(form, 'mcp_server_id').trim()
  const enabled = readString(form, 'enabled') === 'on'
  if (serverId) {
    await setConversationMcpOverride({
      conversationId: conversation.id,
      mcpServerId: serverId,
      enabled,
    })
  }

  return c.redirect(`/conversations/${conversation.id}/tools`)
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
