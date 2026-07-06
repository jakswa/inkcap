import { describe, expect, test } from 'bun:test'
import { randomUUIDv7 } from 'bun'

const { app } = await import('../../src/app')
const { createUser } = await import('../../src/db/queries/users')
const { createConversation } = await import('../../src/db/queries/conversations')
const { listMcpServers, listEnabledMcpServersForConversation } = await import(
  '../../src/db/queries/mcp-servers'
)
const { encryptSession } = await import('../../src/utils/private-session')
const { startStubMcpServer } = await import('../helpers/mcp-stub')

const origin = 'http://localhost:3000'

function url(path: string) {
  return `${origin}${path}`
}

function form(input: Record<string, string>) {
  const body = new FormData()
  for (const [key, value] of Object.entries(input)) body.set(key, value)
  return body
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
    const user = await makeUser()
    const cookie = sessionFor(user)
    const headers = { Cookie: cookie, Origin: origin }
    const name = `srv-${randomUUIDv7()}`

    const create = await app.request(url('/mcp-servers'), {
      method: 'POST',
      headers,
      body: form({
        name,
        url: 'https://mcp.example.com/mcp',
        headers: '{"Authorization":"Bearer x"}',
        request_timeout_ms: '15000',
        auto_approve: 'on',
      }),
    })
    expect(create.status).toBe(302)

    const listed = await listMcpServers()
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
        url: 'https://mcp.example.com/mcp',
        headers: '',
        request_timeout_ms: '20000',
      }),
    })
    expect(edited.status).toBe(302)

    // Disable then enable.
    await app.request(url(`/mcp-servers/${id}/disable`), { method: 'POST', headers })
    let after = (await listMcpServers()).find((s) => s.id === id)
    expect(after?.enabled).toBe(false)
    expect(after?.auto_approve).toBe(false)
    expect(after?.name).toBe(`${name}-v2`)

    await app.request(url(`/mcp-servers/${id}/enable`), { method: 'POST', headers })
    after = (await listMcpServers()).find((s) => s.id === id)
    expect(after?.enabled).toBe(true)

    const del = await app.request(url(`/mcp-servers/${id}/delete`), { method: 'POST', headers })
    expect(del.status).toBe(302)
    expect((await listMcpServers()).find((s) => s.id === id)).toBeUndefined()
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
      const id = (await listMcpServers()).find((s) => s.name === name)!.id

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
    const user = await makeUser()
    const cookie = sessionFor(user)
    const headers = { Cookie: cookie, Origin: origin }
    const conversation = await createConversation({ userId: user.id })

    const name = `ovr-${randomUUIDv7()}`
    await app.request(url('/mcp-servers'), {
      method: 'POST',
      headers,
      body: form({ name, url: 'https://mcp.example.com/mcp', headers: '', request_timeout_ms: '30000' }),
    })
    const id = (await listMcpServers()).find((s) => s.name === name)!.id

    // Default: nothing enabled for the conversation.
    expect(await listEnabledMcpServersForConversation(conversation.id)).toHaveLength(0)

    // The tools page lists the server as off.
    const toolsPage = await app.request(url(`/conversations/${conversation.id}/tools`), {
      headers: { Cookie: cookie },
    })
    const toolsHtml = await toolsPage.text()
    expect(toolsHtml).toContain(name)
    expect(toolsHtml).toContain('Off — turn on')

    // Turn it on for this conversation.
    const toggle = await app.request(url(`/conversations/${conversation.id}/tools`), {
      method: 'POST',
      headers,
      body: form({ mcp_server_id: id, enabled: 'on' }),
    })
    expect(toggle.status).toBe(302)

    const enabled = await listEnabledMcpServersForConversation(conversation.id)
    expect(enabled.map((s) => s.id)).toContain(id)

    // Turn it back off (no `enabled` field).
    await app.request(url(`/conversations/${conversation.id}/tools`), {
      method: 'POST',
      headers,
      body: form({ mcp_server_id: id }),
    })
    expect(await listEnabledMcpServersForConversation(conversation.id)).toHaveLength(0)
  })
})
