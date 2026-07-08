import { Hono } from 'hono'
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServerForUser,
  listMcpServersForUser,
  setMcpServerEnabled,
  updateMcpServer,
} from '../db/queries/mcp-servers'
import { clearMcpToolCache, testMcpConnection, type McpTestResult } from '../services/mcp-client'
import { readString } from '../utils/validation'

export const mcpServerRoutes = new Hono()

const maxNameLength = 200
const maxUrlLength = 2048
const minTimeoutMs = 1000
const maxTimeoutMs = 600_000
const forbiddenHeaderNames = new Set([
  'connection',
  'content-length',
  'host',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

type McpServerFormValues = {
  name: string
  url: string
  autoApprove: boolean
  headers: string
  clearHeaders: boolean
  requestTimeoutMs: string
}

function readForm(form: FormData): McpServerFormValues {
  return {
    name: readString(form, 'name').trim(),
    url: readString(form, 'url').trim(),
    autoApprove: readString(form, 'auto_approve') === 'on',
    headers: readString(form, 'headers').trim(),
    clearHeaders: readString(form, 'clear_headers') === 'on',
    requestTimeoutMs: readString(form, 'request_timeout_ms').trim(),
  }
}

// Parse the headers textarea into a JSON object, or return an error string.
function parseHeaders(raw: string): { headers: unknown } | { error: string } {
  if (raw.length === 0) return { headers: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { error: 'Headers must be valid JSON (an object of header names to values)' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'Headers must be a JSON object' }
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const name = key.toLowerCase()
    if (
      forbiddenHeaderNames.has(name) ||
      name.startsWith('proxy-') ||
      name.startsWith('x-forwarded-') ||
      name === 'forwarded'
    ) {
      return { error: `Header "${key}" is not allowed` }
    }
    if (typeof value !== 'string') {
      return { error: 'Every header value must be a string' }
    }
  }
  return { headers: parsed }
}

function validate(values: McpServerFormValues): string[] {
  const errors: string[] = []
  if (!values.name) errors.push('Name is required')
  if (values.name.length > maxNameLength) {
    errors.push(`Name must be ${maxNameLength} characters or fewer`)
  }
  if (!values.url) errors.push('URL is required')
  if (values.url.length > maxUrlLength) {
    errors.push(`URL must be ${maxUrlLength} characters or fewer`)
  }
  if (values.url && !/^https?:\/\//i.test(values.url)) {
    errors.push('URL must start with http:// or https://')
  }
  if (values.requestTimeoutMs) {
    const ms = Number(values.requestTimeoutMs)
    if (!Number.isFinite(ms) || ms < minTimeoutMs || ms > maxTimeoutMs) {
      errors.push(`Request timeout must be between ${minTimeoutMs} and ${maxTimeoutMs} ms`)
    }
  }
  const headers = parseHeaders(values.headers)
  if ('error' in headers) errors.push(headers.error)
  if (values.clearHeaders && values.headers) {
    errors.push(
      'Choose one: clear the stored headers, or paste a replacement — not both',
    )
  }
  return errors
}

function connectionErrors(result: McpTestResult): string[] {
  if (!result.ok) return ['MCP server test must pass before saving', result.error]
  if (result.tools.length === 0) {
    return ['MCP server connected, but exposes no tools that inkcap can use']
  }
  return []
}

// Stored header values are secrets (issue 02): they are never rendered back
// to the browser. The edit form only learns whether headers exist.
function storedHeaderCount(headers: unknown): number {
  if (!headers || typeof headers !== 'object') return 0
  return Object.keys(headers).length
}

mcpServerRoutes.get('/mcp-servers', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  c.header('Cache-Control', 'private, no-store')
  const servers = await listMcpServersForUser(user.id)
  return c.var.render('mcp-servers/index', {
    title: 'MCP servers',
    servers,
    testResult: null,
  })
})

mcpServerRoutes.post('/mcp-servers/:id/test', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  const server = await getMcpServerForUser({ id: c.req.param('id'), userId: user.id })
  if (!server) return c.notFound()

  const result = await testMcpConnection({
    id: server.id,
    name: server.name,
    url: server.url,
    headers: server.headers,
    request_timeout_ms: server.request_timeout_ms,
  })
  const servers = await listMcpServersForUser(user.id)

  c.header('Cache-Control', 'private, no-store')
  return c.var.render('mcp-servers/index', {
    title: 'MCP servers',
    servers,
    testResult: { serverId: server.id, result },
  })
})

mcpServerRoutes.get('/mcp-servers/new', async (c) => {
  if (!c.var.user) return c.redirect('/login')

  return c.var.render('mcp-servers/new', {
    title: 'Add MCP server',
    errors: [],
    values: { name: '', url: '', autoApprove: false, headers: '', requestTimeoutMs: '30000' },
    testResult: null,
  })
})

mcpServerRoutes.post('/mcp-servers', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  const form = await c.req.formData()
  const values = readForm(form)
  const errors = validate(values)

  if (errors.length > 0) {
    return c.var.render('mcp-servers/new', {
      title: 'Add MCP server',
      errors,
      values,
      testResult: null,
    })
  }

  const headers = parseHeaders(values.headers)
  const parsedHeaders = 'headers' in headers ? headers.headers : null
  const requestTimeoutMs = values.requestTimeoutMs ? Number(values.requestTimeoutMs) : 30000
  const testResult = await testMcpConnection({
    id: 'new',
    name: values.name,
    url: values.url,
    headers: parsedHeaders,
    request_timeout_ms: requestTimeoutMs,
  })
  const testErrors = connectionErrors(testResult)
  if (testErrors.length > 0) {
    return c.var.render('mcp-servers/new', {
      title: 'Add MCP server',
      errors: testErrors,
      values,
      testResult,
    })
  }

  await createMcpServer({
    // Personal account id === user id (migration 012).
    accountId: user.id,
    name: values.name,
    url: values.url,
    autoApprove: values.autoApprove,
    headers: parsedHeaders,
    requestTimeoutMs,
    enabled: true,
  })

  return c.redirect('/mcp-servers')
})

mcpServerRoutes.get('/mcp-servers/:id/edit', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  const server = await getMcpServerForUser({ id: c.req.param('id'), userId: user.id })
  if (!server) return c.notFound()

  return c.var.render('mcp-servers/edit', {
    title: 'Edit MCP server',
    errors: [],
    server,
    storedHeaderCount: storedHeaderCount(server.headers),
    values: {
      name: server.name,
      url: server.url,
      autoApprove: server.auto_approve,
      headers: '',
      requestTimeoutMs: String(server.request_timeout_ms),
    },
    testResult: null,
  })
})

mcpServerRoutes.post('/mcp-servers/:id', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  const id = c.req.param('id')
  const server = await getMcpServerForUser({ id, userId: user.id })
  if (!server) return c.notFound()

  const form = await c.req.formData()
  const values = readForm(form)
  const errors = validate(values)

  if (errors.length > 0) {
    return c.var.render('mcp-servers/edit', {
      title: 'Edit MCP server',
      errors,
      server,
      storedHeaderCount: storedHeaderCount(server.headers),
      values,
      testResult: null,
    })
  }

  // Mirrors the provider API-key form: stored headers never render into the
  // page, so an empty textarea means "keep what is stored"; the explicit
  // "clear stored headers" checkbox is the only way to remove them.
  const parsed = parseHeaders(values.headers)
  const headers = values.clearHeaders
    ? null
    : values.headers
      ? 'headers' in parsed
        ? parsed.headers
        : null
      : server.headers
  const requestTimeoutMs = values.requestTimeoutMs ? Number(values.requestTimeoutMs) : 30000
  const testResult = await testMcpConnection({
    id,
    name: values.name,
    url: values.url,
    headers,
    request_timeout_ms: requestTimeoutMs,
  })
  const testErrors = connectionErrors(testResult)
  if (testErrors.length > 0) {
    return c.var.render('mcp-servers/edit', {
      title: 'Edit MCP server',
      errors: testErrors,
      server,
      storedHeaderCount: storedHeaderCount(server.headers),
      values,
      testResult,
    })
  }

  await updateMcpServer({
    id,
    name: values.name,
    url: values.url,
    autoApprove: values.autoApprove,
    headers,
    requestTimeoutMs,
  })
  clearMcpToolCache(id)

  return c.redirect('/mcp-servers')
})

mcpServerRoutes.post('/mcp-servers/:id/enable', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  const server = await getMcpServerForUser({ id: c.req.param('id'), userId: user.id })
  if (!server) return c.notFound()

  await setMcpServerEnabled({ id: server.id, enabled: true })
  return c.redirect('/mcp-servers')
})

mcpServerRoutes.post('/mcp-servers/:id/disable', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  const server = await getMcpServerForUser({ id: c.req.param('id'), userId: user.id })
  if (!server) return c.notFound()

  await setMcpServerEnabled({ id: server.id, enabled: false })
  return c.redirect('/mcp-servers')
})

mcpServerRoutes.post('/mcp-servers/:id/delete', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  const server = await getMcpServerForUser({ id: c.req.param('id'), userId: user.id })
  if (!server) return c.notFound()

  await deleteMcpServer(server.id)
  clearMcpToolCache(server.id)
  return c.redirect('/mcp-servers')
})
