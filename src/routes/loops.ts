import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  createLoop,
  deleteLoop,
  getLoopForUser,
  listLoopRunHistory,
  listLoopsForUser,
  listMcpServersWithLoopSelection,
  replaceLoopMcpServers,
  setLoopEnabled,
  updateLoop,
} from '../db/queries/loops'
import { countPushSubscriptionsForUser } from '../db/queries/push-subscriptions'
import { listMcpServersForUser } from '../db/queries/mcp-servers'
import { getProviderForUser, listProvidersForUser } from '../db/queries/providers'
import { fireLoop, humanizeRunStatus } from '../services/loops'
import {
  humanizeLoopSchedule,
  nextLoopFireAt,
  normalizeSchedule,
  scheduleFormParts,
  validateLoopSchedule,
  wallTimeToInstant,
} from '../services/loop-schedule'
import { readString } from '../utils/validation'
import { providerModelError } from '../utils/providers'
import { getUserSettings } from '../db/queries/users'
import { relativeTime } from '../utils/relative-time'

export const loopRoutes = new Hono()

const maxNameLength = 120
const maxPromptLength = 100_000
const maxModelLength = 200
const validReasoningEfforts = new Set(['off', 'low', 'medium', 'high', 'max'])

function requireUser(c: Context) {
  return c.var.user
}

function relativeWallTime(value: string | null, timezone: string) {
  if (!value) return null
  return relativeTime(wallTimeToInstant(value, timezone) ?? value)
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

function parseProviderModel(value: string) {
  const separator = value.indexOf(':')
  if (separator < 0) return null
  try {
    return {
      providerId: value.slice(0, separator),
      model: decodeURIComponent(value.slice(separator + 1)),
    }
  } catch {
    return null
  }
}

function modelSupportsReasoning(
  provider: { kind?: string | null; default_model: string | null; model_metadata?: unknown } | null,
  model: string | null,
) {
  const selected = model || provider?.default_model
  if (!selected) return false
  if (provider?.kind === 'llama-server') return true
  const metadata = provider?.model_metadata
  if (!metadata || typeof metadata !== 'object') return false
  const info = (metadata as Record<string, { reasoning?: unknown }>)[selected]
  return info?.reasoning === true
}

async function filterOwnedMcpServerIds(userId: string, ids: string[]) {
  const ownedIds = new Set((await listMcpServersForUser(userId)).map((server) => server.id))
  return [...new Set(ids)].filter((id) => ownedIds.has(id))
}

async function renderList(c: Context) {
  const user = requireUser(c)!
  const [loops, pushSubscriptionCount] = await Promise.all([
    listLoopsForUser(user.id),
    countPushSubscriptionsForUser(user.id),
  ])
  const ownerTimeZones = new Map(
    await Promise.all(
      [...new Set(loops.map((loop) => loop.user_id))].map(async (userId) =>
        [userId, (await getUserSettings(userId)).timeZone] as const,
      ),
    ),
  )
  const error = c.req.query('error') ?? null
  const notice = c.req.query('notice') ?? null
  c.header('Cache-Control', 'private, no-store')
  return c.var.render('loops/index', {
    title: 'Loops',
    error,
    notice,
    pushSubscriptionCount,
    loops: loops.map((loop) => {
      const timezone = ownerTimeZones.get(loop.user_id) ?? 'UTC'
      return {
        ...loop,
        timezone,
        lastFiredLabel: loop.last_fired_at ? relativeTime(loop.last_fired_at) : 'Never',
        nextFireLabel: relativeWallTime(loop.next_fire_at, timezone),
        scheduleLabel: humanizeLoopSchedule(loop.schedule, timezone),
        runStatusLabel: humanizeRunStatus(loop.last_run_status),
      }
    }),
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
  const [providers, servers, userSettings, pushSubscriptionCount] = await Promise.all([
    listProvidersForUser(user.id),
    options.loop
      ? listMcpServersWithLoopSelection({ loopId: options.loop.id, userId: user.id })
      : listMcpServersForUser(user.id).then((rows) =>
          rows.map((row) => ({ ...row, loop_enabled: false, loop_auto_approve: false })),
        ),
    getUserSettings(options.loop?.user_id ?? user.id),
    countPushSubscriptionsForUser(user.id),
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
          : Boolean(server.loop_auto_approve),
      }
    }),
    errors: options.errors ?? [],
    values,
    scheduleParts: scheduleFormParts(values.schedule ?? options.loop?.schedule),
    timeZone: userSettings.timeZone,
    notificationsEnabled: pushSubscriptionCount > 0,
    schedulePreview: (() => {
      const schedule = normalizeSchedule(values.schedule ?? options.loop?.schedule)
      const timezone = userSettings.timeZone
      if (!schedule) return null
      try {
        const next = nextLoopFireAt(schedule, timezone)
        return next ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone, timeZoneName: 'short' }).format(next) : null
      } catch {
        return null
      }
    })(),
  })
}

async function readLoopForm(c: Context, existing?: Awaited<ReturnType<typeof getLoopForUser>>) {
  const user = requireUser(c)!
  const form = await c.req.formData()
  const name = readString(form, 'name').trim()
  const prompt = readString(form, 'prompt').trim()
  const systemPrompt = readString(form, 'system_prompt')
  const providerModel = parseProviderModel(readString(form, 'provider_model'))
  const providerId = readString(form, 'provider_id').trim() || providerModel?.providerId || ''
  const model = readString(form, 'model').trim() || providerModel?.model || ''
  const reasoningEffort = normalizeReasoningEffort(readString(form, 'reasoning_effort').trim())
  const rawMode = readString(form, 'schedule_mode').trim()
  const legacySchedule = readString(form, 'schedule').trim() || readString(form, 'schedule_preset').trim()
  const scheduleMode = ['once', 'hourly', 'daily', 'weekdays', 'weekly', 'custom'].includes(rawMode)
    ? rawMode
    : rawMode === 'scheduled'
      ? 'custom'
      : 'manual'
  const minute = readString(form, 'schedule_minute').trim() || '0'
  const timeField = scheduleMode === 'weekdays' ? 'schedule_weekdays_time' : scheduleMode === 'weekly' ? 'schedule_weekly_time' : 'schedule_daily_time'
  const time = readString(form, timeField).trim() || '09:00'
  const weekday = readString(form, 'schedule_weekday').trim() || '1'
  const once = readString(form, 'schedule_once').trim()
  const custom = readString(form, 'schedule_custom').trim() || legacySchedule
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time)
  const schedule = scheduleMode === 'manual' ? null
    : scheduleMode === 'once' ? normalizeSchedule(`once:${once}`)
    : scheduleMode === 'hourly' ? normalizeSchedule(`${minute} * * * *`)
    : scheduleMode === 'daily' && timeMatch ? `${Number(timeMatch[2])} ${Number(timeMatch[1])} * * *`
    : scheduleMode === 'weekdays' && timeMatch ? `${Number(timeMatch[2])} ${Number(timeMatch[1])} * * 1-5`
    : scheduleMode === 'weekly' && timeMatch ? `${Number(timeMatch[2])} ${Number(timeMatch[1])} * * ${weekday}`
    : normalizeSchedule(custom)
  const userSettings = await getUserSettings(existing?.user_id ?? user.id)
  const timezone = userSettings.timeZone
  const enabled = scheduleMode !== 'manual' && readString(form, 'enabled') === 'on'
  const selectedMcpIdsRaw = readStringList(form, 'enabled_mcp_server_id')
  const approvedMcpIdsRaw = readStringList(form, 'auto_approve_mcp_server_id')

  const errors: string[] = []
  if (!name) errors.push('Name is required')
  if (name.length > maxNameLength) errors.push(`Name must be ${maxNameLength} characters or fewer`)
  if (!prompt) errors.push('Prompt is required')
  if (prompt.length > maxPromptLength) errors.push(`Prompt must be ${maxPromptLength} characters or fewer`)
  if (model.length > maxModelLength) errors.push(`Model must be ${maxModelLength} characters or fewer`)
  if (scheduleMode === 'hourly' && (!/^\d{1,2}$/.test(minute) || Number(minute) > 59)) errors.push('Choose a minute from 0 to 59')
  if (['daily', 'weekdays', 'weekly'].includes(scheduleMode) && (!timeMatch || Number(timeMatch[1]) > 23 || Number(timeMatch[2]) > 59)) errors.push('Choose a valid time of day')
  if (scheduleMode === 'weekly' && !/^[0-6]$/.test(weekday)) errors.push('Choose a day of the week')
  if (scheduleMode === 'once' && !once) errors.push('Choose the date and time for this one-time run')
  if (scheduleMode === 'custom' && !custom) errors.push('Enter a cron expression')

  const provider = providerId ? await getProviderForUser({ id: providerId, userId: user.id }) : null
  if (!provider || !provider.enabled) errors.push('Choose an enabled provider')
  if (provider?.enabled) {
    const modelError = providerModelError(provider, model || provider.default_model)
    if (modelError) errors.push(modelError)
  }

  let nextFireAt: string | null = null
  if (enabled && !schedule) {
    errors.push('Enabled loops need a cron schedule. Leave the loop disabled for manual-only runs.')
  } else {
    try {
      const validatedNextFireAt = validateLoopSchedule(schedule, timezone)
      nextFireAt = enabled ? validatedNextFireAt : null
      if (enabled && !nextFireAt) errors.push('Choose a future run time.')
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
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
      enabled,
      nextFireAt,
    },
    mcpServers: selectedMcpIds.map((mcpServerId) => ({
      mcpServerId,
      autoApprove: approvedMcpIds.has(mcpServerId),
    })),
    selectedMcpIds,
    approvedMcpIds: [...approvedMcpIds],
    values: { name, prompt, systemPrompt, providerId, model, reasoningEffort, schedule: schedule ?? '', scheduleMode, scheduleMinute: minute, scheduleTime: time, scheduleWeekday: weekday, scheduleOnce: once, scheduleCustom: custom, enabled: enabled ? 'on' : '' },
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

loopRoutes.get('/loops/:id', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')
  const loop = await getLoopForUser({ id: c.req.param('id'), userId: user.id })
  if (!loop) return c.notFound()
  const [history, pushSubscriptionCount, ownerSettings] = await Promise.all([
    listLoopRunHistory({ loopId: loop.id, userId: user.id, limit: 30 }),
    countPushSubscriptionsForUser(user.id),
    getUserSettings(loop.user_id),
  ])
  c.header('Cache-Control', 'private, no-store')
  return c.var.render('loops/show', {
    title: loop.name,
    error: c.req.query('error') ?? null,
    loop: {
      ...loop,
      timezone: ownerSettings.timeZone,
      lastFiredLabel: loop.last_fired_at ? relativeTime(loop.last_fired_at) : 'Never',
      nextFireLabel: relativeWallTime(loop.next_fire_at, ownerSettings.timeZone),
      scheduleLabel: humanizeLoopSchedule(loop.schedule, ownerSettings.timeZone),
    },
    history: history.map((run) => ({
      ...run,
      statusLabel: humanizeRunStatus(run.run_status),
      createdLabel: relativeTime(run.created_at),
      updatedLabel: run.run_updated_at ? relativeTime(run.run_updated_at) : relativeTime(run.updated_at),
    })),
    pushSubscriptionCount,
  })
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
  let nextFireAt: string | null = null
  try {
    const timezone = (await getUserSettings(loop.user_id)).timeZone
    nextFireAt = enabled ? validateLoopSchedule(normalizeSchedule(loop.schedule), timezone) : null
  } catch {
    nextFireAt = null
  }
  if (enabled && !nextFireAt) {
    const message = encodeURIComponent('This loop needs a valid schedule before it can be enabled.')
    return c.redirect(`/loops?error=${message}`)
  }
  await setLoopEnabled({ id: loop.id, userId: user.id, enabled, nextFireAt })
  return c.redirect(`/loops?notice=${encodeURIComponent(enabled ? 'Loop enabled.' : 'Loop disabled.')}`)
})

loopRoutes.post('/loops/:id/run', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')
  const loop = await getLoopForUser({ id: c.req.param('id'), userId: user.id })
  if (!loop) return c.notFound()
  try {
    const timezone = (await getUserSettings(loop.user_id)).timeZone
    const conversation = await fireLoop(loop, timezone)
    return c.redirect(`/conversations/${conversation.id}`)
  } catch (error) {
    const message = encodeURIComponent(error instanceof Error ? error.message : String(error))
    return c.redirect(`/loops/${loop.id}?error=${message}`)
  }
})

loopRoutes.post('/loops/:id/delete', async (c) => {
  const user = requireUser(c)
  if (!user) return c.redirect('/login')
  const loop = await getLoopForUser({ id: c.req.param('id'), userId: user.id })
  if (!loop) return c.notFound()
  await deleteLoop({ id: loop.id, userId: user.id })
  return c.redirect('/loops')
})
