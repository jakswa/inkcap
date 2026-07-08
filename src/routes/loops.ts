import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  createLoop,
  deleteLoop,
  getLoopForUser,
  listLoopsForUser,
  listMcpServersWithLoopSelection,
  replaceLoopMcpServers,
  setLoopEnabled,
  updateLoop,
} from '../db/queries/loops'
import { listMcpServersForUser } from '../db/queries/mcp-servers'
import { getProviderForUser, listProvidersForUser } from '../db/queries/providers'
import { fireLoop, defaultLoopTimezone, normalizeSchedule, validateLoopSchedule } from '../services/loops'
import { readString } from '../utils/validation'
import { relativeTime } from '../utils/relative-time'

export const loopRoutes = new Hono()

const maxNameLength = 120
const maxPromptLength = 100_000
const maxModelLength = 200
const validReasoningEfforts = new Set(['off', 'low', 'medium', 'high', 'max'])

function requireUser(c: Context) {
  return c.var.user
}

function readStringList(form: FormData, name: string): string[] {
  return form
    .getAll(name)
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
}

function normalizeReasoningEffort(value: string) {
  return validReasoningEfforts.has(value) ? value : 'medium'
}

function modelSupportsReasoning(
  provider: { default_model: string | null; model_metadata?: unknown } | null,
  model: string | null,
) {
  const metadata = provider?.model_metadata
  if (!metadata || typeof metadata !== 'object') return false
  const selected = model || provider?.default_model
  if (!selected) return false
  const info = (metadata as Record<string, { reasoning?: unknown }>)[selected]
  return info?.reasoning === true
}

async function filterOwnedMcpServerIds(userId: string, ids: string[]) {
  const ownedIds = new Set((await listMcpServersForUser(userId)).map((server) => server.id))
  return [...new Set(ids)].filter((id) => ownedIds.has(id))
}

async function renderList(c: Context) {
  const user = requireUser(c)!
  const loops = await listLoopsForUser(user.id)
  c.header('Cache-Control', 'private, no-store')
  return c.var.render('loops/index', {
    title: 'Loops',
    loops: loops.map((loop) => ({
      ...loop,
      lastFiredLabel: loop.last_fired_at ? relativeTime(loop.last_fired_at) : 'Never',
      nextFireLabel: loop.next_fire_at ? relativeTime(loop.next_fire_at) : null,
    })),
  })
}

async function renderForm(
  c: Context,
  options: {
    mode: 'new' | 'edit'
    loop?: Awaited<ReturnType<typeof getLoopForUser>>
    errors?: string[]
    values?: Record<string, string>
    selectedMcpIds?: string[]
    approvedMcpIds?: string[]
  },
) {
  const user = requireUser(c)!
  const [providers, servers] = await Promise.all([
    listProvidersForUser(user.id),
    options.loop
      ? listMcpServersWithLoopSelection({ loopId: options.loop.id, userId: user.id })
      : listMcpServersForUser(user.id).then((rows) =>
          rows.map((row) => ({ ...row, loop_enabled: false, loop_auto_approve: true })),
        ),
  ])

  const selectedMcpIds = new Set(options.selectedMcpIds)
  const approvedMcpIds = new Set(options.approvedMcpIds)
  const values = options.values ?? {}
  c.header('Cache-Control', 'private, no-store')
  return c.var.render(options.mode === 'new' ? 'loops/new' : 'loops/edit', {
    title: options.mode === 'new' ? 'New loop' : `Edit ${options.loop?.name ?? 'loop'}`,
    mode: options.mode,
    loop: options.loop ?? null,
    providers: providers.filter((p) => p.enabled || p.id === options.loop?.provider_id),
    servers: servers.map((server) => {
      const submitted = options.selectedMcpIds !== undefined
      const id = server.id
      return {
        ...server,
        loop_enabled: submitted ? selectedMcpIds.has(id) : Boolean(server.loop_enabled),
        loop_auto_approve: submitted
          ? approvedMcpIds.has(id)
          : server.loop_auto_approve !== false,
      }
    }),
    errors: options.errors ?? [],
    values,
    schedulePresets: [
      { label: 'Manual only', value: '' },
      { label: 'Hourly', value: '0 * * * *' },
      { label: 'Daily at 7:00', value: '0 7 * * *' },
      { label: 'Weekdays at 8:00', value: '0 8 * * 1-5' },
      { label: 'Mondays at 9:00', value: '0 9 * * 1' },
    ],
  })
}

async function readLoopForm(c: Context, existing?: Awaited<ReturnType<typeof getLoopForUser>>) {
  const user = requireUser(c)!
  const form = await c.req.formData()
  const name = readString(form, 'name').trim()
  const prompt = readString(form, 'prompt').trim()
  const systemPrompt = readString(form, 'system_prompt')
  const providerId = readString(form, 'provider_id').trim()
  const model = readString(form, 'model').trim()
  const reasoningEffort = normalizeReasoningEffort(readString(form, 'reasoning_effort').trim())
  const schedule = normalizeSchedule(readString(form, 'schedule'))
  const timezone = readString(form, 'timezone').trim() || defaultLoopTimezone()
  const enabled = readString(form, 'enabled') === 'on'
  const selectedMcpIdsRaw = readStringList(form, 'enabled_mcp_server_id')
  const approvedMcpIdsRaw = readStringList(form, 'auto_approve_mcp_server_id')

  const errors: string[] = []
  if (!name) errors.push('Name is required')
  if (name.length > maxNameLength) errors.push(`Name must be ${maxNameLength} characters or fewer`)
  if (!prompt) errors.push('Prompt is required')
  if (prompt.length > maxPromptLength) errors.push(`Prompt must be ${maxPromptLength} characters or fewer`)
  if (model.length > maxModelLength) errors.push(`Model must be ${maxModelLength} characters or fewer`)

  const provider = providerId ? await getProviderForUser({ id: providerId, userId: user.id }) : null
  if (!provider || !provider.enabled) errors.push('Choose an enabled provider')

  let nextFireAt: Date | null = null
  try {
    nextFireAt = enabled ? validateLoopSchedule(schedule, timezone) : null
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  const selectedMcpIds = await filterOwnedMcpServerIds(user.id, selectedMcpIdsRaw)
  const approvedMcpIds = new Set(await filterOwnedMcpServerIds(user.id, approvedMcpIdsRaw))

  return {
    errors,
    input: {
      id: existing?.id,
      accountId: existing?.account_id ?? user.id,
      userId: user.id,
      name,
      prompt,
      systemPrompt,
      providerId,
      model: model || provider?.default_model || null,
      reasoningEffort: provider && modelSupportsReasoning(provider, model || provider.default_model || null) ? reasoningEffort : null,
      schedule,
      timezone,
      enabled,
      nextFireAt,
    },
    mcpServers: selectedMcpIds.map((mcpServerId) => ({
      mcpServerId,
      autoApprove: approvedMcpIds.has(mcpServerId),
    })),
    selectedMcpIds,
    approvedMcpIds: [...approvedMcpIds],
    values: { name, prompt, systemPrompt, providerId, model, reasoningEffort, schedule: schedule ?? '', timezone, enabled: enabled ? 'on' : '' },
  }
}

loopRoutes.get('/loops', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')
  return renderList(c)
})

loopRoutes.get('/loops/new', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')
  return renderForm(c, { mode: 'new' })
})

loopRoutes.post('/loops', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')
  const parsed = await readLoopForm(c)
  if (parsed.errors.length > 0) {
    return renderForm(c, {
      mode: 'new',
      errors: parsed.errors,
      values: parsed.values,
      selectedMcpIds: parsed.selectedMcpIds,
      approvedMcpIds: parsed.approvedMcpIds,
    })
  }
  const loop = await createLoop(parsed.input)
  await replaceLoopMcpServers({ loopId: loop.id, servers: parsed.mcpServers })
  return c.redirect('/loops')
})

loopRoutes.get('/loops/:id/edit', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')
  const loop = await getLoopForUser({ id: c.req.param('id'), userId: user.id })
  if (!loop) return c.notFound()
  return renderForm(c, { mode: 'edit', loop })
})

loopRoutes.post('/loops/:id', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')
  const loop = await getLoopForUser({ id: c.req.param('id'), userId: user.id })
  if (!loop) return c.notFound()
  const parsed = await readLoopForm(c, loop)
  if (parsed.errors.length > 0) {
    return renderForm(c, {
      mode: 'edit',
      loop,
      errors: parsed.errors,
      values: parsed.values,
      selectedMcpIds: parsed.selectedMcpIds,
      approvedMcpIds: parsed.approvedMcpIds,
    })
  }
  await updateLoop({ ...parsed.input, id: loop.id })
  await replaceLoopMcpServers({ loopId: loop.id, servers: parsed.mcpServers })
  return c.redirect('/loops')
})

loopRoutes.post('/loops/:id/toggle', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')
  const loop = await getLoopForUser({ id: c.req.param('id'), userId: user.id })
  if (!loop) return c.notFound()
  const enabled = !loop.enabled
  let nextFireAt: Date | null = null
  try {
    nextFireAt = enabled ? validateLoopSchedule(normalizeSchedule(loop.schedule), loop.timezone) : null
  } catch {
    nextFireAt = null
  }
  await setLoopEnabled({ id: loop.id, userId: user.id, enabled, nextFireAt })
  return c.redirect('/loops')
})

loopRoutes.post('/loops/:id/run', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')
  const loop = await getLoopForUser({ id: c.req.param('id'), userId: user.id })
  if (!loop) return c.notFound()
  try {
    const conversation = await fireLoop(loop)
    return c.redirect(`/conversations/${conversation.id}`)
  } catch (error) {
    const message = encodeURIComponent(error instanceof Error ? error.message : String(error))
    return c.redirect(`/loops?error=${message}`)
  }
})

loopRoutes.post('/loops/:id/delete', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')
  await deleteLoop({ id: c.req.param('id'), userId: user.id })
  return c.redirect('/loops')
})
