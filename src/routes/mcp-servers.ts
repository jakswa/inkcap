import { Hono } from 'hono'
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServerById,
  listMcpServers,
  setMcpServerEnabled,
  updateMcpServer,
} from '../db/queries/mcp-servers'
import { testMcpConnection } from '../services/mcp-client'
import { readString } from '../utils/validation'

export const mcpServerRoutes = new Hono()

const maxNameLength = 200
const maxUrlLength = 2048
const minTimeoutMs = 1000
const maxTimeoutMs = 600_000

type McpServerFormValues = {
  name: string
  url: string
  autoApprove: boolean
  headers: string
  requestTimeoutMs: string
}

function readForm(form: FormData): McpServerFormValues {
  return {
    name: readString(form, 'name').trim(),
    url: readString(form, 'url').trim(),
    autoApprove: readString(form, 'auto_approve') === 'on',
    headers: readString(form, 'headers').trim(),
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
  for (const value of Object.values(parsed as Record<string, unknown>)) {
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
  return errors
}

function headersToText(headers: unknown): string {
  if (!headers || typeof headers !== 'object') return ''
  return JSON.stringify(headers, null, 2)
}

mcpServerRoutes.get('/mcp-servers', async (c) => {
  if (!c.var.user) return c.redirect('/login')

  c.header('Cache-Control', 'private, no-store')
  const servers = await listMcpServers()
  return c.var.render('mcp-servers/index', {
    title: 'MCP servers',
    servers,
    testResult: null,
  })
})

mcpServerRoutes.post('/mcp-servers/:id/test', async (c) => {
  if (!c.var.user) return c.redirect('/login')

  const server = await getMcpServerById(c.req.param('id'))
  if (!server) return c.notFound()

  const result = await testMcpConnection({
    id: server.id,
    name: server.name,
    url: server.url,
    headers: server.headers,
    request_timeout_ms: server.request_timeout_ms,
  })
  const servers = await listMcpServers()

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
  })
})

mcpServerRoutes.post('/mcp-servers', async (c) => {
  if (!c.var.user) return c.redirect('/login')

  const form = await c.req.formData()
  const values = readForm(form)
  const errors = validate(values)

  if (errors.length > 0) {
    return c.var.render('mcp-servers/new', { title: 'Add MCP server', errors, values })
  }

  const headers = parseHeaders(values.headers)
  await createMcpServer({
    name: values.name,
    url: values.url,
    autoApprove: values.autoApprove,
    headers: 'headers' in headers ? headers.headers : null,
    requestTimeoutMs: values.requestTimeoutMs ? Number(values.requestTimeoutMs) : 30000,
    enabled: true,
  })

  return c.redirect('/mcp-servers')
})

mcpServerRoutes.get('/mcp-servers/:id/edit', async (c) => {
  if (!c.var.user) return c.redirect('/login')

  const server = await getMcpServerById(c.req.param('id'))
  if (!server) return c.notFound()

  return c.var.render('mcp-servers/edit', {
    title: 'Edit MCP server',
    errors: [],
    server,
    values: {
      name: server.name,
      url: server.url,
      autoApprove: server.auto_approve,
      headers: headersToText(server.headers),
      requestTimeoutMs: String(server.request_timeout_ms),
    },
  })
})

mcpServerRoutes.post('/mcp-servers/:id', async (c) => {
  if (!c.var.user) return c.redirect('/login')

  const id = c.req.param('id')
  const server = await getMcpServerById(id)
  if (!server) return c.notFound()

  const form = await c.req.formData()
  const values = readForm(form)
  const errors = validate(values)

  if (errors.length > 0) {
    return c.var.render('mcp-servers/edit', {
      title: 'Edit MCP server',
      errors,
      server,
      values,
    })
  }

  const headers = parseHeaders(values.headers)
  await updateMcpServer({
    id,
    name: values.name,
    url: values.url,
    autoApprove: values.autoApprove,
    headers: 'headers' in headers ? headers.headers : null,
    requestTimeoutMs: values.requestTimeoutMs ? Number(values.requestTimeoutMs) : 30000,
  })

  return c.redirect('/mcp-servers')
})

mcpServerRoutes.post('/mcp-servers/:id/enable', async (c) => {
  if (!c.var.user) return c.redirect('/login')

  await setMcpServerEnabled({ id: c.req.param('id'), enabled: true })
  return c.redirect('/mcp-servers')
})

mcpServerRoutes.post('/mcp-servers/:id/disable', async (c) => {
  if (!c.var.user) return c.redirect('/login')

  await setMcpServerEnabled({ id: c.req.param('id'), enabled: false })
  return c.redirect('/mcp-servers')
})

mcpServerRoutes.post('/mcp-servers/:id/delete', async (c) => {
  if (!c.var.user) return c.redirect('/login')

  await deleteMcpServer(c.req.param('id'))
  return c.redirect('/mcp-servers')
})
