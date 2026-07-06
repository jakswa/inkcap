import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  createConversation,
  getConversationById,
  listConversationsForUser,
  setConversationCurrNode,
} from '../db/queries/conversations'
import { getProviderById, listProviders } from '../db/queries/providers'
import { createMessage, getActivePath } from '../db/queries/messages'
import { completeOnce, type ChatMessage, type ChatRole } from '../services/provider-client'
import { readString } from '../utils/validation'

export const conversationRoutes = new Hono()

const maxTitleLength = 200
const maxModelLength = 200

// Rows returned by getActivePath are typed all-nullable (recursive CTE), so we
// narrow to the shape the transcript and request builder need.
type PathMessage = {
  id: string | null
  role: string | null
  content: string | null
  reasoning_content: string | null
  model: string | null
  created_at: Date | null
}

function requireUser(c: Context) {
  return c.var.user
}

// Map the active path (root-first) to OpenAI chat messages: drop empty system
// messages (spec §1.2) and forward reasoning_content on assistant turns.
function toChatMessages(path: PathMessage[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const row of path) {
    const role = (row.role ?? '') as ChatRole
    const content = row.content ?? ''
    if (role === 'system' && content.trim().length === 0) continue
    const message: ChatMessage = { role, content }
    if (role === 'assistant' && row.reasoning_content) {
      message.reasoning_content = row.reasoning_content
    }
    messages.push(message)
  }
  return messages
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
  const provider = conversation.provider_id
    ? await getProviderById(conversation.provider_id)
    : null

  const path = conversation.curr_node
    ? ((await getActivePath(conversation.curr_node)) as PathMessage[])
    : []

  c.header('Cache-Control', 'private, no-store')
  return c.var.render('conversations/show', {
    title: conversation.title || 'untitled',
    conversation,
    provider,
    messages: path,
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
    conversations,
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
      conversations: await listConversationsForUser(user.id),
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

// GET /conversations/:id — SSR transcript of the active path + composer.
conversationRoutes.get('/conversations/:id', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')

  const conversation = await loadOwnedConversation(user.id, c.req.param('id'))
  if (!conversation) return c.notFound()

  return renderShow(c, conversation)
})

// POST /conversations/:id/messages — send a user turn, get one reply.
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

  const path = (await getActivePath(userMessage.id)) as PathMessage[]

  let completion
  try {
    completion = await completeOnce(
      { base_url: provider.base_url, api_key: provider.api_key },
      conversation.model,
      toChatMessages(path),
    )
  } catch (error) {
    // Message is saved and on the active path; the reply failed. Surface the
    // error above the composer so the user can retry by posting again.
    const refreshed = await getConversationById(conversation.id)
    return renderShow(c, refreshed ?? conversation, {
      error: `Reply failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  const assistantMessage = await createMessage({
    conversationId: conversation.id,
    parentId: userMessage.id,
    role: 'assistant',
    content: completion.content,
    reasoningContent: completion.reasoningContent,
    model: completion.model ?? conversation.model,
    timings: completion.timings,
  })
  await setConversationCurrNode({
    id: conversation.id,
    currNode: assistantMessage.id,
  })

  return c.redirect(`/conversations/${conversation.id}`)
})
