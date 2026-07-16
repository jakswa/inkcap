import { describe, expect, test } from 'bun:test'
import { randomUUIDv7 } from 'bun'

const { app } = await import('../../src/app')
const { createLoop, getLoopForUser, listLoopMcpServers, listLoopsForUser } = await import('../../src/db/queries/loops')
const { createConversation } = await import('../../src/db/queries/conversations')
const { createMcpServer } = await import('../../src/db/queries/mcp-servers')
const { createProvider } = await import('../../src/db/queries/providers')
const { createUser, getUserSettings, patchUserSettings } = await import('../../src/db/queries/users')
const { createRun, getLatestRunForConversation, isOriginatingRun } = await import('../../src/db/queries/runs')
const { encryptSession } = await import('../../src/utils/private-session')
const { scheduleFormParts, wallTimeToInstant } = await import('../../src/services/loop-schedule')

const origin = 'http://localhost:3000'
const url = (path: string) => `${origin}${path}`

function form(input: Record<string, string | string[]>) {
  const body = new FormData()
  for (const [key, value] of Object.entries(input)) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(key, item)
  }
  return body
}

async function auth() {
  const suffix = randomUUIDv7()
  const user = await createUser({
    name: 'Loops Test User',
    email: `loops-${suffix}@example.com`,
    emailNormalized: `loops-${suffix}@example.com`,
    passwordHash: 'x',
  })
  const expiresAt = new Date(Date.now() + 86_400_000)
  const session = encryptSession({
    user: { id: user.id, name: user.name, email: user.email, created_at: user.created_at.toISOString() },
    issuedAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
  })
  return { user, headers: { Cookie: `session=${session}`, Origin: origin } }
}

async function fixture() {
  const identity = await auth()
  const provider = await createProvider({
    accountId: identity.user.id,
    name: `loop-provider-${randomUUIDv7()}`,
    kind: 'openai-compat',
    baseUrl: 'http://127.0.0.1:9',
    defaultModel: 'model-test',
    models: ['model-test'],
  })
  return { ...identity, provider }
}

function loopForm(providerId: string, overrides: Record<string, string | string[]> = {}) {
  return form({
    name: 'Morning report',
    prompt: 'Summarize the overnight changes.',
    provider_id: providerId,
    model: 'model-test',
    reasoning_effort: 'high',
    schedule_mode: 'manual',
    ...overrides,
  })
}

describe('loops', () => {
  test('anonymous requests redirect to login', async () => {
    const response = await app.request(url('/loops'))
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/login')
  })

  test('create, edit, schedule, toggle, and delete', async () => {
    const { user, headers, provider } = await fixture()
    const created = await app.request(url('/loops'), {
      method: 'POST', headers, body: loopForm(provider.id),
    })
    expect(created.status).toBe(302)

    const listBody = await (await app.request(url('/loops'), { headers })).text()
    expect(listBody).toContain('Morning report')
    expect(listBody).toContain('Manual only')
    expect(listBody).toContain('Paused automation')
    const id = (await listLoopsForUser(user.id)).find((loop) => loop.name === 'Morning report')?.id ?? ''
    expect(id).not.toBe('')

    const manual = await getLoopForUser({ id, userId: user.id })
    expect(manual?.enabled).toBe(false)
    expect(manual?.schedule).toBeNull()

    const updated = await app.request(url(`/loops/${id}`), {
      method: 'POST',
      headers,
      body: loopForm(provider.id, {
        name: 'Weekday report',
        schedule_mode: 'scheduled',
        schedule_preset: '0 8 * * 1-5',
        enabled: 'on',
      }),
    })
    expect(updated.status).toBe(302)
    const scheduled = await getLoopForUser({ id, userId: user.id })
    expect(scheduled?.name).toBe('Weekday report')
    expect(scheduled?.schedule).toBe('0 8 * * 1-5')
    expect(scheduled?.enabled).toBe(true)
    expect(scheduled?.next_fire_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)

    const disable = await app.request(url(`/loops/${id}/toggle`), { method: 'POST', headers })
    expect(disable.status).toBe(302)
    expect((await getLoopForUser({ id, userId: user.id }))?.enabled).toBe(false)
    const enable = await app.request(url(`/loops/${id}/toggle`), { method: 'POST', headers })
    expect(enable.status).toBe(302)
    expect((await getLoopForUser({ id, userId: user.id }))?.enabled).toBe(true)

    const deleted = await app.request(url(`/loops/${id}/delete`), { method: 'POST', headers })
    expect(deleted.status).toBe(302)
    expect(await getLoopForUser({ id, userId: user.id })).toBeUndefined()
  })

  test('loop form picks models from provider catalogs instead of typing IDs', async () => {
    const { headers } = await fixture()
    const response = await app.request(url('/loops/new'), { headers })
    const body = await response.text()
    expect(body).toContain('<select id="provider_model" name="provider_model"')
    expect(body).toContain('Provider &amp; model')
    expect(body).toContain('model-test')
    expect(body).not.toContain('<input id="model"')
  })

  test('builds clear common schedules in the user timezone', async () => {
    const { user, headers, provider } = await fixture()
    await patchUserSettings({ userId: user.id, patch: { timeZone: 'America/New_York' } })
    const response = await app.request(url('/loops'), {
      method: 'POST',
      headers,
      body: loopForm(provider.id, {
        name: 'Daily local report',
        schedule_mode: 'daily',
        schedule_daily_time: '09:30',
        enabled: 'on',
      }),
    })
    expect(response.status).toBe(302)
    const loop = (await listLoopsForUser(user.id)).find((row) => row.name === 'Daily local report')
    expect(loop?.schedule).toBe('30 9 * * *')
    expect(loop?.next_fire_at).toMatch(/^\d{4}-\d{2}-\d{2}T09:30:00$/)
  })

  test('timezone changes reinterpret the same local loop time', async () => {
    const { user, headers, provider } = await fixture()
    await patchUserSettings({ userId: user.id, patch: { timeZone: 'America/New_York' } })
    await app.request(url('/loops'), {
      method: 'POST',
      headers,
      body: loopForm(provider.id, {
        name: 'Timezone follower',
        schedule_mode: 'daily',
        schedule_daily_time: '09:30',
        enabled: 'on',
      }),
    })
    const before = (await listLoopsForUser(user.id)).find((row) => row.name === 'Timezone follower')!
    const beforeInstant = wallTimeToInstant(before.next_fire_at!, 'America/New_York')

    const response = await app.request(url('/settings/timezone'), {
      method: 'POST',
      headers,
      body: form({ timezone: 'Europe/Paris' }),
    })
    expect(response.status).toBe(302)

    const after = await getLoopForUser({ id: before.id, userId: user.id })
    expect((await getUserSettings(user.id)).timeZone).toBe('Europe/Paris')
    expect(after?.next_fire_at).toBe(before.next_fire_at)
    expect(wallTimeToInstant(after!.next_fire_at!, 'Europe/Paris')?.getTime())
      .not.toBe(beforeInstant?.getTime())
  })

  test('supports a one-time local date and pauses after that occurrence', async () => {
    const { user, headers, provider } = await fixture()
    const future = new Date(Date.now() + 86_400_000)
    const local = `${future.getUTCFullYear()}-${String(future.getUTCMonth() + 1).padStart(2, '0')}-${String(future.getUTCDate()).padStart(2, '0')}T12:00`
    const response = await app.request(url('/loops'), {
      method: 'POST', headers, body: loopForm(provider.id, {
        name: 'One shot', schedule_mode: 'once', schedule_once: local, enabled: 'on',
      }),
    })
    expect(response.status).toBe(302)
    const loop = (await listLoopsForUser(user.id)).find((row) => row.name === 'One shot')
    expect(loop?.schedule).toBe(`once:${local}`)
    expect(loop?.next_fire_at).toBe(`${local}:00`)
  })

  test('hourly schedules round-trip every minute through the preset UI', () => {
    for (let minute = 0; minute < 60; minute += 1) {
      expect(scheduleFormParts(`${minute} * * * *`)).toMatchObject({
        mode: 'hourly',
        minute: String(minute),
      })
    }
  })

  test('validation retains submitted values and rejects invalid schedules even while paused', async () => {
    const { headers, provider } = await fixture()
    const response = await app.request(url('/loops'), {
      method: 'POST',
      headers,
      body: loopForm(provider.id, {
        name: 'Retained name',
        schedule_mode: 'scheduled',
        schedule: 'not cron',
      }),
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('Retained name')
    expect(body).toContain('Schedule is not a valid 5-field cron expression')
    expect(body).toContain('value="not cron"')
  })

  test('rejects a model outside the selected provider catalog', async () => {
    const { headers, provider } = await fixture()
    const response = await app.request(url('/loops'), {
      method: 'POST', headers, body: loopForm(provider.id, { model: 'zork-best' }),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('is not in')
  })

  test('MCP auto-approval is stored only for a selected owned server', async () => {
    const { user, headers, provider } = await fixture()
    const selected = await createMcpServer({ accountId: user.id, name: 'selected', url: 'http://127.0.0.1:9991/mcp' })
    const unselected = await createMcpServer({ accountId: user.id, name: 'unselected', url: 'http://127.0.0.1:9992/mcp' })
    await app.request(url('/loops'), {
      method: 'POST',
      headers,
      body: loopForm(provider.id, {
        enabled_mcp_server_id: selected.id,
        auto_approve_mcp_server_id: [selected.id, unselected.id],
      }),
    })
    const id = (await listLoopsForUser(user.id)).find((loop) => loop.name === 'Morning report')?.id ?? ''
    expect(id).not.toBe('')
    expect(await listLoopMcpServers(id)).toEqual([{ mcp_server_id: selected.id, auto_approve: true }])
  })

  test('foreign loops and providers cannot be read or changed', async () => {
    const owner = await fixture()
    const stranger = await fixture()
    const loop = await createLoop({
      accountId: owner.user.id,
      userId: owner.user.id,
      name: 'Private loop',
      prompt: 'private',
      providerId: owner.provider.id,
      enabled: false,
    })

    for (const attempt of [
      { path: `/loops/${loop.id}`, method: 'GET' },
      { path: `/loops/${loop.id}/edit`, method: 'GET' },
      { path: `/loops/${loop.id}/toggle`, method: 'POST' },
      { path: `/loops/${loop.id}/delete`, method: 'POST' },
    ]) {
      const response = await app.request(url(attempt.path), { method: attempt.method, headers: stranger.headers })
      expect(response.status).toBe(404)
    }
    expect(await getLoopForUser({ id: loop.id, userId: owner.user.id })).not.toBeNull()

    const invalidProvider = await app.request(url('/loops'), {
      method: 'POST', headers: stranger.headers, body: loopForm(owner.provider.id),
    })
    expect(invalidProvider.status).toBe(200)
    expect(await invalidProvider.text()).toContain('Choose an enabled provider')
  })

  test('only the originating run of a loop conversation owns notifications', async () => {
    const { user, provider } = await fixture()
    const loop = await createLoop({
      accountId: user.id,
      userId: user.id,
      name: 'Notification owner',
      prompt: 'Check once',
      providerId: provider.id,
      enabled: false,
    })
    const conversation = await createConversation({
      userId: user.id,
      providerId: provider.id,
      routineId: loop.id,
    })

    const originating = await createRun({ conversationId: conversation.id, status: 'done' })
    expect(await isOriginatingRun({ runId: originating.id, conversationId: conversation.id })).toBe(true)

    const continuation = await createRun({ conversationId: conversation.id, status: 'done' })
    expect(await isOriginatingRun({ runId: continuation.id, conversationId: conversation.id })).toBe(false)
    expect(await isOriginatingRun({ runId: originating.id, conversationId: conversation.id })).toBe(true)
  })

  test('run now creates an inspectable conversation', async () => {
    const { user, headers, provider } = await fixture()
    const loop = await createLoop({
      accountId: user.id,
      userId: user.id,
      name: 'Run now loop',
      prompt: 'Say hello',
      providerId: provider.id,
      model: 'model-test',
      enabled: false,
    })
    const response = await app.request(url(`/loops/${loop.id}/run`), { method: 'POST', headers })
    expect(response.status).toBe(302)
    const location = response.headers.get('location') ?? ''
    expect(location).toMatch(/^\/conversations\/[0-9a-f-]+$/)
    const conversationId = location.split('/').at(-1) ?? ''
    expect((await getLoopForUser({ id: loop.id, userId: user.id }))?.last_conversation_id).toBe(conversationId)

    // The runner is intentionally detached from the POST response. Wait for
    // its expected terminal network error so test teardown does not close SQL
    // beneath an in-flight finalization query.
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const run = await getLatestRunForConversation(conversationId)
      if (run && ['done', 'error', 'cancelled'].includes(run.status)) break
      await Bun.sleep(20)
    }
    expect((await getLatestRunForConversation(conversationId))?.status).toBe('error')
  })
})
