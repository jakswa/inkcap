import { describe, expect, test } from 'bun:test'
import { randomUUIDv7 } from 'bun'

const { app } = await import('../../src/app')
const { createProvider } = await import('../../src/db/queries/providers')
const { createUser } = await import('../../src/db/queries/users')
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

async function makeUser() {
  const suffix = randomUUIDv7()
  return createUser({
    name: 'Providers Test User',
    email: `providers-${suffix}@example.com`,
    emailNormalized: `providers-${suffix}@example.com`,
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

// Providers are account-scoped, so a test keeps one identity for all its
// requests; each call creates a fresh user + personal account.
async function authHeadersFor() {
  const user = await makeUser()
  return { user, headers: { Cookie: sessionFor(user), Origin: origin } }
}

function uniqueName(label: string) {
  return `${label}-${randomUUIDv7()}`
}

function openAiStub(options: { models?: string[]; status?: number } = {}) {
  const models = options.models ?? ['gpt-test', 'gpt-test-2']
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const requestUrl = new URL(req.url)
      if (options.status && options.status >= 400) {
        return new Response('upstream error', { status: options.status })
      }
      if (requestUrl.pathname === '/v1/models') {
        return Response.json({ data: models.map((id) => ({ id })) })
      }
      if (requestUrl.pathname === '/v1/chat/completions') {
        const body = (await req.json()) as { model?: string }
        return Response.json({
          model: body.model ?? models[0],
          choices: [{ message: { content: 'OK' } }],
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
}

describe('providers CRUD', () => {
  test('anonymous requests are redirected to login', async () => {
    const res = await app.request(url('/providers'))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  test('create, list, edit, update, disable, enable, and delete', async () => {
    const { headers } = await authHeadersFor()
    const name = uniqueName('openai-provider')
    const server = openAiStub()

    try {
      const create = await app.request(url('/providers'), {
        method: 'POST',
        headers,
        body: form({
          name,
          kind: 'openai-compat',
          base_url: `http://localhost:${server.port}/v1/`,
          api_key: 'sk-secret-1234',
          default_model: 'gpt-test',
        }),
      })

      expect(create.status).toBe(302)
      expect(create.headers.get('location')).toBe('/providers')

      const list = await app.request(url('/providers'), { headers })
      expect(list.status).toBe(200)
      const listBody = await list.text()
      expect(listBody).toContain(name)
      expect(listBody).toContain(`http://localhost:${server.port}<`)
      expect(listBody).not.toContain('sk-secret-1234')
      expect(listBody).toContain('1234')
      expect(listBody).toContain('gpt-test-2')

      const idMatch = listBody.match(new RegExp(`${name}[\\s\\S]*?/providers/([0-9a-f-]+)/edit`))
      expect(idMatch).toBeTruthy()
      const id = idMatch?.[1] ?? ''

      const editForm = await app.request(url(`/providers/${id}/edit`), {
        headers,
      })
      expect(editForm.status).toBe(200)
      const editBody = await editForm.text()
      expect(editBody).toContain(name)
      expect(editBody).toContain(`http://localhost:${server.port}`)

      const updatedName = uniqueName('openai-provider-renamed')
      const update = await app.request(url(`/providers/${id}`), {
        method: 'POST',
        headers,
        body: form({
          name: updatedName,
          kind: 'openai-compat',
          base_url: `http://localhost:${server.port}`,
          api_key: '',
          default_model: 'gpt-test-2',
        }),
      })
      expect(update.status).toBe(302)

      const afterUpdate = await app.request(url('/providers'), { headers })
      const afterUpdateBody = await afterUpdate.text()
      expect(afterUpdateBody).toContain(updatedName)
      expect(afterUpdateBody).toContain('1234')

      const disable = await app.request(url(`/providers/${id}/disable`), {
        method: 'POST',
        headers,
      })
      expect(disable.status).toBe(302)
      const disabledBody = await (
        await app.request(url('/providers'), { headers })
      ).text()
      expect(disabledBody).toContain('Disabled')

      const enable = await app.request(url(`/providers/${id}/enable`), {
        method: 'POST',
        headers,
      })
      expect(enable.status).toBe(302)
      const enabledBody = await (
        await app.request(url('/providers'), { headers })
      ).text()
      expect(enabledBody).toContain('Enabled')

      const clearKey = await app.request(url(`/providers/${id}`), {
        method: 'POST',
        headers,
        body: form({
          name: updatedName,
          kind: 'openai-compat',
          base_url: `http://localhost:${server.port}`,
          api_key: '',
          clear_api_key: 'on',
          default_model: 'gpt-test-2',
        }),
      })
      expect(clearKey.status).toBe(302)
      const clearedBody = await (
        await app.request(url('/providers'), { headers })
      ).text()
      expect(clearedBody).toContain('API key: Not set')

      const del = await app.request(url(`/providers/${id}/delete`), {
        method: 'POST',
        headers,
      })
      expect(del.status).toBe(302)

      const afterDelete = await (
        await app.request(url('/providers'), { headers })
      ).text()
      expect(afterDelete).not.toContain(updatedName)
    } finally {
      server.stop(true)
    }
  })

  test('editing preserves the curated model list instead of replacing it with discovery', async () => {
    const { user, headers } = await authHeadersFor()
    const server = openAiStub({ models: ['discovered-a', 'discovered-b'] })

    try {
      const provider = await createProvider({
        accountId: user.id,
        name: uniqueName('curated-provider'),
        kind: 'openai-compat',
        baseUrl: `http://localhost:${server.port}`,
        apiKey: 'sk-existing',
        defaultModel: 'old-model',
        models: ['old-model'],
        enabled: true,
      })

      const updatedName = uniqueName('curated-provider-renamed')
      const update = await app.request(url(`/providers/${provider.id}`), {
        method: 'POST',
        headers,
        body: form({
          name: updatedName,
          kind: 'openai-compat',
          base_url: `http://localhost:${server.port}`,
          api_key: '',
          default_model: 'custom-model',
          models: 'custom-model\nkept-model',
        }),
      })
      expect(update.status).toBe(302)

      const afterUpdate = await app.request(url('/providers'), { headers })
      const body = await afterUpdate.text()
      expect(body).toContain(updatedName)
      expect(body).toContain('custom-model')
      expect(body).toContain('kept-model')
      expect(body).not.toContain('discovered-a')
      expect(body).not.toContain('discovered-b')
    } finally {
      server.stop(true)
    }
  })

  test('providers are invisible and immutable across accounts', async () => {
    const owner = await authHeadersFor()
    const stranger = await authHeadersFor()
    const server = openAiStub()
    const name = uniqueName('tenant-provider')

    try {
      const provider = await createProvider({
        accountId: owner.user.id,
        name,
        kind: 'openai-compat',
        baseUrl: `http://localhost:${server.port}/v1/`,
        apiKey: 'sk-tenant-secret',
        defaultModel: 'gpt-test',
        enabled: true,
      })

      // Not listed for another account.
      const list = await app.request(url('/providers'), { headers: stranger.headers })
      expect(await list.text()).not.toContain(name)

      // Every per-id route 404s for a non-member; state is untouched.
      for (const attempt of [
        { path: `/providers/${provider.id}/edit`, method: 'GET' },
        { path: `/providers/${provider.id}/test`, method: 'POST' },
        { path: `/providers/${provider.id}/disable`, method: 'POST' },
        { path: `/providers/${provider.id}/delete`, method: 'POST' },
        { path: `/providers/${provider.id}/reauth`, method: 'POST' },
      ]) {
        const res = await app.request(url(attempt.path), {
          method: attempt.method,
          headers: stranger.headers,
          ...(attempt.method === 'POST' ? { body: form({}) } : {}),
        })
        expect(res.status).toBe(404)
      }

      const after = await app.request(url('/providers'), { headers: owner.headers })
      const afterBody = await after.text()
      expect(afterBody).toContain(name)
      expect(afterBody).toContain('Enabled')
    } finally {
      server.stop(true)
    }
  })

  test('validation errors re-render the new provider form', async () => {
    const { headers } = await authHeadersFor()
    const res = await app.request(url('/providers'), {
      method: 'POST',
      headers,
      body: form({ name: '', kind: 'bogus', base_url: 'not-a-url', api_key: '', default_model: '' }),
    })

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Name is required')
    expect(body).toContain('Kind must be openai-compat, llama-server, or openai-codex')
    expect(body).toContain('Base URL must start with http:// or https://')
  })

  test('provider creation is blocked when inference fails', async () => {
    const { headers } = await authHeadersFor()
    const server = openAiStub({ status: 401 })
    try {
      const res = await app.request(url('/providers'), {
        method: 'POST',
        headers,
        body: form({
          name: uniqueName('blocked-provider'),
          kind: 'openai-compat',
          base_url: `http://localhost:${server.port}`,
          api_key: 'bad-key',
          default_model: 'gpt-test',
        }),
      })

      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toContain('Provider test must pass before it can be added')
      expect(body).toContain('HTTP 401')
    } finally {
      server.stop(true)
    }
  })
})

describe('providers test connection', () => {
  test('llama-server kind succeeds against a stub /props endpoint', async () => {
    const { headers } = await authHeadersFor()
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const requestUrl = new URL(req.url)
        if (requestUrl.pathname === '/props') {
          return Response.json({
            default_generation_settings: { n_ctx: 4096 },
            model_path: '/models/test-model.gguf',
          })
        }
        if (requestUrl.pathname === '/v1/chat/completions') {
          const body = (await req.json()) as { model?: string }
          return Response.json({
            model: body.model ?? 'test-model.gguf',
            choices: [{ message: { content: 'OK' } }],
          })
        }
        return new Response('not found', { status: 404 })
      },
    })

    try {
      const created = await app.request(url('/providers'), {
        method: 'POST',
        headers,
        body: form({
          name: uniqueName('llama-stub'),
          kind: 'llama-server',
          base_url: `http://localhost:${server.port}`,
          api_key: '',
          default_model: '',
        }),
      })
      expect(created.status).toBe(302)

      const list = await app.request(url('/providers'), { headers })
      const listBody = await list.text()
      const rowMatch = listBody.match(
        new RegExp(`localhost:${server.port}[\\s\\S]*?/providers/([0-9a-f-]+)/test`),
      )
      const id = rowMatch?.[1] ?? ''
      expect(id).not.toBe('')

      const testResult = await app.request(url(`/providers/${id}/test`), {
        method: 'POST',
        headers,
      })
      expect(testResult.status).toBe(200)
      const testBody = await testResult.text()
      expect(testBody).toContain('Connection ok')
      expect(testBody).toContain('4096')
      expect(testBody).toContain('test-model.gguf')
      expect(testBody).toContain('Inference')
    } finally {
      server.stop(true)
    }
  })

  test('openai-compat kind reports the upstream error on 401', async () => {
    const { user, headers } = await authHeadersFor()
    const server = openAiStub({ status: 401 })

    try {
      const provider = await createProvider({
        accountId: user.id,
        name: uniqueName('openai-stub'),
        kind: 'openai-compat',
        baseUrl: `http://localhost:${server.port}`,
        apiKey: 'bad-key',
        enabled: true,
      })

      const testResult = await app.request(url(`/providers/${provider.id}/test`), {
        method: 'POST',
        headers,
      })
      expect(testResult.status).toBe(200)
      const testBody = await testResult.text()
      expect(testBody).toContain('Connection failed')
      expect(testBody).toContain('HTTP 401')
    } finally {
      server.stop(true)
    }
  })
})
