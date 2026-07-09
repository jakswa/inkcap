import { Hono } from 'hono'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  createConversation,
  deleteConversation,
  getConversationById,
  listConversationsForUser,
  setConversationCurrNode,
  updateConversationModelSettings,
} from '../db/queries/conversations'
import { getProviderForUser, listProvidersForUser } from '../db/queries/providers'
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
  listMcpServersForUser,
  listMcpServersWithOverride,
  setConversationMcpOverride,
} from '../db/queries/mcp-servers'
import { getUserSettings, patchUserSettings } from '../db/queries/users'
import { listPendingApprovalsForRun } from '../db/queries/tool-approvals'
import { listArtifactsForConversation } from '../db/queries/artifacts'
import { getRunEventCursor } from '../db/queries/run-events'
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
import { uniqueModels } from '../utils/providers'
import { toRenderable, toolCallsFor } from '../utils/message-view'
import { relativeTime } from '../utils/relative-time'
import {
  findLeafByLastChild,
  forkConversationPath,
  siblingNavFor,
} from '../services/branching'

export const conversationRoutes = new Hono()

const maxTitleLength = 200
const maxModelLength = 200
const maxSystemPromptLength = 100_000
const maxMessageLength = 100_000
const validReasoningEfforts = new Set(['off', 'low', 'medium', 'high', 'max'])

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
  tool_calls: unknown
  tool_call_id: string | null
  created_at: Date | null
}

function requireUser(c: Context) {
  return c.var.user
}

function normalizeReasoningEffort(value: string): string {
  return validReasoningEfforts.has(value) ? value : 'medium'
}

function readStringList(form: FormData, name: string): string[] {
  return form
    .getAll(name)
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
}

// Submitted MCP server ids may only point at servers the user can see;
// duplicates and foreign ids from a tampered form are dropped (the runner's
// membership join would refuse foreign servers anyway, but don't persist
// garbage).
async function filterOwnedMcpServerIds(userId: string, ids: string[]) {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return []
  const ownedIds = new Set(
    (await listMcpServersForUser(userId)).map((server) => server.id),
  )
  return unique.filter((id) => ownedIds.has(id))
}

function modelSupportsReasoning(
  provider: { kind?: string | null; default_model: string | null; model_metadata?: unknown } | null,
  model: string | null,
): boolean {
  const selected = model || provider?.default_model
  if (!selected) return false
  // llama-server's /v1/models often reports only "completion" even when the
  // chat template accepts enable_thinking/thinking_budget_tokens. For that
  // provider kind, show the control and let the explicit budget keep Qwen-style
  // thinking bounded. Keep generic OpenAI-compatible endpoints metadata-gated.
  if (provider?.kind === 'llama-server') return true
  const metadata = provider?.model_metadata
  if (!metadata || typeof metadata !== 'object') return false
  const info = (metadata as Record<string, { reasoning?: unknown }>)[selected]
  return info?.reasoning === true
}

function currentReasoningEffort(
  provider: { default_model: string | null; model_metadata?: unknown } | null,
  model: string | null,
  value: string | null | undefined,
) {
  if (!modelSupportsReasoning(provider, model)) return 'off'
  return normalizeReasoningEffort(value ?? 'medium')
}

function uniqueProviders<T extends { id: string }>(providers: T[]): T[] {
  const seen = new Set<string>()
  return providers.filter((provider) => {
    if (seen.has(provider.id)) return false
    seen.add(provider.id)
    return true
  })
}

const providerModelSeparator = ':'

function providerModelValue(providerId: string, model: string) {
  return `${providerId}${providerModelSeparator}${encodeURIComponent(model)}`
}

function parseProviderModel(value: string) {
  const index = value.indexOf(providerModelSeparator)
  if (index < 0) return null
  try {
    return {
      providerId: value.slice(0, index).trim(),
      model: decodeURIComponent(value.slice(index + providerModelSeparator.length)).trim(),
    }
  } catch {
    return null
  }
}

function modelControlData(input: {
  providers: Array<{
    id: string
    name: string
    default_model: string | null
    models: string[] | null
    kind?: string | null
    model_metadata?: unknown
  }>
  selectedProviderId?: string | null
  selectedModel?: string | null
  selectedReasoning?: string | null
  allowProviderSelect: boolean
}) {
  const selectedProvider =
    input.providers.find((provider) => provider.id === input.selectedProviderId) ??
    input.providers[0] ??
    null
  const selectedModel =
    input.selectedModel || selectedProvider?.default_model || selectedProvider?.models?.[0] || null

  const providers = input.providers.map((provider) => {
    const models = uniqueModels([
      ...(provider.id === selectedProvider?.id && selectedModel ? [selectedModel] : []),
      ...(provider.default_model ? [provider.default_model] : []),
      ...(provider.models ?? []),
    ])
    return {
      id: provider.id,
      name: provider.name,
      defaultModel: provider.default_model,
      models: models.map((model) => ({
        name: model,
        reasoning: modelSupportsReasoning(provider, model),
      })),
    }
  })

  const modelOptions = providers.flatMap((provider) => {
    const models =
      provider.models.length > 0
        ? provider.models
        : input.allowProviderSelect
          ? [{ name: '', reasoning: false }]
          : []
    return models.map((model) => {
      const label = model.name || 'Provider default'
      return {
        key: providerModelValue(provider.id, model.name),
        value: providerModelValue(provider.id, model.name),
        name: model.name,
        label,
        summary: input.allowProviderSelect ? `${label} · ${provider.name}` : label,
        providerId: provider.id,
        providerName: provider.name,
        reasoning: model.reasoning,
      }
    })
  })
  const selectedModelKey = selectedProvider
    ? providerModelValue(selectedProvider.id, selectedModel ?? '')
    : null

  return {
    allowProviderSelect: input.allowProviderSelect,
    selectedProviderId: selectedProvider?.id ?? null,
    selectedModel,
    selectedModelKey,
    selectedReasoning: currentReasoningEffort(
      selectedProvider,
      selectedModel,
      input.selectedReasoning,
    ),
    modelSupportsReasoning: modelSupportsReasoning(selectedProvider, selectedModel),
    providers,
    modelOptions,
  }
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
  const [provider, providers, activeRun, sidebar, latestRun, mcpServers, artifacts] = await Promise.all([
    // Scoped by the conversation owner: a provider the owner's accounts can
    // no longer see renders as "no provider" instead of leaking its details.
    conversation.provider_id
      ? getProviderForUser({ id: conversation.provider_id, userId: conversation.user_id })
      : Promise.resolve(null),
    listProvidersForUser(conversation.user_id),
    getRunningRunForConversation(conversation.id),
    listConversationsForUser(conversation.user_id),
    getLatestRunForConversation(conversation.id),
    listMcpServersWithOverride({
      conversationId: conversation.id,
      userId: conversation.user_id,
    }),
    listArtifactsForConversation({
      conversationId: conversation.id,
      userId: conversation.user_id,
    }),
  ])

  // Capture a best-effort SSE cursor before reading the transcript. The
  // browser subscribes after it to avoid replaying the whole run over the SSR
  // snapshot; delta offsets still make races harmless if a flushed delta lands
  // between this cursor read and the transcript read.
  const eventCursor = activeRun ? await getRunEventCursor(activeRun.id) : 0

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

  // Tool calls are stored on assistant turns; tool results are separate
  // role='tool' messages keyed by tool_call_id. The durable transcript shows
  // resolved tool metadata on the tool row, not by mutating the previous
  // assistant row in the browser.
  const toolCallById = new Map(
    path
      .flatMap((message) => toolCallsFor(message).filter((call) => call.id))
      .map((call) => [call.id!, call] as const),
  )

  // Attach sibling-navigation metadata (M7) to each message on the active
  // path: where a message has siblings (siblingNav.total > 1) the transcript
  // renders a "‹ i/n ›" switcher. Computed here (not in toRenderable) because
  // it needs a DB lookup the runner's message-final render doesn't do.
  const messages = await Promise.all(
    path.map(async (message) => ({
      ...toRenderable({
        ...message,
        toolCall:
          message.role === 'tool' && message.tool_call_id
            ? toolCallById.get(message.tool_call_id) ?? null
            : null,
      }),
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
  const selectedModel = conversation.model || provider?.default_model || null
  return c.var.render('conversations/show', {
    title: conversation.title || 'New chat',
    shell: 'chat',
    conversation,
    provider,
    modelControls: modelControlData({
      providers: uniqueProviders([
        ...(provider ? [provider] : []),
        ...providers.filter((p) => p.enabled),
      ]),
      selectedProviderId: provider?.id,
      selectedModel,
      selectedReasoning: conversation.reasoning_effort,
      allowProviderSelect: true,
    }),
    selectedModel,
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
    eventCursor,
    pendingApproval,
    artifacts,
    mcpServers,
    enabledMcpServerCount: mcpServers.filter(
      (server) => server.enabled && server.override_enabled,
    ).length,
    error: options.error ?? null,
    draft: options.draft ?? '',
  })
}

// Landing page render: the "Hello there" hero composer plus the chats
// sidebar. Shared by GET and the POST validation-error path.
async function renderLanding(
  c: Context,
  userId: string,
  options: {
    errors?: string[]
    values?: Record<string, string>
    selectedMcpServerIds?: string[]
  } = {},
) {
  const [conversations, providers, mcpServers, settings] = await Promise.all([
    listConversationsForUser(userId),
    listProvidersForUser(userId),
    listMcpServersForUser(userId),
    getUserSettings(userId),
  ])
  // Fresh landing: pre-check the servers from the user's saved defaults (the
  // last created conversation's selection). A validation-error re-render
  // passes the submitted selection instead — even when it's empty.
  const selectedMcpServerIds = new Set(
    options.selectedMcpServerIds ?? settings.defaultMcpServerIds,
  )

  const enabledMcpServerCount = mcpServers.filter(
    (server) => server.enabled && selectedMcpServerIds.has(server.id),
  ).length

  c.header('Cache-Control', 'private, no-store')
  return c.var.render('conversations/list', {
    title: 'Chats',
    shell: 'chat',
    sidebar: conversations.map((row) => ({
      id: row.id,
      title: row.title,
      updatedLabel: relativeTime(row.updated_at),
      current: false,
    })),
    providers: providers.filter((p) => p.enabled),
    mcpServers: mcpServers.map((server) => ({
      ...server,
      override_enabled: selectedMcpServerIds.has(server.id),
    })),
    enabledMcpServerCount,
    modelControls: modelControlData({
      providers: providers.filter((p) => p.enabled),
      selectedProviderId: options.values?.providerId,
      selectedModel: options.values?.model,
      selectedReasoning: options.values?.reasoningEffort,
      allowProviderSelect: true,
    }),
    errors: options.errors ?? [],
    values: options.values ?? {},
  })
}

// Derive a conversation title from the first message when none was given —
// what llama-server's UI does, so a chat never shows up as "untitled".
function titleFromContent(content: string): string | null {
  const collapsed = content.replace(/\s+/g, ' ').trim()
  if (!collapsed) return null
  return collapsed.length > 64 ? `${collapsed.slice(0, 63).trimEnd()}…` : collapsed
}

// GET /conversations — the landing: hero composer + chats sidebar.
conversationRoutes.get('/conversations', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')

  return renderLanding(c, user.id)
})

// POST /conversations — create a conversation and redirect to it. When the
// hero composer carried a first message, save it and start the reply run too,
// so "type and hit send" is the whole flow.
conversationRoutes.post('/conversations', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')

  const form = await c.req.formData()
  const selectedProviderModel = parseProviderModel(readString(form, 'providerModel'))
  const providerId = readString(form, 'providerId').trim() || selectedProviderModel?.providerId || ''
  const title = readString(form, 'title').trim()
  const model = readString(form, 'model').trim() || selectedProviderModel?.model || ''
  const reasoningEffort = normalizeReasoningEffort(readString(form, 'reasoning_effort').trim())
  const systemPrompt = readString(form, 'systemPrompt')
  const content = readString(form, 'content').trim()
  const selectedMcpServerIds = readStringList(form, 'enabled_mcp_server_id')

  const providers = await listProvidersForUser(user.id)
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
  if (systemPrompt.length > maxSystemPromptLength) {
    errors.push(`System prompt must be ${maxSystemPromptLength} characters or fewer`)
  }
  if (content.length > maxMessageLength) {
    errors.push(`Message must be ${maxMessageLength} characters or fewer`)
  }

  if (errors.length > 0 || !provider) {
    return renderLanding(c, user.id, {
      errors,
      values: { title, model, reasoningEffort, systemPrompt, providerId, content },
      selectedMcpServerIds,
    })
  }

  const selectedModel = model || provider.default_model || null

  const conversation = await createConversation({
    userId: user.id,
    title: title || titleFromContent(content),
    providerId: provider.id,
    model: selectedModel,
    reasoningEffort: modelSupportsReasoning(provider, selectedModel) ? reasoningEffort : null,
  })

  const enabledMcpServerIds = await filterOwnedMcpServerIds(
    user.id,
    selectedMcpServerIds,
  )
  await Promise.all(
    enabledMcpServerIds.map((mcpServerId) =>
      setConversationMcpOverride({
        conversationId: conversation.id,
        mcpServerId,
        enabled: true,
      }),
    ),
  )
  // Remember this selection (including "none") as the new-chat default, so
  // the next landing page comes pre-checked with it. Best-effort: a failed
  // preference write must not abort the request between conversation
  // creation and first-message persistence.
  try {
    await patchUserSettings({
      userId: user.id,
      patch: { defaultMcpServerIds: enabledMcpServerIds },
    })
  } catch (error) {
    console.warn('failed to save new-chat tool defaults', error)
  }

  // A configured system prompt lives in the tree as the root message and
  // becomes curr_node, so the first user turn hangs off it (spec §1.2).
  let parentId: string | null = null
  if (systemPrompt.trim().length > 0) {
    const systemMessage = await createMessage({
      conversationId: conversation.id,
      role: 'system',
      content: systemPrompt,
    })
    parentId = systemMessage.id
    await setConversationCurrNode({ id: conversation.id, currNode: systemMessage.id })
  }

  // First message straight from the hero composer: durable user turn, then
  // kick the run. A run that fails to start surfaces on the conversation page
  // via ?error= — the message itself is already saved.
  if (content.length > 0) {
    const userMessage = await createMessage({
      conversationId: conversation.id,
      parentId,
      role: 'user',
      content,
    })
    await setConversationCurrNode({ id: conversation.id, currNode: userMessage.id })
    try {
      await startRun(conversation.id)
    } catch (error) {
      const reason = `Reply failed: ${error instanceof Error ? error.message : String(error)}`
      return c.redirect(
        `/conversations/${conversation.id}?error=${encodeURIComponent(reason)}`,
      )
    }
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

  // ?error= carries a one-shot notice across the create-and-send redirect
  // (e.g. the first run failed to start). Escaped by the template like any
  // other error string.
  return renderShow(c, conversation, { error: c.req.query('error') || undefined })
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
  const selectedProviderModel = parseProviderModel(readString(form, 'providerModel'))
  const submittedProviderId = readString(form, 'providerId').trim() || selectedProviderModel?.providerId || conversation.provider_id || ''
  const content = readString(form, 'content').trim()
  const model = readString(form, 'model').trim() || selectedProviderModel?.model || ''
  const reasoningEffort = normalizeReasoningEffort(readString(form, 'reasoning_effort').trim())

  if (content.length === 0) {
    return renderShow(c, conversation, { error: 'Type a message before sending.' })
  }
  if (content.length > maxMessageLength) {
    return renderShow(c, conversation, {
      draft: content.slice(0, maxMessageLength),
      error: `Message must be ${maxMessageLength} characters or fewer.`,
    })
  }
  if (model.length > maxModelLength) {
    return renderShow(c, conversation, {
      draft: content,
      error: `Model must be ${maxModelLength} characters or fewer.`,
    })
  }

  // One run at a time per conversation; nothing is saved while one streams.
  if (getActiveRunHandle(conversation.id)) {
    return renderShow(c, conversation, {
      draft: content,
      error: 'A reply is already streaming. Wait for it to finish or stop it first.',
    })
  }
  const latestRun = await getLatestRunForConversation(conversation.id)
  if (latestRun?.status === 'waiting_approval') {
    return renderShow(c, conversation, {
      draft: content,
      error: 'A reply is waiting for tool approval. Approve, deny, or stop it first.',
    })
  }

  // Pre-flight: the selected provider must exist, be enabled, and be visible to
  // the conversation owner's accounts. A conversation's previous provider may
  // be disabled/deleted; choosing a different enabled provider in the composer
  // is allowed and updates the conversation before the run starts.
  const provider = submittedProviderId
    ? await getProviderForUser({ id: submittedProviderId, userId: conversation.user_id })
    : null
  if (!provider) {
    return renderShow(c, conversation, {
      draft: content,
      error: 'Choose an enabled provider before sending.',
    })
  }
  if (!provider.enabled) {
    return renderShow(c, conversation, {
      draft: content,
      error: `Provider "${provider.name}" is disabled. Choose an enabled provider before sending.`,
    })
  }

  const selectedModel = model || provider.default_model || null
  const updatedConversation = await updateConversationModelSettings({
    id: conversation.id,
    providerId: provider.id,
    model: selectedModel,
    reasoningEffort: modelSupportsReasoning(provider, selectedModel) ? reasoningEffort : null,
  })

  // Save the user message and advance curr_node so the turn is durable even if
  // the reply fails. parent is the current leaf (system/root message or null).
  const userMessage = await createMessage({
    conversationId: conversation.id,
    parentId: updatedConversation.curr_node,
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
    ? await getProviderForUser({ id: conversation.provider_id, userId: conversation.user_id })
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
  if (content.length > maxMessageLength) {
    return renderShow(c, conversation, {
      error: `Message must be ${maxMessageLength} characters or fewer.`,
    })
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

  const servers = await listMcpServersWithOverride({
    conversationId: conversation.id,
    userId: user.id,
  })

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
  const serverIds = await filterOwnedMcpServerIds(
    user.id,
    readStringList(form, 'mcp_server_id'),
  )
  if (serverIds.length > 1 || form.has('enabled_mcp_server_id')) {
    const enabledIds = new Set(readStringList(form, 'enabled_mcp_server_id'))
    await Promise.all(
      serverIds.map((mcpServerId) =>
        setConversationMcpOverride({
          conversationId: conversation.id,
          mcpServerId,
          enabled: enabledIds.has(mcpServerId),
        }),
      ),
    )
  } else {
    const serverId = serverIds[0] ?? ''
    const enabled = readString(form, 'enabled') === 'on'
    if (serverId) {
      await setConversationMcpOverride({
        conversationId: conversation.id,
        mcpServerId: serverId,
        enabled,
      })
    }
  }

  if (readString(form, 'redirect_to') === 'conversation') {
    return c.redirect(`/conversations/${conversation.id}`)
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
      const transient = event.type === 'run-progress'
      if (!transient) {
        if (event.seq <= lastSentSeq) return
        lastSentSeq = event.seq
      }
      writeChain = writeChain
        .then(() =>
          stream.writeSSE({
            ...(transient ? {} : { id: String(event.seq) }),
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
