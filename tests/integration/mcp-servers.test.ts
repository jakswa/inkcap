import { describe, expect, test } from 'bun:test'
import { randomUUIDv7 } from 'bun'

const { app } = await import('../../src/app')
const { createUser, getUserSettings } = await import('../../src/db/queries/users')
const { createConversation } = await import('../../src/db/queries/conversations')
const { createProvider } = await import('../../src/db/queries/providers')
const { createMcpServer, listMcpServersForUser, listEnabledMcpServersForConversation, setConversationMcpOverride } =
  await import('../../src/db/queries/mcp-servers')
const { encryptSession } = await import('../../src/utils/private-session')
const { startStubMcpServer } = await import('../helpers/mcp-stub')

const origin = 'http://localhost:3000'

function url(path: string) {
  return `${origin}${path}`
}

function form(input: Record<string, string | string[]>) {
  const body = new FormData()
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      for (const item of value) body.append(key, item)
    } else {
      body.set(key, value)
    }
  }
  return body
}

function startCaptureProvider() {
  let resolveBody!: (body: Record<string, unknown>) => void
  const requestBody = new Promise<Record<string, unknown>>((resolve) => {
    resolveBody = resolve
  })
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== '/v1/chat/completions' || req.method !== 'POST') {
        return new Response('not found', { status: 404 })
      }
      resolveBody((await req.json()) as Record<string, unknown>)
      const body =
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: [DONE]\n\n'
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
    },
  })
  return {
    url: `http://localhost:${server.port}`,
    requestBody,
    stop: () => server.stop(true),
  }
}

async function waitForProviderBody(provider: ReturnType<typeof startCaptureProvider>) {
  const timeout = Bun.sleep(5000).then(() => {
    throw new Error('provider request timed out')
  })
  return Promise.race([provider.requestBody, timeout])
}

async function makeUser() {
  const suffix = randomUUIDv7()
  return createUser({
    name: 'MCP CRUD User',
    email: `mcpcrud-${suffix}@example.com`,
    emailNormalized: `mcpcrud-${suffix}@example.com`,
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

describe('MCP servers CRUD', () => {
  test('anonymous requests are redirected to login', async () => {
    const res = await app.request(url('/mcp-servers'))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  test('create, list, edit, disable, enable, delete', async () => {
    const stub = startStubMcpServer()
    const user = await makeUser()
    const cookie = sessionFor(user)
    const headers = { Cookie: cookie, Origin: origin }
    const name = `srv-${randomUUIDv7()}`

    try {
      const create = await app.request(url('/mcp-servers'), {
        method: 'POST',
        headers,
        body: form({
          name,
          url: stub.url,
          headers: '{"Authorization":"Bearer x"}',
          request_timeout_ms: '15000',
          auto_approve: 'on',
        }),
      })
      expect(create.status).toBe(302)

      const listed = await listMcpServersForUser(user.id)
      const created = listed.find((s) => s.name === name)
      expect(created).toBeTruthy()
      expect(created?.auto_approve).toBe(true)
      expect(created?.request_timeout_ms).toBe(15000)
      expect(created?.headers).toEqual({ Authorization: 'Bearer x' })

      const id = created!.id
      const page = await app.request(url('/mcp-servers'), { headers: { Cookie: cookie } })
      expect(await page.text()).toContain(name)

      // Edit: rename + drop auto-approve.
      const edited = await app.request(url(`/mcp-servers/${id}`), {
        method: 'POST',
        headers,
        body: form({
          name: `${name}-v2`,
          url: stub.url,
          headers: '',
          request_timeout_ms: '20000',
        }),
      })
      expect(edited.status).toBe(302)

      // Disable then enable.
      await app.request(url(`/mcp-servers/${id}/disable`), { method: 'POST', headers })
      let after = (await listMcpServersForUser(user.id)).find((s) => s.id === id)
      expect(after?.enabled).toBe(false)
      expect(after?.auto_approve).toBe(false)
      expect(after?.name).toBe(`${name}-v2`)

      await app.request(url(`/mcp-servers/${id}/enable`), { method: 'POST', headers })
      after = (await listMcpServersForUser(user.id)).find((s) => s.id === id)
      expect(after?.enabled).toBe(true)

      const del = await app.request(url(`/mcp-servers/${id}/delete`), { method: 'POST', headers })
      expect(del.status).toBe(302)
      expect((await listMcpServersForUser(user.id)).find((s) => s.id === id)).toBeUndefined()
    } finally {
      stub.stop()
    }
  })

  test('MCP servers are invisible and immutable across accounts', async () => {
    const owner = await makeUser()
    const stranger = await makeUser()
    const ownerHeaders = { Cookie: sessionFor(owner), Origin: origin }
    const strangerHeaders = { Cookie: sessionFor(stranger), Origin: origin }
    const name = `tenant-srv-${randomUUIDv7()}`

    const server = await createMcpServer({
      accountId: owner.id,
      name,
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer tenant-secret' },
      enabled: true,
    })

    const list = await app.request(url('/mcp-servers'), { headers: strangerHeaders })
    expect(await list.text()).not.toContain(name)

    for (const attempt of [
      { path: `/mcp-servers/${server.id}/edit`, method: 'GET' },
      { path: `/mcp-servers/${server.id}/test`, method: 'POST' },
      { path: `/mcp-servers/${server.id}/disable`, method: 'POST' },
      { path: `/mcp-servers/${server.id}/delete`, method: 'POST' },
    ]) {
      const res = await app.request(url(attempt.path), {
        method: attempt.method,
        headers: strangerHeaders,
        ...(attempt.method === 'POST' ? { body: form({}) } : {}),
      })
      expect(res.status).toBe(404)
    }

    const mine = await listMcpServersForUser(owner.id)
    expect(mine.some((s) => s.id === server.id && s.enabled)).toBe(true)
    // Still intact for the owner via the UI too.
    const page = await app.request(url('/mcp-servers'), { headers: ownerHeaders })
    expect(await page.text()).toContain(name)
  })

  test('stored auth headers never render into the edit form; blank keeps, checkbox clears', async () => {
    const stub = startStubMcpServer()
    const user = await makeUser()
    const headers = { Cookie: sessionFor(user), Origin: origin }
    const name = `masked-${randomUUIDv7()}`
    const server = await createMcpServer({
      accountId: user.id,
      name,
      url: stub.url,
      headers: { Authorization: 'Bearer super-secret-header' },
      enabled: true,
    })

    try {
      const editPage = await app.request(url(`/mcp-servers/${server.id}/edit`), { headers })
      const editHtml = await editPage.text()
      expect(editHtml).not.toContain('super-secret-header')
      expect(editHtml).toContain('Stored header values are never shown')
      expect(editHtml).toContain('Clear stored headers')

      // Blank submission keeps the stored headers.
      const keep = await app.request(url(`/mcp-servers/${server.id}`), {
        method: 'POST',
        headers,
        body: form({ name, url: stub.url, headers: '', request_timeout_ms: '30000' }),
      })
      expect(keep.status).toBe(302)
      let row = (await listMcpServersForUser(user.id)).find((s) => s.id === server.id)
      expect(row?.headers).toEqual({ Authorization: 'Bearer super-secret-header' })

      // Clear + replacement together is contradictory input: rejected, and the
      // re-rendered form keeps the checkbox state.
      const conflicted = await app.request(url(`/mcp-servers/${server.id}`), {
        method: 'POST',
        headers,
        body: form({
          name,
          url: stub.url,
          headers: '{"Authorization":"Bearer replacement"}',
          clear_headers: 'on',
          request_timeout_ms: '30000',
        }),
      })
      expect(conflicted.status).toBe(200)
      const conflictedHtml = await conflicted.text()
      expect(conflictedHtml).toContain('not both')
      expect(conflictedHtml).toContain('name="clear_headers" checked')
      row = (await listMcpServersForUser(user.id)).find((s) => s.id === server.id)
      expect(row?.headers).toEqual({ Authorization: 'Bearer super-secret-header' })

      // The checkbox is the only way to remove them.
      const clear = await app.request(url(`/mcp-servers/${server.id}`), {
        method: 'POST',
        headers,
        body: form({
          name,
          url: stub.url,
          headers: '',
          clear_headers: 'on',
          request_timeout_ms: '30000',
        }),
      })
      expect(clear.status).toBe(302)
      row = (await listMcpServersForUser(user.id)).find((s) => s.id === server.id)
      expect(row?.headers).toBeNull()
    } finally {
      stub.stop()
    }
  })

  test('a stray override row cannot expose another account\'s server to the runner', async () => {
    const owner = await makeUser()
    const stranger = await makeUser()
    const conversation = await createConversation({ userId: stranger.id })
    const server = await createMcpServer({
      accountId: owner.id,
      name: `foreign-${randomUUIDv7()}`,
      url: 'https://mcp.example.com/mcp',
      enabled: true,
    })

    // Bypass the routes entirely: write the override row directly.
    await setConversationMcpOverride({
      conversationId: conversation.id,
      mcpServerId: server.id,
      enabled: true,
    })

    // The runner-side query refuses servers outside the owner's accounts.
    expect(await listEnabledMcpServersForConversation(conversation.id)).toHaveLength(0)
  })

  test('invalid headers JSON is rejected with a form error', async () => {
    const user = await makeUser()
    const headers = { Cookie: sessionFor(user), Origin: origin }
    const res = await app.request(url('/mcp-servers'), {
      method: 'POST',
      headers,
      body: form({
        name: `bad-${randomUUIDv7()}`,
        url: 'https://mcp.example.com/mcp',
        headers: 'not json',
        request_timeout_ms: '30000',
      }),
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Headers must be valid JSON')
  })

  test('saving an MCP server requires successful tool discovery and explains redirects', async () => {
    const redirect = Bun.serve({
      port: 0,
      async fetch() {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://mcp.example.com/mcp' },
        })
      },
    })
    try {
      const user = await makeUser()
      const headers = { Cookie: sessionFor(user), Origin: origin }
      const name = `redirect-${randomUUIDv7()}`
      const res = await app.request(url('/mcp-servers'), {
        method: 'POST',
        headers,
        body: form({
          name,
          url: `http://localhost:${redirect.port}/mcp`,
          headers: '',
          request_timeout_ms: '30000',
        }),
      })
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('MCP server test must pass before saving')
      expect(html).toContain('redirected')
      expect(html).toContain('https://mcp.example.com/mcp')
      expect((await listMcpServersForUser(user.id)).some((server) => server.name === name)).toBe(false)
    } finally {
      redirect.stop(true)
    }
  })

  test('test-connection button connects to a live server and lists tools', async () => {
    const stub = startStubMcpServer({ tools: [{ name: 'echo' }, { name: 'ping' }] })
    try {
      const user = await makeUser()
      const headers = { Cookie: sessionFor(user), Origin: origin }
      const name = `live-${randomUUIDv7()}`
      await app.request(url('/mcp-servers'), {
        method: 'POST',
        headers,
        body: form({ name, url: stub.url, headers: '', request_timeout_ms: '5000' }),
      })
      const id = (await listMcpServersForUser(user.id)).find((s) => s.name === name)!.id

      const res = await app.request(url(`/mcp-servers/${id}/test`), { method: 'POST', headers })
      const html = await res.text()
      expect(html).toContain('Connection ok')
      expect(html).toContain('echo')
      expect(html).toContain('ping')
    } finally {
      stub.stop()
    }
  }, 15_000)

  test('per-conversation override gates which servers are enabled', async () => {
    const stub = startStubMcpServer()
    const user = await makeUser()
    const cookie = sessionFor(user)
    const headers = { Cookie: cookie, Origin: origin }
    const conversation = await createConversation({ userId: user.id })

    const name = `ovr-${randomUUIDv7()}`
    await app.request(url('/mcp-servers'), {
      method: 'POST',
      headers,
      body: form({ name, url: stub.url, headers: '', request_timeout_ms: '30000' }),
    })
    const id = (await listMcpServersForUser(user.id)).find((s) => s.name === name)!.id

    // Default: nothing enabled for the conversation.
    expect(await listEnabledMcpServersForConversation(conversation.id)).toHaveLength(0)

    // The tools page lists the server as off.
    const toolsPage = await app.request(url(`/conversations/${conversation.id}/tools`), {
      headers: { Cookie: cookie },
    })
    const toolsHtml = await toolsPage.text()
    expect(toolsHtml).toContain(name)
    expect(toolsHtml).toContain('Off — turn on')

    const chatPage = await app.request(url(`/conversations/${conversation.id}`), {
      headers: { Cookie: cookie },
    })
    const chatHtml = await chatPage.text()
    expect(chatHtml).toContain('Tools')
    expect(chatHtml).toContain('Save tool choices')
    expect(chatHtml).toContain(name)

    // Turn it on for this conversation.
    const toggle = await app.request(url(`/conversations/${conversation.id}/tools`), {
      method: 'POST',
      headers,
      body: form({
        mcp_server_id: [id],
        enabled_mcp_server_id: [id],
        redirect_to: 'conversation',
      }),
    })
    expect(toggle.status).toBe(302)
    expect(toggle.headers.get('location')).toBe(`/conversations/${conversation.id}`)

    const enabled = await listEnabledMcpServersForConversation(conversation.id)
    expect(enabled.map((s) => s.id)).toContain(id)

    // Turn it back off (no `enabled` field).
    await app.request(url(`/conversations/${conversation.id}/tools`), {
      method: 'POST',
      headers,
      body: form({ mcp_server_id: id }),
    })
    expect(await listEnabledMcpServersForConversation(conversation.id)).toHaveLength(0)
    stub.stop()
  })

  test('new-chat options can enable MCP before the first run', async () => {
    const user = await makeUser()
    const cookie = sessionFor(user)
    const headers = { Cookie: cookie, Origin: origin }
    const provider = await createProvider({
      accountId: user.id,
      name: `provider-${randomUUIDv7()}`,
      kind: 'openai-compat',
      baseUrl: 'http://127.0.0.1:1',
      defaultModel: 'stub-model',
      enabled: true,
    })

    const mcp = startStubMcpServer()
    const name = `new-chat-mcp-${randomUUIDv7()}`
    await app.request(url('/mcp-servers'), {
      method: 'POST',
      headers,
      body: form({ name, url: mcp.url, headers: '', request_timeout_ms: '30000' }),
    })
    const id = (await listMcpServersForUser(user.id)).find((s) => s.name === name)!.id

    const create = await app.request(url('/conversations'), {
      method: 'POST',
      headers,
      body: form({
        providerId: provider.id,
        model: 'stub-model',
        enabled_mcp_server_id: [id],
      }),
    })
    expect(create.status).toBe(302)
    const conversationId = (create.headers.get('location') ?? '').slice('/conversations/'.length)

    const enabled = await listEnabledMcpServersForConversation(conversationId)
    expect(enabled.map((s) => s.id)).toContain(id)
    mcp.stop()
  })

  test('new-chat first run sends selected MCP tool definitions to the provider', async () => {
    const user = await makeUser()
    const cookie = sessionFor(user)
    const headers = { Cookie: cookie, Origin: origin }
    const providerServer = startCaptureProvider()
    const mcpServer = startStubMcpServer({
      tools: [
        {
          name: 'exa_search',
          description: 'Search with Exa',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
    })
    try {
      const provider = await createProvider({
        accountId: user.id,
        name: `capture-${randomUUIDv7()}`,
        kind: 'openai-compat',
        baseUrl: providerServer.url,
        defaultModel: 'stub-model',
        enabled: true,
      })
      const server = await createMcpServer({
        accountId: user.id,
        name: `exa-${randomUUIDv7()}`,
        url: mcpServer.url,
        enabled: true,
      })

      const create = await app.request(url('/conversations'), {
        method: 'POST',
        headers,
        body: form({
          providerId: provider.id,
          model: 'stub-model',
          content: 'do you see exa search tool?',
          enabled_mcp_server_id: [server.id],
        }),
      })
      expect(create.status).toBe(302)

      const body = await waitForProviderBody(providerServer)
      expect(body['tool_choice']).toBe('auto')
      expect((body['tools'] as Array<{ function?: { name?: string } }>).map((tool) => tool.function?.name)).toEqual([
        'exa_search',
      ])
    } finally {
      providerServer.stop()
      mcpServer.stop()
    }
  }, 10_000)

  test('new-chat tool selection is remembered as the default for the next chat', async () => {
    const user = await makeUser()
    const cookie = sessionFor(user)
    const headers = { Cookie: cookie, Origin: origin }
    const provider = await createProvider({
      accountId: user.id,
      name: `provider-${randomUUIDv7()}`,
      kind: 'openai-compat',
      baseUrl: 'http://127.0.0.1:1',
      defaultModel: 'stub-model',
      enabled: true,
    })
    const name = `sticky-${randomUUIDv7()}`
    const server = await createMcpServer({
      accountId: user.id,
      name,
      url: 'https://mcp.example.com/mcp',
      enabled: true,
    })

    // Fresh account: the landing renders the server unchecked.
    let landing = await app.request(url('/conversations'), { headers: { Cookie: cookie } })
    expect(await landing.text()).toContain(`aria-label="Off — turn on ${name}"`)

    // Create a chat with the server selected...
    const create = await app.request(url('/conversations'), {
      method: 'POST',
      headers,
      body: form({
        providerId: provider.id,
        model: 'stub-model',
        enabled_mcp_server_id: [server.id],
      }),
    })
    expect(create.status).toBe(302)

    // ...and the next landing comes pre-checked with it, including the visible
    // tools-count badge on the collapsed button.
    landing = await app.request(url('/conversations'), { headers: { Cookie: cookie } })
    const checkedLandingHtml = await landing.text()
    expect(checkedLandingHtml).toContain(`aria-label="On — turn off ${name}"`)
    expect(checkedLandingHtml).toContain('data-tools-count>1</span>')

    // Foreign ids from a tampered form are never persisted, and repeated ids
    // collapse to one before touching overrides or the remembered default.
    const foreign = randomUUIDv7()
    const createAgain = await app.request(url('/conversations'), {
      method: 'POST',
      headers,
      body: form({
        providerId: provider.id,
        model: 'stub-model',
        enabled_mcp_server_id: [server.id, server.id, foreign],
      }),
    })
    expect(createAgain.status).toBe(302)
    const conversationId = (createAgain.headers.get('location') ?? '').slice(
      '/conversations/'.length,
    )
    expect(
      (await listEnabledMcpServersForConversation(conversationId)).map((s) => s.id),
    ).toEqual([server.id])
    expect((await getUserSettings(user.id)).defaultMcpServerIds).toEqual([server.id])

    // Creating a chat with nothing selected clears the remembered default.
    const createEmpty = await app.request(url('/conversations'), {
      method: 'POST',
      headers,
      body: form({ providerId: provider.id, model: 'stub-model' }),
    })
    expect(createEmpty.status).toBe(302)
    landing = await app.request(url('/conversations'), { headers: { Cookie: cookie } })
    expect(await landing.text()).toContain(`aria-label="Off — turn on ${name}"`)
  })
})
