import { describe, expect, test } from 'bun:test'
import { randomUUIDv7 } from 'bun'

const { app } = await import('../../src/app')
const { encryptSession } = await import('../../src/utils/private-session')

const origin = 'http://localhost:3000'

function url(path: string) {
  return `${origin}${path}`
}

function form(input: Record<string, string>) {
  const body = new FormData()
  for (const [key, value] of Object.entries(input)) body.set(key, value)
  return body
}

function authCookie() {
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + 1)

  const cookie = encryptSession({
    expiresAt: expiresAt.toISOString(),
    user: {
      id: randomUUIDv7(),
      name: 'Providers Test User',
      email: `providers-${randomUUIDv7()}@example.com`,
      created_at: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    },
    issuedAt: new Date().toISOString(),
  })

  return `session=${cookie}`
}

function authHeaders(extra: Record<string, string> = {}) {
  return { Cookie: authCookie(), Origin: origin, ...extra }
}

function uniqueName(label: string) {
  return `${label}-${randomUUIDv7()}`
}

describe('providers CRUD', () => {
  test('anonymous requests are redirected to login', async () => {
    const res = await app.request(url('/providers'))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  test('create, list, edit, update, disable, enable, and delete', async () => {
    const name = uniqueName('openai-provider')

    const create = await app.request(url('/providers'), {
      method: 'POST',
      headers: authHeaders(),
      body: form({
        name,
        kind: 'openai-compat',
        base_url: 'https://api.example.com/v1/',
        api_key: 'sk-secret-1234',
        default_model: 'gpt-test',
      }),
    })

    expect(create.status).toBe(302)
    expect(create.headers.get('location')).toBe('/providers')

    const list = await app.request(url('/providers'), { headers: authHeaders() })
    expect(list.status).toBe(200)
    const listBody = await list.text()
    expect(listBody).toContain(name)
    // base_url normalization strips the trailing /v1 and slash
    expect(listBody).toContain('https://api.example.com<')
    expect(listBody).not.toContain('sk-secret-1234')
    expect(listBody).toContain('1234')

    const idMatch = listBody.match(new RegExp(`${name}[\\s\\S]*?/providers/([0-9a-f-]+)/edit`))
    expect(idMatch).toBeTruthy()
    const id = idMatch?.[1] ?? ''

    const editForm = await app.request(url(`/providers/${id}/edit`), {
      headers: authHeaders(),
    })
    expect(editForm.status).toBe(200)
    const editBody = await editForm.text()
    expect(editBody).toContain(name)
    expect(editBody).toContain('https://api.example.com')

    const updatedName = uniqueName('openai-provider-renamed')
    const update = await app.request(url(`/providers/${id}`), {
      method: 'POST',
      headers: authHeaders(),
      body: form({
        name: updatedName,
        kind: 'openai-compat',
        base_url: 'https://api.example.com',
        api_key: '',
        default_model: 'gpt-test-2',
      }),
    })
    expect(update.status).toBe(302)

    const afterUpdate = await app.request(url('/providers'), { headers: authHeaders() })
    const afterUpdateBody = await afterUpdate.text()
    expect(afterUpdateBody).toContain(updatedName)
    // blank api_key on edit keeps the previously stored key (masked tail still visible)
    expect(afterUpdateBody).toContain('1234')

    const disable = await app.request(url(`/providers/${id}/disable`), {
      method: 'POST',
      headers: authHeaders(),
    })
    expect(disable.status).toBe(302)
    const disabledBody = await (
      await app.request(url('/providers'), { headers: authHeaders() })
    ).text()
    expect(disabledBody).toContain('Disabled')

    const enable = await app.request(url(`/providers/${id}/enable`), {
      method: 'POST',
      headers: authHeaders(),
    })
    expect(enable.status).toBe(302)
    const enabledBody = await (
      await app.request(url('/providers'), { headers: authHeaders() })
    ).text()
    expect(enabledBody).toContain('Enabled')

    const clearKey = await app.request(url(`/providers/${id}`), {
      method: 'POST',
      headers: authHeaders(),
      body: form({
        name: updatedName,
        kind: 'openai-compat',
        base_url: 'https://api.example.com',
        api_key: '',
        clear_api_key: 'on',
        default_model: 'gpt-test-2',
      }),
    })
    expect(clearKey.status).toBe(302)
    const clearedBody = await (
      await app.request(url('/providers'), { headers: authHeaders() })
    ).text()
    expect(clearedBody).toContain('API key: Not set')

    const del = await app.request(url(`/providers/${id}/delete`), {
      method: 'POST',
      headers: authHeaders(),
    })
    expect(del.status).toBe(302)

    const afterDelete = await (
      await app.request(url('/providers'), { headers: authHeaders() })
    ).text()
    expect(afterDelete).not.toContain(updatedName)
  })

  test('validation errors re-render the new provider form', async () => {
    const res = await app.request(url('/providers'), {
      method: 'POST',
      headers: authHeaders(),
      body: form({ name: '', kind: 'bogus', base_url: 'not-a-url', api_key: '', default_model: '' }),
    })

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Name is required')
    expect(body).toContain('Kind must be openai-compat or llama-server')
    expect(body).toContain('Base URL must start with http:// or https://')
  })
})

describe('providers test connection', () => {
  test('llama-server kind succeeds against a stub /props endpoint', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const requestUrl = new URL(req.url)
        if (requestUrl.pathname === '/props') {
          return Response.json({
            default_generation_settings: { n_ctx: 4096 },
            model_path: '/models/test-model.gguf',
          })
        }
        return new Response('not found', { status: 404 })
      },
    })

    try {
      const created = await app.request(url('/providers'), {
        method: 'POST',
        headers: authHeaders(),
        body: form({
          name: uniqueName('llama-stub'),
          kind: 'llama-server',
          base_url: `http://localhost:${server.port}`,
          api_key: '',
          default_model: '',
        }),
      })
      expect(created.status).toBe(302)

      const list = await app.request(url('/providers'), { headers: authHeaders() })
      const listBody = await list.text()
      const rowMatch = listBody.match(
        new RegExp(`localhost:${server.port}[\\s\\S]*?/providers/([0-9a-f-]+)/test`),
      )
      const id = rowMatch?.[1] ?? ''
      expect(id).not.toBe('')

      const test = await app.request(url(`/providers/${id}/test`), {
        method: 'POST',
        headers: authHeaders(),
      })
      expect(test.status).toBe(200)
      const testBody = await test.text()
      expect(testBody).toContain('Connection ok')
      expect(testBody).toContain('4096')
      expect(testBody).toContain('test-model.gguf')
    } finally {
      server.stop(true)
    }
  })

  test('openai-compat kind reports the upstream error on 401', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response('unauthorized', { status: 401 })
      },
    })

    try {
      const created = await app.request(url('/providers'), {
        method: 'POST',
        headers: authHeaders(),
        body: form({
          name: uniqueName('openai-stub'),
          kind: 'openai-compat',
          base_url: `http://localhost:${server.port}`,
          api_key: 'bad-key',
          default_model: '',
        }),
      })
      expect(created.status).toBe(302)

      const list = await app.request(url('/providers'), { headers: authHeaders() })
      const listBody = await list.text()
      const rowMatch = listBody.match(
        new RegExp(`localhost:${server.port}[\\s\\S]*?/providers/([0-9a-f-]+)/test`),
      )
      const id = rowMatch?.[1] ?? ''
      expect(id).not.toBe('')

      const test = await app.request(url(`/providers/${id}/test`), {
        method: 'POST',
        headers: authHeaders(),
      })
      expect(test.status).toBe(200)
      const testBody = await test.text()
      expect(testBody).toContain('Connection failed')
      expect(testBody).toContain('HTTP 401')
    } finally {
      server.stop(true)
    }
  })
})
